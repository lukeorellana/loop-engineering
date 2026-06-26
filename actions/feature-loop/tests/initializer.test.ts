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
import type { BackoffPolicy, RetryTiming } from '../src/initializer/retry.js';
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
  exactSync?: boolean;
  dryRun?: boolean;
  forceReinitialize?: boolean;
  epicNumber?: number;
  /** Mutate the fake (install transient/visibility hooks) before running. */
  prepare?: (api: FakeGitHubApi) => void;
  /** Optional bounded backoff override (defaults to a small bounded policy). */
  backoff?: BackoffPolicy;
}

/** Deterministic, zero-delay timing so retry/backoff tests run instantly. */
const instantTiming: RetryTiming = {
  sleep: async () => {},
  random: () => 0,
};

/** A small bounded policy used by tests to keep retry counts predictable. */
const testBackoff: BackoffPolicy = {
  maxAttempts: 5,
  initialDelayMs: 1,
  maxDelayMs: 1,
};

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
    exactSync: options.exactSync ?? true,
    dryRun: options.dryRun ?? false,
    forceReinitialize: options.forceReinitialize ?? false,
    backoff: options.backoff ?? testBackoff,
    timing: instantTiming,
  });
  return { result, api };
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
  it('attaches unparented issues and persists the plan', async () => {
    const { result, api } = await init({
      config: epicConfig([
        fakeIssue({ number: 11 }),
        fakeIssue({ number: 12 }),
      ]),
      intendedIssues: [11, 12],
    });

    expect(result.kind).toBe('initialized');
    expect(api.addedSubIssues.map((entry) => entry.sub).sort()).toEqual([
      11, 12,
    ]);
    // The plan is persisted on the epic after verification.
    expect(api.createdComments.some((c) => c.issue === 1)).toBe(true);
  });

  it('does no hierarchy writes when already fully linked and ordered', async () => {
    const { result, api } = await init({
      config: epicConfig(
        [fakeIssue({ number: 11 }), fakeIssue({ number: 12 })],
        { subIssues: { 1: [11, 12] }, parents: { 11: 1, 12: 1 } },
      ),
      intendedIssues: [11, 12],
    });

    expect(result.kind).toBe('initialized');
    expect(api.addedSubIssues).toHaveLength(0);
    expect(api.reprioritized).toHaveLength(0);
    expect(api.removedSubIssues).toHaveLength(0);
  });
});

describe('initializeEpic — repair and reparenting', () => {
  it('reparents an issue attached to a different epic', async () => {
    const { result, api } = await init({
      config: epicConfig([fakeIssue({ number: 11 })], {
        subIssues: { 1: [], 9: [11] },
        parents: { 11: 9 },
      }),
      intendedIssues: [11],
    });

    expect(result.kind).toBe('initialized');
    expect(api.addedSubIssues).toContainEqual({
      parent: 1,
      sub: 11,
      replaceParent: true,
    });
  });

  it('removes unexpected native sub-issues under exact synchronization', async () => {
    const { result, api } = await init({
      config: epicConfig(
        [fakeIssue({ number: 11 }), fakeIssue({ number: 99 })],
        { subIssues: { 1: [11, 99] }, parents: { 11: 1, 99: 1 } },
      ),
      intendedIssues: [11],
    });

    expect(result.kind).toBe('initialized');
    expect(api.removedSubIssues).toContainEqual({ parent: 1, sub: 99 });
  });

  it('reorders native sub-issues to match the requested order', async () => {
    const { result, api } = await init({
      config: epicConfig(
        [
          fakeIssue({ number: 11 }),
          fakeIssue({ number: 12 }),
          fakeIssue({ number: 13 }),
        ],
        { subIssues: { 1: [13, 11, 12] }, parents: { 11: 1, 12: 1, 13: 1 } },
      ),
      intendedIssues: [11, 12, 13],
    });

    expect(result.kind).toBe('initialized');
    expect(api.reprioritized.length).toBeGreaterThan(0);
    // After reordering, the native order matches the plan exactly.
    const finalOrder = await api.listSubIssues(1, 1);
    expect(finalOrder.items.map((ref) => ref.number)).toEqual([11, 12, 13]);
  });
});

