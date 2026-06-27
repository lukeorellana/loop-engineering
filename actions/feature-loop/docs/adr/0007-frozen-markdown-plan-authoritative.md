# ADR 0007: The frozen Markdown plan is authoritative; native sub-issue hierarchy is non-authoritative UI metadata

- **Status:** Accepted
- **Epic:** lukeorellana/loop-engineering#1
- **Issue:** lukeorellana/loop-engineering#35
- **Supersedes:** the native sub-issue hierarchy management introduced in
  [ADR 0006](0006-epic-initialization-and-frozen-plan.md) for orchestration
  purposes, and the native reorder hardening tracked separately.

## Context

[ADR 0006](0006-epic-initialization-and-frozen-plan.md) treated GitHub's native
sub-issue hierarchy as required orchestration state. During initialization the
loop attached, reparented, removed, reordered, polled, and verified native
sub-issues before persisting the execution plan, and every continuation run
compared the persisted plan against the live native order, pausing with
`plan-drift` on any difference.

The native hierarchy is eventually consistent. GraphQL reprioritization did not
always converge, REST ordering reads sometimes returned an empty list, and the
loop could fail before agent assignment even when the ordered Markdown plan had
been discovered correctly. These native-UI synchronization failures are
unrelated to the actual execution contract.

## Decision

The authored Markdown ordered list is authoritative, and the frozen execution
plan derived from it is the **sole execution-order source** after
initialization. Native GitHub sub-issue links and ordering are presentation
metadata outside Feature Loop's orchestration responsibilities.

### Initialization (`initializer/initialize-epic.ts`)

The transaction no longer reads or mutates the native sub-issue hierarchy:

    validate the authored ordered issue list
    -> verify every planned issue exists in the same repository
    -> read issue state directly from the planned issue numbers
    -> normalize canonical state
    -> persist the frozen plan last

`validatePlannedIssues` still rejects empty, non-positive, duplicate, and
self-referential lists. Canonical state normalization and the unexpected
active-issue safeguard are preserved. The following native hierarchy operations
are no longer called during initialization: `getNativeSubIssueNumbers`,
`getParentEpicNumber`, `addSubIssue`, `removeSubIssue`, `reprioritizeSubIssue`,
and hierarchy convergence polling. The `exactSync` flag is retained as an
ignored, deprecated no-op for backward compatibility.

### Continuation runs

A continuation run loads the persisted frozen plan and uses its `issues` array
directly. The native hierarchy is never read for ordering and is never compared
against the plan, so the `plan-drift` pause and `detectPlanDrift` are removed.
Markdown is not reread on ordinary continuation runs: the frozen plan's issues
are passed to preflight, which skips Markdown and native source resolution
entirely. When no frozen plan exists (an epic initialized before the plan
existed), continuation falls back to the preflight-resolved Markdown order as a
documented backward-compatibility path; the native order is never adopted as a
replacement plan.

### Force reinitialization

`force-reinitialize` rereads and validates the current Markdown and replaces the
persisted frozen plan. Existing active-issue safeguards still apply.

### Preserved behavior

PR-to-child closing relationships (`Closes #<child>`), the
`Parent epic: #<epic>` metadata used to resolve the owning epic, merged-PR
validation and completion, the one-active-issue state machine, the dry-run
zero-write guarantee, and the informational Markdown discovery notice are all
unchanged.

## Consequences

- Native linking, reparenting, removal, ordering, and convergence failures can
  no longer block initialization or continuation.
- The frozen plan is the single execution-order source; the loop never derives
  execution order from native linked issue order.
- Markdown is reread only for first initialization or explicit force
  reinitialization.
- `plan-drift` is no longer emitted as a reason code.

## Non-goals

Re-establishing native sub-issue links as an authoritative source, parallel
execution of multiple sub-issues, and automatically changing the frozen plan
during a PR event remain out of scope.
