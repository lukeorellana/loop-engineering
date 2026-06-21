/**
 * Agent provider port.
 *
 * The loop delegates implementation work to a coding-agent provider through this
 * port. The default provider is `github-copilot`, but the port is
 * provider-independent. When a request is a dry run, an implementation must not
 * perform any mutation and should report what it would have done.
 */
import type { AgentStartRequest, AgentStartResult } from '../domain/agent.js';

export interface AgentProviderPort {
  /** Stable provider identifier, for example `github-copilot`. */
  readonly id: string;

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
