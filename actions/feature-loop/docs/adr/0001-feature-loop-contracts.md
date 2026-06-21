# ADR 0001: Feature Loop contracts, configuration, ports, and state model

- **Status:** Accepted
- **Epic:** lukeorellana/loop-engineering#1
- **Scope:** Define the reusable Feature Loop contracts before any GitHub
  behavior is implemented.

## Context

Feature Loop is a GitHub Action that advances a feature epic through an ordered
set of sub-issues, assigning exactly one issue at a time to a coding agent and
remaining human-gated: a human reviews and merges every pull request before the
next issue starts.

Before implementing GitHub behavior we fix the contracts the rest of the work
depends on: configuration, domain types, the canonical state model, loop
decisions, action outcomes, agent requests/results, and the ports that isolate
the loop from external systems. These contracts live in
`actions/feature-loop/src/` and are exported from `src/contracts.ts`. No GitHub
API call, issue-selection algorithm, Copilot assignment, or workflow packaging
is part of this decision.

## Decision

### Invariants

The following invariants are represented in the types and validation logic and
are binding on every later implementation:

1. **First incomplete controls the loop.** The first incomplete ordered
   sub-issue (by position) is the only issue the loop may act on. Only the `done`
   state counts as complete (`isComplete` in `domain/state.ts`).
2. **Head-of-line pausing pauses the epic.** Blocked, invalid, skipped,
   needs-human, or not-planned work at the head of the line pauses the epic
   (`isPausing`).
3. **One canonical state label per issue.** An issue carries exactly one
   canonical state label. Default labels are customizable but must remain
   distinct (`resolveLabels`). More than one canonical label present on an issue
   is treated as `invalid`.
4. **Dry-run is strictly read-only.** Dry-run depends only on
   `GitHubRepositoryReadPort`, and `AgentStartRequest.dryRun` forbids provider
   mutations. Read and write operations are split at the port boundary so a
   read-only path cannot mutate by construction.
5. **Human merge is required.** `merge.requireHuman` is always `true` and cannot
   be disabled; `merge.autoMerge` is always `false`. Completion is only ever
   recognized from a human-merged pull request.
6. **Ambiguous state fails closed.** Unknown configuration versions, invalid
   configuration, duplicate canonical labels, multiple linked pull requests, and
   ambiguous completion never advance the loop; they surface as
   `configuration-error` or `needs-human`.
7. **Duplicate processing is idempotent.** Re-processing the same event must not
   start duplicate work. The agent provider returns `already-running` for an
   already-assigned issue, and `AgentStartResult` distinguishes
   `started` / `already-running` / `uncertain` / `failed`.

### Configuration

Configuration is the versioned `.github/feature-loop.yml`, read from the
repository default branch. The resolved shape is `FeatureLoopConfig`
(`config/schema.ts`); loading and validation live in `config/load.ts`.

```yaml
version: 1
issues:
  source: native | markdown | auto
  markdown:
    heading: Ordered sub-issues
agent:
  provider: github-copilot
  model: null # null => automatic selection
base:
  branch: null # null => repository default branch
merge:
  requireHuman: true
  autoMerge: false
concurrency:
  activeIssuesPerEpic: 1
labels:
  todo: 'feature-loop:todo'
  in-progress: 'feature-loop:in-progress'
  blocked: 'feature-loop:blocked'
  needs-human: 'feature-loop:needs-human'
  skipped: 'feature-loop:skipped'
  invalid: 'feature-loop:invalid'
  done: 'feature-loop:done'
  not-planned: 'feature-loop:not-planned'
```

Rules:

- **Missing configuration resolves to documented defaults** (`defaultConfig`).
- **Unknown versions fail closed.** Only `version: 1` is supported; any other
  value, or a present file missing `version`, is a `configuration-error`.
- **Invalid configuration returns actionable errors.** Each problem is reported
  as a discrete, human-readable message; an invalid config never yields a
  partially-resolved configuration, so it can never produce a start decision.
- **Labels are customizable while preserving one canonical state.** Each of the
  eight canonical states must map to a distinct label.
- **Nothing operational is hardcoded.** Branch names (`main`), repository names
  (`LingoQuest`), model names, and local skill paths are never baked into the
  loop. They come from configuration or the repository default branch.

### Deterministic issue source behavior

`resolveIssueSource` (`domain/issue-source.ts`) implements:

- `native`: use only native GitHub sub-issues.
- `markdown`: use only the configured Markdown section.
- `auto`: use native when non-empty, otherwise Markdown. If both are non-empty
  and differ, fail preflight (`ambiguous-sources`).

### Secure defaults

- `provider: github-copilot`.
- Automatic model selection when no model is supplied (`model: null`).
- Repository default branch when no base branch is supplied (`branch: null`).
- Human merge required; no automatic merge.
- One active issue per epic.

### State model

Canonical issue states (`domain/state.ts`): `todo`, `in-progress`, `blocked`,
`needs-human`, `skipped`, `invalid`, `done`, `not-planned`. Canonical epic
states: `idle`, `running`, `paused`, `complete`.

Closed-issue behavior is explicit:

- **Closed-completed** maps to `done` and is the only state that advances the
  loop.
- **Closed-not-planned** maps to `not-planned`. It is a closed state but not a
  success: head-of-line `not-planned` work pauses the epic until a human
  resolves the ordering.

### Decisions and outcomes

`LoopDecision` (`domain/decisions.ts`) is a discriminated union whose `outcome`
field maps to one `ActionOutcome`: `started`, `already-running`, `complete`,
`needs-human`, `dry-run`, `no-op`, `configuration-error`, `operational-error`.
There is intentionally no start decision variant that bypasses configuration
validation, so invalid configuration cannot produce a start.

### Ports

- **GitHub repository port** (`ports/github-repository.ts`): split into
  `GitHubRepositoryReadPort` and `GitHubRepositoryWritePort`. Reads expose the
  default branch, epics, native/Markdown sub-issue numbers, canonical labels,
  linked pull requests, and pull-request completion context. Writes set the
  single canonical state label and close completed issues. The port never checks
  out or executes pull-request code.
- **Agent provider port** (`ports/agent-provider.ts`): `startAgent` is
  idempotent and may return `uncertain` so the orchestrator reconciles before
  rollback. The default provider id is `github-copilot`.
- **Clock and logger ports** (`ports/clock.ts`, `ports/logger.ts`): isolate time
  and structured logging for deterministic testing.

### Recovery, retry, and uncertain mutations

- **Uncertain mutations:** when a start may or may not have taken effect, the
  provider returns `uncertain`. The orchestrator must reconcile the real
  repository state before any rollback; it must never blindly retry a mutation
  that may have already applied.
- **Retry:** read operations are safe to retry. Write operations are only
  retried after reconciliation confirms they did not take effect.
- **Recovery:** ambiguous or inconsistent head-of-line state is surfaced as
  `needs-human` (or `configuration-error` for configuration problems) rather
  than guessed, keeping the loop fail-closed.

## Consequences

- Later issues implement adapters against these ports without changing the
  contracts.
- The loop core stays pure and unit-testable: configuration resolution, source
  resolution, and the state helpers have no I/O.
- Because invalid configuration and ambiguous state are unrepresentable as a
  start, the human-gated, fail-closed guarantees hold by construction.

## Non-goals

GitHub API calls, issue-selection implementation, Copilot assignment
implementation, and workflow packaging are out of scope for this ADR.
