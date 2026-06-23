import { describe, expect, it } from 'vitest';

import {
  appendClosingLine,
  closingLineFor,
  resolvePullRequestLink,
  type OpenedPullRequest,
  type PullRequestLinkContext,
} from '../src/domain/pr-link.js';

const repository = { owner: 'octo', name: 'demo' };

function pr(overrides: Partial<OpenedPullRequest> = {}): OpenedPullRequest {
  return {
    number: 456,
    author: 'copilot-swe-agent',
    baseRef: 'main',
    body: 'Implements the change.',
    closingIssueReferences: [],
    ...overrides,
  };
}

function context(
  overrides: Partial<PullRequestLinkContext> = {},
): PullRequestLinkContext {
  return {
    repository,
    baseBranch: 'main',
    agentLogins: ['copilot-swe-agent', 'copilot'],
    activeIssues: [123],
    ...overrides,
  };
}

describe('resolvePullRequestLink', () => {
  it('links a Copilot PR to the single active sub-issue', () => {
    const result = resolvePullRequestLink(pr(), context());
    expect(result.outcome).toBe('link');
    if (result.outcome === 'link') {
      expect(result.issueNumber).toBe(123);
      expect(result.body).toBe('Implements the change.\n\nCloses #123\n');
    }
  });

  it('matches the agent login case-insensitively', () => {
    const result = resolvePullRequestLink(pr({ author: 'Copilot' }), context());
    expect(result.outcome).toBe('link');
  });

  it('ignores pull requests authored by anyone else', () => {
    const result = resolvePullRequestLink(pr({ author: 'octocat' }), context());
    expect(result).toEqual({ outcome: 'no-op', reason: 'wrong-author' });
  });

  it('ignores pull requests with an unknown author', () => {
    const result = resolvePullRequestLink(pr({ author: null }), context());
    expect(result).toEqual({ outcome: 'no-op', reason: 'wrong-author' });
  });

  it('ignores pull requests targeting the wrong base branch', () => {
    const result = resolvePullRequestLink(
      pr({ baseRef: 'develop' }),
      context(),
    );
    expect(result).toEqual({ outcome: 'no-op', reason: 'wrong-base-branch' });
  });

  it('leaves a pull request with a formal closing reference unchanged', () => {
    const result = resolvePullRequestLink(
      pr({ closingIssueReferences: [999] }),
      context(),
    );
    expect(result).toEqual({ outcome: 'no-op', reason: 'already-linked' });
  });

  it('leaves a pull request that already has a closing keyword unchanged', () => {
    const result = resolvePullRequestLink(
      pr({ body: 'Work.\n\nCloses #123' }),
      context(),
    );
    expect(result).toEqual({ outcome: 'no-op', reason: 'already-linked' });
  });

  it('does nothing when there is no active sub-issue', () => {
    const result = resolvePullRequestLink(pr(), context({ activeIssues: [] }));
    expect(result).toEqual({ outcome: 'no-op', reason: 'no-active-issue' });
  });

  it('fails closed when multiple active sub-issues are in progress', () => {
    const result = resolvePullRequestLink(
      pr(),
      context({ activeIssues: [123, 124] }),
    );
    expect(result.outcome).toBe('needs-human');
    if (result.outcome === 'needs-human') {
      expect(result.reason).toBe('ambiguous-active-issue');
      expect(result.message).toContain('#123');
      expect(result.message).toContain('#124');
    }
  });

  it('treats duplicate active issue numbers as a single candidate', () => {
    const result = resolvePullRequestLink(
      pr(),
      context({ activeIssues: [123, 123] }),
    );
    expect(result.outcome).toBe('link');
    if (result.outcome === 'link') {
      expect(result.issueNumber).toBe(123);
    }
  });
});

describe('appendClosingLine', () => {
  it('appends the closing line after existing content', () => {
    expect(appendClosingLine('Body text.', 7)).toBe(
      'Body text.\n\nCloses #7\n',
    );
  });

  it('uses only the closing line for an empty body', () => {
    expect(appendClosingLine(null, 7)).toBe('Closes #7\n');
    expect(appendClosingLine('   \n', 7)).toBe('Closes #7\n');
  });

  it('formats the canonical closing line', () => {
    expect(closingLineFor(42)).toBe('Closes #42');
  });
});
