# Feature Loop configuration reference

This reference documents every action input, output, configuration field,
outcome, and reason code. It matches the bundled action interface
([`action.yml`](../action.yml)) and the configuration schema.

## Action inputs

| Input          | Required | Default                    | Description                                                                                                   |
| -------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `github-token` | yes      | `${{ github.token }}`      | Token for repository reads and writes (configuration, labels, status comments, closing sub-issues).           |
| `agent-token`  | no       | `github-token`             | Token used to assign the GitHub Copilot coding agent. Empty falls back to `github-token`.                     |
| `epic-issue`   | no       | —                          | Epic issue number for a manual start. Required for `workflow_dispatch`; ignored for a merged-PR continuation. |
| `dry-run`      | no       | `false`                    | When `true`, evaluate only and perform no writes.                                                             |
| `config-path`  | no       | `.github/feature-loop.yml` | Configuration file path on the default branch.                                                                |

Inputs are validated and fail closed. Credentials are registered as secrets so
they are masked in logs and never printed.

## Action outputs

Every normal exit path sets all five outputs. Numeric outputs are empty when
they do not apply.

| Output            | Description                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `outcome`         | The coarse-grained result (see [Outcomes](#outcomes)).                                              |
| `epic-issue`      | The epic issue number the loop acted on, when resolved.                                             |
| `active-issue`    | The sub-issue the loop is driving (started, running, or paused), when one applies.                  |
| `completed-issue` | The sub-issue completed from a trusted merged pull request during this run, when one was completed. |
| `reason`          | A stable, machine-readable reason code for the outcome (see [Reason codes](#reason-codes)).         |

A Markdown summary of the result (including dry-run previews) is written to
`GITHUB_STEP_SUMMARY`.

## Outcomes

| Outcome               | Step result | Meaning                                                                         |
| --------------------- | ----------- | ------------------------------------------------------------------------------- |
| `started`             | success     | A new sub-issue was started (assigned to the agent).                            |
| `already-running`     | success     | The head-of-line sub-issue is already active; no new start.                     |
| `complete`            | success     | Every sub-issue is `done`.                                                      |
| `needs-human`         | success     | Head-of-line work requires human attention; the epic is paused.                 |
| `dry-run`             | success     | Evaluation only; no mutations were performed.                                   |
| `no-op`               | success     | Nothing to do (for example, the event does not apply).                          |
| `configuration-error` | failure     | Configuration was missing a required value, invalid, or an unsupported version. |
| `operational-error`   | failure     | An unexpected runtime or provider failure occurred.                             |

Expected pauses (`needs-human`) and `no-op` outcomes complete the step
**successfully** so the workflow does not fail when the repository simply needs a
human or the event does not apply. Only `configuration-error` and
`operational-error` fail the step.

## Reason codes

The `reason` output carries a stable, machine-readable code. Codes fall into
these categories.

### Outcome-named reasons

`started`, `already-running`, `complete`, `dry-run`, `configuration-error`, and
`operational-error` use their outcome name as the reason.

### Pause reasons (`outcome: needs-human`)

| Reason                            | Meaning                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `blocked`                         | Head-of-line sub-issue is `blocked`.                                                                                                     |
| `invalid`                         | Head-of-line sub-issue resolved to `invalid` (ambiguous or inconsistent state).                                                          |
| `skipped`                         | Head-of-line sub-issue is `skipped`; the skip must be acknowledged before later work runs.                                               |
| `needs-human`                     | Head-of-line sub-issue is explicitly `needs-human`.                                                                                      |
| `not-planned`                     | Head-of-line sub-issue is closed as `not-planned`; ordering needs human resolution.                                                      |
| `multiple-canonical-state-labels` | The sub-issue carries more than one canonical-state label (a refinement of `invalid`).                                                   |
| `multiple-linked-pull-requests`   | The sub-issue has more than one linked pull request; the ambiguity needs a human.                                                        |
| `assignment-failed`               | The coding agent could not be assigned (or confirmed assigned); a human can resume the loop.                                             |
| `ambiguous-active-issue`          | More than one sub-issue is active (`in-progress`) when linking an opened pull request; the action cannot infer which issue it completes. |
| `link-not-verified`               | The opened pull request body was updated, but GitHub has not yet reported the closing relationship; confirm the link before merging.     |

When a merged pull request cannot be resolved to a single trusted completion,
the loop pauses (`needs-human`) with one of these completion-resolution reasons:

| Reason                           | Meaning                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `conflicting-closing-references` | The closing keyword and GitHub closing references disagree.                             |
| `multiple-closing-issues`        | The pull request formally closes more than one issue; exactly one is required.          |
| `out-of-order`                   | The closed issue is not the head-of-line issue; an earlier sub-issue is not yet `done`. |
| `ambiguous-completion`           | A merged pull request claims an issue that GitHub records as closed-not-planned.        |

### No-op reasons (`outcome: no-op`)

| Reason                 | Meaning                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `event-not-applicable` | The triggering event does not apply to the loop.                                                          |
| `epic-not-open`        | The epic issue is closed.                                                                                 |
| `epic-empty`           | The epic has no ordered sub-issues.                                                                       |
| `foreign-parent`       | A completion event belongs to a different parent epic.                                                    |
| `not-merged`           | A `pull_request: closed` event closed without merging.                                                    |
| `wrong-base-branch`    | The merge did not target the configured base branch.                                                      |
| `no-closing-reference` | The merged pull request has no formal closing relationship to a sub-issue.                                |
| `wrong-author`         | An opened pull request was not authored by the coding-agent provider, so it is not linked.                |
| `already-linked`       | An opened pull request already has a formal closing relationship; the link is left unchanged.             |
| `no-active-issue`      | No sub-issue is active (`in-progress`) when an agent pull request is opened, so there is nothing to link. |

### Pull-request link reasons

When the coding agent opens (or reopens) a pull request, the loop may record a
`Closes #<issue>` relationship with the active sub-issue:

| Reason                | Outcome           | Meaning                                                                                          |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `pull-request-linked` | `already-running` | The opened pull request was linked to the active sub-issue and GitHub verified the relationship. |
| `pull-request-link`   | `dry-run`         | Dry-run preview of the link that would be recorded; no write is performed.                       |

## Configuration file (`.github/feature-loop.yml`)

Configuration is read from the repository **default branch**. Every key is
optional and resolves to a documented, secure default; a repository with no
configuration file uses these defaults. When a file is present, `version` is
required and an unsupported version fails closed.

See [`examples/feature-loop.yml`](../examples/feature-loop.yml) for an annotated
example.

### `version`

The configuration schema version. The only supported value is `1`. Any other
value fails closed with a configuration error.

### `issues`

| Field                     | Type   | Default              | Description                                                                              |
| ------------------------- | ------ | -------------------- | ---------------------------------------------------------------------------------------- |
| `issues.source`           | enum   | `auto`               | `native`, `markdown`, or `auto` (see below).                                             |
| `issues.markdown.heading` | string | `Ordered sub-issues` | Heading whose list contains the ordered sub-issues, used in `markdown` and `auto` modes. |

Sub-issue **sources**:

- `native`: use only native GitHub sub-issues.
- `markdown`: use only the configured Markdown section of the epic body.
- `auto`: use native sub-issues when non-empty; otherwise use Markdown. **If
  both are non-empty and differ, preflight fails closed** so a human resolves
  the conflict. (Identical native and Markdown lists are treated as agreeing.)

### `agent`

| Field            | Type           | Default          | Description                                                                                |
| ---------------- | -------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `agent.provider` | string         | `github-copilot` | Coding-agent provider identifier.                                                          |
| `agent.model`    | string \| null | `null`           | `null` selects a model automatically (secure default). Set a name to pin a specific model. |

### `base`

| Field         | Type           | Default | Description                                                                                |
| ------------- | -------------- | ------- | ------------------------------------------------------------------------------------------ |
| `base.branch` | string \| null | `null`  | `null` uses the repository default branch. Set a branch name to override. Never hardcoded. |

### `merge`

| Field                | Type    | Default | Description                                                       |
| -------------------- | ------- | ------- | ----------------------------------------------------------------- |
| `merge.requireHuman` | boolean | `true`  | A human merge is always required; this cannot be disabled.        |
| `merge.autoMerge`    | boolean | `false` | Automatic merge is never supported. The action never auto-merges. |

### `concurrency`

| Field                             | Type   | Default | Description                            |
| --------------------------------- | ------ | ------- | -------------------------------------- |
| `concurrency.activeIssuesPerEpic` | number | `1`     | Exactly one active sub-issue per epic. |

### `labels`

Canonical-state labels project the eight internal canonical states onto
repository label names. Each label may be customized, but the eight canonical
states must map to **eight distinct** label names so that exactly one
canonical-state label can exist on an issue at a time.

| Field                | Type    | Default                    | Description                                                                                                                             |
| -------------------- | ------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `labels.auto-create` | boolean | `false`                    | When `true`, preflight creates any missing canonical-state labels; when `false`, missing labels are reported and the loop fails closed. |
| `labels.todo`        | string  | `feature-loop:todo`        | Label for the `todo` state.                                                                                                             |
| `labels.in-progress` | string  | `feature-loop:in-progress` | Label for the `in-progress` (active) state.                                                                                             |
| `labels.blocked`     | string  | `feature-loop:blocked`     | Label for the `blocked` state.                                                                                                          |
| `labels.needs-human` | string  | `feature-loop:needs-human` | Label for the `needs-human` state.                                                                                                      |
| `labels.skipped`     | string  | `feature-loop:skipped`     | Label for the `skipped` state.                                                                                                          |
| `labels.invalid`     | string  | `feature-loop:invalid`     | Label for the `invalid` state.                                                                                                          |
| `labels.done`        | string  | `feature-loop:done`        | Label for the `done` state.                                                                                                             |
| `labels.not-planned` | string  | `feature-loop:not-planned` | Label for the `not-planned` state.                                                                                                      |

## Canonical states

Each sub-issue resolves to exactly one canonical state:

| State         | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `todo`        | Not yet started; eligible to become the active issue.                                                |
| `in-progress` | Currently assigned to the coding agent (the active issue).                                           |
| `blocked`     | Head-of-line work that cannot proceed; pauses the epic.                                              |
| `needs-human` | Requires human attention; pauses the epic.                                                           |
| `skipped`     | Explicitly skipped by a human; pauses the epic so the skip is acknowledged.                          |
| `invalid`     | Ambiguous or inconsistent state; fails closed and pauses the epic.                                   |
| `done`        | Successfully completed (issue closed as completed). The only state that advances the loop.           |
| `not-planned` | Closed as not planned; head-of-line `not-planned` work pauses the epic until a human resolves order. |

Closed issues resolve from their close reason: `not-planned` maps to
`not-planned`; any other close reason maps to `done`. Open issues resolve from
the canonical-state labels present: none → `todo`, exactly one → that label's
state, more than one → `invalid` (fail closed).
