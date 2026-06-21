import { describe, expect, it } from 'vitest';

import {
  parseClosingKeywords,
  resolveMergedPullRequest,
  type Epic,
  type IssueState,
  type MergedPullRequestContext,
  type MergedPullRequestEvent,
  type SubIssue,
} from '../src/domain/index.js';
import { DEFAULT_CANONICAL_STATE_LABELS } from '../src/config/schema.js';
import { GitHubRepositoryAdapter } from '../src/adapters/github/index.js';
import { FakeGitHubApi } from './helpers/fake-github-api.js';

const repo = { owner: 'lukeorellana', name: 'loop-engineering' };
const doneLabel = DEFAULT_CANONICAL_STATE_LABELS.done;

interface SubIssueOverrides {
  readonly number: number;
  readonly order: number;
  readonly state: IssueState;
  readonly open?: boolean;
  readonly canonicalStateLabels?: readonly string[];
}

function labelFor(state: IssueState): string {
  return DEFAULT_CANONICAL_STATE_LABELS[state];
}

function subIssue(overrides: SubIssueOverrides): SubIssue {
  const open =
    overrides.open ??
    (overrides.state !== 'done' && overrides.state !== 'not-planned');
  return {
    number: overrides.number,
    title: `Issue ${overrides.number}`,
    order: overrides.order,
    open,
    closedReason: open
      ? undefined
      : overrides.state === 'not-planned'
        ? 'not-planned'
        : 'completed',
    state: overrides.state,
    canonicalStateLabels:
      overrides.canonicalStateLabels ??
      (overrides.state === 'done' || overrides.state === 'not-planned'
        ? []
        : overrides.state === 'todo'
          ? []
          : [labelFor(overrides.state)]),
  };
}

function epicWith(subIssues: readonly SubIssue[], number = 1): Epic {
  return { number, title: 'Epic', open: true, subIssues };
}

interface EventOverrides {
  readonly name?: string;
  readonly action?: string;
  readonly number?: number;
  readonly merged?: boolean;
  readonly mergedBy?: string;
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly body?: string | null;
  readonly closingIssueReferences?: readonly number[];
}

function event(overrides: EventOverrides = {}): MergedPullRequestEvent {
  return {
    name: overrides.name ?? 'pull_request',
    action: overrides.action ?? 'closed',
    pullRequest: {
      number: overrides.number ?? 50,
      merged: overrides.merged ?? true,
      mergedBy: overrides.mergedBy ?? 'human',
      baseRef: overrides.baseRef ?? 'main',
      headRef: overrides.headRef ?? 'feature',
      body: overrides.body ?? null,
      closingIssueReferences: overrides.closingIssueReferences ?? [],
    },
  };
}

function contextFor(
  epic: Epic,
  overrides: Partial<MergedPullRequestContext> = {},
): MergedPullRequestContext {
  return {
    repository: overrides.repository ?? repo,
    baseBranch: overrides.baseBranch ?? 'main',
    epic,
    doneLabel: overrides.doneLabel ?? doneLabel,
  };
}

