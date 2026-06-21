# ADR 0002: GitHub repository adapter and preflight

- **Status:** Accepted
- **Epic:** lukeorellana/loop-engineering#1
- **Issue:** lukeorellana/loop-engineering#4
- **Scope:** Implement the GitHub-facing repository adapter and repository
  preflight on top of the contracts fixed in
  [ADR 0001](0001-feature-loop-contracts.md), without coupling the loop core to
  Octokit or raw API responses.

## Context

ADR 0001 fixed the ports and domain types but deliberately left all GitHub
behavior unimplemented. The loop now needs to read epics, sub-issues, labels,
configuration, and pull requests from GitHub, normalize them into the
provider-independent domain shapes, and run the preflight checks that must pass
before any issue is acted on — all while keeping the core replaceable with an
in-memory fake in tests and never leaking credentials or raw API bodies.

## Decision

### Transport boundary

A narrow `GitHubApi` interface (`adapters/github/api.ts`) describes exactly the
transport operations the adapter needs, using small provider-independent shapes
(`ApiIssue`, `ApiLabel`, `ApiPullRequest`, …). List operations are
**page-oriented** (`ApiPage<T>` with `hasNextPage`) so the adapter owns
pagination and it can be exercised deterministically. The loop core depends on
the `GitHubRepositoryPort`, never on `GitHubApi` or Octokit; a concrete
Octokit-backed `GitHubApi` is supplied by the composition layer when the
controller is wired in.

### Adapter

`GitHubRepositoryAdapter` (`adapters/github/repository-adapter.ts`) implements
`GitHubRepositoryPort` over `GitHubApi`. It owns:

- **Pagination.** Every list read loops `GitHubApi` pages until `hasNextPage` is
  false (bounded by a defensive page cap).
- **Native sub-issues.** Order is preserved exactly as GitHub returns it; parent
  lookups use GitHub parent/sub-issue metadata, not `Parent epic:` body text.
- **Markdown discovery.** Delegated to the pure `parseMarkdownSubIssues`
  (`domain/markdown.ts`), which scopes references to the configured heading's
  section and **rejects cross-repository references** in v1 (fail closed).
- **Canonical state.** Resolved by the pure `resolveIssueState`
  (`domain/issue-state-resolution.ts`); more than one canonical label on an open
  issue resolves to `invalid`. `setCanonicalState` normalizes labels so exactly
  one canonical state remains.
- **Status comments.** `upsertStatusComment` embeds a hidden HTML-comment marker
  so a prior status comment is updated in place instead of duplicated.
- **Error sanitization.** Every transport call is wrapped so any failure becomes
  a `RepositoryApiError` whose message is derived only from the operation name
  and a coarse, status-based category — never raw bodies, tokens, or headers.

Configuration is always read with `getDefaultBranchFile`, which resolves the
default branch first and reads the file at that ref, so configuration can never
come from a pull-request head, a fork, an arbitrary ref, or checked-out
pull-request code.

### Preflight

`preflight` (`preflight/index.ts`) runs the fail-closed checks before the loop
acts: valid configuration (loaded from the default branch), the epic exists and
is open, ordered sub-issues exist, the configured base branch exists, required
labels exist (or are created when `labels.auto-create` is enabled), token write
access where it can be determined, and provider-specific checks delegated to the
caller. Source rules are enforced via `resolveIssueSource` (ambiguous `auto`
sources fail closed) and the cross-repository rejection above. Failures are
reported as structured `configuration-error` or `operational-error` results with
actionable messages and never a partial success.

### Configuration change

`labels` gains an `auto-create` flag (`config/schema.ts`, `config/load.ts`). The
resolved `labels` value is `{ autoCreate, names }`; the YAML reserves the
`auto-create` key alongside the canonical-state label names.

## Consequences

- The loop core stays decoupled from Octokit; adapter behavior (pagination,
  parsing, normalization, sanitization, preflight) is covered by mocked tests
  through an in-memory `GitHubApi` fake.
- Wiring the Octokit transport and controller orchestration remains future work
  (non-goals here); the `GitHubApi` boundary is the single seam to implement.

## Non-goals

Pure selection decisions, Copilot GraphQL assignment, full controller
orchestration, and consumer workflow packaging remain out of scope.
