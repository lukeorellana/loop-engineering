# ADR 0003: Trusted merged-PR resolution

- **Status:** Accepted
- **Epic:** lukeorellana/loop-engineering#1
- **Issue:** lukeorellana/loop-engineering#6
- **Scope:** Decide, safely and idempotently, whether a merged pull request
  completed the active Feature Loop sub-issue, and produce a validated
  completion context. Builds on the contracts in
  [ADR 0001](0001-feature-loop-contracts.md) and the adapter in
  [ADR 0002](0002-github-repository-adapter-and-preflight.md).

## Context

Completion is the only event that lets the loop advance, and the loop is
human-gated: a human reviews and merges every pull request. A merged pull
request is therefore the trust anchor, but a merge alone is not proof that the
**active** sub-issue was completed. The pull request may be unmerged, merged into
the wrong base branch, merely mention an issue, formally close several issues, or
close an issue that is foreign or out of order. GitHub may also auto-close the
issue and the same delivery may be replayed. The decision must fail closed in
every ambiguous case and never start the next issue on bad input.

## Decision

### Pure trusted resolver

`resolveMergedPullRequest` (`domain/merged-pr.ts`) is a pure function that turns a
`pull_request: closed` event plus an epic context into exactly one result:
`completed` (with a validated `PullRequestCompletionContext` and an idempotent
`CompletionPreparation`), a benign `no-op`, or a fail-closed `needs-human`. It
performs no I/O and is fully determined by its inputs.

A pull request advances the loop only when **all** of the following hold:

1. The event is `pull_request: closed`.
2. The pull request was actually merged.
3. The pull request was merged into the configured base branch.
4. GitHub reports a formal closing relationship through a closing keyword or
   `closingIssuesReferences`.
5. Exactly one issue is resolved.
6. The resolved issue is the active head-of-line issue for its epic (every
   earlier ordered sub-issue is `done`).
7. The issue belongs to the same repository and parent epic — it is listed in the
   epic's ordered sub-issues.

### Trusted resolution order

1. Parse a GitHub closing keyword (for example `Closes owner/repo#123`) from the
   pull-request body, scoped to this repository (`parseClosingKeywords`).
   Cross-repository references are ignored because closing keywords only
   auto-close issues in the same repository.
2. Read GitHub `closingIssuesReferences`.
3. When both methods return a result they must agree; a conflict fails closed
   (`conflicting-closing-references`).

Generic issue-timeline cross-references are never used as proof of completion.

### Fail-closed outcomes

- No formal closing relationship, an unmerged PR, a wrong-base merge, or a
  foreign/unrelated issue → `no-op` with a stable reason.
- More than one closed issue → `needs-human` (`multiple-closing-issues`).
- Conflicting keyword and metadata → `needs-human`
  (`conflicting-closing-references`).
- An out-of-order issue → `needs-human` (`out-of-order`).
- A merge that claims a `not-planned` issue → `needs-human`
  (`ambiguous-completion`).

### Idempotent completion preparation

`CompletionPreparation` describes the minimal mutations needed to bring the
resolved issue to a consistent completed state, so applying it is safe to repeat:

- `alreadyComplete` — the issue is already resolved as `done` (auto-closed).
- `closeAsCompleted` — the issue is still open and must be closed as completed.
- `normalizeDoneLabel` — the canonical labels must be normalized to exactly the
  `done` label (missing it, or carrying stale active labels).

A replayed merged-PR event recomputes the same preparation; when the issue is
already consistent it requests no mutations.

### Adapter support

`ApiPullRequest` gains a `body` field, and the repository read port exposes
`getMergedPullRequest`, which returns the raw, untrusted `MergedPullRequest`
(body plus GitHub closing references). The adapter only supplies data; all trust
decisions live in the pure resolver. The pre-existing `getPullRequestCompletion`
is retained for the foreign-parent check in the state machine.

## Consequences

- Every resolution path is covered by pure unit tests and by mocked-API tests
  driven through the in-memory `GitHubApi` fake.
- Because the resolver is pure and fails closed, API failures and ambiguous input
  can never start the next issue.

## Non-goals

Selecting or assigning the next issue, Copilot assignment, full controller
orchestration, and any timeline cross-reference fallback remain out of scope.