describe('initializeEpic — state normalization', () => {
  it('normalizes a completed issue with a stale running label to done', async () => {
    const { result, api } = await init({
      config: epicConfig(
        [
          fakeIssue({
            number: 11,
            open: false,
            closedReason: 'completed',
            labelNames: [labels['in-progress']],
          }),
        ],
        { subIssues: { 1: [11] }, parents: { 11: 1 } },
      ),
      intendedIssues: [11],
    });

    expect(result.kind).toBe('initialized');
    expect(api.addedLabels).toContainEqual({
      issue: 11,
      labels: [labels.done],
    });
  });

  it('fails closed on an unexpected active issue', async () => {
    const { result } = await init({
      config: epicConfig(
        [fakeIssue({ number: 11, labelNames: [labels['in-progress']] })],
        { subIssues: { 1: [11] }, parents: { 11: 1 } },
      ),
      intendedIssues: [11],
    });

    expect(result.kind).toBe('unexpected-active-issue');
    expect(
      result.kind === 'unexpected-active-issue' && result.issueNumber,
    ).toBe(11);
  });

  it('allows an active issue during an explicit reinitialization', async () => {
    const { result } = await init({
      config: epicConfig(
        [fakeIssue({ number: 11, labelNames: [labels['in-progress']] })],
        { subIssues: { 1: [11] }, parents: { 11: 1 } },
      ),
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
});

describe('initializeEpic — idempotency and reinitialization', () => {
  it('returns already-initialized for a normal rerun', async () => {
    const { result, api } = await init({
      config: epicConfig([fakeIssue({ number: 11 })], {
        subIssues: { 1: [11] },
        parents: { 11: 1 },
        comments: { 1: [seededPlan(1, [11])] },
      }),
      intendedIssues: [11],
    });

    expect(result.kind).toBe('already-initialized');
    expect(api.addedSubIssues).toHaveLength(0);
    expect(api.reprioritized).toHaveLength(0);
  });

  it('rewrites the plan when reinitialization is forced', async () => {
    const { result } = await init({
      config: epicConfig(
        [fakeIssue({ number: 11 }), fakeIssue({ number: 12 })],
        {
          subIssues: { 1: [11] },
          parents: { 11: 1 },
          comments: { 1: [seededPlan(1, [11])] },
        },
      ),
      intendedIssues: [11, 12],
      forceReinitialize: true,
    });

    expect(result.kind).toBe('initialized');
    expect(result.kind === 'initialized' && result.plan.issues).toEqual([
      11, 12,
    ]);
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
  });
});

describe('initializeEpic — hierarchy convergence and retries', () => {
  it('waits for delayed native visibility before reordering', async () => {
    const { result, api } = await init({
      config: epicConfig([
        fakeIssue({ number: 11 }),
        fakeIssue({ number: 12 }),
        fakeIssue({ number: 13 }),
      ]),
      intendedIssues: [11, 12, 13],
      prepare: (fake) => {
        // The first two native reads omit #13, modeling a hierarchy index that
        // has not yet converged after linking.
        fake.nativeVisibilityDelay = 2;
        fake.hiddenUntilVisible = [13];
      },
    });

    expect(result.kind).toBe('initialized');
    const finalOrder = await api.listSubIssues(1, 1);
    expect(finalOrder.items.map((ref) => ref.number)).toEqual([11, 12, 13]);
  });

  it('retries a transient reprioritize failure once, then succeeds', async () => {
    const { result, api } = await init({
      config: epicConfig(
        [
          fakeIssue({ number: 11 }),
          fakeIssue({ number: 12 }),
          fakeIssue({ number: 13 }),
        ],
        { subIssues: { 1: [13, 11, 12] }, parents: { 11: 1, 12: 1, 13: 1 } },
      ),
      intendedIssues: [11, 12, 13],
      prepare: (fake) => {
        fake.reprioritizeFailures = 1;
      },
    });

    expect(result.kind).toBe('initialized');
    const finalOrder = await api.listSubIssues(1, 1);
    expect(finalOrder.items.map((ref) => ref.number)).toEqual([11, 12, 13]);
  });

  it('retries a transient reprioritize failure several times within the bound', async () => {
    const { result, api } = await init({
      config: epicConfig(
        [
          fakeIssue({ number: 11 }),
          fakeIssue({ number: 12 }),
          fakeIssue({ number: 13 }),
        ],
        { subIssues: { 1: [13, 11, 12] }, parents: { 11: 1, 12: 1, 13: 1 } },
      ),
      intendedIssues: [11, 12, 13],
      prepare: (fake) => {
        fake.reprioritizeFailures = 3;
      },
    });

    expect(result.kind).toBe('initialized');
    const finalOrder = await api.listSubIssues(1, 1);
    expect(finalOrder.items.map((ref) => ref.number)).toEqual([11, 12, 13]);
  });

  it('returns initialization-failed when transient retries are exhausted', async () => {
    const { result, api } = await init({
      config: epicConfig(
        [
          fakeIssue({ number: 11 }),
          fakeIssue({ number: 12 }),
          fakeIssue({ number: 13 }),
        ],
        { subIssues: { 1: [13, 11, 12] }, parents: { 11: 1, 12: 1, 13: 1 } },
      ),
      intendedIssues: [11, 12, 13],
      prepare: (fake) => {
        // Always fail: more failures than the retry budget allows.
        fake.reprioritizeFailures = 100;
      },
    });

    expect(result.kind).toBe('failed');
    expect(
      result.kind === 'failed' && result.reason === 'initialization-failed',
    ).toBe(true);
    expect(result.kind === 'failed' && result.messages.join(' ')).toContain(
      'Retry 5 of 5 failed',
    );
    // The frozen plan must not be persisted when ordering fails.
    expect(api.createdComments.some((c) => c.issue === 1)).toBe(false);
  });

  it('does not retry a permanent reprioritize failure', async () => {
    const { result, api } = await init({
      config: epicConfig(
        [
          fakeIssue({ number: 11 }),
          fakeIssue({ number: 12 }),
          fakeIssue({ number: 13 }),
        ],
        { subIssues: { 1: [13, 11, 12] }, parents: { 11: 1, 12: 1, 13: 1 } },
      ),
      intendedIssues: [11, 12, 13],
      prepare: (fake) => {
        fake.reprioritizeFailures = 1;
        fake.transientError = fake.permanentError;
      },
    });

    expect(result.kind).toBe('failed');
    // A permanent failure stops immediately: exactly one failed attempt.
    const failedCalls = api.calls.filter(
      (call) => call.op === 'reprioritizeSubIssue:failed',
    );
    expect(failedCalls).toHaveLength(1);
    expect(result.kind === 'failed' && result.messages.join(' ')).toContain(
      'forbidden',
    );
  });

  it('skips reprioritize when adjacency is already satisfied', async () => {
    const { result, api } = await init({
      config: epicConfig(
        [
          fakeIssue({ number: 11 }),
          fakeIssue({ number: 12 }),
          fakeIssue({ number: 13 }),
        ],
        { subIssues: { 1: [11, 12, 13] }, parents: { 11: 1, 12: 1, 13: 1 } },
      ),
      intendedIssues: [11, 12, 13],
    });

    expect(result.kind).toBe('initialized');
    // Already ordered: no reprioritize writes are issued.
    expect(api.reprioritized).toHaveLength(0);
  });

  it('resumes ordering safely from current native state on rerun', async () => {
    // The epic is fully linked but partially ordered ([11, 13, 12]); a rerun
    // (no persisted plan) must finish ordering without re-linking.
    const { result, api } = await init({
      config: epicConfig(
        [
          fakeIssue({ number: 11 }),
          fakeIssue({ number: 12 }),
          fakeIssue({ number: 13 }),
        ],
        { subIssues: { 1: [11, 13, 12] }, parents: { 11: 1, 12: 1, 13: 1 } },
      ),
      intendedIssues: [11, 12, 13],
    });

    expect(result.kind).toBe('initialized');
    expect(api.addedSubIssues).toHaveLength(0);
    const finalOrder = await api.listSubIssues(1, 1);
    expect(finalOrder.items.map((ref) => ref.number)).toEqual([11, 12, 13]);
  });
});

describe('initializeEpic — LingoQuest race recovery (integration)', () => {
  it('attaches eight issues, survives stale reads and a transient reprioritize, and persists the plan', async () => {
    const issues = [201, 202, 203, 204, 205, 206, 207, 208];
    const { result, api } = await init({
      config: epicConfig(
        issues.map((number) => fakeIssue({ number })),
        // None are linked yet; all eight are unparented planned issues.
        { subIssues: { 1: [] } },
      ),
      intendedIssues: issues,
      prepare: (fake) => {
        // The first post-attach hierarchy reread is temporarily incomplete (the
        // last two children are not yet visible), and the first reprioritize
        // fails transiently before succeeding. (Call #1 is the pre-attach
        // planning read of the empty epic, so a delay of 2 hides on the first
        // convergence poll.)
        fake.nativeVisibilityDelay = 2;
        fake.hiddenUntilVisible = [207, 208];
        fake.reprioritizeFailures = 1;
      },
    });

    expect(result.kind).toBe('initialized');
    expect(api.addedSubIssues.map((entry) => entry.sub).sort()).toEqual(
      [...issues].sort(),
    );
    const finalOrder = await api.listSubIssues(1, 1);
    expect(finalOrder.items.map((ref) => ref.number)).toEqual(issues);
    // The frozen plan is persisted on the epic only after verification.
    expect(api.createdComments.some((c) => c.issue === 1)).toBe(true);
    expect(result.kind === 'initialized' && result.plan.issues).toEqual(issues);
  });
});
