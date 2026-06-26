import { describe, expect, it } from 'vitest';

import {
  executeAction,
  finalize,
  type ActionEnvironment,
} from '../src/action/index.js';
import { ACTION_OUTPUT_NAMES } from '../src/action/outputs.js';
import { DEFAULT_CANONICAL_STATE_LABELS } from '../src/config/schema.js';
import type { OrchestratorResult } from '../src/orchestrator/index.js';
import type { Clock } from '../src/ports/clock.js';
import { FakeActionCore } from './helpers/fake-action-core.js';
import {
  FakeGitHubApi,
  fakeIssue,
  type FakeConfig,
  type FakeIssue,
} from './helpers/fake-github-api.js';
import { FakeCopilotAgentApi } from './helpers/fake-copilot-api.js';

const labels = DEFAULT_CANONICAL_STATE_LABELS;
const allLabelNames = Object.values(labels);

const CLOCK: Clock = { now: () => new Date('2024-06-01T12:00:00.000Z') };

/** A Copilot transport that can start any of the given issue numbers. */
function copilotFor(issueNumbers: number[]): FakeCopilotAgentApi {
  const issues: Record<number, { id: string; assigneeLogins: string[] }> = {};
  for (const number of issueNumbers) {
    issues[number] = { id: `node-${number}`, assigneeLogins: [] };
  }
  return new FakeCopilotAgentApi({
    actors: [{ id: 'BOT', login: 'copilot-swe-agent', typename: 'Bot' }],
    issues,
    assignPersists: true,
  });
}

function epicConfig(
  subIssues: FakeIssue[],
  overrides: Partial<FakeConfig> = {},
): FakeConfig {
  const issues: Record<number, FakeIssue> = {
    1: fakeIssue({ number: 1, title: 'Epic' }),
  };
  const parents: Record<number, number> = {};
  for (const issue of subIssues) {
    issues[issue.number] = issue;
    parents[issue.number] = 1;
  }
  return {
    issues,
    subIssues: { 1: subIssues.map((issue) => issue.number) },
    parents,
    branches: ['main'],
    repoLabels: allLabelNames,
    ...overrides,
  };
}

function closedDone(number: number): FakeIssue {
  return fakeIssue({
    number,
    open: false,
    closedReason: 'completed',
    labelNames: [labels.done],
  });
}

interface RunOptions {
  inputs?: Record<string, string>;
  event: ActionEnvironment['event'];
  config?: FakeConfig;
  copilot?: FakeCopilotAgentApi;
}

interface RunResult {
  result: OrchestratorResult;
  core: FakeActionCore;
  api: FakeGitHubApi;
}

async function run(options: RunOptions): Promise<RunResult> {
  const core = new FakeActionCore({
    'github-token': 'gh-secret-token',
    'dry-run': 'false',
    ...options.inputs,
  });
  const api = new FakeGitHubApi(options.config ?? epicConfig([]));
  const copilot = options.copilot ?? copilotFor([]);
  const env: ActionEnvironment = {
    core,
    clock: CLOCK,
    event: options.event,
    buildRepositoryApi: () => api,
    buildAgentApi: () => copilot,
  };
  const result = await executeAction(env);
  return { result, core, api };
}

describe('executeAction — outputs contract', () => {
  it('sets all five outputs on every normal exit path', async () => {
    const { core } = await run({
      inputs: { 'epic-issue': '1' },
      event: { eventName: 'workflow_dispatch' },
      config: epicConfig([fakeIssue({ number: 11 })]),
      copilot: copilotFor([11]),
    });
    for (const name of ACTION_OUTPUT_NAMES) {
      expect(core.outputs).toHaveProperty(name);
    }
  });
});