describe('parseClosingKeywords', () => {
  it('returns an empty list for a missing body', () => {
    expect(parseClosingKeywords(null, repo)).toEqual([]);
    expect(parseClosingKeywords(undefined, repo)).toEqual([]);
    expect(parseClosingKeywords('', repo)).toEqual([]);
  });

  it('parses every supported closing keyword case-insensitively', () => {
    const body = [
      'Closes #1',
      'closed #2',
      'CLOSE #3',
      'Fixes #4',
      'fixed #5',
      'fix #6',
      'Resolves #7',
      'resolved #8',
      'resolve #9',
    ].join('\n');
    expect(parseClosingKeywords(body, repo)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it('accepts a colon separator and owner/repo and URL forms', () => {
    const body = [
      'Closes: #11',
      'Fixes lukeorellana/loop-engineering#12',
      'Resolves https://github.com/lukeorellana/loop-engineering/issues/13',
    ].join('\n');
    expect(parseClosingKeywords(body, repo)).toEqual([11, 12, 13]);
  });

  it('ignores plain mentions that are not closing keywords', () => {
    expect(parseClosingKeywords('See #1 and relates to #2.', repo)).toEqual([]);
    expect(parseClosingKeywords('This addresses #3', repo)).toEqual([]);
  });

  it('ignores cross-repository closing references', () => {
    const body = [
      'Closes other/elsewhere#1',
      'Fixes https://github.com/other/elsewhere/issues/2',
      'Resolves #3',
    ].join('\n');
    expect(parseClosingKeywords(body, repo)).toEqual([3]);
  });

  it('deduplicates repeated references in first-appearance order', () => {
    expect(
      parseClosingKeywords('Closes #5\nFixes #5\nResolves #4', repo),
    ).toEqual([5, 4]);
  });
});

describe('resolveMergedPullRequest: event gating', () => {
  const epic = epicWith([
    subIssue({ number: 11, order: 0, state: 'in-progress' }),
  ]);

  it('no-ops a non pull_request event', () => {
    const result = resolveMergedPullRequest(
      event({ name: 'issues', body: 'Closes #11' }),
      contextFor(epic),
    );
    expect(result).toEqual({
      outcome: 'no-op',
      reason: 'event-not-applicable',
    });
  });

  it('no-ops a pull_request action other than closed', () => {
    const result = resolveMergedPullRequest(
      event({ action: 'opened', body: 'Closes #11' }),
      contextFor(epic),
    );
    expect(result).toEqual({
      outcome: 'no-op',
      reason: 'event-not-applicable',
    });
  });

  it('no-ops a closed but unmerged pull request', () => {
    const result = resolveMergedPullRequest(
      event({ merged: false, body: 'Closes #11' }),
      contextFor(epic),
    );
    expect(result).toEqual({ outcome: 'no-op', reason: 'not-merged' });
  });

  it('no-ops a merge into the wrong base branch', () => {
    const result = resolveMergedPullRequest(
      event({ baseRef: 'develop', body: 'Closes #11' }),
      contextFor(epic),
    );
    expect(result).toEqual({ outcome: 'no-op', reason: 'wrong-base-branch' });
  });
});

describe('resolveMergedPullRequest: closing relationship', () => {
  const epic = epicWith([
    subIssue({ number: 11, order: 0, state: 'in-progress' }),
  ]);

  it('no-ops a merged PR with no closing relationship', () => {
    const result = resolveMergedPullRequest(
      event({ body: 'Mentions #11 but does not close it.' }),
      contextFor(epic),
    );
    expect(result).toEqual({
      outcome: 'no-op',
      reason: 'no-closing-reference',
    });
  });

  it('completes via a closing keyword alone', () => {
    const result = resolveMergedPullRequest(
      event({ body: 'Closes #11' }),
      contextFor(epic),
    );
    expect(result.outcome).toBe('completed');
  });

  it('completes via GitHub closing references alone', () => {
    const result = resolveMergedPullRequest(
      event({ closingIssueReferences: [11] }),
      contextFor(epic),
    );
    expect(result.outcome).toBe('completed');
  });

  it('completes when keyword and GitHub references agree', () => {
    const result = resolveMergedPullRequest(
      event({ body: 'Closes #11', closingIssueReferences: [11] }),
      contextFor(epic),
    );
    expect(result.outcome).toBe('completed');
  });

  it('fails closed when keyword and GitHub references conflict', () => {
    const result = resolveMergedPullRequest(
      event({ body: 'Closes #11', closingIssueReferences: [12] }),
      contextFor(epic),
    );
    expect(result.outcome).toBe('needs-human');
    if (result.outcome === 'needs-human') {
      expect(result.reason).toBe('conflicting-closing-references');
    }
  });

  it('fails closed when more than one issue is closed', () => {
    const twoIssues = epicWith([
      subIssue({ number: 11, order: 0, state: 'in-progress' }),
      subIssue({ number: 12, order: 1, state: 'todo' }),
    ]);
    const result = resolveMergedPullRequest(
      event({ closingIssueReferences: [11, 12] }),
      contextFor(twoIssues),
    );
    expect(result.outcome).toBe('needs-human');
    if (result.outcome === 'needs-human') {
      expect(result.reason).toBe('multiple-closing-issues');
    }
  });
});

describe('resolveMergedPullRequest: epic membership and ordering', () => {
  it('no-ops when the closed issue is not a sub-issue of the epic', () => {
    const epic = epicWith([
      subIssue({ number: 11, order: 0, state: 'in-progress' }),
    ]);
    const result = resolveMergedPullRequest(
      event({ closingIssueReferences: [999] }),
      contextFor(epic),
    );
    expect(result).toEqual({ outcome: 'no-op', reason: 'foreign-parent' });
  });

  it('fails closed for an out-of-order issue', () => {
    const epic = epicWith([
      subIssue({ number: 11, order: 0, state: 'in-progress' }),
      subIssue({ number: 12, order: 1, state: 'todo' }),
    ]);
    const result = resolveMergedPullRequest(
      event({ closingIssueReferences: [12] }),
      contextFor(epic),
    );
    expect(result.outcome).toBe('needs-human');
    if (result.outcome === 'needs-human') {
      expect(result.reason).toBe('out-of-order');
    }
  });

  it('completes the head-of-line issue when earlier issues are done', () => {
    const epic = epicWith([
      subIssue({ number: 11, order: 0, state: 'done' }),
      subIssue({ number: 12, order: 1, state: 'in-progress' }),
    ]);
    const result = resolveMergedPullRequest(
      event({
        number: 80,
        mergedBy: 'maintainer',
        closingIssueReferences: [12],
      }),
      contextFor(epic),
    );
    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') {
      expect(result.completion).toEqual({
        pullRequestNumber: 80,
        merged: true,
        mergedBy: 'maintainer',
        baseRef: 'main',
        headRef: 'feature',
        epicNumber: 1,
        closesIssueNumbers: [12],
      });
    }
  });

  it('fails closed when a merge claims a not-planned issue', () => {
    const epic = epicWith([
      subIssue({ number: 11, order: 0, state: 'not-planned' }),
    ]);
    const result = resolveMergedPullRequest(
      event({ closingIssueReferences: [11] }),
      contextFor(epic),
    );
    expect(result.outcome).toBe('needs-human');
    if (result.outcome === 'needs-human') {
      expect(result.reason).toBe('ambiguous-completion');
    }
  });
});

describe('resolveMergedPullRequest: idempotent completion preparation', () => {
  it('requests a close and label normalization for an open active issue', () => {
    const epic = epicWith([
      subIssue({
        number: 11,
        order: 0,
        state: 'in-progress',
      }),
    ]);
    const result = resolveMergedPullRequest(
      event({ closingIssueReferences: [11] }),
      contextFor(epic),
    );
    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') {
      expect(result.preparation).toEqual({
        issueNumber: 11,
        alreadyComplete: false,
        closeAsCompleted: true,
        normalizeDoneLabel: true,
      });
    }
  });

  it('is idempotent for an issue already auto-closed as done with the done label', () => {
    const epic = epicWith([
      subIssue({
        number: 11,
        order: 0,
        state: 'done',
        canonicalStateLabels: [doneLabel],
      }),
    ]);
    const result = resolveMergedPullRequest(
      event({ closingIssueReferences: [11] }),
      contextFor(epic),
    );
    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') {
      expect(result.preparation).toEqual({
        issueNumber: 11,
        alreadyComplete: true,
        closeAsCompleted: false,
        normalizeDoneLabel: false,
      });
    }
  });

  it('flags stale active labels on an already-closed issue for normalization', () => {
    const epic = epicWith([
      subIssue({
        number: 11,
        order: 0,
        state: 'done',
        canonicalStateLabels: [DEFAULT_CANONICAL_STATE_LABELS['in-progress']],
      }),
    ]);
    const result = resolveMergedPullRequest(
      event({ closingIssueReferences: [11] }),
      contextFor(epic),
    );
    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') {
      expect(result.preparation).toEqual({
        issueNumber: 11,
        alreadyComplete: true,
        closeAsCompleted: false,
        normalizeDoneLabel: true,
      });
    }
  });
});

