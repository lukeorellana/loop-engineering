import { describe, expect, it } from 'vitest';

import { DEFAULT_CANONICAL_STATE_LABELS } from '../src/config/schema.js';
import { GitHubRepositoryAdapter } from '../src/adapters/github/index.js';
import {
  buildPlanCommentBody,
  epicPlanMarker,
} from '../src/adapters/github/plan-comment.js';
import { buildStatusCommentBody } from '../src/adapters/github/status-comment.js';
import { buildExecutionPlan } from '../src/domain/plan.js';
import {
  runFeatureLoop,
  buildStatusComment,
  epicStatusMarker,
  type LoopRequest,
  type OrchestratorResult,
} from '../src/orchestrator/index.js';
import type { AgentStartRequest } from '../src/domain/agent.js';
import type { Logger } from '../src/ports/logger.js';
import {
  FakeGitHubApi,
  fakeIssue,
  type FakeConfig,
  type FakeIssue,
} from './helpers/fake-github-api.js';
import {
  FakeAgentProvider,
  type FakeAgentProviderConfig,
} from './helpers/fake-agent-provider.js';

const labels = DEFAULT_CANONICAL_STATE_LABELS;
const allLabelNames = Object.values(labels);

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warning: () => {},
  error: () => {},
};

class FixedClock {
  constructor(private readonly instant: Date) {}
  now(): Date {
    return this.instant;
  }
}

const CLOCK = new FixedClock(new Date('2024-06-01T12:00:00.000Z'));

interface RunOptions {
  config: FakeConfig;
  provider?: FakeAgentProviderConfig;
  request: LoopRequest;
  clock?: FixedClock;
}

interface RunResult {
  result: OrchestratorResult;
  api: FakeGitHubApi;
  provider: FakeAgentProvider;
}

async function run(options: RunOptions): Promise<RunResult> {
  const api = new FakeGitHubApi(options.config);
  const repository = new GitHubRepositoryAdapter({ api, labels });
  const provider = new FakeAgentProvider(options.provider);
  const result = await runFeatureLoop({
    repository,
    provider,
    clock: options.clock ?? CLOCK,
    logger: silentLogger,
    request: options.request,
  });
  return { result, api, provider };
}

/** Build the standard fixture: epic #1 with the given ordered sub-issues. */
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

const manual: LoopRequest = {
  event: { name: 'workflow_dispatch', epicNumber: 1 },
  dryRun: false,
};

/** Build a persisted plan comment for epic #1 with the given ordered issues. */
function seededPlan(epicNumber: number, issues: number[]) {
  const plan = buildExecutionPlan(epicNumber, issues);
  const marker = epicPlanMarker(epicNumber);
  return {
    id: 5000,
    body: buildStatusCommentBody(marker, buildPlanCommentBody(plan)),
  };
}

function closedDone(number: number, labelNames: string[] = []): FakeIssue {
  return fakeIssue({
    number,
    open: false,
    closedReason: 'completed',
    labelNames,
  });
}

function mergedPrRequest(
  prNumber: number,
  closes: number[],
  dryRun = false,
): LoopRequest {
  return {
    event: {
      name: 'pull_request',
      action: 'closed',
      pullRequest: {
        number: prNumber,
        merged: true,
        baseRef: 'main',
        headRef: 'feature',
        body: closes.map((n) => `Closes #${n}`).join('\n'),
        closingIssueReferences: closes,
      },
    },
    dryRun,
  };
}

describe('runFeatureLoop — initial start', () => {
  it('starts the first todo issue and marks it running', async () => {
    const { result, api, provider } = await run({
      config: epicConfig([
        fakeIssue({ number: 11 }),
        fakeIssue({ number: 12 }),
      ]),
      request: manual,
    });

    expect(result.outcome).toBe('started');
    expect(result.issueNumber).toBe(11);
    expect(provider.startRequests).toHaveLength(1);
    expect(provider.startRequests[0].issue.number).toBe(11);
    expect(api.addedLabels).toContainEqual({
      issue: 11,
      labels: [labels['in-progress']],
    });
    // A status comment with the hidden marker is posted on the issue, alongside
    // the frozen execution plan persisted on the epic during initialization.
    expect(api.createdComments).toHaveLength(2);
    const planComment = api.createdComments.find((c) => c.issue === 1);
    expect(planComment?.body).toContain(epicPlanMarker(1));
    const statusComment = api.createdComments.find((c) => c.issue === 11);
    expect(statusComment?.body).toContain(epicStatusMarker(1));
  });
});

