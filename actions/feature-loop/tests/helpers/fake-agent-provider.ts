/**
 * In-memory fake of the {@link AgentProviderPort}.
 *
 * Core/orchestrator tests use this fake so the loop can be exercised without any
 * real provider, GraphQL transport, or network access. Every method returns a
 * configurable, deterministic result and records the requests it received.
 */
import type {
  AgentPreflightRequest,
  AgentPreflightResult,
  AgentStartRequest,
  AgentStartResult,
} from '../../src/domain/agent.js';
import type { AgentProviderPort } from '../../src/ports/agent-provider.js';

export interface FakeAgentProviderConfig {
  id?: string;
  preflightResult?: AgentPreflightResult;
  alreadyStarted?: boolean;
  startResult?: (request: AgentStartRequest) => AgentStartResult;
}

export class FakeAgentProvider implements AgentProviderPort {
  readonly id: string;
  readonly preflightRequests: AgentPreflightRequest[] = [];
  readonly startRequests: AgentStartRequest[] = [];

  constructor(private readonly config: FakeAgentProviderConfig = {}) {
    this.id = config.id ?? 'fake-provider';
  }

  async preflight(
    request: AgentPreflightRequest,
  ): Promise<AgentPreflightResult> {
    this.preflightRequests.push(request);
    return this.config.preflightResult ?? { ok: true };
  }

  async isAlreadyStarted(request: AgentStartRequest): Promise<boolean> {
    void request;
    return this.config.alreadyStarted ?? false;
  }

  async startAgent(request: AgentStartRequest): Promise<AgentStartResult> {
    this.startRequests.push(request);
    if (this.config.startResult) {
      return this.config.startResult(request);
    }
    return {
      status: 'started',
      issueNumber: request.issue.number,
      assignedAt: '2024-01-01T00:00:00.000Z',
    };
  }
}
