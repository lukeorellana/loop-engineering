# CallAgent migration guide

This guide migrates the **CallAgent** repository from its current **inline**
Agent Tasks implementation — a workflow that builds a prompt and calls the Agent
Tasks API directly with `curl`, plus its own commit/PR history logic — to the
bundled **CI Triage** reusable action. It is a **reversible** rollout: nothing is
deleted until CI Triage has been validated live, and every step can be rolled
back.

> Scope: this guide does not modify the CallAgent repository for you and does not
> publish a CI Triage release. It is the plan a maintainer follows. Read the
> [Setup guide](setup.md), [Reference](reference.md),
> [Pipeline targeting](pipeline-targeting.md), [Security model](security.md), and
> [Operational behavior](operations.md) first; this guide assumes that
> vocabulary.

## Current CallAgent behavior to preserve

CallAgent today triages two pipelines with bespoke inline logic:

- **`ci` failures** are triaged for **pull-request-triggered** runs.
- **`infra` failures** are triaged on **`main`**.
- Before calling Agent Tasks it logs into Azure (OIDC) and runs an Application
  Insights / KQL query to enrich the prompt with operational evidence. This
  enrichment is **best effort** and must **not** block task creation.
- It calls the Agent Tasks API directly (`curl`) and keeps its own
  commit/PR-history bookkeeping.

The migration must keep the **same** `ci`/`infra` eligibility after cutover,
keep the Azure enrichment in the **consumer** workflow (never embedded in the
generic action), and introduce **no failed-branch checkout**.

## Overview

You will:

1. Keep the inline workflow running during validation.
2. Add a CI Triage invocation in strict **dry-run** mode.
3. Verify target resolution for both `ci` PR failures and `infra` failures on
   `main`.
4. Keep the existing Azure OIDC + Application Insights query steps as
   consumer-specific enrichment.
5. Pass the resulting Azure evidence through `additional-context`.
6. Configure the intended hardcoded `model` and `pull-request-mode`.
7. Trigger controlled failures and confirm **exactly one** correctly targeted
   task per run attempt.
8. Enable live task creation.
9. Remove the old `curl` task-creation and commit/PR-history logic **only after**
   the reusable action succeeds live.
10. Keep a documented rollback at every step.

Do everything on a branch, but remember `workflow_run` only fires for triage
workflows on the **default branch** — merge the new workflow (kept dry-run) to
the default branch to exercise it, since dry-run performs zero writes.

## 1. Preserve the inline workflow during validation

**Do not delete** the existing inline CallAgent workflow yet. It remains the
authoritative path until CI Triage is validated live. Add the CI Triage workflow
as a **new** file (for example `.github/workflows/ci-triage.yml`) so both can be
observed side by side. Because the new workflow starts in dry-run, it performs no
writes and cannot conflict with the inline path.

**Rollback:** delete the new workflow file; the inline workflow is untouched.

## 2. Add the reusable action in strict dry-run mode

Start from [`examples/ci-and-infra-targeting.yml`](../examples/ci-and-infra-targeting.yml)
(one triage workflow watching the `ci` and `infra` source workflows with
different job-level conditions) and set `dry-run: true`:

```yaml
on:
  workflow_run:
    # Match the exact `name:` of CallAgent's source workflows.
    workflows: ['ci', 'infra']
    types: [completed]

permissions:
  actions: read
  contents: read
  pull-requests: read

concurrency:
  group: ci-triage-${{ github.repository }}-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}
  cancel-in-progress: false

jobs:
  triage-ci:
    # ci failures only for pull-request-triggered runs (current behavior).
    if: >-
      ${{ github.event.workflow_run.name == 'ci'
          && github.event.workflow_run.conclusion == 'failure'
          && github.event.workflow_run.event == 'pull_request' }}
    runs-on: ubuntu-latest
    steps:
      - uses: lukeorellana/loop-engineering/actions/ci-triage@v1
        with:
          github-token: ${{ github.token }}
          agent-token: ${{ secrets.CI_TRIAGE_AGENT_TOKEN }}
          dry-run: true

  triage-infra:
    # infra failures only on main (current behavior).
    if: >-
      ${{ github.event.workflow_run.name == 'infra'
          && github.event.workflow_run.conclusion == 'failure'
          && github.event.workflow_run.head_branch == 'main' }}
    runs-on: ubuntu-latest
    steps:
      - uses: lukeorellana/loop-engineering/actions/ci-triage@v1
        with:
          github-token: ${{ github.token }}
          agent-token: ${{ secrets.CI_TRIAGE_AGENT_TOKEN }}
          dry-run: true
```