describe('runFeatureLoop — merged pull-request continuation', () => {
  it('continues to the next issue after a trusted merge', async () => {
    const { result, provider } = await run({
      config: epicConfig([
        closedDone(11, [labels.done]),
        fakeIssue({ number: 12 }),
      ]),
      request: mergedPrRequest(20, [11]),
    });

    expect(result.outcome).toBe('started');
    expect(result.issueNumber).toBe(12);
    expect(provider.startRequests[0].issue.number).toBe(12);
  });

  it('marks the epic complete when the final issue is completed', async () => {
    const { result } = await run({
      config: epicConfig([
        closedDone(11, [labels.done]),
        closedDone(12, [labels.done]),
      ]),
      request: mergedPrRequest(20, [12]),
    });

    expect(result.outcome).toBe('complete');
  });

  it('is idempotent for a duplicate merged-PR event', async () => {
    // Issue 11 is already done; replaying the merge must not mutate it.
    const { result, api } = await run({
      config: epicConfig([
        closedDone(11, [labels.done]),
        fakeIssue({ number: 12 }),
      ]),
      request: mergedPrRequest(20, [11]),
    });

    expect(result.outcome).toBe('started');
    expect(result.issueNumber).toBe(12);
    // No close or label mutation on the already-complete issue 11.
    expect(api.stateChanges).toHaveLength(0);
    expect(api.addedLabels.filter((entry) => entry.issue === 11)).toHaveLength(
      0,
    );
  });

  it('resolves completion from the authoritative re-read, not the event payload', async () => {
    // The delivered webhook payload carries no closing information at all, but
    // the repository's authoritative pull request closes issue #11. The loop
    // must re-read the pull request and continue to the next issue.
    const { result, provider } = await run({
      config: epicConfig(
        [closedDone(11, [labels.done]), fakeIssue({ number: 12 })],
        {
          pulls: {
            20: {
              number: 20,
              merged: true,
              mergedBy: 'octocat',
              baseRef: 'main',
              headRef: 'feature',
              body: 'Closes #11',
              closesIssueNumbers: [11],
            },
          },
        },
      ),
      request: {
        event: {
          name: 'pull_request',
          action: 'closed',
          pullRequest: {
            number: 20,
            merged: true,
            baseRef: 'main',
            headRef: 'feature',
            body: null,
            closingIssueReferences: [],
          },
        },
        dryRun: false,
      },
    });

    expect(result.outcome).toBe('started');
    expect(result.issueNumber).toBe(12);
    expect(provider.startRequests[0].issue.number).toBe(12);
  });

  it('no-ops for an unmerged pull request', async () => {
    const config = epicConfig([fakeIssue({ number: 11 })]);
    const { result } = await run({
      config,
      request: {
        event: {
          name: 'pull_request',
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
        dryRun: false,
      },
    });
    expect(result.outcome).toBe('no-op');
    expect(result.reasonCode).toBe('not-merged');
  });
});

describe('runFeatureLoop — epic initialization and frozen plan', () => {
  it('initializes an uninitialized epic and persists the frozen plan before starting', async () => {
    const { result, api, provider } = await run({
      config: epicConfig([
        fakeIssue({ number: 11 }),
        fakeIssue({ number: 12 }),
      ]),
      request: manual,
    });

    expect(result.outcome).toBe('started');
    expect(result.issueNumber).toBe(11);
    expect(provider.startRequests[0].issue.number).toBe(11);
    // The frozen plan is persisted on the epic with the planned order.
    const planComment = api.createdComments.find((c) => c.issue === 1);
    expect(planComment?.body).toContain(epicPlanMarker(1));
  });

  it('is idempotent on a manual rerun of an already-initialized epic', async () => {
    const { result, api } = await run({
      config: epicConfig(
        [fakeIssue({ number: 11 }), fakeIssue({ number: 12 })],
        {
          comments: { 1: [seededPlan(1, [11, 12])] },
        },
      ),
      request: manual,
    });

    expect(result.outcome).toBe('started');
    expect(result.issueNumber).toBe(11);
    // No new plan comment is created on the epic; the existing plan is reused.
    expect(api.createdComments.filter((c) => c.issue === 1)).toHaveLength(0);
  });

  it('rewrites the plan only when reinitialization is explicitly requested', async () => {
    const { result, api } = await run({
      config: epicConfig(
        [fakeIssue({ number: 11 }), fakeIssue({ number: 12 })],
        {
          comments: { 1: [seededPlan(1, [11])] },
        },
      ),
      request: { ...manual, forceReinitialize: true },
    });

    expect(result.outcome).toBe('started');
    // The stored plan comment is updated to reflect the reauthored order.
    expect(
      api.updatedComments.some((c) => c.body.includes(epicPlanMarker(1))),
    ).toBe(true);
  });

  it('fails closed when the authored plan has duplicate issue references', async () => {
    const { result, provider } = await run({
      config: epicConfig([fakeIssue({ number: 11 })], {
        subIssues: { 1: [11, 11] },
      }),
      request: manual,
    });

    expect(result.outcome).toBe('configuration-error');
    expect(result.reasonCode).toBe('initialization-failed');
    expect(provider.startRequests).toHaveLength(0);
  });

  it('pauses an uninitialized epic with an unexpected in-progress issue', async () => {
    const { result, provider } = await run({
      config: epicConfig([
        fakeIssue({ number: 11, labelNames: [labels['in-progress']] }),
        fakeIssue({ number: 12 }),
      ]),
      request: manual,
    });

    expect(result.outcome).toBe('needs-human');
    expect(result.reasonCode).toBe('unexpected-active-issue');
    expect(provider.startRequests).toHaveLength(0);
  });

  it('continues a merged-PR run from the frozen plan order', async () => {
    const { result, api, provider } = await run({
      config: epicConfig(
        [closedDone(11, [labels.done]), fakeIssue({ number: 12 })],
        { comments: { 1: [seededPlan(1, [11, 12])] } },
      ),
      request: mergedPrRequest(20, [11]),
    });

    expect(result.outcome).toBe('started');
    expect(result.issueNumber).toBe(12);
    expect(provider.startRequests[0].issue.number).toBe(12);
    // A continuation run never rewrites the frozen plan.
    expect(api.createdComments.filter((c) => c.issue === 1)).toHaveLength(0);
  });

  it('pauses with plan-drift when the native hierarchy no longer matches the plan', async () => {
    const { result, provider } = await run({
      config: epicConfig(
        [closedDone(11, [labels.done]), fakeIssue({ number: 12 })],
        {
          comments: { 1: [seededPlan(1, [11, 12])] },
          // The native sub-issue order drifted away from the frozen plan.
          subIssues: { 1: [12, 11] },
        },
      ),
      request: mergedPrRequest(20, [11]),
    });

    expect(result.outcome).toBe('needs-human');
    expect(result.reasonCode).toBe('plan-drift');
    expect(provider.startRequests).toHaveLength(0);
  });
});

describe('runFeatureLoop — paused states', () => {
  it('pauses for blocked head-of-line work', async () => {
    const { result, provider } = await run({
      config: epicConfig([
        fakeIssue({ number: 11, labelNames: [labels.blocked] }),
      ]),
      request: manual,
    });
    expect(result.outcome).toBe('needs-human');
    expect(result.reasonCode).toBe('blocked');
    expect(provider.startRequests).toHaveLength(0);
  });

  it('pauses for contradictory canonical state labels', async () => {
    const { result } = await run({
      config: epicConfig([
        fakeIssue({ number: 11, labelNames: [labels.todo, labels.blocked] }),
      ]),
      request: manual,
    });
    expect(result.outcome).toBe('needs-human');
    expect(result.reasonCode).toBe('multiple-canonical-state-labels');
  });

  it('pauses when a head-of-line issue has multiple linked pull requests', async () => {
    const { result, api, provider } = await run({
      config: epicConfig([fakeIssue({ number: 11 })], {
        linkedPulls: { 11: [20, 21] },
      }),
      request: manual,
    });
    expect(result.outcome).toBe('needs-human');
    expect(result.reasonCode).toBe('multiple-linked-pull-requests');
    expect(provider.startRequests).toHaveLength(0);
    expect(api.addedLabels).toContainEqual({
      issue: 11,
      labels: [labels['needs-human']],
    });
  });
});

describe('runFeatureLoop — assignment outcomes', () => {
  it('leaves a recoverable needs-human state on assignment failure', async () => {
    const { result, api } = await run({
      config: epicConfig([fakeIssue({ number: 11 })]),
      provider: {
        startResult: (request: AgentStartRequest) => ({
          status: 'failed',
          issueNumber: request.issue.number,
          error: 'boom',
          reason: 'unavailable',
        }),
      },
      request: manual,
    });
    expect(result.outcome).toBe('needs-human');
    expect(result.reasonCode).toBe('assignment-failed');
    expect(api.addedLabels).toContainEqual({
      issue: 11,
      labels: [labels['needs-human']],
    });
    // The sanitized comment must not contain the raw provider error.
    const bodies = [
      ...api.createdComments.map((c) => c.body),
      ...api.updatedComments.map((c) => c.body),
    ].join('\n');
    expect(bodies).not.toContain('boom');
  });

  it('reconciles an uncertain assignment that actually succeeded', async () => {
    const { result } = await run({
      config: epicConfig([fakeIssue({ number: 11 })]),
      provider: {
        // First read (idempotency) reports not started; reconcile confirms it.
        alreadyStartedSequence: [false, true],
        startResult: (request: AgentStartRequest) => ({
          status: 'uncertain',
          issueNumber: request.issue.number,
          detail: 'response lost',
        }),
      },
      request: manual,
    });
    expect(result.outcome).toBe('started');
    expect(result.issueNumber).toBe(11);
  });

  it('pauses when an uncertain assignment cannot be confirmed', async () => {
    const { result } = await run({
      config: epicConfig([fakeIssue({ number: 11 })]),
      provider: {
        alreadyStartedSequence: [false, false],
        startResult: (request: AgentStartRequest) => ({
          status: 'uncertain',
          issueNumber: request.issue.number,
          detail: 'response lost',
        }),
      },
      request: manual,
    });
    expect(result.outcome).toBe('needs-human');
    expect(result.reasonCode).toBe('assignment-failed');
  });

  it('leaves a recoverable needs-human state when the provider throws', async () => {
    const { result, api } = await run({
      config: epicConfig([fakeIssue({ number: 11 })]),
      provider: {
        startResult: () => {
          throw new Error('transport exploded');
        },
      },
      request: manual,
    });
    expect(result.outcome).toBe('needs-human');
    expect(result.reasonCode).toBe('assignment-failed');
    expect(api.addedLabels).toContainEqual({
      issue: 11,
      labels: [labels['needs-human']],
    });
    // The raw provider error stays out of the sanitized comment.
    const bodies = [
      ...api.createdComments.map((c) => c.body),
      ...api.updatedComments.map((c) => c.body),
    ].join('\n');
    expect(bodies).not.toContain('transport exploded');
  });
});

describe('runFeatureLoop — idempotency and reconciliation', () => {
  it('does not re-assign on a duplicate manual dispatch', async () => {
    const { result, provider } = await run({
      config: epicConfig(
        [fakeIssue({ number: 11, labelNames: [labels['in-progress']] })],
        { comments: { 1: [seededPlan(1, [11])] } },
      ),
      provider: { alreadyStarted: true },
      request: manual,
    });
    expect(result.outcome).toBe('already-running');
    expect(result.issueNumber).toBe(11);
    expect(provider.startRequests).toHaveLength(0);
  });

  it('normalizes stale running labels on a closed issue', async () => {
    const { result, api } = await run({
      config: epicConfig([
        closedDone(11, [labels['in-progress']]),
        fakeIssue({ number: 12 }),
      ]),
      request: manual,
    });
    expect(api.removedLabels).toContainEqual({
      issue: 11,
      label: labels['in-progress'],
    });
    expect(api.addedLabels).toContainEqual({
      issue: 11,
      labels: [labels.done],
    });
    expect(result.outcome).toBe('started');
    expect(result.issueNumber).toBe(12);
  });

  it('reports the age of stalled active work without timing out', async () => {
    const startedAt = '2024-06-01T09:00:00.000Z'; // three hours before the clock
    const seeded = buildStatusComment(
      {
        epic: 1,
        issue: 11,
        provider: 'fake-provider',
        state: 'running',
        reason: 'started',
        startedAt,
      },
      'previous status',
    );
    const { result, provider } = await run({
      config: epicConfig(
        [fakeIssue({ number: 11, labelNames: [labels['in-progress']] })],
        {
          comments: {
            1: [seededPlan(1, [11])],
            11: [{ id: 99, body: seeded.body }],
          },
        },
      ),
      provider: { alreadyStarted: true },
      request: manual,
    });
    expect(result.outcome).toBe('already-running');
    expect(provider.startRequests).toHaveLength(0); // never reassigns
    expect(result.details.join(' ')).toContain('active for 3h');
  });

  it('reports a running issue whose agent is no longer assigned', async () => {
    const { result, provider } = await run({
      config: epicConfig(
        [fakeIssue({ number: 11, labelNames: [labels['in-progress']] })],
        { comments: { 1: [seededPlan(1, [11])] } },
      ),
      provider: { alreadyStarted: false },
      request: manual,
    });
    expect(result.outcome).toBe('already-running');
    expect(provider.startRequests).toHaveLength(0); // never reassigns
    expect(result.details.join(' ')).toContain('no longer assigned');
  });

  it('resumes after a human repair', async () => {
    // A human cleared an invalid state, leaving the head issue as plain todo.
    const { result } = await run({
      config: epicConfig([
        fakeIssue({ number: 11, labelNames: [labels.todo] }),
        fakeIssue({ number: 12 }),
      ]),
      request: manual,
    });
    expect(result.outcome).toBe('started');
    expect(result.issueNumber).toBe(11);
  });
});

describe('runFeatureLoop — no-op and dry-run', () => {
  it('no-ops on an unrelated event', async () => {
    const { result } = await run({
      config: epicConfig([fakeIssue({ number: 11 })]),
      request: { event: { name: 'issues', action: 'labeled' }, dryRun: false },
    });
    expect(result.outcome).toBe('no-op');
    expect(result.reasonCode).toBe('event-not-applicable');
  });

  it('performs no writes in dry-run mode', async () => {
    const { result, api, provider } = await run({
      config: epicConfig([
        fakeIssue({ number: 11 }),
        fakeIssue({ number: 12 }),
      ]),
      request: {
        event: { name: 'workflow_dispatch', epicNumber: 1 },
        dryRun: true,
      },
    });
    expect(result.outcome).toBe('dry-run');
    expect(result.issueNumber).toBe(11);
    expect(api.addedLabels).toHaveLength(0);
    expect(api.removedLabels).toHaveLength(0);
    expect(api.stateChanges).toHaveLength(0);
    expect(api.createdComments).toHaveLength(0);
    expect(api.updatedComments).toHaveLength(0);
    expect(api.createdLabels).toHaveLength(0);
    expect(provider.startRequests).toHaveLength(0);
  });
});

describe('runFeatureLoop — preflight failures', () => {
  it('fails closed when the epic does not exist', async () => {
    const { result } = await run({
      config: epicConfig([fakeIssue({ number: 11 })]),
      request: {
        event: { name: 'workflow_dispatch', epicNumber: 999 },
        dryRun: false,
      },
    });
    expect(result.outcome).toBe('configuration-error');
  });

  it('surfaces a provider preflight failure as a configuration error', async () => {
    const { result } = await run({
      config: epicConfig([fakeIssue({ number: 11 })]),
      provider: {
        preflightResult: {
          ok: false,
          reason: 'actor-not-found',
          messages: ['Copilot is not available.'],
        },
      },
      request: manual,
    });
    expect(result.outcome).toBe('configuration-error');
    expect(result.details.join(' ')).toContain('Copilot is not available.');
  });
});

function prOpenedRequest(prNumber: number, dryRun = false): LoopRequest {
  return {
    event: {
      name: 'pull_request',
      action: 'opened',
      pullRequest: {
        number: prNumber,
        merged: false,
        baseRef: 'main',
        headRef: 'copilot/feature',
        body: 'Implements the change.',
        closingIssueReferences: [],
      },
    },
    dryRun,
  };
}

function copilotPull(
  number: number,
  overrides: Partial<{
    author: string | null;
    baseRef: string;
    body: string | null;
    closesIssueNumbers: number[];
  }> = {},
) {
  return {
    number,
    merged: false,
    mergedBy: null,
    author: 'copilot-swe-agent',
    baseRef: 'main',
    headRef: 'copilot/feature',
    body: 'Implements the change.',
    closesIssueNumbers: [],
    ...overrides,
  };
}

const copilotProvider = { authorLogins: ['copilot-swe-agent', 'copilot'] };

describe('runFeatureLoop — pull-request link reconciliation', () => {
  it('links a Copilot PR to the single active sub-issue', async () => {
    const { result, api } = await run({
      config: epicConfig(
        [fakeIssue({ number: 11, labelNames: [labels['in-progress']] })],
        { pulls: { 456: copilotPull(456) } },
      ),
      provider: copilotProvider,
      request: prOpenedRequest(456),
    });

    expect(result.outcome).toBe('already-running');
    expect(result.reasonCode).toBe('pull-request-linked');
    expect(result.issueNumber).toBe(11);
    expect(api.updatedPulls).toEqual([
      { pull: 456, body: 'Implements the change.\n\nCloses #11\n' },
    ]);
  });

  it('reports the closing relationship GitHub records after the update', async () => {
    const { api } = await run({
      config: epicConfig(
        [fakeIssue({ number: 11, labelNames: [labels['in-progress']] })],
        { pulls: { 456: copilotPull(456) } },
      ),
      provider: copilotProvider,
      request: prOpenedRequest(456),
    });

    const pull = await api.getPullRequest(456);
    expect(pull?.closesIssueNumbers).toEqual([11]);
  });

  it('leaves an already-linked PR unchanged', async () => {
    const { result, api } = await run({
      config: epicConfig(
        [fakeIssue({ number: 11, labelNames: [labels['in-progress']] })],
        { pulls: { 456: copilotPull(456, { closesIssueNumbers: [11] }) } },
      ),
      provider: copilotProvider,
      request: prOpenedRequest(456),
    });

    expect(result.outcome).toBe('no-op');
    expect(result.reasonCode).toBe('already-linked');
    expect(api.updatedPulls).toEqual([]);
  });

  it('is idempotent when the body already contains the closing line', async () => {
    const { result, api } = await run({
      config: epicConfig(
        [fakeIssue({ number: 11, labelNames: [labels['in-progress']] })],
        {
          pulls: {
            456: copilotPull(456, {
              body: 'Implements the change.\n\nCloses #11\n',
            }),
          },
        },
      ),
      provider: copilotProvider,
      request: prOpenedRequest(456),
    });

    expect(result.outcome).toBe('no-op');
    expect(result.reasonCode).toBe('already-linked');
    expect(api.updatedPulls).toEqual([]);
  });

  it('ignores a PR authored by someone other than the coding agent', async () => {
    const { result, api } = await run({
      config: epicConfig(
        [fakeIssue({ number: 11, labelNames: [labels['in-progress']] })],
        { pulls: { 456: copilotPull(456, { author: 'octocat' }) } },
      ),
      provider: copilotProvider,
      request: prOpenedRequest(456),
    });

    expect(result.outcome).toBe('no-op');
    expect(result.reasonCode).toBe('wrong-author');
    expect(api.updatedPulls).toEqual([]);
  });

  it('ignores a PR targeting the wrong base branch', async () => {
    const { result, api } = await run({
      config: epicConfig(
        [fakeIssue({ number: 11, labelNames: [labels['in-progress']] })],
        { pulls: { 456: copilotPull(456, { baseRef: 'develop' }) } },
      ),
      provider: copilotProvider,
      request: prOpenedRequest(456),
    });

    expect(result.outcome).toBe('no-op');
    expect(result.reasonCode).toBe('wrong-base-branch');
    expect(api.updatedPulls).toEqual([]);
  });

  it('does nothing when no sub-issue is active', async () => {
    const { result, api } = await run({
      config: epicConfig([fakeIssue({ number: 11 })], {
        pulls: { 456: copilotPull(456) },
      }),
      provider: copilotProvider,
      request: prOpenedRequest(456),
    });

    expect(result.outcome).toBe('no-op');
    expect(result.reasonCode).toBe('no-active-issue');
    expect(api.updatedPulls).toEqual([]);
  });

  it('fails closed when multiple sub-issues are active', async () => {
    const { result, api } = await run({
      config: epicConfig(
        [
          fakeIssue({ number: 11, labelNames: [labels['in-progress']] }),
          fakeIssue({ number: 12, labelNames: [labels['in-progress']] }),
        ],
        { pulls: { 456: copilotPull(456) } },
      ),
      provider: copilotProvider,
      request: prOpenedRequest(456),
    });

    expect(result.outcome).toBe('needs-human');
    expect(result.reasonCode).toBe('ambiguous-active-issue');
    expect(api.updatedPulls).toEqual([]);
  });

  it('performs no writes and previews the link in dry run', async () => {
    const { result, api } = await run({
      config: epicConfig(
        [fakeIssue({ number: 11, labelNames: [labels['in-progress']] })],
        { pulls: { 456: copilotPull(456) } },
      ),
      provider: copilotProvider,
      request: prOpenedRequest(456, true),
    });

    expect(result.outcome).toBe('dry-run');
    expect(result.reasonCode).toBe('pull-request-link');
    expect(result.issueNumber).toBe(11);
    expect(result.details[0]).toContain('would link');
    expect(api.updatedPulls).toEqual([]);
  });
});
