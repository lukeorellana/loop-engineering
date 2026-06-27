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
  ExistingTask,
  FindTaskResult,
  RecentTasksResult,
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
  /** The raw payload returned from a successful `listTasks`. */
  readonly listResponse?: unknown;
  /** When set, `listTasks` throws this instead of returning a response. */
  readonly listError?: unknown;
  /** Raw payloads returned from `getTask`, keyed by task id. */
  readonly taskDetails?: Record<string, unknown>;
}

export class FakeAgentTasksTransport implements AgentTasksTransport {
  readonly requests: AgentTaskRequestBody[] = [];
  listCalls = 0;
  readonly getCalls: string[] = [];

  constructor(private readonly config: FakeAgentTasksTransportConfig = {}) {}

  async createTask(body: AgentTaskRequestBody): Promise<unknown> {
    this.requests.push(body);
    if (this.config.error !== undefined) {
      throw this.config.error;
    }
    return this.config.response;
  }

  async listTasks(): Promise<unknown> {
    this.listCalls += 1;
    if (this.config.listError !== undefined) {
      throw this.config.listError;
    }
    return this.config.listResponse ?? [];
  }

  async getTask(taskId: string): Promise<unknown> {
    this.getCalls.push(taskId);
    return this.config.taskDetails?.[taskId] ?? null;
  }
}

export interface FakeAgentTasksProviderConfig {
  readonly result?: StartTaskResult;
  readonly findResult?: FindTaskResult;
  readonly recentResult?: RecentTasksResult;
  /**
   * When set, `findTaskByFingerprint` returns each configured result in order
   * across successive calls (the first for deduplication, the second for
   * reconciliation), falling back to `findResult` once exhausted.
   */
  readonly findResults?: readonly FindTaskResult[];
}

export class FakeAgentTasksProvider implements AgentTasksProvider {
  readonly inputs: StartTaskInput[] = [];
  readonly findFingerprints: string[] = [];
  listRecentCalls = 0;
  private findCallIndex = 0;

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

  async findTaskByFingerprint(fingerprint: string): Promise<FindTaskResult> {
    this.findFingerprints.push(fingerprint);
    const index = this.findCallIndex;
    this.findCallIndex += 1;
    if (this.config.findResults !== undefined) {
      const sequenced = this.config.findResults[index];
      if (sequenced !== undefined) {
        return sequenced;
      }
    }
    return this.config.findResult ?? { ok: true, task: null };
  }

  async listRecentTasks(): Promise<RecentTasksResult> {
    this.listRecentCalls += 1;
    return this.config.recentResult ?? { ok: true, tasks: [] };
  }
}

export type { ExistingTask };
export { AgentTasksError };