describe('executeAction — manual start', () => {
  it('starts the first todo issue and reports success', async () => {
    const { result, core, api } = await run({
      inputs: { 'epic-issue': '1' },
      event: { eventName: 'workflow_dispatch' },
      config: epicConfig([
        fakeIssue({ number: 11 }),
        fakeIssue({ number: 12 }),
      ]),
      copilot: copilotFor([11]),
    });

    expect(result.outcome).toBe('started');
    expect(core.outputs.outcome).toBe('started');
    expect(core.outputs['epic-issue']).toBe('1');
    expect(core.outputs['active-issue']).toBe('11');
    expect(core.outputs['completed-issue']).toBe('');
    expect(core.outputs.reason).toBe('started');
    expect(core.failed).toBeNull();
    expect(api.addedLabels).toContainEqual({
      issue: 11,
      labels: [labels['in-progress']],
    });
    expect(core.summary.buffer).toContain('Feature Loop');
    expect(core.summary.buffer).toContain('#11');
  });

  it('masks the credential and never logs it', async () => {
    const { core } = await run({
      inputs: { 'epic-issue': '1', 'github-token': 'super-secret-pat' },
      event: { eventName: 'workflow_dispatch' },
      config: epicConfig([fakeIssue({ number: 11 })]),
      copilot: copilotFor([11]),
    });
    expect(core.secrets).toContain('super-secret-pat');
    for (const line of core.allLogs()) {
      expect(line).not.toContain('super-secret-pat');
    }
  });
});

describe('executeAction — dry run', () => {
  it('previews without writing and completes successfully', async () => {
    const { result, core, api } = await run({
      inputs: { 'epic-issue': '1', 'dry-run': 'true' },
      event: { eventName: 'workflow_dispatch' },
      config: epicConfig([fakeIssue({ number: 11 })]),
      copilot: copilotFor([11]),
    });

    expect(result.outcome).toBe('dry-run');
    expect(core.outputs.outcome).toBe('dry-run');
    expect(core.outputs['active-issue']).toBe('11');
    expect(core.failed).toBeNull();
    expect(core.summary.buffer).toContain('(dry run)');
    // Strictly read-only.
    expect(api.addedLabels).toHaveLength(0);
    expect(api.createdComments).toHaveLength(0);
    expect(api.stateChanges).toHaveLength(0);
  });
});

describe('executeAction — merged pull-request continuation', () => {
  it('reports the completed issue and continues to the next', async () => {
    const { result, core } = await run({
      event: {
        eventName: 'pull_request',
        action: 'closed',
        pullRequest: {
          number: 20,
          merged: true,
          baseRef: 'main',
          headRef: 'feature',
          body: 'Closes #11',
          closingIssueReferences: [11],
        },
      },
      config: epicConfig([closedDone(11), fakeIssue({ number: 12 })]),
      copilot: copilotFor([12]),
    });

    expect(result.outcome).toBe('started');
    expect(core.outputs['active-issue']).toBe('12');
    expect(core.outputs['completed-issue']).toBe('11');
    expect(core.failed).toBeNull();
  });

  it('ignores a pull request closed without merging', async () => {
    const { result, core } = await run({
      event: {
        eventName: 'pull_request',
        action: 'closed',
        pullRequest: {
          number: 20,
          merged: false,
          baseRef: 'main',
          headRef: 'feature',
          body: 'Closes #11',
          closingIssueReferences: [11],
        },
      },
      config: epicConfig([fakeIssue({ number: 11 })]),
    });

    expect(result.outcome).toBe('no-op');
    expect(core.outputs.reason).toBe('not-merged');
    expect(core.failed).toBeNull();
  });
});

describe('executeAction — pauses and no-ops complete successfully', () => {
  it('does not fail the step on an unrelated event', async () => {
    const { result, core } = await run({
      event: { eventName: 'push' },
      config: epicConfig([fakeIssue({ number: 11 })]),
    });
    expect(result.outcome).toBe('no-op');
    expect(core.failed).toBeNull();
  });
});