> Targeting belongs in this consumer workflow, not in the action: the source
> workflow **names** select which runs can start triage, and the job-level `if`
> encodes the `ci` = pull-request and `infra` = `main` conditions. See
> [Pipeline targeting](pipeline-targeting.md).

**Rollback:** delete the new workflow file.

## 3. Verify target resolution for `ci` and `infra`

Trigger controlled failures and read each dry-run summary:

- **`ci` PR failure:** `triage-ci` runs; the dry run reports
  `resolved-mode: existing` (auto) and `target-head-ref` = the PR head branch, or
  the stacked/new target if you pin `pull-request-mode: new`. `triage-infra` does
  not run.
- **`infra` failure on `main`:** `triage-infra` runs; the dry run reports
  `resolved-mode: new` and `target-base-ref: main` (remediation branch
  `ci-triage/main`). `triage-ci` does not run.
- Confirm a `ci` failure on a non-PR event and an `infra` failure on a non-`main`
  branch do **not** start either job — eligibility matches the inline workflow.

Only proceed when target resolution matches what the inline workflow targets.

**Rollback:** none needed — dry-run wrote nothing.

## 4. Preserve Azure OIDC and Application Insights steps (consumer-specific)

Keep CallAgent's existing Azure login (OIDC) and Application Insights / KQL query
steps **in the consumer workflow**. They must **not** be embedded in CI Triage —
the action contains no cloud login or query behavior (a non-goal). Add the
permission and the enrichment steps to the relevant job:

```yaml
permissions:
  actions: read
  contents: read
  pull-requests: read
  id-token: write # Azure OIDC login (consumer-specific enrichment)

steps:
  - name: Azure login (OIDC)
    uses: azure/login@v2
    with:
      client-id: ${{ secrets.AZURE_CLIENT_ID }}
      tenant-id: ${{ secrets.AZURE_TENANT_ID }}
      subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

  - name: Query Application Insights (best effort)
    id: insights
    continue-on-error: true # enrichment must never block task creation
    run: |
      # Run the existing KQL query and write a bounded result to $GITHUB_OUTPUT.
      echo "evidence<<EOF" >> "$GITHUB_OUTPUT"
      az monitor app-insights query ... >> "$GITHUB_OUTPUT" || true
      echo "EOF" >> "$GITHUB_OUTPUT"
```

`continue-on-error: true` keeps the enrichment **best effort**: a failed query
does not fail the job, matching the current behavior. This adds **no**
`actions/checkout` of failed-branch code.

See [`examples/additional-context-azure.yml`](../examples/additional-context-azure.yml).

**Rollback:** these are the same steps CallAgent already runs; removing them
returns to the inline behavior.

## 5. Pass the Azure evidence through `additional-context`

Feed the query result into CI Triage as **untrusted** evidence:

```yaml
- uses: lukeorellana/loop-engineering/actions/ci-triage@v1
  with:
    github-token: ${{ github.token }}
    agent-token: ${{ secrets.CI_TRIAGE_AGENT_TOKEN }}
    additional-context: ${{ steps.insights.outputs.evidence }}
    dry-run: true
```

