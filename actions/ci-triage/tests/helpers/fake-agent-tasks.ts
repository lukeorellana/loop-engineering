/**
 * In-memory fakes for the Agent Tasks provider boundary.
 *
 * {@link FakeAgentTasksTransport} records the exact request bodies the provider
 * builds and returns a configured success payload or throws a configured
 * HTTP-status error, so contract tests can assert the precise wire payload and
 * exercise every failure classification without any network access.
 *
 * {@link FakeAgentTasksProvider} stubs the clean provider port directly for the
 * orchestration tests that do not care about the wire shape.
 */
import type {
  AgentTaskRequestBody,
  AgentTasksTransport,
} from '../../src/adapters/agent-tasks/api.js';
import { AgentTasksError } from '../../src/adapters/agent-tasks/errors.js';
import type {
  AgentTasksProvider,
  StartTaskInput,
  StartTaskResult,
} from '../../src/adapters/agent-tasks/provider.js';

/** An error that carries an HTTP `status`, mirroring Octokit's `RequestError`. */
export class FakeHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'FakeHttpError';
  }
}

export interface FakeAgentTasksTransportConfig {
  /** The raw payload returned from a successful `createTask`. */
  readonly response?: unknown;
  /** When set, `createTask` throws this instead of returning a response. */
  readonly error?: unknown;
}

export class FakeAgentTasksTransport implements AgentTasksTransport {
  readonly requests: AgentTaskRequestBody[] = [];

  constructor(private readonly config: FakeAgentTasksTransportConfig = {}) {}

  async createTask(body: AgentTaskRequestBody): Promise<unknown> {
    this.requests.push(body);
    if (this.config.error !== undefined) {
      throw this.config.error;
    }
    return this.config.response;
  }
}

export interface FakeAgentTasksProviderConfig {
  readonly result?: StartTaskResult;
}

export class FakeAgentTasksProvider implements AgentTasksProvider {
  readonly inputs: StartTaskInput[] = [];

  constructor(private readonly config: FakeAgentTasksProviderConfig = {}) {}

  async startTask(input: StartTaskInput): Promise<StartTaskResult> {
    this.inputs.push(input);
    return (
      this.config.result ?? {
        ok: true,
        task: { taskId: 'task-1', taskUrl: 'https://example.com/tasks/1' },
      }
    );
  }
}

export { AgentTasksError };
