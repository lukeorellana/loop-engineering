import { describe, expect, it } from 'vitest';

import { executeAction, type ActionEnvironment } from '../src/action/index.js';
import type { TriageResult } from '../src/action/result.js';
import type { FindTaskResult } from '../src/adapters/agent-tasks/index.js';
import type {
  TriageEvent,
  TriageWorkflowRun,
} from '../src/adapters/github/index.js';
import type { CandidatePullRequest } from '../src/domain/index.js';
import { FakeActionCore } from './helpers/fake-action-core.js';
import { FakeAgentTasksProvider } from './helpers/fake-agent-tasks.js';
import {
  FakeTriageGitHubApi,
  FakeTriageHistoryGitHubApi,
  type FakeHistoryConfig,
} from './helpers/fake-triage-api.js';

const VALID_INPUTS: Record<string, string> = {
  'github-token': 'gh-secret-token',
  'agent-token': 'agent-secret-token',
};

const RUN_ID = 4242;
const HEAD_SHA = 'a'.repeat(40);
const HEAD_BRANCH = 'feature/login';

const COMPLETED_EVENT: TriageEvent = {
  name: 'workflow_run',
  action: 'completed',
  workflowRunId: RUN_ID,
};

function makeRun(
  overrides: Partial<TriageWorkflowRun> = {},
): TriageWorkflowRun {
  return {
    id: RUN_ID,
    name: 'CI',
    runAttempt: 2,
    htmlUrl: `https://github.com/acme/app/actions/runs/${RUN_ID}`,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    pullRequestNumbers: [7],
    ...overrides,
  };
}

function makePr(): CandidatePullRequest {
  return {
    number: 7,
    state: 'open',
    isFork: false,
    baseRef: 'main',
    headRef: HEAD_BRANCH,
    headSha: HEAD_SHA,
  };
}

function existingPrApi(run?: Partial<TriageWorkflowRun>): FakeTriageGitHubApi {
  return new FakeTriageGitHubApi({
    workflowRuns: { [RUN_ID]: makeRun(run) },
    pullRequests: { 7: makePr() },
  });
}

interface RunOptions {
  readonly inputs?: Record<string, string>;
  readonly provider?: FakeAgentTasksProvider;
  readonly run?: Partial<TriageWorkflowRun>;
  readonly history?: FakeHistoryConfig;
  readonly withHistoryApi?: boolean;
}

async function run(options: RunOptions = {}): Promise<{
  core: FakeActionCore;
  result: TriageResult;
  provider: FakeAgentTasksProvider;
}> {
  const core = new FakeActionCore({ ...VALID_INPUTS, ...options.inputs });
  const provider = options.provider ?? new FakeAgentTasksProvider();
  const env: ActionEnvironment = {
    core,
    repository: 'acme/app',
    event: COMPLETED_EVENT,
    buildTriageApi: () => existingPrApi(options.run),
    ...(options.withHistoryApi !== false
      ? {
          buildHistoryApi: () =>
            new FakeTriageHistoryGitHubApi(options.history ?? {}),
        }
      : {}),
    buildAgentTasksProvider: () => provider,
  };
  const result = await executeAction(env);
  return { core, result, provider };
}

const existingTaskFind: FindTaskResult = {
  ok: true,
  task: {
    taskId: 'dup-task',
    taskUrl: 'https://github.com/acme/app/agents/dup-task',
  },
};

describe('idempotency — first creation', () => {
  it('creates a task when no fingerprint match exists', async () => {
    const { result, provider } = await run();
    expect(result.outcome).toBe('started');
    expect(result.reasonCode).toBe('task-started');
    // Deduplication ran before the create.
    expect(provider.findFingerprints).toHaveLength(1);
    expect(provider.inputs).toHaveLength(1);
  });
});

describe('idempotency — exact duplicate', () => {
  it('returns the existing task and never creates another', async () => {
    const provider = new FakeAgentTasksProvider({
      findResult: existingTaskFind,
    });
    const { result } = await run({ provider });
    expect(result.outcome).toBe('duplicate');
    expect(result.reasonCode).toBe('agent-task-already-exists');
    expect(result.taskId).toBe('dup-task');
    expect(provider.inputs).toHaveLength(0);
  });
});

