import { describe, expect, it } from 'vitest';

import {
  executeAction,
  finalize,
  type ActionEnvironment,
} from '../src/action/index.js';
import { ACTION_OUTPUT_NAMES } from '../src/action/outputs.js';
import type { TriageResult } from '../src/action/result.js';
import type {
  StartTaskResult,
  AgentTasksProvider,
} from '../src/adapters/agent-tasks/index.js';
import type {
  TriageEvent,
  TriageGitHubApi,
  TriageWorkflowRun,
} from '../src/adapters/github/index.js';
import type { CandidatePullRequest } from '../src/domain/index.js';
import { TRIAGE_OUTCOMES, TRIAGE_REASON_CODES } from '../src/domain/index.js';
import { FakeActionCore } from './helpers/fake-action-core.js';
import { FakeAgentTasksProvider } from './helpers/fake-agent-tasks.js';
import { FakeTriageGitHubApi } from './helpers/fake-triage-api.js';

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

function makePr(
  overrides: Partial<CandidatePullRequest> = {},
): CandidatePullRequest {
  return {
    number: 7,
    state: 'open',
    isFork: false,
    baseRef: 'main',
    headRef: HEAD_BRANCH,
    headSha: HEAD_SHA,
    ...overrides,
  };
}

/** A FakeTriageGitHubApi that resolves the standard PR-update target. */
function existingPrApi(): FakeTriageGitHubApi {
  return new FakeTriageGitHubApi({
    workflowRuns: { [RUN_ID]: makeRun() },
    pullRequests: { 7: makePr() },
  });
}

/** A FakeTriageGitHubApi that resolves a push-triggered new-PR target. */
function pushApi(): FakeTriageGitHubApi {
  return new FakeTriageGitHubApi({
    workflowRuns: {
      [RUN_ID]: makeRun({ event: 'push', pullRequestNumbers: [] }),
    },
    branchHeads: { [HEAD_BRANCH]: HEAD_SHA },
  });
}

interface RunOptions {
  readonly inputs?: Record<string, string>;
  readonly event?: TriageEvent;
  readonly api?: TriageGitHubApi;
  readonly provider?: AgentTasksProvider;
}

async function run(options: RunOptions = {}): Promise<{
  core: FakeActionCore;
  result: TriageResult;
  provider: FakeAgentTasksProvider;
}> {
  const core = new FakeActionCore({ ...VALID_INPUTS, ...options.inputs });
  const provider =
    (options.provider as FakeAgentTasksProvider | undefined) ??
    new FakeAgentTasksProvider();
  const env: ActionEnvironment = {
    core,
    repository: 'acme/app',
    event: options.event ?? COMPLETED_EVENT,
    buildTriageApi: () => options.api ?? existingPrApi(),
    buildAgentTasksProvider: () => provider,
  };
  const result = await executeAction(env);
  return { core, result, provider };
}

describe('executeAction — outputs contract', () => {
  it('sets all ten outputs on every normal exit path', async () => {
    const cases: RunOptions[] = [
      {}, // started (existing PR)
      { inputs: { 'dry-run': 'true' } }, // dry-run
      { inputs: { 'agent-token': '' } }, // configuration-error (invalid input)
      { event: { name: 'push' } }, // ignored (not a workflow_run event)
    ];
    for (const options of cases) {
      const { core } = await run(options);
      for (const name of ACTION_OUTPUT_NAMES) {
        expect(core.outputs).toHaveProperty(name);
      }
    }
  });

  it('emits empty strings for outputs that do not apply', async () => {
    const { core } = await run({ event: { name: 'push' } });
    expect(core.outputs['task-id']).toBe('');
    expect(core.outputs['task-url']).toBe('');
    expect(core.outputs['workflow-run-id']).toBe('');
    expect(core.outputs['resolved-mode']).toBe('');
    expect(core.outputs['target-base-ref']).toBe('');
    expect(core.outputs['existing-pr-number']).toBe('');
  });

  it('always reports a contract outcome and reason code', async () => {
    const { result } = await run();
    expect(TRIAGE_OUTCOMES).toContain(result.outcome);
    expect(TRIAGE_REASON_CODES).toContain(result.reasonCode);
  });
});

