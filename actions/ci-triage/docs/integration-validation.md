# CI Triage integration validation plan

This plan validates CI Triage end to end against the **public-preview** Agent
Tasks API in a **disposable** repository before any release. Run every scenario
in a throwaway repo you can delete afterward, never against a production
repository.

Each scenario lists: the setup, the action, the **expected outcome/reason** from
the [public contract](reference.md), and an evidence slot to record the actual
result. Where the underlying decision is already proven by automated unit tests,
the test is cited so the live run only has to confirm the API behaves as the
tests assume.

> **If the preview API differs from these expectations**, update the provider,
> its tests, the [contract](../src/domain/contract.ts), and the docs **before**
> migration — do not document unsupported behavior as working
> ([Operational behavior](operations.md#public-preview-api-limitations)).

## Disposable environment setup

1. Create a throwaway repository (for example `ci-triage-validation`) where Agent
   Tasks (public preview) is enabled.
2. Add a trivially failable source CI workflow named `CI` (for example a job that
   runs a test you can break on demand) and, for the infra scenarios, a second
   source workflow named `Infra`.
3. Copy [`examples/ci-and-infra-targeting.yml`](../examples/ci-and-infra-targeting.yml)
   to `.github/workflows/ci-triage.yml` on the **default branch**.
4. Provision a `CI_TRIAGE_AGENT_TOKEN` secret with the Agent Tasks permission and
   PR-creation scope.
5. Start every scenario in `dry-run: true`, confirm the resolved target, then
   repeat with `dry-run: false` for the live behavior.

## Scenarios

### 1. Update an ordinary same-repository existing PR branch

- **Setup:** open a normal pull request from a same-repo branch; break a test so
  `CI` fails on it. `pull-request-mode: auto`.
- **Expect:** `started` / `task-started`, `resolved-mode: existing`,
  `target-head-ref` = the PR's head branch, `existing-pr-number` = the PR number.
  Copilot updates the **existing** pull request.
- **Unit coverage:** `resolve-target` "PR + auto updates the existing pull
  request"; `executeAction — started (existing PR mode)`.
- **Evidence:** _record run URL, task URL, outputs._

### 2. Create a stacked remediation PR targeting an existing feature branch

- **Setup:** same failing PR as scenario 1, but `pull-request-mode: new`.
- **Expect:** `started`, `resolved-mode: new`, a **stacked** remediation PR on
  the original PR's head branch; `existing-pr-number` empty (new PR number is
  created asynchronously and is not output).
- **Unit coverage:** `resolve-target` "PR + new creates a stacked pull request
  and leaves the PR number empty"; `executeAction` outputs contract.
- **Evidence:** _record that a new stacked PR was opened, base = feature branch._

### 3. Create a remediation PR targeting `main` after a failed push

- **Setup:** push a breaking commit directly to `main`; `CI` fails for a `push`
  run. `pull-request-mode: auto` (or `new`).
- **Expect:** `started`, `resolved-mode: new`,
  `target-base-ref` = `main`, remediation head branch `ci-triage/main`.
- **Unit coverage:** `resolve-target` "push + auto creates a remediation pull
  request on the failed branch"; `remediationBranchName` determinism.
- **Evidence:** _record remediation PR targeting `main`._

### 4. Pass a valid hardcoded model

- **Setup:** any failing run with `model` set to a valid model identifier.
- **Expect:** the model is passed **unchanged**; `started`.
- **Unit coverage:** `executeAction — model override` "passes the model unchanged
  to the provider".
- **Evidence:** _confirm the task was created with the pinned model._

### 5. Handle an invalid/unavailable model without silent fallback

- **Setup:** any failing run with `model` set to a bogus/unavailable identifier.
- **Expect:** `configuration-error` / `agent-invalid-request`. **No** task is
  created and **no** fallback model is used.
- **Unit coverage:** `executeAction — agent failures` "maps invalid-model
  rejection to a configuration error".
- **Evidence:** _confirm failure, no task created, no fallback._

### 6. Reject a fork PR

- **Setup:** open a pull request from a **fork**; break `CI` on it.
- **Expect:** `needs-human` / `fork-pull-request`. No task, no write to the fork
  branch.
- **Unit coverage:** `resolve-target` "needs human when the matching pull request
  comes from a fork"; `selectPullRequest` fork cases; `executeAction` "pauses for
  human attention on a fork pull request".
- **Evidence:** _confirm needs-human with no provider call._

### 7. Ignore a stale failed run after the branch advances

- **Setup:** fail `CI`, then push a new commit advancing the branch past the
  failed run's head SHA, then let the **old** failed run reach triage.
- **Expect:** `ignored` / `stale-workflow-run`.
- **Unit coverage:** `resolve-target` "ignores a stale PR run …" and "ignores a
  stale push run …".
- **Evidence:** _confirm the stale run is ignored._

### 8. Reconcile a duplicate invocation for the same run attempt

- **Setup:** deliver/replay the **same** failed run attempt to triage twice (for
  example re-deliver the `workflow_run` event) with the recommended concurrency
  group in place.
- **Expect:** the first invocation `started`; the second `duplicate` /
  `agent-task-already-exists` pointing at the same task. A genuinely **new** run
  attempt would instead start a new task.
- **Unit coverage:** `idempotency — exact duplicate`; `idempotency — new attempt`;
  `reconciliation` cases.
- **Evidence:** _confirm one task for one attempt; second invocation deduplicated._

### 9. Confirm Copilot can access and inspect the exact failed run and logs

- **Setup:** any live `started` scenario.
- **Expect:** the started task investigates the **exact** failed run id and
  attempt that the action resolved (`workflow-run-id` / `workflow-run-attempt`)
  and can read its logs. CI Triage itself never parses the logs.
- **Evidence:** _open the task (`task-url`) and confirm it references the correct
  run id/attempt and can read the failure._

### 10. Confirm normal CI does not create live tasks

- **Setup:** run the repository's normal CI (including the dry-run smoke test)
  with no induced failure, or with `dry-run: true`.
- **Expect:** no real Agent Tasks task is created. Dry runs report
  `dry-run` / `dry-run-preview` and perform zero writes.
- **Unit coverage:** `executeAction — dry run` "reports a preview … and performs
  zero writes"; "skips deduplication and history collection entirely on a dry
  run".
- **Evidence:** _confirm zero tasks created during normal CI._

## Evidence record

Record, per scenario: the date, the failing source-run URL, the triage-run URL,
the `outcome`/`reason`/target outputs, the task URL (when started), and a
pass/fail note. Attach this record to the implementation pull request. If any
scenario contradicts the expected contract, file the provider/test/contract/docs
fix it requires before proceeding to migration or release.

## Result

| #   | Scenario                          | Expected outcome / reason                       | Status   |
| --- | --------------------------------- | ----------------------------------------------- | -------- |
| 1   | Existing PR update                | `started` / `task-started`                      | _record_ |
| 2   | Stacked remediation PR            | `started` / `task-started` (new)                | _record_ |
| 3   | Push remediation PR on `main`     | `started` / `task-started` (new)                | _record_ |
| 4   | Valid pinned model                | `started` (model unchanged)                     | _record_ |
| 5   | Invalid model, no fallback        | `configuration-error` / `agent-invalid-request` | _record_ |
| 6   | Fork PR                           | `needs-human` / `fork-pull-request`             | _record_ |
| 7   | Stale failed run                  | `ignored` / `stale-workflow-run`                | _record_ |
| 8   | Duplicate same-attempt invocation | `duplicate` / `agent-task-already-exists`       | _record_ |
| 9   | Copilot accesses exact run/logs   | task references resolved run id/attempt         | _record_ |
| 10  | Normal CI creates no live tasks   | `dry-run` / `dry-run-preview`, zero writes      | _record_ |