describe('idempotency — new attempt', () => {
  it('produces a distinct fingerprint for a new run attempt', async () => {
    const a = await run({ run: { runAttempt: 2 } });
    const b = await run({ run: { runAttempt: 3 } });
    expect(a.provider.findFingerprints[0]).not.toBe(
      b.provider.findFingerprints[0],
    );
    expect(b.result.outcome).toBe('started');
  });
});

describe('idempotency — concurrent lookup race (best effort)', () => {
  it('proceeds to create when a duplicate is not yet visible', async () => {
    // The lookup misses (delayed visibility); the create still proceeds. Without
    // an atomic key this is the documented best-effort limit.
    const { result, provider } = await run();
    expect(result.outcome).toBe('started');
    expect(provider.inputs).toHaveLength(1);
  });

  it('fails closed when deduplication itself cannot be performed reliably', async () => {
    const provider = new FakeAgentTasksProvider({
      findResult: {
        ok: false,
        reason: 'agent-transient',
        message: 'list failed',
      },
    });
    const { result } = await run({ provider });
    expect(result.outcome).toBe('operational-error');
    expect(result.reasonCode).toBe('agent-transient');
    // No task is created when dedup is unreliable.
    expect(provider.inputs).toHaveLength(0);
  });
});

describe('reconciliation — uncertain create result', () => {
  it('reconciles to the created task when a follow-up search finds it', async () => {
    const provider = new FakeAgentTasksProvider({
      findResults: [
        { ok: true, task: null }, // dedup: not found
        {
          ok: true,
          task: {
            taskId: 'reconciled',
            taskUrl: 'https://github.com/acme/app/agents/reconciled',
          },
        }, // reconcile: found
      ],
      result: { ok: false, reason: 'agent-transient', message: 'timeout' },
    });
    const { result } = await run({ provider });
    expect(result.outcome).toBe('started');
    expect(result.reasonCode).toBe('agent-task-create-reconciled');
    expect(result.taskId).toBe('reconciled');
    expect(provider.findFingerprints).toHaveLength(2);
  });

  it('reports reconciliation-failed when no task can be confirmed', async () => {
    const provider = new FakeAgentTasksProvider({
      findResults: [
        { ok: true, task: null },
        { ok: true, task: null },
      ],
      result: {
        ok: false,
        reason: 'agent-unexpected-response',
        message: 'decode failure',
      },
    });
    const { result } = await run({ provider });
    expect(result.outcome).toBe('operational-error');
    expect(result.reasonCode).toBe('agent-task-reconciliation-failed');
  });

  it('does not reconcile a definitive rejection', async () => {
    const provider = new FakeAgentTasksProvider({
      result: {
        ok: false,
        reason: 'agent-invalid-request',
        message: 'bad model',
      },
    });
    const { result } = await run({ provider });
    expect(result.reasonCode).toBe('agent-invalid-request');
    // Only the dedup search ran; no reconciliation search.
    expect(provider.findFingerprints).toHaveLength(1);
  });
});

describe('history — best effort and bounded', () => {
  it('records unavailable optional history without blocking the new task', async () => {
    const provider = new FakeAgentTasksProvider({
      recentResult: { ok: true, tasks: [] },
    });
    const { result } = await run({
      provider,
      history: { commitsError: new Error('boom') },
    });
    expect(result.outcome).toBe('started');
    expect(result.historyUnavailable).toBe(true);
    expect(
      result.details.some((line) =>
        line.includes('agent-task-history-unavailable'),
      ),
    ).toBe(true);
  });

  it('feeds legacy copilot pull requests into the prompt as fallback only', async () => {
    const provider = new FakeAgentTasksProvider({
      recentResult: { ok: true, tasks: [] },
    });
    await run({
      provider,
      history: {
        legacyPullRequests: [
          {
            number: 9,
            state: 'open',
            url: 'https://github.com/acme/app/pull/9',
            headRef: 'copilot/old-fix',
          },
        ],
      },
    });
    expect(provider.inputs[0].prompt).toContain('legacy-pr-9');
  });

  it('skips deduplication and history collection entirely on a dry run', async () => {
    const provider = new FakeAgentTasksProvider();
    const { result } = await run({
      provider,
      inputs: { 'dry-run': 'true' },
    });
    expect(result.outcome).toBe('dry-run');
    expect(provider.findFingerprints).toHaveLength(0);
    expect(provider.listRecentCalls).toBe(0);
    expect(provider.inputs).toHaveLength(0);
  });
});
