# ADR 0005: Transactional orchestration and reconciliation

- **Status:** Accepted
- **Epic:** lukeorellana/loop-engineering#1
- **Issue:** lukeorellana/loop-engineering#8
- **Scope:** Compose the repository adapter
  ([ADR 0002](0002-github-repository-adapter-and-preflight.md)), the trusted
  merged-PR resolver ([ADR 0003](0003-trusted-merged-pr-resolution.md)), the pure
  ordered state machine ([ADR 0001](0001-feature-loop-contracts.md)), and the
  GitHub Copilot agent provider
  ([ADR 0004](0004-github-copilot-agent-provider.md)) into the complete,
  idempotent Feature Loop controller.

## Context

Every prior layer was deliberately pure or narrowly scoped. The loop now needs a
controller that turns a single triggering event into exactly one safe iteration
while remaining idempotent under manual reruns and duplicate webhook deliveries,
strictly read-only in dry-run mode, and fail-closed on ambiguity. The controller
must reconcile stale and inconsistent state before acting and must never start
more than one issue per epic.

## Decision

### Orchestrator

`runFeatureLoop` (`orchestrator/controller.ts`) depends only on ports
(`GitHubRepositoryPort`, `AgentProviderPort`, `Clock`, `Logger`), so the whole
loop is exercised end-to-end with in-memory fakes. It follows a strict pattern:

    read → decide → re-read → mutate → verify

1. **Resolve the event context.** `resolveEvent` (`orchestrator/event.ts`) is a
   pure classifier producing a manual start, a merged-PR continuation, or an
   unrelated no-op. The epic number for a merged PR is derived from the closing
   issue's native parent.
2. **Preflight.** Repository preflight (default-branch config, epic, ordered
   sub-issues, base branch, labels, token access) followed by provider preflight.
3. **Complete the prior issue.** A trusted merged PR is resolved by the pure
   `resolveMergedPullRequest`; its idempotent `CompletionPreparation` is applied
   (replays request no mutations).
4. **Reload** the epic with the controlling ordered sub-issue list via the new
   `getEpicWithSubIssues` read method, so canonical state reflects the configured
   source rather than the native list alone.
5. **Reconcile** stale, inconsistent state (for example a closed issue still
   carrying a running label).
6. **Decide** with the pure `decideLoop`.
7. **Re-read** immediately before any mutation: a `started` decision is re-decided
   once on the latest state, so a concurrent duplicate dispatch or a human repair
   is observed before mutating.
   8–11. Set the canonical running state, post scoped instructions plus a
   machine-readable status, start the provider, then verify the assignment and
   persist the final status.

### Strict dry-run

Dry-run wraps the repository in `readOnlyRepository`, whose write methods are
inert no-ops. The zero-write invariant therefore holds by construction — even a
code path that forgets an explicit guard cannot mutate through the wrapper — and
the state machine itself returns a read-only `dry-run` preview instead of a
`started` decision.

### Reconciliation and recovery

- **Duplicate manual dispatch / lost response:** the provider's read-only
  `isAlreadyStarted` short-circuits to `already-running` rather than reassigning.
- **Uncertain assignment:** reconciled by re-reading the provider before any
  rollback; only a confirmed non-assignment becomes a recoverable `needs-human`.
- **Assignment failure:** leaves a recoverable `needs-human` canonical state.
- **Stale running labels on closed issues:** normalized to the terminal label.
- **Multiple linked pull requests / contradictory labels / blocked or invalid
  head-of-line work:** pause the epic for human attention.
- **Stalled active work:** reported with its age (recovered from the hidden
  status payload). V1 never times out, cancels, or reassigns.

### Status markers

`orchestrator/status.ts` embeds a hidden, machine-readable payload (epic, issue,
provider, state, reason, start timestamp) inside an HTML comment, alongside the
existing dedupe marker, so a prior status comment is updated in place and the
start timestamp can be recovered to report stalled-work age. Human-readable text
is sanitized; raw provider errors and transport details stay in the Actions log.

## Consequences

- Every execution context and reconciliation path is covered by event-fixture
  tests driven through the in-memory `GitHubApi` and provider fakes.
- The controller is wired only to ports; binding the concrete Octokit transports
  and the consumer workflow remains future work.

## Non-goals

Action packaging, release creation, marketplace publication, parallel issue
execution, and automatic stalled-agent timeout remain out of scope.
