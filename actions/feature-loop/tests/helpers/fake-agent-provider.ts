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
  authorLogins?: string[];
  preflightResult?: AgentPreflightResult;
  alreadyStarted?: boolean;
  /**
   * Sequence of `isAlreadyStarted` results consumed in call order. When the
   * sequence is exhausted (or absent), `alreadyStarted` is used. Useful to model
   * an assignment that is not yet visible on the first read but confirmed on a
   * subsequent reconciliation read.
   */
  alreadyStartedSequence?: boolean[];
  startResult?: (request: AgentStartRequest) => AgentStartResult;
}

export class FakeAgentProvider implements AgentProviderPort {
  readonly id: string;
  readonly authorLogins: readonly string[];
  readonly preflightRequests: AgentPreflightRequest[] = [];
  readonly startRequests: AgentStartRequest[] = [];
  private alreadyStartedCalls = 0;

  constructor(private readonly config: FakeAgentProviderConfig = {}) {
    this.id = config.id ?? 'fake-provider';
    this.authorLogins = config.authorLogins ?? ['fake-agent'];
  }

  async preflight(
    request: AgentPreflightRequest,
  ): Promise<AgentPreflightResult> {
    this.preflightRequests.push(request);
    return this.config.preflightResult ?? { ok: true };
  }

  async isAlreadyStarted(request: AgentStartRequest): Promise<boolean> {
    void request;
    const index = this.alreadyStartedCalls;
    this.alreadyStartedCalls += 1;
    const sequence = this.config.alreadyStartedSequence;
    if (sequence !== undefined && index < sequence.length) {
      return sequence[index];
    }
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
