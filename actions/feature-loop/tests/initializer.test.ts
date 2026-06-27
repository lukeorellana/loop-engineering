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
  initializeEpic,
  type InitializeEpicResult,
} from '../src/initializer/index.js';
import type { Logger } from '../src/ports/logger.js';
import {
  FakeGitHubApi,
  fakeIssue,
  type FakeConfig,
  type FakeIssue,
} from './helpers/fake-github-api.js';

const labels = DEFAULT_CANONICAL_STATE_LABELS;

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warning: () => {},
  error: () => {},
};

interface InitOptions {
  config: FakeConfig;
  intendedIssues: number[];
  dryRun?: boolean;
  forceReinitialize?: boolean;
  epicNumber?: number;
  /** Mutate the fake before running. */
  prepare?: (api: FakeGitHubApi) => void;
}

async function init(options: InitOptions): Promise<{
  result: InitializeEpicResult;
  api: FakeGitHubApi;
}> {
  const api = new FakeGitHubApi(options.config);
  options.prepare?.(api);
  const repository = new GitHubRepositoryAdapter({ api, labels });
  const result = await initializeEpic({
    repository,
    logger: silentLogger,
    epicNumber: options.epicNumber ?? 1,
    intendedIssues: options.intendedIssues,
    labels,
    dryRun: options.dryRun ?? false,
    forceReinitialize: options.forceReinitialize ?? false,
  });
  return { result, api };
}

/** Native sub-issue hierarchy operations that initialization must never make. */
const HIERARCHY_OPS = [
  'listSubIssues',
  'getParentIssueNumber',
  'addSubIssue',
  'removeSubIssue',
  'reprioritizeSubIssue',
];

/** Assert that the run made zero native sub-issue hierarchy calls. */
function expectNoHierarchyCalls(api: FakeGitHubApi): void {
  const hierarchyCalls = api.calls.filter((call) =>
    HIERARCHY_OPS.some((op) => call.op.startsWith(op)),
  );
  expect(hierarchyCalls).toEqual([]);
  expect(api.addedSubIssues).toHaveLength(0);
  expect(api.removedSubIssues).toHaveLength(0);
  expect(api.reprioritized).toHaveLength(0);
}

/** Build a config with an epic #1 and the given issues/parents/order. */
function epicConfig(
  issues: FakeIssue[],
  overrides: Partial<FakeConfig> = {},
): FakeConfig {
  const issueMap: Record<number, FakeIssue> = {
    1: fakeIssue({ number: 1, title: 'Epic' }),
  };
  for (const issue of issues) {
    issueMap[issue.number] = issue;
  }
  return {
    issues: issueMap,
    branches: ['main'],
    repoLabels: Object.values(labels),
    ...overrides,
  };
}

/** Seed the persisted plan comment on epic #1. */
function seededPlan(epicNumber: number, issues: number[]) {
  const plan = buildExecutionPlan(epicNumber, issues);
  const marker = epicPlanMarker(epicNumber);
  return {
    id: 5000,
    body: buildStatusCommentBody(marker, buildPlanCommentBody(plan)),
  };
}

describe('initializeEpic — fresh initialization', () => {
  it('freezes the plan for unlinked planned issues with zero hierarchy calls', async () => {
    // None of the issues are linked as native sub-issues of the epic.
    const { result, api } = await init({
      config: epicConfig([
        fakeIssue({ number: 11 }),
        fakeIssue({ number: 12 }),
      ]),
      intendedIssues: [11, 12],
    });

    expect(result.kind).toBe('initialized');
    expect(result.kind === 'initialized' && result.plan.issues).toEqual([
      11, 12,
    ]);
    // The plan is persisted on the epic.
    expect(api.createdComments.some((c) => c.issue === 1)).toBe(true);
    expectNoHierarchyCalls(api);
  });

  it('initializes regardless of the native linked order or membership', async () => {
    // The native order is empty, reversed, incomplete, and includes a stranger;
    // none of this affects the frozen plan derived from the authored order.
    const { result, api } = await init({
      config: epicConfig(
        [
          fakeIssue({ number: 11 }),
          fakeIssue({ number: 12 }),
          fakeIssue({ number: 13 }),
        ],
        { subIssues: { 1: [13, 99] }, parents: { 11: 7, 13: 1 } },
      ),
      intendedIssues: [11, 12, 13],
    });

    expect(result.kind).toBe('initialized');
    expect(result.kind === 'initialized' && result.plan.issues).toEqual([
      11, 12, 13,
    ]);
    expectNoHierarchyCalls(api);
  });

  it('initializes even when native hierarchy API calls would fail', async () => {
    const boom = (): never => {
      throw new Error('native hierarchy API is unavailable');
    };
    const { result, api } = await init({
      config: epicConfig([
        fakeIssue({ number: 11 }),
        fakeIssue({ number: 12 }),
      ]),
      intendedIssues: [11, 12],
      prepare: (fake) => {
        // Any native hierarchy read/mutation throws; initialization must not
        // depend on them.
        fake.listSubIssues = boom as typeof fake.listSubIssues;
        fake.getParentIssueNumber = boom as typeof fake.getParentIssueNumber;
        fake.addSubIssue = boom as typeof fake.addSubIssue;
        fake.removeSubIssue = boom as typeof fake.removeSubIssue;
        fake.reprioritizeSubIssue = boom as typeof fake.reprioritizeSubIssue;
      },
    });

    expect(result.kind).toBe('initialized');
    expect(api.createdComments.some((c) => c.issue === 1)).toBe(true);
  });
});

