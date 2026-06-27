# CI Triage reference: inputs, outputs, outcomes, and reason codes

This is the complete, stable public contract for the CI Triage action. Every
value here is safe to depend on and branch on from a consumer workflow. The
machine-readable source of truth is
[`src/domain/contract.ts`](../src/domain/contract.ts) (re-exported from
[`src/contracts.ts`](../src/contracts.ts)); this document describes it in prose.

## Inputs

| Input                 | Required | Default               | Description                                                                                                                                          |
| --------------------- | -------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`        | yes      | `${{ github.token }}` | Token for read-only repository, workflow-run, branch, commit, and pull-request reads. The workflow `GITHUB_TOKEN` is sufficient.                     |
| `agent-token`         | yes      | _none_                | Credential for Copilot Agent Tasks reads and writes. **No default** — the workflow token cannot start Agent Tasks.                                   |
| `model`               | no       | _empty_               | Model identifier passed **unchanged** to the Agent Tasks API. Empty means no override (the API picks its default). No allowlist, no silent fallback. |
| `pull-request-mode`   | no       | `auto`                | Fix pull-request resolution: `auto`, `existing`, or `new`. Any other value is a `configuration-error`.                                               |
| `prompt-instructions` | no       | _empty_               | **Trusted** repository-owner instructions appended to the triage prompt. Trusted because only repository owners can set workflow inputs.             |
| `additional-context`  | no       | _empty_               | Bounded operational evidence (for example log excerpts or Azure query results). Treated as **untrusted data**, never as instructions.                |
| `include-history`     | no       | `true`                | Collect bounded, redacted previous-attempt history (best effort) for the prompt. Strict boolean (`true`/`false`, case-insensitive).                  |
| `dry-run`             | no       | `false`               | Evaluate and report what would happen with **no** Agent Tasks writes or pull-request mutations. Strict boolean.                                      |

Boolean inputs (`include-history`, `dry-run`) accept only `true` or `false`
(case-insensitive); any other value is rejected as a `configuration-error` with
reason `invalid-input`.

## Outputs

Every normal result path sets all outputs; values that do not apply are emitted
as empty strings.

| Output                 | Description                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- |
| `outcome`              | The coarse-grained result (see [Outcomes](#outcomes)).                          |
| `reason`               | A stable, machine-readable reason code (see [Reason codes](#reason-codes)).     |
| `task-id`              | The Agent Tasks task id, when a task was started or reused.                     |
| `task-url`             | The Agent Tasks task URL, when a task was started or reused.                    |
| `workflow-run-id`      | The failed workflow run id the triage acted on, when resolved.                  |
| `workflow-run-attempt` | The failed workflow run attempt the triage acted on, when resolved.             |
| `resolved-mode`        | The pull-request mode actually applied: `auto` resolves to `existing` or `new`. |
| `target-base-ref`      | The base ref the fix pull request targets, when resolved.                       |
| `target-head-ref`      | The head ref of the fix pull request, when resolved.                            |
| `existing-pr-number`   | The reused existing fix pull-request number, when one applied.                  |

> **New-mode PR creation is asynchronous.** When the action requests a brand-new
> pull request, the Agent Tasks API creates it after the task starts. The action
> therefore **cannot** output the future PR number; `existing-pr-number` is set
> only when an existing pull request is reused. See
> [Operational behavior](operations.md#new-mode-pr-creation-is-asynchronous).

## Outcomes

`outcome` is always one of:

| Outcome               | Meaning                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `started`             | A new Agent Tasks task was started for the failed run.                                    |
| `duplicate`           | An in-flight or completed task already covers this failed run attempt; no new task.       |
| `ignored`             | The triggering event or run did not warrant triage; a benign no-op.                       |
| `needs-human`         | Triage cannot proceed safely and requires human attention.                                |
| `dry-run`             | Evaluation only; no Agent Tasks writes or pull-request mutations were performed.          |
| `configuration-error` | An input or credential was missing, invalid, unauthorized, or out of range. Fails closed. |
| `operational-error`   | An unexpected runtime or provider failure occurred.                                       |

## Reason codes

`reason` is a stable, machine-readable code that explains the `outcome`. Codes
are grouped by the stage that emits them.

### Input handling and start

| Reason            | Outcome               | Meaning                                          |
| ----------------- | --------------------- | ------------------------------------------------ |
| `invalid-input`   | `configuration-error` | One or more inputs failed validation.            |
| `dry-run-preview` | `dry-run`             | A dry run reported what would happen, no writes. |
| `task-started`    | `started`             | A new Agent Tasks task was started.              |

### Target resolution (failed-run and delivery-target resolver)

| Reason                                | Outcome       | Meaning                                                                               |
| ------------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| `not-a-workflow-run-event`            | `ignored`     | The trigger was not a `workflow_run` event.                                           |
| `workflow-run-not-completed`          | `ignored`     | The failed run could not be confirmed completed.                                      |
| `workflow-run-not-failed`             | `ignored`     | The run completed with a non-`failure` conclusion.                                    |
| `unsupported-triggering-event`        | `ignored`     | The failed run was triggered by something other than `pull_request` or `push`.        |
| `stale-workflow-run`                  | `ignored`     | The branch/PR advanced past the failed run's head SHA, so the failure is not current. |
| `pull-request-not-found`              | `needs-human` | No fix pull request could be resolved for the failed run.                             |
| `pull-request-ambiguous`              | `needs-human` | More than one open same-repository pull request matched.                              |
| `pull-request-closed`                 | `needs-human` | The only matching pull request is closed.                                             |
| `fork-pull-request`                   | `needs-human` | The matching pull request originates from a fork; triage never targets fork branches. |
| `existing-mode-requires-pull-request` | `needs-human` | `existing` mode was requested for a push-triggered run with no pull request to reuse. |
| `target-branch-not-found`             | `needs-human` | The branch the fix would target no longer exists (or the run targeted a tag).         |

### Agent Tasks provider (Copilot Agent Tasks API boundary)

| Reason                      | Outcome               | Meaning                                                                                       |
| --------------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `agent-auth-failed`         | `configuration-error` | The `agent-token` was rejected as unauthenticated.                                            |
| `agent-forbidden`           | `configuration-error` | Authenticated but not authorized, or missing the Agent Tasks permission.                      |
| `agent-unsupported`         | `configuration-error` | The credential type, plan, or preview API is unavailable for Agent Tasks.                     |
| `agent-invalid-request`     | `configuration-error` | The request was rejected as invalid, **including an invalid model**, with no silent fallback. |
| `agent-rate-limited`        | `operational-error`   | The Agent Tasks API rate-limited the request.                                                 |
| `agent-transient`           | `operational-error`   | A transient server or network failure occurred.                                               |
| `agent-unexpected-response` | `operational-error`   | The Agent Tasks API returned an unexpected response shape.                                    |

### Idempotency, reconciliation, and history

| Reason                             | Outcome             | Meaning                                                                                         |
| ---------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `agent-task-already-exists`        | `duplicate`         | A task for this exact failed run attempt already exists (matched by fingerprint); no new task.  |
| `agent-task-create-reconciled`     | `started`           | An uncertain create result was confirmed created by a follow-up fingerprint search.             |
| `agent-task-reconciliation-failed` | `operational-error` | An uncertain create result could not be reconciled to an existing task.                         |
| `agent-task-history-unavailable`   | _(not terminal)_    | Optional previous-attempt history could not be retrieved; recorded safely, never blocks a task. |
| `task-already-exists`              | `duplicate`         | An existing task already covers the run (generic duplicate code).                               |

See [Operational behavior](operations.md) for the idempotency model in depth.

## Pull-request modes

`pull-request-mode` decides how the fix pull request is resolved, in combination
with the failed run's triggering event. The action always resolves `auto` to a
concrete mode (`existing` or `new`), reported in `resolved-mode`.

| Mode       | PR-triggered failure (`pull_request`)                                                                    | Push-triggered failure (`push`)                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `auto`     | Reuse the matching open same-repository pull request (update it in place). `resolved-mode: existing`.    | Open a remediation pull request targeting the failed branch. `resolved-mode: new`. |
| `existing` | Reuse the matching open same-repository pull request. If none, `needs-human` / `pull-request-not-found`. | No pull request to reuse → `needs-human` / `existing-mode-requires-pull-request`.  |
| `new`      | Open a **stacked** remediation pull request on the original PR's head branch. `resolved-mode: new`.      | Open a remediation pull request targeting the failed branch. `resolved-mode: new`. |

The concrete write the resolver chooses is one of:

- `update-existing-pull-request` — reuse an open PR and push the fix to its head
  branch.
- `create-stacked-pull-request` — open a remediation PR stacked on the original
  PR's head branch (PR-triggered `new`).
- `create-remediation-pull-request` — open a remediation PR targeting the failed
  branch (push-triggered `auto`/`new`). The remediation head branch name is the
  deterministic `ci-triage/<base-ref>`, so re-triaging the same target reuses the
  same head branch and the downstream write stays idempotent.

Fail-closed rules apply uniformly: fork pull requests, ambiguous matches, closed
pull requests, missing target branches, and stale runs never produce a write.
See [Security model](security.md) and [Pipeline targeting](pipeline-targeting.md).