describe('resolveMergedPullRequest: through the mocked GitHub API', () => {
  it('resolves a trusted completion from raw adapter data', async () => {
    const api = new FakeGitHubApi({
      pulls: {
        9: {
          number: 9,
          merged: true,
          mergedBy: 'maintainer',
          baseRef: 'main',
          headRef: 'feature',
          body: 'Closes lukeorellana/loop-engineering#11',
          closesIssueNumbers: [11],
        },
      },
    });
    const adapter = new GitHubRepositoryAdapter({
      api,
      labels: DEFAULT_CANONICAL_STATE_LABELS,
    });
    const pullRequest = await adapter.getMergedPullRequest(9);
    expect(pullRequest).not.toBeNull();
    const epic = epicWith([
      subIssue({ number: 11, order: 0, state: 'in-progress' }),
    ]);
    const result = resolveMergedPullRequest(
      { name: 'pull_request', action: 'closed', pullRequest: pullRequest! },
      contextFor(epic),
    );
    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') {
      expect(result.completion.closesIssueNumbers).toEqual([11]);
    }
  });

  it('no-ops an unrelated merged pull request fetched from the API', async () => {
    const api = new FakeGitHubApi({
      pulls: {
        9: {
          number: 9,
          merged: true,
          mergedBy: 'maintainer',
          baseRef: 'main',
          headRef: 'feature',
          body: 'Mentions #11 only.',
          closesIssueNumbers: [],
        },
      },
    });
    const adapter = new GitHubRepositoryAdapter({
      api,
      labels: DEFAULT_CANONICAL_STATE_LABELS,
    });
    const pullRequest = await adapter.getMergedPullRequest(9);
    const epic = epicWith([
      subIssue({ number: 11, order: 0, state: 'in-progress' }),
    ]);
    const result = resolveMergedPullRequest(
      { name: 'pull_request', action: 'closed', pullRequest: pullRequest! },
      contextFor(epic),
    );
    expect(result).toEqual({
      outcome: 'no-op',
      reason: 'no-closing-reference',
    });
  });
});