describe('initializeEpic — state normalization', () => {
  it('normalizes a completed issue with a stale running label to done', async () => {
    const { result, api } = await init({
      config: epicConfig([
        fakeIssue({
          number: 11,
          open: false,
          closedReason: 'completed',
          labelNames: [labels['in-progress']],
        }),
      ]),
      intendedIssues: [11],
    });

    expect(result.kind).toBe('initialized');
    expect(api.addedLabels).toContainEqual({
      issue: 11,
      labels: [labels.done],
    });
    expectNoHierarchyCalls(api);
  });

  it('fails closed on an unexpected active issue', async () => {
    const { result } = await init({
      config: epicConfig([
        fakeIssue({ number: 11, labelNames: [labels['in-progress']] }),
      ]),
      intendedIssues: [11],
    });

    expect(result.kind).toBe('unexpected-active-issue');
    expect(
      result.kind === 'unexpected-active-issue' && result.issueNumber,
    ).toBe(11);
  });

  it('allows an active issue during an explicit reinitialization', async () => {
    const { result } = await init({
      config: epicConfig([
        fakeIssue({ number: 11, labelNames: [labels['in-progress']] }),
      ]),
      intendedIssues: [11],
      forceReinitialize: true,
    });

    expect(result.kind).toBe('initialized');
  });
});

describe('initializeEpic — validation', () => {
  it('rejects duplicate issue references', async () => {
    const { result } = await init({
      config: epicConfig([fakeIssue({ number: 11 })]),
      intendedIssues: [11, 11],
    });
    expect(result.kind).toBe('failed');
  });

  it('rejects the epic appearing as its own sub-issue', async () => {
    const { result } = await init({
      config: epicConfig([fakeIssue({ number: 11 })]),
      intendedIssues: [1, 11],
    });
    expect(result.kind).toBe('failed');
  });

  it('rejects a missing issue', async () => {
    const { result } = await init({
      config: epicConfig([fakeIssue({ number: 11 })]),
      intendedIssues: [11, 404],
    });
    expect(result.kind).toBe('failed');
  });

  it('rejects an empty plan', async () => {
    const { result } = await init({
      config: epicConfig([]),
      intendedIssues: [],
    });
    expect(result.kind).toBe('failed');
  });
});

describe('initializeEpic — idempotency and reinitialization', () => {
  it('returns already-initialized for a normal rerun', async () => {
    const { result, api } = await init({
      config: epicConfig([fakeIssue({ number: 11 })], {
        comments: { 1: [seededPlan(1, [11])] },
      }),
      intendedIssues: [11],
    });

    expect(result.kind).toBe('already-initialized');
    expectNoHierarchyCalls(api);
  });

  it('rewrites the plan with the newly validated order when forced', async () => {
    const { result, api } = await init({
      config: epicConfig(
        [fakeIssue({ number: 11 }), fakeIssue({ number: 12 })],
        { comments: { 1: [seededPlan(1, [11])] } },
      ),
      intendedIssues: [11, 12],
      forceReinitialize: true,
    });

    expect(result.kind).toBe('initialized');
    expect(result.kind === 'initialized' && result.plan.issues).toEqual([
      11, 12,
    ]);
    expectNoHierarchyCalls(api);
  });
});

describe('initializeEpic — dry run', () => {
  it('reports proposed changes and performs zero writes', async () => {
    const { result, api } = await init({
      config: epicConfig([
        fakeIssue({ number: 11 }),
        fakeIssue({ number: 12 }),
      ]),
      intendedIssues: [11, 12],
      dryRun: true,
    });

    expect(result.kind).toBe('dry-run');
    expect(result.kind === 'dry-run' && result.details.length).toBeGreaterThan(
      0,
    );
    expect(api.addedSubIssues).toHaveLength(0);
    expect(api.reprioritized).toHaveLength(0);
    expect(api.createdComments).toHaveLength(0);
    expect(api.addedLabels).toHaveLength(0);
    expect(api.stateChanges).toHaveLength(0);
  });
});

describe('initializeEpic — LingoQuest plan', () => {
  it('freezes the exact plan [171..178] when the native order is empty', async () => {
    const issues = [171, 172, 173, 174, 175, 176, 177, 178];
    const { result, api } = await init({
      config: epicConfig(
        issues.map((number) => fakeIssue({ number })),
        // No native links at all: the authored order is authoritative.
        { subIssues: { 1: [] } },
      ),
      intendedIssues: issues,
    });

    expect(result.kind).toBe('initialized');
    expect(result.kind === 'initialized' && result.plan.issues).toEqual(issues);
    expect(api.createdComments.some((c) => c.issue === 1)).toBe(true);
    expectNoHierarchyCalls(api);
  });
});
