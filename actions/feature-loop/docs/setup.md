# Feature Loop setup guide

This guide takes a repository from nothing to a working Feature Loop without
reading the action's source. Follow it in order; each step is verifiable.

Feature Loop advances a feature **epic** through an ordered set of
**sub-issues**, assigning exactly one sub-issue at a time to the GitHub Copilot
coding agent. The loop is human-gated: a human reviews and merges every pull
request before the next sub-issue starts. The action never checks out or
executes pull-request code.

See also:

- [Configuration reference](configuration.md) — every configuration field.
- [Security model](security.md) — trust boundaries and required permissions.
- [Troubleshooting & recovery runbook](troubleshooting.md) — operating procedures.

## 1. Prerequisites

- A GitHub repository where you can add workflows and configuration.
- The **GitHub Copilot coding agent** enabled for the repository (see step 5).
- Permission to create labels, or the ability to let the loop create them (see
  step 4).

## 2. Add the consumer workflow

Copy [`examples/feature-loop.workflow.yml`](../examples/feature-loop.workflow.yml)
into the repository as `.github/workflows/feature-loop.yml`.

The workflow:

- Triggers on `workflow_dispatch` (manual start for a chosen epic) and on
  `pull_request` (`closed`, `opened`, and `reopened`).
- Guards the closed pull-request trigger so it runs **only when the pull request
  was actually merged** (`github.event.pull_request.merged == true`). Pull
  requests closed without merging are ignored. Opened and reopened pull-request
  events always run so a Copilot-created pull request can be linked to the active
  sub-issue before merge.