describe('executeAction — failing exit paths', () => {
  it('fails the step on invalid input', async () => {
    const { result, core } = await run({
      inputs: { 'epic-issue': 'not-a-number' },
      event: { eventName: 'workflow_dispatch' },
      config: epicConfig([fakeIssue({ number: 11 })]),
    });
    expect(result.outcome).toBe('configuration-error');
    expect(result.reasonCode).toBe('invalid-input');
    expect(core.failed).not.toBeNull();
    // Outputs are still published.
    expect(core.outputs.outcome).toBe('configuration-error');
  });

  it('fails the step when a required credential is missing', async () => {
    const { core } = await run({
      inputs: { 'epic-issue': '1', 'github-token': '' },
      event: { eventName: 'workflow_dispatch' },
      config: epicConfig([fakeIssue({ number: 11 })]),
    });
    expect(core.failed).not.toBeNull();
    expect(core.outputs.outcome).toBe('configuration-error');
  });

  it('fails the step when the epic does not exist', async () => {
    const { result, core } = await run({
      inputs: { 'epic-issue': '999' },
      event: { eventName: 'workflow_dispatch' },
      config: epicConfig([fakeIssue({ number: 11 })]),
    });
    expect(result.outcome).toBe('configuration-error');
    expect(core.failed).not.toBeNull();
  });
});

describe('finalize — notices and failure diagnostics', () => {
  it('fails with the primary detail, not an informational notice', async () => {
    const core = new FakeActionCore();
    const result: OrchestratorResult = {
      outcome: 'configuration-error',
      reasonCode: 'initialization-failed',
      dryRun: false,
      details: ['actual hierarchy failure', 'secondary failure detail'],
      notices: [
        'Ordered sub-issues discovered from Markdown via the structural fallback.',
      ],
    };

    await finalize(core, result);

    expect(core.failed).toBe('actual hierarchy failure');
    expect(core.failed).not.toBe(
      'Ordered sub-issues discovered from Markdown via the structural fallback.',
    );
    expect(core.summary.buffer).toContain('### Notices');
    expect(core.summary.buffer).toContain(
      'Ordered sub-issues discovered from Markdown via the structural fallback.',
    );
    expect(core.summary.buffer).toContain('### Details');
    expect(core.summary.buffer).toContain('actual hierarchy failure');
    expect(core.summary.buffer).toContain('secondary failure detail');
  });

  it('falls back to the reason code when a failed result has no details', async () => {
    const core = new FakeActionCore();

    await finalize(core, {
      outcome: 'operational-error',
      reasonCode: 'transport-failed',
      dryRun: false,
      details: [],
      notices: ['informational context'],
    });

    expect(core.failed).toBe('Feature Loop failed: transport-failed.');
  });

  it('does not fail successful or needs-human results that include notices', async () => {
    const successCore = new FakeActionCore();
    await finalize(successCore, {
      outcome: 'started',
      reasonCode: 'started',
      dryRun: false,
      issueNumber: 11,
      details: ['Feature Loop started issue #11.'],
      notices: ['informational context'],
    });

    const needsHumanCore = new FakeActionCore();
    await finalize(needsHumanCore, {
      outcome: 'needs-human',
      reasonCode: 'blocked',
      dryRun: false,
      issueNumber: 11,
      details: ['Feature Loop paused at issue #11: blocked.'],
      notices: ['informational context'],
    });

    expect(successCore.failed).toBeNull();
    expect(needsHumanCore.failed).toBeNull();
    expect(successCore.summary.buffer).toContain('informational context');
    expect(needsHumanCore.summary.buffer).toContain('informational context');
  });
});

describe('executeAction — custom configuration labels', () => {
  it('resolves issue state with the configured labels', async () => {
    const configFile = [
      'version: 1',
      'labels:',
      "  in-progress: 'custom:running'",
    ].join('\n');
    const customLabels = [
      ...allLabelNames.filter((name) => name !== labels['in-progress']),
      'custom:running',
    ];
    const { result, core } = await run({
      inputs: { 'epic-issue': '1' },
      event: { eventName: 'workflow_dispatch' },
      config: epicConfig([fakeIssue({ number: 11 })], {
        files: { '.github/feature-loop.yml': configFile },
        repoLabels: customLabels,
      }),
      copilot: copilotFor([11]),
    });

    expect(result.outcome).toBe('started');
    expect(core.outputs['active-issue']).toBe('11');
  });
});
