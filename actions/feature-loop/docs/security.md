# Feature Loop security model

This document describes Feature Loop's trust boundaries, the guarantees it does
and does not make, and the operational practices that keep an adoption safe.

## Design principles

- **Fail closed.** Ambiguous, inconsistent, or unverifiable state pauses the
  epic for a human rather than guessing.
- **Least privilege.** The action requests the minimum permissions it needs and
  never writes repository contents or merges pull requests.
- **Untrusted pull-request code is never executed.** The action does not check
  out, build, or run pull-request code.

## Trust boundaries

### Configuration is read only from the default branch

Configuration is always loaded from the repository **default branch**, never
from a pull-request ref or a contributor's branch. A pull request cannot change
the loop's behavior by editing `.github/feature-loop.yml` in its own head ref.
**Do not** add a workflow step that checks out a pull request and reads
configuration from it.

### Pull-request code is never executed

The reference workflow deliberately has no `actions/checkout` step. The action
inspects pull-request _metadata_ (merge status, base branch, closing references)
through the GitHub API; it never executes, builds, or sources pull-request
contents. This is why the loop is safe to run on `pull_request: closed` events.

### Trusted merged-PR completion

A merged pull request completes a sub-issue only when **all** of these hold:

- The event is `pull_request: closed` and the pull request was actually merged.
- The merge targeted the configured base branch.
- GitHub reports a **formal closing relationship** — a closing keyword (for
  example `Closes owner/repo#123`, scoped to this repository) or GitHub's
  `closingIssuesReferences`. When both are present they must agree, or the loop
  fails closed (`ambiguous-completion`).
- Exactly one issue is resolved, it is the active head-of-line issue, and it
  belongs to the same repository and parent epic.

Generic issue-timeline cross-references and mentions are **never** treated as
proof of completion. Only formal closing relationships are trusted because they
are the unambiguous, author-asserted statement that the pull request resolves
the issue; weaker signals can be created accidentally or by third parties and
would let unrelated activity advance the loop.

### Blocked head-of-line work is never skipped

The loop examines sub-issues in order and skips only successfully completed
(`done`) work. The first issue that is not `done` controls the result. Blocked,
invalid, skipped, closed-not-planned, or needs-human work at the head of the
line **pauses the epic** instead of being bypassed. Skipping head-of-line work
could run later sub-issues that depend on an unfinished predecessor, so the loop
always stops for a human instead.

### The action never auto-merges or executes PR code

`merge.autoMerge` is always `false` and `merge.requireHuman` is always `true`; a
human reviews and merges every pull request. The action never merges a pull
request and never runs its code. This keeps a human in control of what reaches
the base branch and prevents agent-authored code from executing with the
workflow's privileges.

## Permissions

Grant only:

```yaml
permissions:
  contents: read # read .github/feature-loop.yml from the default branch
  issues: write # labels, status comments, agent assignment, closing sub-issues
  pull-requests: read # inspect merged and linked pull requests
```

Do not grant `contents: write` or `pull-requests: write`. The loop never writes
repository contents and never merges pull requests.

## Credentials

Feature Loop uses two logical credentials, each with a distinct responsibility:

- **`github-token`** — repository reads and writes (configuration, labels,
  status comments, closing completed sub-issues). The workflow `GITHUB_TOKEN`
  with the permissions above is sufficient.
- **`agent-token`** — assigning the GitHub Copilot coding agent. Coding-agent
  assignment may require a credential with broader scope than `GITHUB_TOKEN`.
  When it does, supply a dedicated credential; when `agent-token` is empty the
  action falls back to `github-token`.

Both tokens are registered as secrets, masked in logs, and never printed.

### Rotating the agent credential

When `agent-token` is backed by a dedicated secret:

1. Create the replacement credential with the same scope.
2. Update the repository (or organization) secret used by the workflow (for
   example `FEATURE_LOOP_AGENT_TOKEN`) with the new value.
3. Revoke the old credential.
4. Run the workflow in dry-run mode to confirm provider preflight still passes.

Because the secret is read fresh on each run, no redeploy is required — the next
run uses the rotated value.

## Pinning the action

Pin the action to an **immutable** reference so a moved tag cannot change the
code your workflow runs:

- **By release tag** (convenient, mutable unless you trust the publisher):

  ```yaml
  uses: lukeorellana/loop-engineering/actions/feature-loop@v1
  ```

- **By immutable commit SHA** (strongest):

  ```yaml
  uses: lukeorellana/loop-engineering/actions/feature-loop@<full-40-char-sha>
  ```

Prefer the commit SHA for supply-chain integrity; use a release tag when you
accept the publisher's release process and want automatic patch updates.

## Repository-wide controller serialization

Run the controller **serially per repository** so concurrent events queue
instead of racing. The reference workflow uses:

```yaml
concurrency:
  group: feature-loop-${{ github.repository }}
  cancel-in-progress: false
```

`cancel-in-progress: false` **queues** runs and never cancels a running
controller, equivalent to a `queue: max` contract. The action is idempotent, so
a queued run that observes already-applied state is safe. Serialization prevents
two simultaneous events (for example a manual dispatch racing a merge) from both
trying to start work.

## Hidden status comments and reconciliation

Each per-epic status comment the loop posts carries a hidden marker (so the
comment is updated in place rather than duplicated) and an embedded,
machine-readable JSON payload (epic, active issue, provider, canonical state,
reason, and start timestamp). The payload lives inside an HTML comment, so it is
invisible in rendered Markdown but recoverable on the next run — for example to
report the age of stalled active work. The human-readable text is sanitized;
raw provider errors and transport details never reach a comment. This is a
reconciliation aid, not a security boundary: canonical state is always
re-derived from issue labels and GitHub state, not trusted blindly from a
comment.

## Guarantees this version does NOT make

Be precise about scope:

- **No protected-path enforcement.** This version does **not** enforce protected
  paths or otherwise restrict which files an agent's pull request may change.
  Enforce path or content restrictions with your own branch protection, required
  reviews, and CODEOWNERS.
- **It does not prevent multiple pull requests.** The action does **not** stop an
  agent from opening more than one pull request for a sub-issue. Instead,
  inconsistent multiple-linked-pull-request state is **detected** and the epic is
  **paused** (`multiple-linked-pull-requests`) so a human resolves the ambiguity
  before the loop continues.

Relying on guarantees the action does not provide would create a false sense of
safety; use GitHub's native repository controls for those concerns.