`additional-context` is treated as data, never as instructions
([Security model](security.md#trusted-instructions-vs-untrusted-evidence)), and
is bounded/truncated by the prompt builder. Keep the Azure-specific KQL in the
consumer workflow — it is never embedded in the generic action.

## 6. Configure the intended model and pull-request mode

Pin CallAgent's intended values explicitly (still in dry-run):

```yaml
with:
  model: '<callagent-pinned-model>' # passed unchanged; no allowlist, no fallback
  pull-request-mode: auto # or existing / new to match current behavior
```

A pinned model may be rejected by GitHub or org policy
([Operational behavior](operations.md#a-pinned-model-may-be-rejected)); confirm
the value is accepted during validation. Leave `model` empty to use the API
default. See [`examples/model-pinning.yml`](../examples/model-pinning.yml).

## 7. Controlled failures: exactly one targeted task per run attempt

With the recommended `concurrency` group in place (keyed by repository, run id,
and run attempt), trigger controlled `ci` and `infra` failures and confirm — by
reading the dry-run previews — that **exactly one** correctly targeted job runs
per failed run attempt, and that re-delivering the **same** attempt would
reconcile to one task (`duplicate` / `agent-task-already-exists`) rather than
duplicating. A genuinely new run attempt may legitimately produce a new task. See
[Integration validation](integration-validation.md) scenarios 1–3 and 8.

## 8. Enable live task creation

Once dry-run target resolution and eligibility match the inline workflow for both
`ci` and `infra`, flip `dry-run: false`. Run controlled `ci` and `infra` failures
once more and confirm:

- exactly one task per failed run attempt,
- the task targets the same PR/branch the inline workflow would have,
- the Azure evidence appears in the task as untrusted context,
- a human still reviews and merges the resulting pull request.

At this point CI Triage is the authoritative path, but the inline workflow still
exists as a fallback.

## 9. Remove the inline `curl` and history logic (only after live success)

After CI Triage has driven at least one full live `ci` and one `infra` cycle:

| Asset                                         | Recommendation | Notes                                                                                              |
| --------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| Inline Agent Tasks `curl` POST                | **Remove**     | Replaced by the CI Triage provider. Delete only after live validation.                             |
| Inline commit/PR-history bookkeeping          | **Remove**     | Replaced by CI Triage's best-effort fingerprint idempotency and bounded history.                   |
| Inline prompt-building logic                  | **Remove**     | Replaced by the hardened triage prompt. Fold any still-useful guidance into `prompt-instructions`. |
| Azure OIDC + Application Insights query steps | **Retain**     | Consumer-specific enrichment passed via `additional-context`; never embed in the action.           |
| Old inline workflow file                      | **Remove**     | Replaced by `.github/workflows/ci-triage.yml`. Delete after cutover is confirmed.                  |

Remove these only when you are confident the rollback below is no longer needed;
removal is itself reversible via version control.

## 10. Rollback plan

Each step is independently reversible:

1. **Before cutover (dry-run):** delete the new CI Triage workflow file. The
   inline workflow is untouched and remains authoritative. Dry-run wrote nothing.
2. **At/after enabling live creation, before deleting inline logic:** set CI
   Triage back to `dry-run: true` (or delete its workflow) and re-enable the
   inline workflow's reactive trigger. Because no inline code was deleted yet,
   this is an immediate revert.
3. **After removing inline logic:** restore it from version control (revert the
   removal commit), then perform step 2. The prior CallAgent workflow commit is
   the documented rollback target — record its SHA in the migration PR before
   deleting the inline path.

Because CI Triage is read-only against the failed run, idempotent per run
attempt, and reads nothing from failed-branch code, switching paths back and
forth does not corrupt any state.

## Migration checklist

- [ ] Inline CallAgent workflow preserved during validation.
- [ ] CI Triage workflow added in `dry-run: true` on the default branch.
- [ ] `ci` PR-failure and `infra` `main`-failure target resolution verified in
      dry-run; ineligible cases confirmed to skip.
- [ ] Azure OIDC + Application Insights steps retained in the consumer workflow,
      best effort (`continue-on-error: true`), no failed-branch checkout.
- [ ] Azure evidence passed via `additional-context`.
- [ ] Pinned `model` and `pull-request-mode` configured and accepted.
- [ ] Exactly one correctly targeted task per run attempt confirmed.
- [ ] Live task creation enabled (`dry-run: false`) and validated for `ci` and
      `infra`.
- [ ] Inline `curl` POST, prompt-building, and commit/PR-history logic removed
      **after** live success.
- [ ] Rollback target commit SHA recorded; rollback steps documented and known to
      the team.
