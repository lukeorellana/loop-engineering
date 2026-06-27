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

### Automatic pull-request linking

When the coding agent opens (or reopens) a pull request, the `pull_request:
opened` / `reopened` trigger fires and the loop tries to record a formal
`Closes #<issue>` relationship with the active sub-issue, so the later merge can
complete it without a human remembering to link it. The link is applied only
when the pull request was authored by the coding-agent provider, targets the
configured base branch, has no existing closing relationship, and **exactly one**
sub-issue is active (`in-progress`). Otherwise the loop is a no-op or pauses for a
human (see [Security model](security.md#conservative-pull-request-linking)).
Replayed `opened`/`reopened` events are idempotent: an already-linked pull
request is left unchanged.

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

### Ambiguous or empty Markdown ordered-issue discovery

- **Symptom:** `outcome: configuration-error`; the summary cites a reason such as
  `ambiguous-ordered-issue-sections`, `multiple-ordered-issues-markers`, or
  `ordered-issues-marker-empty`.
- **Cause:** The epic body has more than one possible ordered-issue section (or
  more than one marker), or a `<!-- feature-loop:ordered-issues -->` marker is not
  followed by a valid ordered issue list.
- **Fix:** Add a single `<!-- feature-loop:ordered-issues -->` marker immediately
  before the authoritative ordered list. The marker wins over the configured
  heading and any structural candidates, so it resolves ambiguity. Ensure the
  marked list is an ordered list (`1.`, `1)`, …) with one same-repository issue
  reference per item.
- **Verify:** Dry-run; the summary reports discovery came from the marker.

- **Symptom:** `outcome: configuration-error`, reason `initialization-failed`.
- **Cause:** A manual run could not initialize the epic: the authored ordered
  list contains duplicate, missing, cross-repository, or self-referential issue
  references, or a planned issue could not be found in the repository.
- **Fix:** Correct the epic's ordered sub-issues so every reference is a unique,
  existing issue in the same repository and the epic does not list itself.
- **Verify:** Dry-run; the summary reports the proposed plan with zero writes.

### Native sub-issue hierarchy is non-authoritative

- **Symptom:** Native sub-issue links are missing, out of order, reversed, or
  point at a different parent in the GitHub UI.
- **Cause:** Feature Loop no longer manages the native sub-issue hierarchy. The
  authored Markdown ordered list is authoritative, and the frozen execution plan
  derived from it is the sole execution-order source. Native sub-issue links and
  ordering are presentation metadata only.
- **What the loop does:** Initialization validates the authored Markdown list,
  verifies every planned issue exists in the same repository, reads issue state
  directly from the planned issue numbers, normalizes canonical state, and
  persists the frozen plan. It never attaches, reparents, removes, reorders, or
  polls native sub-issues, so native linking and convergence failures can never
  block the loop.
- **Fix:** Edit the epic's Markdown ordered list, then rerun the manual dispatch
  with **force-reinitialize** to adopt and freeze the new order. Reconcile the
  native sub-issue links separately in the GitHub UI if you want them to match;
  they do not affect orchestration.
- **Verify:** Dry-run the manual dispatch; the summary reports the proposed plan
  with zero writes.

- **Symptom:** `outcome: needs-human`, reason `unexpected-active-issue`.
- **Cause:** A first-time initialization found a sub-issue already labeled
  `in-progress`, which the loop will not silently adopt.
- **Fix:** Resolve the in-progress issue (let it complete, or clear the label),
  then rerun. To deliberately recover and re-author the plan, rerun with
  **force-reinitialize**.
- **Verify:** Dry-run, then re-run the manual dispatch.

### Continuation runs follow the frozen plan

- **Symptom:** The native sub-issue order in the GitHub UI differs from the
  order the loop executes on a continuation run.
- **Cause:** A continuation run loads the persisted frozen plan and uses its
  ordered issues directly. It never rereads Markdown and never compares the plan
  against the native sub-issue hierarchy, so a divergent native order cannot
  pause or redirect the loop.
- **Fix:** No action is required for orchestration. To change the execution
  order, edit the epic's Markdown and rerun the manual workflow with
  **force-reinitialize** to refreeze the plan.
- **Verify:** Dry-run the manual dispatch to confirm the intended plan, then
  reinitialize.

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

### Pull request that could not be auto-linked

- **Symptom:** A Copilot pull request was opened but no `Closes #<issue>` line was
  added. The result is `outcome: needs-human` with reason
  `ambiguous-active-issue` or `link-not-verified`; or `outcome: no-op` with
  reason `wrong-author`, `wrong-base-branch`, `already-linked`, or
  `no-active-issue`.
- **Cause:** The loop links a pull request only when it was authored by the
  coding-agent provider, targets the configured base branch, has no existing
  closing relationship, and exactly one sub-issue is active.
- **Fix:**
  - `ambiguous-active-issue`: more than one sub-issue is `in-progress`. Resolve
    the extra active sub-issues so exactly one is active, or manually add the
    correct `Closes #<issue>` line to the pull request.
  - `link-not-verified`: the body was updated but GitHub has not yet reported the
    closing relationship. Confirm the link in the pull request's Development
    sidebar before merging; re-running the workflow re-checks it.
  - `wrong-author`: the pull request was not opened by the coding agent — add the
    closing reference manually if the link is intended.
  - `wrong-base-branch`: re-target the pull request at the configured base branch.
  - `already-linked` / `no-active-issue`: no action needed; the link already
    exists or there is no active sub-issue to link.
- **Verify:** Re-run the workflow (or reopen the pull request); a healthy run
  reports `already-running` with reason `pull-request-linked`, or leaves an
  already-linked pull request unchanged.

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
