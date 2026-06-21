# LingoQuest migration guide

This guide migrates the LingoQuest repository from its existing custom
agent-orchestration setup (a repository-local controller, its tests, skill
files, and `agent:*` labels) to the bundled **Feature Loop** action. It is a
**reversible** rollout: nothing is deleted until Feature Loop has been verified,
and every step can be rolled back.

> Scope: this guide does not modify the LingoQuest repository for you and does
> not publish a Feature Loop release. It is the plan a maintainer follows.

Read the [Setup guide](setup.md), [Configuration reference](configuration.md),
and [Security model](security.md) first; this guide assumes that vocabulary.

## Overview

You will:

1. Add Feature Loop configuration alongside the existing setup.
2. Add the Feature Loop workflow **disabled/parallel** and dry-run it.
3. Map existing `agent:*` labels to canonical-state labels.
4. Cut over by replacing the old workflow.
5. Retire the now-unused controller, tests, and skill files (or retain them).
6. Keep a documented rollback at each step.

Do everything on a branch and merge to the default branch only when dry runs
pass — remember Feature Loop reads configuration from the **default branch**.

## 1. Configuration to add

Add `.github/feature-loop.yml` on the default branch. Start from
[`examples/feature-loop.yml`](../examples/feature-loop.yml). For LingoQuest,
set the fields that differ from the secure defaults:

```yaml
version: 1

issues:
  # Choose the source that matches how LingoQuest already lists ordered work.
  # Use `native` if the epic uses GitHub sub-issues; `markdown` if the epic body
  # lists them under a heading; `auto` to prefer native and fall back to Markdown.
  source: auto
  markdown:
    heading: Ordered sub-issues # match LingoQuest's existing epic heading

agent:
  provider: github-copilot
  model: null # pin a model name only if LingoQuest requires a specific one

base:
  branch: null # null = default branch; set if LingoQuest targets another branch

# Map the existing agent:* labels here (see section 3). Keep auto-create false
# until you have decided whether Feature Loop should manage labels.
labels:
  auto-create: false
  todo: 'agent:todo'
  in-progress: 'agent:in-progress'
  blocked: 'agent:blocked'
  needs-human: 'agent:needs-human'
  skipped: 'agent:skipped'
  invalid: 'agent:invalid'
  done: 'agent:done'
  not-planned: 'agent:not-planned'
```

Adjust each value to LingoQuest's real configuration. Every key is optional and
falls back to the documented default; only set what LingoQuest needs.

**Rollback:** delete `.github/feature-loop.yml`. With the file absent, the
action would use defaults — but since you have not enabled its workflow yet, the
old setup is unaffected.

## 2. Workflow to replace

LingoQuest currently runs its custom controller from a workflow (for example
`.github/workflows/agent-loop.yml`). **Do not delete it yet.** Instead:

1. Add the Feature Loop workflow from
   [`examples/feature-loop.workflow.yml`](../examples/feature-loop.workflow.yml)
   as a **new** file, for example `.github/workflows/feature-loop.yml`.
2. Give it `workflow_dispatch` only at first (comment out the
   `pull_request: closed` trigger) so it cannot react to merges during
   validation.
