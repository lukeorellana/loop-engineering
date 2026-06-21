# Feature Loop troubleshooting & recovery runbook

This runbook explains how the loop operates day to day and how to recover from
every pause and failure it can report. For the meaning of each outcome and
reason code, see the [Configuration reference](configuration.md#outcomes).

## How the loop runs

### Manual startup

Start (or re-run) the loop for an epic from **Actions → Feature Loop → Run
workflow** (`workflow_dispatch`). Provide the epic issue number. The
`epic-issue` input is required for manual starts and ignored for merged-PR
continuations. Set **dry-run** to `true` to preview without writing.

### Merge-based continuation

After a human merges a sub-issue's pull request, the `pull_request: closed`
trigger fires and the loop continues automatically — completing the merged
sub-issue and starting the next `todo`. The workflow's merged-PR guard ignores
pull requests closed without merging. The epic for a continuation is derived
from the merged pull request's closing sub-issue (its native parent), so you do
not pass `epic-issue`.

The action re-reads the merged pull request through the GitHub API rather than
trusting the webhook payload, and completes a sub-issue only on a trusted formal
closing relationship (see [Security model](security.md#trusted-merged-pr-completion)).

### Strict zero-write dry-run

A dry run (`dry-run: true`) is strictly read-only. It evaluates the epic and
reports what _would_ happen — including the sub-issue it would start — without
creating comments, changing labels, assigning the agent, or updating issues. Use
it to validate setup, configuration changes, and provider availability safely.
The result is reported with `outcome: dry-run`.

### Idempotency and serialization

The controller is idempotent: a re-run that observes already-applied state is
safe. Runs are serialized repository-wide (`concurrency` in the reference
workflow) so concurrent events queue instead of racing. If a run seems stuck
behind another, check for a queued run in the Actions tab.

## Recovery procedures

For each situation: symptom → cause → fix → verify (run a dry run, then resume).

### Missing canonical-state labels

- **Symptom:** `outcome: configuration-error`; the summary lists missing
  canonical-state labels.
- **Cause:** `labels.auto-create` is `false` (default) and one or more canonical
  labels do not exist in the repository.
- **Fix:** Create the missing labels (see the table in the
  [Setup guide](setup.md#4-provision-canonical-state-labels)), or set
  `labels.auto-create: true` in `.github/feature-loop.yml` to let preflight
  create them.
- **Verify:** Dry-run the epic; preflight should pass. Then re-run.

### GitHub Copilot coding agent unavailable

- **Symptom:** `outcome: configuration-error` or `operational-error` referencing
  the coding-agent provider; a dry run reports the provider check failed.
- **Cause:** Copilot is not enabled for the repository/owner, or the coding agent
  is not available.
- **Fix:** Enable GitHub Copilot and the coding agent for the repository (see
  [Setup guide](setup.md#5-enable-and-verify-the-github-copilot-coding-agent)).
- **Verify:** Dry-run the epic; provider preflight should pass.

### Invalid or insufficient credentials

- **Symptom:** `operational-error`, or `needs-human` with reason
  `assignment-failed`, around assignment.
- **Cause:** `agent-token` is missing the scope coding-agent assignment requires,
  or a token is expired/revoked.
- **Fix:** Provide a correctly scoped `agent-token` secret (see
  [Setup guide](setup.md#6-tokens-repository-token-vs-agent-assignment-token)) or
  rotate it (see [Security model](security.md#rotating-the-agent-credential)).
  Confirm workflow `permissions` match the
  [required set](setup.md#3-required-workflow-permissions).
- **Verify:** Dry-run, then re-run to assign.

### Stalled assignment (assigned work that never opens a PR)

- **Symptom:** `outcome: already-running`; the status comment reports how long
  the sub-issue has been active and may note that the agent is no longer
  assigned.
- **Cause:** The agent was assigned but no pull request appeared, or the
  assignment was lost. This version **reports** stalled active work but never
  times out, cancels, or reassigns automatically.
- **Fix:** Investigate the assigned sub-issue. To re-drive it, ensure it is the
  head-of-line issue and re-run the workflow for the epic; the loop is idempotent
  and will re-confirm or re-assign as needed. If the agent should not continue,
  set the sub-issue to a pausing state (for example `needs-human`) and resolve it
  manually.
- **Verify:** Re-run; a healthy run reports `already-running` (agent confirmed)
  or `started`.

### Multiple linked pull requests

- **Symptom:** `outcome: needs-human`, reason `multiple-linked-pull-requests`.
- **Cause:** The active sub-issue has more than one linked pull request. The
  action does not prevent an agent from opening multiple pull requests; it
  detects the inconsistent state and pauses.
- **Fix:** Decide which pull request is authoritative. Close or unlink the
  others so exactly one pull request links to the sub-issue. Have a human merge
  the correct pull request (which must formally close the sub-issue) to complete
  it.
- **Verify:** Re-run (or let the merge continue the loop); the pause should clear.

### Inconsistent / contradictory labels

- **Symptom:** `outcome: needs-human`, reason `invalid` or
  `multiple-canonical-state-labels`.
- **Cause:** An open sub-issue carries more than one canonical-state label, so
  its state is ambiguous and resolves to `invalid` (fail closed).
- **Fix:** Edit the sub-issue's labels so it carries **exactly one**
  canonical-state label that reflects its real state (or none, which means
  `todo`). Do not manage canonical labels by hand during normal operation — let
  the loop drive them.
- **Verify:** Dry-run to confirm the issue resolves to a single state, then
  re-run.

> The loop automatically reconciles **stale** labels on **closed** sub-issues
> (for example a closed issue still carrying an `in-progress` label is normalized to
> `done` or `not-planned`). Contradictory labels on **open** issues require the
> manual repair above.

### Source conflicts (native vs. Markdown)

- **Symptom:** `outcome: configuration-error`; the summary reports the native
  sub-issue list and the Markdown list disagree.
- **Cause:** `issues.source: auto` and both native sub-issues and the configured
  Markdown list are non-empty but differ.
- **Fix:** Make the two sources agree, or pin the source explicitly with
  `issues.source: native` or `issues.source: markdown`.
- **Verify:** Dry-run; preflight should resolve a single ordered list.

### Closed-not-planned sub-issues

- **Symptom:** `outcome: needs-human`, reason `not-planned`.
- **Cause:** The head-of-line sub-issue was closed as **not planned**. Unlike
  `done`, this is not a success, so the loop pauses rather than advancing past
  it — later sub-issues might depend on the skipped work.
- **Fix:** Decide the intended ordering. If the work is genuinely unnecessary,
  reorder the epic so the not-planned issue is no longer at the head of the line
  (or remove it from the ordered list), then resume. If it is still needed,
  reopen it and let the loop drive it.
- **Verify:** Dry-run to confirm the next head-of-line issue, then re-run.

### Merged pull request that does not resolve to a completion

- **Symptom:** `outcome: needs-human` with reason
  `conflicting-closing-references`, `multiple-closing-issues`, `out-of-order`,
  or `ambiguous-completion`; or `outcome: no-op` with reason `not-merged`,
  `wrong-base-branch`, or `no-closing-reference`.
- **Cause:** A merged pull request could not be turned into a single trusted
  completion. Only a formal closing relationship that resolves exactly one
  head-of-line sub-issue on the configured base branch advances the loop.
- **Fix:**
  - `conflicting-closing-references`: make the pull-request closing keyword and
    GitHub's closing references agree.
  - `multiple-closing-issues`: have the pull request formally close exactly one
    sub-issue.
  - `out-of-order`: complete the earlier sub-issue first, or correct the order.
  - `ambiguous-completion`: the issue is closed as not planned but a merge claims
    it — reconcile the issue's state (reopen and complete, or accept the skip per
    the not-planned procedure).
  - `not-merged` / `wrong-base-branch` / `no-closing-reference`: these are no-ops,
    not failures; merge the correct pull request into the configured base branch
    with a closing keyword (for example `Closes #123`) to complete the sub-issue.
- **Verify:** Re-merge or re-run; the loop should complete the sub-issue and
  start the next one.

### Recovering from `needs-human` (general)

`needs-human` is an **expected pause**, not a failure — the step succeeds with
outputs populated. To recover:

1. Read the `reason` output / status comment to identify the specific pause
   (`blocked`, `invalid`, `skipped`, `needs-human`, `not-planned`,
   `multiple-canonical-state-labels`, `multiple-linked-pull-requests`,
   `assignment-failed`, or a completion-resolution reason such as
   `conflicting-closing-references`, `multiple-closing-issues`, `out-of-order`,
   or `ambiguous-completion`).
2. Apply the matching procedure above to resolve the underlying condition.
3. **Manual resume:** re-run the workflow (`workflow_dispatch`) for the epic, or
   let a merge continue the loop. The loop re-evaluates from the head of the line
   and proceeds when the condition is cleared.

### Manual resume after any pause or fix

After resolving any condition, resume by re-running **Feature Loop** for the
epic. Run with `dry-run: true` first to confirm the loop will do what you expect,
then run with `dry-run: false` to apply. Because the loop is idempotent, an extra
re-run that finds nothing to do is harmless (`no-op` or `already-running`).
