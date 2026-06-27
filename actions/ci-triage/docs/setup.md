# CI Triage setup guide

This guide takes a repository from nothing to a working CI Triage without reading
the action's source. Follow it in order; each step is verifiable.

CI Triage watches a **CI workflow** for failures and, when one fails, hands the
exact failed run to the GitHub Copilot **Agent Tasks** API so Copilot can
investigate and open (or reuse) a **fix pull request**. The loop is human-gated:
a person reviews and merges every fix pull request. The action is read-only
against the failed run and **never checks out or executes failed-branch code**.

See also:

- [Inputs, outputs, outcomes, and reason codes](reference.md) — the full public
  contract.
- [Pipeline targeting](pipeline-targeting.md) — which workflows trigger triage
  and where that decision lives.
- [Security model](security.md) — trust boundaries, token responsibilities, and
  required permissions.
- [Operational behavior & public-preview limits](operations.md) — what the
  action guarantees and what the preview API does not.
- [Troubleshooting & recovery](troubleshooting.md) — operating procedures.
- [Examples](../examples/README.md) — copy-ready consumer workflows.

## 1. Prerequisites

- A GitHub repository where you can add workflows and secrets.
- The **GitHub Copilot coding agent / Agent Tasks** feature enabled for the
  repository or organization. Agent Tasks is in **public preview**; availability
  depends on your plan and organization policy (see
  [Operational behavior & public-preview limits](operations.md)).
- A credential that can start Agent Tasks (the `agent-token`). The
  workflow-provided `GITHUB_TOKEN` **cannot** start Agent Tasks; it is only used
  for the read-only repository, workflow-run, branch, commit, and pull-request
  reads. See [Tokens and permissions](security.md#tokens-and-permissions).
- At least one **source CI workflow** whose failures you want triaged (for
  example a build/test workflow named `CI`).

## 2. Add the triage workflow

Copy one of the [examples](../examples/README.md) into the repository as
`.github/workflows/ci-triage.yml`. The simplest starting point is
[`examples/pr-failure-auto.yml`](../examples/pr-failure-auto.yml).

A triage workflow always:

- Triggers on `workflow_run` with a `completed` type, listing the **names** of
  the source workflows to watch under `on.workflow_run.workflows`.
- Guards the job with an `if` expression so it runs only when the source run
  actually **failed** (`github.event.workflow_run.conclusion == 'failure'`) and
  matches the conditions you want (branch, event, etc.). See
  [Pipeline targeting](pipeline-targeting.md).
- Declares minimal permissions (step 4).
- Serializes duplicate executions with a `concurrency` group keyed by repository,
  run id, and run attempt (step 5).
- Has **no `actions/checkout` step** — the triage workflow must never check out
  or execute the failed branch's code.

> **The triage workflow must already exist on the repository's default branch.**
> GitHub only fires `workflow_run` for triage workflows present on the default
> branch. A triage workflow added only on a feature branch never runs.

## 3. Configure the source-workflow contract

`workflow_run` selects source workflows by their **name** (`on.workflow_run.workflows`),
not by file path. This creates a name contract between the source workflow and
the triage workflow:

- List the exact `name:` of each source workflow you want to watch.
- If you ever **rename** a source workflow, update the triage workflow's
  `on.workflow_run.workflows` list to match, or triage silently stops firing.

See [Pipeline targeting](pipeline-targeting.md) for the full ownership model.

## 4. Permissions

The triage workflow needs only read scopes for its own GitHub reads. All Agent
Tasks writes go through the dedicated `agent-token`, not the workflow token:

```yaml
permissions:
  actions: read # read the failed workflow run and its attempt
  contents: read # read branches and commits
  pull-requests: read # match and inspect the candidate fix pull request
```

The `agent-token` carries the Agent Tasks permission separately (step 6 and
[Tokens and permissions](security.md#tokens-and-permissions)).

## 5. Recommended concurrency

Because Agent Tasks exposes no atomic idempotency key, deduplication is
best effort. Serialize duplicate executions of the **same failed run attempt**
so they queue instead of racing:

```yaml
concurrency:
  group: ci-triage-${{ github.repository }}-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}
  cancel-in-progress: false
```

Keying on run id **and** run attempt means a genuinely new failed attempt gets
its own group (and may legitimately start a new task), while a replayed delivery
of the same attempt reconciles to the single task. `cancel-in-progress: false`
queues rather than cancels. See
[`examples/concurrency.yml`](../examples/concurrency.yml).

## 6. Tokens: repository token vs. Agent Tasks token

CI Triage uses two credentials:

| Input          | Used for                                                           | Typical value                          |
| -------------- | ------------------------------------------------------------------ | -------------------------------------- |
| `github-token` | Read-only run, branch, commit, and pull-request reads.             | `${{ github.token }}`                  |
| `agent-token`  | Starting and searching Copilot Agent Tasks (reads **and** writes). | `${{ secrets.CI_TRIAGE_AGENT_TOKEN }}` |

Provision an `agent-token` secret with the Agent Tasks permission and the scope
to open pull requests on your behalf. There is **no default** for `agent-token`
because the workflow token cannot start Agent Tasks. See
[Tokens and permissions](security.md#tokens-and-permissions).

## 7. Choose a pull-request mode

`pull-request-mode` controls how the fix pull request is resolved:

- `auto` (default): reuse an existing same-repository fix pull request for the
  failed branch when present; otherwise open a new one.
- `existing`: only reuse an existing pull request; never open a new one. A
  push-triggered failure with no pull request resolves to `needs-human`
  (`existing-mode-requires-pull-request`).
- `new`: always open a new pull request — a **stacked** remediation pull request
  for a PR-triggered failure, or a remediation pull request targeting the failed
  branch for a push-triggered failure.

See [Pull-request modes](reference.md#pull-request-modes) for the full matrix.

## 8. Pin a model (optional)

Leave `model` empty to let the Agent Tasks API pick its default, or set it to a
specific model identifier. The value is passed **unchanged**; the action keeps no
allowlist and performs **no silent fallback**. GitHub or your organization policy
may reject a pinned or unavailable model, which surfaces as
`configuration-error` / `agent-invalid-request`. See
[`examples/model-pinning.yml`](../examples/model-pinning.yml) and
[Operational behavior](operations.md#a-pinned-model-may-be-rejected).

## 9. Dry-run first

Set `dry-run: true` to evaluate the failed run and report what **would** happen —
the resolved target, mode, run id, and attempt — without any Agent Tasks writes
or pull-request mutations. Confirm the dry-run summary resolves the target you
expect before enabling live task creation (`dry-run: false`).

## 10. Verify end to end

1. Trigger a real failure in a source workflow (for example, push a commit that
   breaks a test on a pull-request branch).
2. Confirm the triage workflow runs (Actions → CI Triage) and reports `started`
   with a `task-url`.
3. Confirm Copilot opens or updates the fix pull request and that a human is
   still required to review and merge it.

For the full disposable validation matrix, see
[Integration validation](integration-validation.md).
