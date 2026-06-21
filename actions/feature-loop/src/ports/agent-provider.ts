/**
 * Agent provider port.
 *
 * The loop delegates implementation work to a coding-agent provider through this
 * port. The default provider is `github-copilot`, but the port is
 * provider-independent. When a request is a dry run, an implementation must not
 * perform any mutation and should report what it would have done.
 *
 * The port is isolated from the core state machine so the loop can be exercised
 * with an in-memory fake provider, and so additional providers can be added
 * without touching the orchestrator.
 */
import type {
  AgentPreflightRequest,
  AgentPreflightResult,
  AgentStartRequest,
  AgentStartResult,
} from '../domain/agent.js';

export interface AgentProviderPort {
  /** Stable provider identifier, for example `github-copilot`. */
  readonly id: string;

  /**
   * Verify, read-only, that the provider is available to the repository and that
   * the agent-assignment credential is present and authorized. Used during
   * preflight so the loop fails closed before any mutation is attempted.
   */
  preflight(request: AgentPreflightRequest): Promise<AgentPreflightResult>;

  /**
   * Whether the agent is already assigned to the request's sub-issue. Read-only,
   * so it is safe in dry-run mode and safe to retry. Lets the orchestrator keep
   * re-processing idempotent without attempting a mutation.
   */
  isAlreadyStarted(request: AgentStartRequest): Promise<boolean>;

  /**
   * Start the agent on exactly one sub-issue.
   *
   * Implementations must be idempotent: starting an already-running issue
   * returns `already-running` rather than creating duplicate work. When the
   * outcome is uncertain, return `uncertain` so the orchestrator can reconcile
   * the real state before any rollback.
   */
  startAgent(request: AgentStartRequest): Promise<AgentStartResult>;
}