describe('executeAction — started (existing PR mode)', () => {
  it('starts a task, sets all target outputs, and does not fail the step', async () => {
    const { core, result, provider } = await run();
    expect(result.outcome).toBe('started');
    expect(result.reasonCode).toBe('task-started');
    expect(core.failed).toBeNull();
    expect(core.outputs['task-id']).toBe('task-1');
    expect(core.outputs['resolved-mode']).toBe('existing');
    expect(core.outputs['target-base-ref']).toBe('main');
    expect(core.outputs['target-head-ref']).toBe(HEAD_BRANCH);
    expect(core.outputs['existing-pr-number']).toBe('7');
    expect(core.outputs['workflow-run-id']).toBe(String(RUN_ID));
    // Existing mode passes both refs and reuses the PR (no new PR requested).
    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0].headRef).toBe(HEAD_BRANCH);
    expect(provider.inputs[0].baseRef).toBe('main');
  });
});

describe('executeAction — started (new PR mode, push)', () => {
  it('omits the head ref and never sets existing-pr-number', async () => {
    const { core, provider } = await run({ api: pushApi() });
    expect(core.outputs['resolved-mode']).toBe('new');
    expect(core.outputs['existing-pr-number']).toBe('');
    expect(provider.inputs[0].headRef).toBeUndefined();
    expect(provider.inputs[0].baseRef).toBe(HEAD_BRANCH);
  });
});

describe('executeAction — model override', () => {
  it('passes the model unchanged to the provider', async () => {
    const { provider } = await run({ inputs: { model: 'gpt-test:1' } });
    expect(provider.inputs[0].model).toBe('gpt-test:1');
  });

  it('omits the model when empty', async () => {
    const { provider } = await run({ inputs: { model: '' } });
    expect(provider.inputs[0].model).toBeUndefined();
  });
});

describe('executeAction — agent failures', () => {
  const failure = (result: StartTaskResult): AgentTasksProvider =>
    new FakeAgentTasksProvider({ result });

  it('maps invalid-model rejection to a configuration error', async () => {
    const { core, result } = await run({
      provider: failure({
        ok: false,
        reason: 'agent-invalid-request',
        message: 'invalid request',
      }),
    });
    expect(result.outcome).toBe('configuration-error');
    expect(result.reasonCode).toBe('agent-invalid-request');
    expect(core.failed).not.toBeNull();
  });

  it('maps authentication failure to a configuration error', async () => {
    const { result } = await run({
      provider: failure({
        ok: false,
        reason: 'agent-auth-failed',
        message: 'auth failed',
      }),
    });
    expect(result.outcome).toBe('configuration-error');
    expect(result.reasonCode).toBe('agent-auth-failed');
  });

  it('maps a rate-limit to an operational error', async () => {
    const { result } = await run({
      provider: failure({
        ok: false,
        reason: 'agent-rate-limited',
        message: 'rate limited',
      }),
    });
    expect(result.outcome).toBe('operational-error');
    expect(result.reasonCode).toBe('agent-rate-limited');
  });

  it('reconciles a transient create failure and reports reconciliation-failed when no task exists', async () => {
    const { result } = await run({
      provider: failure({
        ok: false,
        reason: 'agent-transient',
        message: 'transient',
      }),
    });
    expect(result.outcome).toBe('operational-error');
    expect(result.reasonCode).toBe('agent-task-reconciliation-failed');
  });

  it('reconciles a malformed create response and reports reconciliation-failed when no task exists', async () => {
    const { result } = await run({
      provider: failure({
        ok: false,
        reason: 'agent-unexpected-response',
        message: 'unexpected',
      }),
    });
    expect(result.outcome).toBe('operational-error');
    expect(result.reasonCode).toBe('agent-task-reconciliation-failed');
  });
});

