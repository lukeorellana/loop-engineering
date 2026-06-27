# ADR 0006: Epic initialization and the frozen execution plan

- **Status:** Accepted (native hierarchy management superseded by
  [ADR 0007](0007-frozen-markdown-plan-authoritative.md))
- **Epic:** lukeorellana/loop-engineering#1
- **Issue:** lukeorellana/loop-engineering#25
- **Scope:** Make the initial manual run normalize an epic exactly once and
  persist a frozen execution plan, so later continuation runs read that plan
  instead of re-resolving competing issue sources
  ([ADR 0005](0005-transactional-orchestration-and-reconciliation.md)).

## Context

Before this change the loop re-resolved the ordered sub-issue list on every run
from GitHub native sub-issues and/or the epic's Markdown `Ordered sub-issues`
section. When those sources drift, differ, or are only partially linked,
preflight can fail and the loop may not reliably identify the next issue. A
PR-triggered continuation should not have to repair or reinterpret the epic
hierarchy.

## Decision

### Frozen execution plan

The persisted ordered issue list is the execution contract; native GitHub
sub-issues are its visible operational representation. The plan is a pure value
(`domain/plan.ts`):

```json
{
  "version": 1,
  "epic": 123,
  "issues": [124, 125, 126],
  "planHash": "sha256:…",
  "initialized": true
}
```

`validatePlannedIssues` rejects empty, non-positive, duplicate, and
self-referential lists; `computePlanHash` binds the epic and ordered issues;
`detectPlanDrift` compares the plan against the live native order. The plan is
persisted with the existing status-comment mechanism under a dedicated per-epic
marker (`plan-<epic>`, `adapters/github/plan-comment.ts`), so it never collides
with the operational status comment (`epic-<epic>`).

### Initialization transaction

`initializer/initialize-epic.ts` runs an idempotent transaction:

    read desired state
    -> calculate mutations
    -> apply only missing changes
    -> re-read
    -> verify exact match
    -> persist the initialized marker last

It resolves the intended ordered list, verifies every issue exists in the same
repository, attaches unparented issues to the epic, reparents issues attached to
a different epic, removes unexpected native sub-issues (exact sync), reorders
native sub-issues to match the requested order, normalizes canonical state on
closed issues, re-reads and verifies the final hierarchy, and only then persists
the plan. Because the plan is written last and every mutation is idempotent, a
partial failure can be safely rerun.

### Orchestrator wiring

- `workflow_dispatch`: initialize (or verify) the epic, set the controlling
  ordered list from the frozen plan, then run the normal state-machine dispatch.
  A normal rerun of an already-initialized epic is idempotent; the
  `force-reinitialize` input rewrites the plan for an intentional change. An
  unexpected `in-progress` issue on first initialization pauses with
  `unexpected-active-issue` unless reinitialization (explicit recovery) is
  requested.
- Trusted merged-PR continuation: load the frozen plan, verify the native
  hierarchy has not drifted, complete the merged issue, and start the first
  planned issue that is not `done`. Continuation never parses Markdown to
  redefine the plan and never silently repairs or reorders it; a divergence
  pauses with `needs-human` and a stable `plan-drift` reason. When no plan has
  been persisted yet (an epic from before this feature), continuation falls back
  to the preflight-resolved order.

### New reason codes

`initialization-failed` (fails closed as `configuration-error`),
`unexpected-active-issue`, and `plan-drift` (both pause as `needs-human`).

## Consequences

- After initialization the loop reads a single frozen contract; PR continuations
  no longer re-resolve native versus Markdown sources.
- Intentional plan changes require explicit reinitialization, preventing silent
  plan rewrites from PR events.
- Dry-run reports the proposed hierarchy, ordering, state, and plan changes while
  performing zero writes (the read-only repository wrapper plus an explicit
  early return in the initializer).

## Non-goals

Parallel execution of multiple sub-issues, automatically changing the frozen
plan during a PR event, automatically bypassing blocked or human-attention work,
and automatically timing out or reassigning stalled coding-agent work remain out
of scope.