- Declares minimal permissions (see step 3).
- Serializes controller runs repository-wide (see
  [Serialization](#7-repository-wide-serialization)).

Pin the action to an immutable reference (see
[Pinning the action](security.md#pinning-the-action)).

## 3. Required workflow permissions

The action needs only:

```yaml
permissions:
  contents: read # read .github/feature-loop.yml from the default branch
  issues: write # labels, status comments, agent assignment, closing sub-issues
  pull-requests: write # inspect pull requests and record the Closes #<issue> link
```

These are already declared in the reference workflow. `pull-requests: write` is
required so the action can append a `Closes #<issue>` line to a Copilot-created
pull request that has no formal closing relationship yet. Do not grant
`contents: write`; the loop never writes repository contents and never merges
pull requests.

## 4. Provision canonical-state labels

Feature Loop tracks each sub-issue with exactly one **canonical-state** label.
The eight canonical states and their default label names are:

| State         | Default label              |
| ------------- | -------------------------- |
| `todo`        | `feature-loop:todo`        |
| `in-progress` | `feature-loop:in-progress` |
| `blocked`     | `feature-loop:blocked`     |
| `needs-human` | `feature-loop:needs-human` |
| `skipped`     | `feature-loop:skipped`     |
| `invalid`     | `feature-loop:invalid`     |
| `done`        | `feature-loop:done`        |
| `not-planned` | `feature-loop:not-planned` |

Provide these labels in one of two ways:

- **Pre-create them** in the repository (default, `labels.auto-create: false`).
  Missing labels are reported and the loop fails closed until they exist.
- **Let the loop create them** by setting `labels.auto-create: true` in
  `.github/feature-loop.yml`. Preflight then creates any missing canonical-state
  labels on the first run.

You may rename any label; the eight canonical states must map to eight distinct
names so that exactly one canonical-state label can exist on an issue at a time.
See [`examples/feature-loop.custom-labels.yml`](../examples/feature-loop.custom-labels.yml).

## 5. Enable and verify the GitHub Copilot coding agent

1. Ensure GitHub Copilot is available for the repository's owner and that the
   **coding agent** is enabled for the repository.
2. Verify by running a **dry run** (step 8). Preflight performs a
   provider-specific check; if Copilot is unavailable, the dry run reports it
   without making any changes.

Coding-agent assignment may require a credential with broader scope than the
default `GITHUB_TOKEN`. See step 6.

### Install the agent instructions and self-review skill

Feature Loop assigns the issue itself as the coding task. Install repository
instructions that define how the agent must complete that task:

1. Copy [`examples/copilot-instructions.md`](../examples/copilot-instructions.md)
   to `.github/copilot-instructions.md`, or merge its Feature Loop sections into
   an existing file.
2. Copy
   [`examples/skills/self-review/SKILL.md`](../examples/skills/self-review/SKILL.md)
   to `.github/skills/self-review/SKILL.md`.
3. Fill in the project-specific build, test, lint, formatting, and coding
   conventions in the instruction file.
4. Use the provided sub-issue template so each issue repeats the self-review
   completion contract in the task itself.

Before handing a pull request to a human, the agent is instructed to review the
complete diff against the issue, actively search for correctness and regression
risks, fix valid findings, rerun affected validation, and document evidence in
the pull-request summary.

This is intentionally an instruction-based quality gate. The Feature Loop action
does not execute a second review agent, post automatic repair comments, or infer
that self-review occurred. A human still reviews and merges the pull request.

## 6. Tokens: repository token vs. agent-assignment token

Feature Loop uses two logical credentials:

- **`github-token`** (defaults to the workflow `GITHUB_TOKEN`): repository reads
  and writes — reading configuration, managing labels, posting status comments,
  and closing completed sub-issues. The workflow `GITHUB_TOKEN` with the
  permissions in step 3 is sufficient for these operations.
- **`agent-token`** (defaults to `github-token` when empty): assigning the
  GitHub Copilot coding agent. Coding-agent assignment can require permissions
  beyond `GITHUB_TOKEN`. When it does, create a separate credential, store it as
  a repository secret (the reference workflow uses
  `secrets.FEATURE_LOOP_AGENT_TOKEN`), and the action uses it only for
  assignment. When the secret is empty, the action falls back to `github-token`.

Both tokens are registered as secrets so they are masked in logs and never
printed.

## 7. Add the configuration file (optional)

Every configuration key is optional and resolves to a secure default, so a
repository with **no** configuration file still runs with documented defaults.
To customize behavior, copy [`examples/feature-loop.yml`](../examples/feature-loop.yml)
to `.github/feature-loop.yml` and edit it. Configuration is always read from the
repository **default branch** — never from a pull-request ref. See the
[Configuration reference](configuration.md).

## 8. Create an epic and its sub-issues

1. Create an epic issue. Copy
   [`examples/ISSUE_TEMPLATE/feature-epic.md`](../examples/ISSUE_TEMPLATE/feature-epic.md)
   into `.github/ISSUE_TEMPLATE/` to provide a form for it.
2. Add ordered sub-issues using one of the supported sources:
   - **Native sub-issues** — add real GitHub sub-issues to the epic.
   - **Markdown** — list them under the heading configured by
     `issues.markdown.heading` (default `Ordered sub-issues`).
   - With `issues.source: auto` (default), native sub-issues are used when
     present; otherwise the Markdown list is used. If both are non-empty and
     disagree, preflight fails closed.
3. Use
   [`examples/ISSUE_TEMPLATE/feature-sub-issue.md`](../examples/ISSUE_TEMPLATE/feature-sub-issue.md)
   for sub-issues so each starts in the `todo` state.

## 9. Dry run first

Before letting the loop write anything, run it in **dry-run** mode:

1. Open **Actions → Feature Loop → Run workflow**.
2. Enter the epic issue number and set **dry-run** to `true`.

A dry run is strictly zero-write: it evaluates the epic and reports what _would_
happen (including the sub-issue it would start) without creating comments,
changing labels, assigning the agent, or updating issues. The result is written
to the job summary with `outcome: dry-run`.

## 10. Start the loop

Run the workflow again with **dry-run** `false` (or leave it unset). The first
manual run **initializes** the epic: it resolves the intended ordered sub-issue
list, repairs native parent/sub-issue relationships, reorders native sub-issues
to match the authored order, normalizes canonical state labels, verifies the
resulting hierarchy, and persists a **frozen execution plan** on the epic. Only
after verification succeeds does it start the first eligible sub-issue by
assigning it to the coding agent and labeling it `in-progress`.

Initialization is idempotent: rerunning the workflow on an already-initialized
epic reuses the stored plan and does not rewrite it. To intentionally re-author
the plan after changing the epic's ordered sub-issues, run the workflow with
**force-reinitialize** set to `true`.

When the coding agent opens its pull request, the `pull_request: opened` trigger
records a formal `Closes #<issue>` relationship with the active sub-issue (when
one is unambiguous) so the merge can complete it. After a human merges the
sub-issue's pull request, the `pull_request: closed` trigger continues the loop
automatically: it loads the frozen plan, completes the merged sub-issue, and
starts the next planned issue. A continuation run never re-resolves competing
issue sources or rewrites the plan. If the native sub-issue hierarchy has
drifted away from the frozen plan, the loop pauses with `needs-human` and a
`plan-drift` reason instead of starting a potentially incorrect issue; resolve
the drift or rerun manually with **force-reinitialize**.

## 11. Verify a healthy run

Check the job summary (also written to `GITHUB_STEP_SUMMARY`). On a normal start
you should see:

- `outcome: started` with the started sub-issue as the active issue, or
- `outcome: already-running` if the head-of-line issue is already assigned, or
- `outcome: complete` when every sub-issue is `done`.

Expected pauses (`needs-human`) and `no-op` outcomes complete **successfully**;
only invalid configuration and unrecoverable operational errors fail the step.
For what each outcome and reason code means and how to respond, see the
[Troubleshooting & recovery runbook](troubleshooting.md).