3. Configure the `agent-token` secret if coding-agent assignment needs broader
   scope than `GITHUB_TOKEN` (see
   [Setup guide](setup.md#6-tokens-repository-token-vs-agent-assignment-token)).

At cutover you will remove the `pull_request` trigger from the **old** workflow
and enable it on the Feature Loop workflow, so only one controller reacts to
merges at a time.

**Rollback:** delete the new workflow file; the old workflow keeps running.

## 3. Label mapping from existing `agent:*` labels

Feature Loop needs the eight canonical states mapped to eight **distinct** label
names. Map LingoQuest's existing `agent:*` labels directly so historical issues
keep their labels. A typical mapping:

| Canonical state | Feature Loop config key | Existing LingoQuest label (example) |
| --------------- | ----------------------- | ----------------------------------- |
| `todo`          | `labels.todo`           | `agent:todo`                        |
| `in-progress`   | `labels.in-progress`    | `agent:in-progress`                 |
| `blocked`       | `labels.blocked`        | `agent:blocked`                     |
| `needs-human`   | `labels.needs-human`    | `agent:needs-human`                 |
| `skipped`       | `labels.skipped`        | `agent:skipped`                     |
| `invalid`       | `labels.invalid`        | `agent:invalid`                     |
| `done`          | `labels.done`           | `agent:done`                        |
| `not-planned`   | `labels.not-planned`    | `agent:not-planned`                 |

Mapping rules:

- Map to the **actual** label names LingoQuest uses; the table is illustrative.
- If LingoQuest lacks a label for some canonical state, either create it or set
  `labels.auto-create: true` so preflight creates the missing ones.
- Every open issue must carry **at most one** canonical-state label after the
  mapping, or it resolves to `invalid`. Audit issues that carry two mapped
  labels and reduce each to one before cutover.
- If LingoQuest used labels that do not correspond to a canonical state (for
  example `agent:reviewing`), decide which canonical state they map to or remove
  them from in-flight issues.

**Rollback:** the mapping lives only in `.github/feature-loop.yml`; reverting the
file reverts the mapping. No labels are renamed by adding the mapping.

## 4. Safe dry-run sequence

Validate before any writes:

1. On your migration branch, set the Feature Loop workflow's default branch as
   the place configuration is read from — i.e. merge `.github/feature-loop.yml`
   to the default branch (the config file is harmless without an enabled
   reacting workflow), or temporarily point `config-path` at the file under test.
2. Run **Feature Loop** via `workflow_dispatch` with **dry-run: `true`** for a
   representative epic.
3. Confirm the dry-run summary:
   - Preflight passes (configuration parses, labels resolve, base branch and
     sub-issue source are valid, provider check passes).
   - The `would start` sub-issue matches what the old controller would pick.
   - No comments, labels, assignments, or issue updates were made (dry run is
     strictly zero-write).
4. Repeat for an epic in each interesting state (running, paused, complete) and
   for a not-planned / blocked head-of-line case to confirm the expected
   `needs-human` pauses.

Only proceed to cutover when every dry run behaves as expected.

## 5. Cutover

1. Disable the **old** controller's reactive triggers: remove its
   `pull_request`/merge trigger (or disable the old workflow entirely).
2. Enable the Feature Loop workflow's `pull_request: closed` trigger (uncomment
   it) and keep `workflow_dispatch`.
3. Do a final **dry run**, then run Feature Loop for real (`dry-run: false`) for
   an active epic.
4. Merge a sub-issue's pull request and confirm the loop continues
   automatically (merge-based continuation).

At this point exactly one controller (Feature Loop) reacts to merges.

## 6. Existing controller, tests, and skill files: retire or retain

After Feature Loop has driven at least one full sub-issue cycle in production:

| Asset                                   | Recommendation      | Notes                                                                                                                                                                                                                                                    |
| --------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old controller code/scripts             | **Retire**          | Feature Loop replaces the orchestration logic. Remove once cutover is stable.                                                                                                                                                                            |
| Old controller's unit/integration tests | **Retire**          | They test the retired controller. Remove with the controller to avoid confusing CI signal.                                                                                                                                                               |
| Old reactive workflow                   | **Retire**          | Replaced by `.github/workflows/feature-loop.yml`. Delete after cutover is confirmed.                                                                                                                                                                     |
| Agent **skill** files                   | **Retain (review)** | If they encode repository-specific guidance for the coding agent, fold them into the [agent instruction template](../examples/copilot-instructions.md) (`.github/copilot-instructions.md`). Retire only the parts that merely re-implement loop control. |
| `agent:*` labels                        | **Retain**          | They are now Feature Loop's canonical-state labels via the mapping. Do not delete them.                                                                                                                                                                  |
| Epic / sub-issue issue templates        | **Retain (align)**  | Keep, but align headings and starting labels with the [Feature Loop templates](../examples/ISSUE_TEMPLATE).                                                                                                                                              |

Retire assets only after you are confident the rollback below is no longer
needed. Retiring is itself reversible via version control.

## 7. Rollback plan

Each step is independently reversible:

1. **Before cutover:** delete the new Feature Loop workflow and (optionally)
   `.github/feature-loop.yml`. The old controller is untouched and keeps running.
2. **At cutover:** if Feature Loop misbehaves, re-enable the old workflow's
   reactive trigger and disable the Feature Loop workflow's `pull_request`
   trigger. Because no controller code was deleted yet, this is an immediate
   revert.
3. **After retiring old assets:** restore them from version control (revert the
   removal commit), then perform step 2 to switch the reactive controller back.

Because Feature Loop is idempotent and reads configuration only from the default
branch, switching controllers back and forth does not corrupt issue state —
canonical state is always re-derived from labels and GitHub state.

## Migration checklist

- [ ] `.github/feature-loop.yml` added and merged to the default branch.
- [ ] `agent:*` labels mapped to all eight canonical states (each open issue has
      at most one).
- [ ] Feature Loop workflow added with `workflow_dispatch` only.
- [ ] `agent-token` secret configured if assignment needs broader scope.
- [ ] Dry runs pass for running, paused, and complete epics.
- [ ] Old reactive trigger disabled; Feature Loop `pull_request` trigger enabled.
- [ ] One full sub-issue cycle (assign → human merge → continue) verified.
- [ ] Old controller, its tests, and the old workflow retired.
- [ ] Skill files reviewed and folded into `.github/copilot-instructions.md`.
- [ ] Rollback steps documented and known to the team.
