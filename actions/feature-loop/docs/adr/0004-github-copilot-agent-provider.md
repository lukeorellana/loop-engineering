# ADR 0004: GitHub Copilot agent provider

- **Status:** Accepted
- **Epic:** lukeorellana/loop-engineering#1
- **Issue:** lukeorellana/loop-engineering#7
- **Scope:** Implement the agent-provider boundary's first provider — GitHub
  Copilot coding-agent assignment — on top of the contracts fixed in
  [ADR 0001](0001-feature-loop-contracts.md), without coupling the loop core to
  Octokit, raw GraphQL responses, or a specific provider.

## Context

ADR 0001 fixed the `AgentProviderPort` but deliberately left Copilot assignment
unimplemented. The loop now needs to delegate implementation work to a
coding-agent provider: verify the provider is available and authorized, detect
when work is already assigned, and assign the agent to exactly one sub-issue —
all while keeping the core replaceable with an in-memory fake in tests and never
leaking credentials, tokens, or raw API bodies to logs or issues.

## Decision

### Provider port

`AgentProviderPort` (`ports/agent-provider.ts`) gains two read-only methods
alongside `startAgent`, matching the provider boundary the orchestrator needs:

- `preflight(request)` — verify, read-only, that the provider is available to the
  repository and that the agent-assignment credential is present and authorized.
- `isAlreadyStarted(request)` — whether the agent is already assigned, so
  re-processing stays idempotent without attempting a mutation.
- `startAgent(request)` — assign the agent to one sub-issue.

The port is provider-independent and isolated from the core state machine, so
the loop can be exercised with `FakeAgentProvider` and additional providers can
be added later without touching the orchestrator.

### Transport boundary

A narrow `CopilotAgentApi` interface (`adapters/github-copilot/api.ts`) describes
exactly the GraphQL operations the provider needs, using small
provider-independent shapes (`AssignableActor`, `AssignableIssue`,
`AssignActorRequest`/`AssignActorResult`). The provider depends only on this
boundary, never on Octokit or raw GraphQL responses; a concrete transport is
supplied by the composition layer. Tests drive the provider through an in-memory
`FakeCopilotAgentApi`.

The concrete transport is constructed with the dedicated **agent-assignment
credential**, kept separate from the ordinary repository token used by the
repository adapter. Splitting the token at the transport seam keeps assignment
privileges isolated from routine repository reads and writes.

### Provider

`GitHubCopilotProvider` (`adapters/github-copilot/provider.ts`) implements
`AgentProviderPort` over `CopilotAgentApi`. It owns:

- **Actor discovery.** The assignable Copilot actor is discovered by login from
  the repository's suggested actors (`adapters/github-copilot/actors.ts`).
  Matching covers the current login (`copilot-swe-agent`) and documented legacy
  logins (`copilot`), case-insensitively, preferring the current login — no
  single name is hardcoded into the loop.
- **Availability.** Preflight confirms the Copilot actor is assignable and the
  credential is authorized, failing closed with a normalized reason and
  actionable, sanitized messages when Copilot is unavailable or access is
  insufficient.
- **Model selection.** The assignment includes a model only when the user
  explicitly configured one; the field is omitted entirely to request automatic
  model selection (the secure default).
- **Base branch.** The configured base branch is threaded into the assignment.
- **Idempotency.** An already-assigned issue returns `already-running` and never
  re-assigns.
- **Error sanitization.** Every transport failure becomes a
  `CopilotProviderError` whose message is derived only from the operation name
  and a coarse, status-based `AgentReasonCode` — never raw bodies, tokens, or
  headers. Results carry a normalized `reason`.

### Uncertain mutations

Assignment is the only mutating operation and is never blindly retried. When the
mutation returns an error or loses its response, the provider reconciles by
re-reading the issue:

1. If Copilot is now assigned, the operation is treated as `started`
   (recovered).
2. If Copilot is not assigned, a sanitized `failed` result is returned with the
   original normalized reason.
3. If the reconciliation read itself fails, the outcome stays `uncertain` so the
   orchestrator reconciles the real state later rather than rolling back or
   retrying a possibly-successful mutation.

Dry-run is strictly read-only: the provider performs no mutation and reports
only what it observes.

## Consequences

- The loop core stays decoupled from Octokit and from any single provider;
  provider behavior (discovery, assignment, model omission, sanitization,
  reconciliation) is covered by mocked tests through the in-memory
  `CopilotAgentApi` fake, and core tests can use `FakeAgentProvider`.
- Wiring the concrete Octokit-backed GraphQL transport and orchestrating the
  provider from the controller remain future work; the `CopilotAgentApi`
  boundary is the single seam to implement, with its own credential.

## Non-goals

A Claude Code provider, an OpenAI Codex provider, generic command execution, the
Cloud Agent task API, and automatic PR merge are all out of scope for v1.
