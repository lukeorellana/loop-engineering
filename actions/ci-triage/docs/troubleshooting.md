# CI Triage troubleshooting & recovery runbook

This runbook explains how CI Triage operates day to day and how to recover from
every outcome it can report. For the meaning of each outcome and reason code, see
the [Reference](reference.md#outcomes).

## How triage runs

A source CI workflow completes. If it **failed**, GitHub fires a `workflow_run`
event that starts your triage workflow (provided the triage workflow is on the
default branch and the source workflow name is listed in
`on.workflow_run.workflows`). The triage job's `if` expression filters out
non-failures and unwanted conditions, then the action:

1. Refetches the failed run and resolves the exact run id, attempt, triggering
   event, head branch, and head SHA — never from the triage workflow's own ref.
2. Resolves the delivery target (existing PR to update, stacked PR, or
   remediation PR) per `pull-request-mode`.
3. Searches recent Agent Tasks for this run attempt's fingerprint
   (deduplication).
4. Starts a task (or, in `dry-run`, previews) that hands Copilot the exact run to
   investigate and the target to write to.

The action is read-only against the failed run and never checks out failed-branch
code.

## Reading the result

Inspect the action's `outcome` and `reason` outputs (and the step summary). Use
the tables below to act on each.

### `started`

A task was started (`task-started`) or an uncertain create was reconciled to an
existing task (`agent-task-create-reconciled`). The `task-url` points at the
Copilot Agent Task. Copilot will open or update the fix pull request
asynchronously. **Action:** review and merge the resulting pull request once it
appears; approve CI if your repository requires it.

### `duplicate`

A task already covers this exact failed run attempt
(`agent-task-already-exists` / `task-already-exists`). The `task-id` / `task-url`
point at the existing task. **Action:** none — this is the idempotency contract
working. To force a fresh attempt, **re-run** the failed workflow (a new run
attempt yields a new fingerprint).

### `ignored`

A benign no-op. Common reasons and what they mean:

| Reason                         | What happened                                                    | Action                                                                 |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `not-a-workflow-run-event`     | The trigger was not a `workflow_run` event.                      | Check the triage workflow's `on:` triggers.                            |
| `workflow-run-not-completed`   | The failed run was not confirmed completed.                      | Usually transient; re-delivery resolves it.                            |
| `workflow-run-not-failed`      | The source run did not end in `failure`.                         | Expected for passing runs. Tighten the job `if` to skip these earlier. |
| `unsupported-triggering-event` | The failed run was triggered by something other than PR or push. | v1 supports `pull_request` and `push` only.                            |
| `stale-workflow-run`           | The branch/PR advanced past the failed run's head SHA.           | Expected — the failure is no longer current. Triage the newer run.     |

### `needs-human`

Triage cannot proceed safely. Resolve the underlying condition, then re-run the
failed workflow to re-trigger triage:

| Reason                                | What happened                                                     | Recovery                                                                           |
| ------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pull-request-not-found`              | No fix pull request resolved for the failed run.                  | Open a pull request for the branch, or use `auto`/`new` mode for push failures.    |
| `pull-request-ambiguous`              | Multiple open same-repository PRs matched the head branch/SHA.    | Close or retarget duplicates so exactly one open PR matches.                       |
| `pull-request-closed`                 | The only matching pull request is closed.                         | Reopen it, or switch to `new` mode to open a fresh remediation PR.                 |
| `fork-pull-request`                   | The matching pull request originates from a fork.                 | Expected and intentional — triage never targets fork branches. Fix forks manually. |
| `existing-mode-requires-pull-request` | `existing` mode on a push failure with no PR to reuse.            | Use `auto` or `new` mode for push-triggered failures.                              |
| `target-branch-not-found`             | The branch the fix would target no longer exists (or it's a tag). | The branch was deleted or the run targeted a tag; nothing to write to.             |

### `dry-run`

`dry-run-preview`: the action reported what it **would** do with no writes.
**Action:** confirm `resolved-mode`, `target-base-ref`, `target-head-ref`,
`workflow-run-id`, and `workflow-run-attempt` are what you expect, then set
`dry-run: false`.

### `configuration-error`

The action failed closed. Fix the configuration and re-run:

| Reason                  | What happened                                                         | Fix                                                                                             |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `invalid-input`         | An input failed validation (bad boolean, unknown PR mode, etc.).      | Correct the input value; booleans must be `true`/`false`, mode must be `auto`/`existing`/`new`. |
| `agent-auth-failed`     | The `agent-token` was rejected as unauthenticated.                    | Provide a valid Agent Tasks credential.                                                         |
| `agent-forbidden`       | Authenticated but not authorized / missing Agent Tasks permission.    | Grant the credential the Agent Tasks permission and PR-creation scope.                          |
| `agent-unsupported`     | Credential type, plan, or preview API unavailable for Agent Tasks.    | Confirm Agent Tasks (public preview) is enabled for the repo/org and your plan.                 |
| `agent-invalid-request` | The request was rejected, **including an invalid/unavailable model**. | Fix or clear the `model` input; check the request shape if it persists.                         |

### `operational-error`

An unexpected runtime/provider failure. These are typically transient:

| Reason                             | What happened                                          | Action                                                                   |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `agent-rate-limited`               | Agent Tasks rate-limited the request.                  | Re-run later; consider reducing triage frequency.                        |
| `agent-transient`                  | A transient server/network failure.                    | Re-run; if persistent, check GitHub status.                              |
| `agent-unexpected-response`        | The API returned an unexpected shape.                  | Re-run; if persistent, the preview API may have changed — open an issue. |
| `agent-task-reconciliation-failed` | An uncertain create could not be reconciled to a task. | Search Agent Tasks for the run before re-running to avoid a duplicate.   |

## Common situations

- **Triage never runs.** Confirm the triage workflow is on the **default
  branch**, the source workflow's `name:` is listed in
  `on.workflow_run.workflows`, and the source run actually failed. See
  [Pipeline targeting](pipeline-targeting.md).
- **Triage stopped after a rename.** Renaming a source workflow breaks the name
  contract; update `on.workflow_run.workflows`.
- **Copilot's pull request has no CI.** Your repository may require a human to
  **approve CI** for the agent's changes. See
  [Operational behavior](operations.md#a-human-may-need-to-approve-ci).
- **Duplicate tasks under load.** Add or verify the recommended `concurrency`
  group (repository + run id + run attempt). Best-effort idempotency cannot
  guarantee exactly-once without it. See
  [Operational behavior](operations.md#best-effort-idempotency-not-exactly-once).
- **Sensitive content in logs.** The full prompt and untrusted evidence are never
  logged; only a redaction-safe summary is emitted. If you need more diagnostics,
  use the task itself via `task-url`.
