# CI Triage pipeline targeting

This document defines **which** workflows trigger CI Triage and **where** that
decision lives. The single most important rule: workflow targeting belongs in the
**consumer** triage workflow, not in the reusable action.

## The action cannot change what triggers GitHub

GitHub decides which workflows run **before** any job starts, from the `on:`
triggers committed to the repository's **default branch**. The CI Triage action
runs only after GitHub has already started the triage job. Therefore:

- The reusable action **cannot** dynamically change which source workflows
  trigger triage. That is fixed by your triage workflow's `on.workflow_run`
  configuration.
- The action receives one already-selected failed `workflow_run` event and
  resolves a delivery target from it. It is a consumer responsibility to ensure
  the workflow only triggers for the runs you actually want triaged.

## Selecting source workflows by name

`workflow_run` selects source workflows by their **name**, listed in
`on.workflow_run.workflows`:

```yaml
on:
  workflow_run:
    workflows: ['CI'] # the source workflow's `name:`, not its file path
    types: [completed]
```

Consequences of the name contract:

- The names in `on.workflow_run.workflows` must match the `name:` field of each
  source workflow exactly.
- **Renaming a source workflow breaks the contract.** If you rename the source
  workflow's `name:`, you must update the triage workflow's
  `on.workflow_run.workflows` list to match, or triage silently stops firing for
  that workflow.
- Watch multiple source workflows by listing multiple names:
  `workflows: ['CI', 'Infra']`.

## Job-level `if`: event, branch, and other conditions

`on.workflow_run.workflows` selects **which named workflows** can start the
triage workflow. Everything else — the source run's **conclusion**, its
**triggering event**, its **branch**, and any other condition — belongs in the
job-level `if` expression:

```yaml
jobs:
  triage:
    # Only triage genuine failures of a pull-request-triggered source run.
    if: >-
      ${{ github.event.workflow_run.conclusion == 'failure'
          && github.event.workflow_run.event == 'pull_request' }}
```

Useful fields on `github.event.workflow_run`:

- `conclusion` — gate on `'failure'` so successful or cancelled runs are skipped
  before the action even starts.
- `event` — the source run's triggering event (`'pull_request'`, `'push'`, …).
- `head_branch` — the source run's branch (for example gate `infra` triage to
  `main` with `github.event.workflow_run.head_branch == 'main'`).
- `name` — the source workflow's name, useful when one triage workflow watches
  several source workflows and you want per-workflow conditions.

See [`examples/ci-and-infra-targeting.yml`](../examples/ci-and-infra-targeting.yml)
for one triage workflow that watches two source workflows with different
job-level conditions.

> The action **also** fails closed on conditions you don't pre-filter (a
> non-failure run resolves to `ignored` / `workflow-run-not-failed`, a non-PR/non-push
> event to `unsupported-triggering-event`, and so on). Pre-filtering in the
> consumer `if` simply avoids starting the job at all.

## The triage workflow must exist on the default branch

`workflow_run` triggers only fire for triage workflows present on the
repository's **default branch**. A triage workflow added only on a feature branch
will never be invoked. Merge the triage workflow to the default branch before
expecting it to react to failures — and validate it there.

## Targeting ownership summary

| Decision                                                    | Owned by                                                |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| Which named source workflows can start triage               | Consumer `on.workflow_run.workflows`                    |
| Source-run conclusion / event / branch / other conditions   | Consumer job-level `if` expression                      |
| Whether the triage workflow exists where GitHub can fire it | Consumer (must be on the **default branch**)            |
| The source-workflow name contract (and renames)             | Consumer (`on.workflow_run.workflows` must match names) |
| Resolving the failed run into a delivery target             | The CI Triage action                                    |
| Fail-closed safety on forks, ambiguity, stale runs, etc.    | The CI Triage action                                    |