describe('executeAction — dry run', () => {
  it('reports a preview, resolves the target, and performs zero writes', async () => {
    const provider = new FakeAgentTasksProvider();
    const { core, result } = await run({
      inputs: { 'dry-run': 'true' },
      provider,
    });
    expect(result.outcome).toBe('dry-run');
    expect(result.reasonCode).toBe('dry-run-preview');
    expect(result.dryRun).toBe(true);
    expect(core.failed).toBeNull();
    // The target is previewed...
    expect(core.outputs['resolved-mode']).toBe('existing');
    expect(core.outputs['target-base-ref']).toBe('main');
    // ...but no task is ever started.
    expect(provider.inputs).toHaveLength(0);
    expect(core.outputs['task-id']).toBe('');
  });
});

describe('executeAction — ignored and needs-human', () => {
  it('ignores a non-workflow_run event without contacting the provider', async () => {
    const provider = new FakeAgentTasksProvider();
    const { core, result } = await run({ event: { name: 'push' }, provider });
    expect(result.outcome).toBe('ignored');
    expect(result.reasonCode).toBe('not-a-workflow-run-event');
    expect(core.failed).toBeNull();
    expect(provider.inputs).toHaveLength(0);
  });

  it('pauses for human attention on a fork pull request', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun() },
      pullRequests: { 7: makePr({ isFork: true }) },
    });
    const provider = new FakeAgentTasksProvider();
    const { core, result } = await run({ api, provider });
    expect(result.outcome).toBe('needs-human');
    expect(result.reasonCode).toBe('fork-pull-request');
    expect(provider.inputs).toHaveLength(0);
    // Failed-run metadata is still surfaced for the operator.
    expect(core.outputs['workflow-run-id']).toBe(String(RUN_ID));
  });
});

describe('executeAction — invalid inputs', () => {
  it('fails closed with a configuration error', async () => {
    const { core, result } = await run({
      inputs: { 'pull-request-mode': 'bogus' },
    });
    expect(result.outcome).toBe('configuration-error');
    expect(result.reasonCode).toBe('invalid-input');
    expect(core.failed).not.toBeNull();
  });

  it('never starts work for an invalid run', async () => {
    const provider = new FakeAgentTasksProvider();
    const { core } = await run({ inputs: { 'agent-token': '' }, provider });
    expect(core.outputs['outcome']).toBe('configuration-error');
    expect(provider.inputs).toHaveLength(0);
  });
});

describe('executeAction — resolver failure', () => {
  it('reports a sanitized operational error when a read throws', async () => {
    const api: TriageGitHubApi = {
      getWorkflowRun: async () => {
        throw new Error('boom');
      },
      getPullRequest: async () => null,
      listPullRequestsForCommit: async () => [],
      getBranchHeadSha: async () => null,
    };
    const { core, result } = await run({ api });
    expect(result.outcome).toBe('operational-error');
    expect(core.failed).not.toBeNull();
  });
});

describe('executeAction — secrets and prompt redaction', () => {
  it('masks both tokens and never logs them or the prompt', async () => {
    const { core, provider } = await run({
      inputs: { 'additional-context': 'SENSITIVE-LOG-EVIDENCE-XYZ' },
    });
    expect(core.secrets).toContain('gh-secret-token');
    expect(core.secrets).toContain('agent-secret-token');
    // The prompt was built and contains the untrusted context...
    expect(provider.inputs[0].prompt).toContain('SENSITIVE-LOG-EVIDENCE-XYZ');
    // ...but it never reaches logs or the step summary.
    for (const line of core.allLogs()) {
      expect(line).not.toContain('gh-secret-token');
      expect(line).not.toContain('agent-secret-token');
      expect(line).not.toContain('SENSITIVE-LOG-EVIDENCE-XYZ');
    }
  });
});

describe('finalize — step summary resilience', () => {
  it('does not mask the outcome when the summary write fails', async () => {
    const core = new FakeActionCore(VALID_INPUTS);
    core.summary.write = async () => {
      throw new Error('summary boom');
    };
    const result: TriageResult = {
      outcome: 'dry-run',
      reasonCode: 'dry-run-preview',
      dryRun: true,
      details: [],
    };
    await expect(finalize(core, result)).resolves.toBe(result);
    expect(core.failed).toBeNull();
  });
});
