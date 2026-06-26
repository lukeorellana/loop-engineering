import { describe, expect, it } from 'vitest';

import { DEFAULT_CANONICAL_STATE_LABELS } from '../src/config/schema.js';
import {
  GitHubRepositoryAdapter,
  RepositoryApiError,
  CrossRepositoryReferenceError,
  MarkdownDiscoveryError,
  hasStatusMarker,
  sanitizeError,
  type GitHubApi,
} from '../src/adapters/github/index.js';
import { FakeGitHubApi, fakeIssue } from './helpers/fake-github-api.js';

const labels = DEFAULT_CANONICAL_STATE_LABELS;

function adapterFor(api: GitHubApi): GitHubRepositoryAdapter {
  return new GitHubRepositoryAdapter({ api, labels });
}

describe('GitHubRepositoryAdapter reads', () => {
  it('exposes repository identity and default branch', async () => {
    const adapter = adapterFor(new FakeGitHubApi());
    expect(await adapter.getRepositoryInfo()).toEqual({
      owner: 'octo',
      name: 'demo',
      defaultBranch: 'main',
    });
  });

  it('reads configuration from the default branch only', async () => {
    const api = new FakeGitHubApi({
      repository: { defaultBranch: 'trunk' },
      files: { '.github/feature-loop.yml': 'version: 1' },
    });
    const adapter = adapterFor(api);
    expect(await adapter.getDefaultBranchFile('.github/feature-loop.yml')).toBe(
      'version: 1',
    );
    const read = api.calls.find((call) => call.op === 'getFileContent');
    expect(read?.args).toEqual(['.github/feature-loop.yml', 'trunk']);
  });

  it('returns null when the configuration file is absent', async () => {
    const adapter = adapterFor(new FakeGitHubApi());
    expect(
      await adapter.getDefaultBranchFile('.github/feature-loop.yml'),
    ).toBeNull();
  });

  it('preserves native sub-issue order across pages', async () => {
    const api = new FakeGitHubApi({
      subIssues: { 1: [11, 12, 13, 14, 15] },
      pageSize: 2,
    });
    const adapter = adapterFor(api);
    expect(await adapter.getNativeSubIssueNumbers(1)).toEqual([
      11, 12, 13, 14, 15,
    ]);
    const pages = api.calls
      .filter((call) => call.op === 'listSubIssues')
      .map((call) => call.args[1]);
    expect(pages).toEqual([1, 2, 3]);
  });

  it('builds an epic with ordered, state-resolved sub-issues', async () => {
    const api = new FakeGitHubApi({
      issues: {
        1: fakeIssue({ number: 1, title: 'Epic' }),
        11: fakeIssue({ number: 11, labelNames: [labels['in-progress']] }),
        12: fakeIssue({ number: 12, open: false, closedReason: 'completed' }),
      },
      subIssues: { 1: [11, 12] },
    });
    const epic = await adapterFor(api).getEpic(1);
    expect(epic?.number).toBe(1);
    expect(epic?.subIssues.map((s) => [s.number, s.order, s.state])).toEqual([
      [11, 0, 'in-progress'],
      [12, 1, 'done'],
    ]);
  });

  it('returns null for a missing epic', async () => {
    expect(await adapterFor(new FakeGitHubApi()).getEpic(99)).toBeNull();
  });

  it('parses Markdown sub-issues scoped to the heading', async () => {
    const api = new FakeGitHubApi({
      issues: {
        1: fakeIssue({
          number: 1,
          body: ['## Ordered sub-issues', '- #11', '- #12'].join('\n'),
        }),
      },
    });
    expect(
      await adapterFor(api).getMarkdownSubIssueNumbers(1, 'Ordered sub-issues'),
    ).toEqual({ numbers: [11, 12], source: 'configured-heading' });
  });

  it('discovers a marked ordered list regardless of heading wording', async () => {
    const api = new FakeGitHubApi({
      issues: {
        1: fakeIssue({
          number: 1,
          body: [
            '<!-- feature-loop:ordered-issues -->',
            '## Ordered child issues',
            '1. #11',
            '2. #12',
          ].join('\n'),
        }),
      },
    });
    expect(
      await adapterFor(api).getMarkdownSubIssueNumbers(1, 'Ordered sub-issues'),
    ).toEqual({ numbers: [11, 12], source: 'marker' });
  });

  it('rejects an ambiguous epic with multiple ordered issue sections', async () => {
    const api = new FakeGitHubApi({
      issues: {
        1: fakeIssue({
          number: 1,
          body: [
            '## Implementation sequence',
            '1. #11',
            '2. #12',
            '',
            '## Feature tasks',
            '1. #13',
            '2. #14',
          ].join('\n'),
        }),
      },
    });
    await expect(
      adapterFor(api).getMarkdownSubIssueNumbers(1, 'Ordered sub-issues'),
    ).rejects.toBeInstanceOf(MarkdownDiscoveryError);
  });

  it('rejects cross-repository Markdown references', async () => {
    const api = new FakeGitHubApi({
      issues: {
        1: fakeIssue({
          number: 1,
          body: ['## Ordered sub-issues', '- other/repo#9'].join('\n'),
        }),
      },
    });
    await expect(
      adapterFor(api).getMarkdownSubIssueNumbers(1, 'Ordered sub-issues'),
    ).rejects.toBeInstanceOf(CrossRepositoryReferenceError);
  });

  it('looks up the native parent epic number', async () => {
    const api = new FakeGitHubApi({ parents: { 11: 1 } });
    const adapter = adapterFor(api);
    expect(await adapter.getParentEpicNumber(11)).toBe(1);
    expect(await adapter.getParentEpicNumber(12)).toBeNull();
  });

  it('returns only the configured canonical labels present on an issue', async () => {
    const api = new FakeGitHubApi({
      issues: {
        11: fakeIssue({
          number: 11,
          labelNames: ['bug', labels.todo, labels.blocked],
        }),
      },
      pageSize: 1,
    });
    expect(
      await adapterFor(api).getCanonicalStateLabels(11, [
        labels.todo,
        labels.blocked,
        labels.done,
      ]),
    ).toEqual([labels.todo, labels.blocked]);
  });

  it('builds pull-request completion with the parent epic number', async () => {
    const api = new FakeGitHubApi({
      pulls: {
        7: {
          number: 7,
          merged: true,
          mergedBy: 'alice',
          baseRef: 'main',
          headRef: 'feature',
          body: null,
          closesIssueNumbers: [11],
        },
      },
      parents: { 11: 1 },
    });
    expect(await adapterFor(api).getPullRequestCompletion(7)).toEqual({
      pullRequestNumber: 7,
      merged: true,
      mergedBy: 'alice',
      baseRef: 'main',
      headRef: 'feature',
      epicNumber: 1,
      closesIssueNumbers: [11],
    });
  });

  it('exposes the raw merged pull request for trusted resolution', async () => {
    const api = new FakeGitHubApi({
      pulls: {
        9: {
          number: 9,
          merged: true,
          mergedBy: 'maintainer',
          baseRef: 'main',
          headRef: 'feature',
          body: 'Closes #11',
          closesIssueNumbers: [11],
        },
      },
    });
    expect(await adapterFor(api).getMergedPullRequest(9)).toEqual({
      number: 9,
      merged: true,
      mergedBy: 'maintainer',
      baseRef: 'main',
      headRef: 'feature',
      body: 'Closes #11',
      closingIssueReferences: [11],
    });
  });

  it('returns null for a missing merged pull request', async () => {
    expect(
      await adapterFor(new FakeGitHubApi()).getMergedPullRequest(404),
    ).toBeNull();
  });

  it('exposes the raw opened pull request with its author', async () => {
    const api = new FakeGitHubApi({
      pulls: {
        9: {
          number: 9,
          merged: false,
          mergedBy: null,
          author: 'copilot-swe-agent',
          baseRef: 'main',
          headRef: 'copilot/feature',
          body: 'Work in progress',
          closesIssueNumbers: [],
        },
      },
    });
    expect(await adapterFor(api).getOpenedPullRequest(9)).toEqual({
      number: 9,
      author: 'copilot-swe-agent',
      baseRef: 'main',
      body: 'Work in progress',
      closingIssueReferences: [],
    });
  });

  it('reports a null author when the pull request has none', async () => {
    const api = new FakeGitHubApi({
      pulls: {
        9: {
          number: 9,
          merged: false,
          mergedBy: null,
          baseRef: 'main',
          headRef: 'copilot/feature',
          body: null,
          closesIssueNumbers: [],
        },
      },
    });
    const pr = await adapterFor(api).getOpenedPullRequest(9);
    expect(pr?.author).toBeNull();
  });

  it('returns null for a missing opened pull request', async () => {
    expect(
      await adapterFor(new FakeGitHubApi()).getOpenedPullRequest(404),
    ).toBeNull();
  });

  it('collects open issues carrying the active label across pages', async () => {
    const api = new FakeGitHubApi({
      issues: {
        11: fakeIssue({ number: 11, labelNames: ['feature-loop:in-progress'] }),
        12: fakeIssue({ number: 12, labelNames: ['feature-loop:in-progress'] }),
        13: fakeIssue({ number: 13, labelNames: ['unrelated'] }),
        14: fakeIssue({
          number: 14,
          open: false,
          labelNames: ['feature-loop:in-progress'],
        }),
      },
      pageSize: 1,
    });
    expect(
      await adapterFor(api).findActiveSubIssues('feature-loop:in-progress'),
    ).toEqual([11, 12]);
  });

  it('updates a pull-request body through the transport', async () => {
    const api = new FakeGitHubApi({
      pulls: {
        9: {
          number: 9,
          merged: false,
          mergedBy: null,
          author: 'copilot-swe-agent',
          baseRef: 'main',
          headRef: 'copilot/feature',
          body: 'Work',
          closesIssueNumbers: [],
        },
      },
    });
    await adapterFor(api).updatePullRequestBody(9, 'Work\n\nCloses #11\n');
    expect(api.updatedPulls).toEqual([
      { pull: 9, body: 'Work\n\nCloses #11\n' },
    ]);
  });

  it('collects linked pull requests across pages', async () => {
    const api = new FakeGitHubApi({
      linkedPulls: { 11: [101, 102, 103] },
      pageSize: 2,
    });
    expect(await adapterFor(api).getLinkedPullRequestNumbers(11)).toEqual([
      101, 102, 103,
    ]);
  });
});

describe('GitHubRepositoryAdapter writes', () => {
  it('normalizes to a single canonical state label', async () => {
    const api = new FakeGitHubApi({
      issues: {
        11: fakeIssue({
          number: 11,
          labelNames: [labels.todo, labels.blocked],
        }),
      },
    });
    await adapterFor(api).setCanonicalState(11, labels['in-progress']);
    expect(api.removedLabels.map((r) => r.label).sort()).toEqual(
      [labels.todo, labels.blocked].sort(),
    );
    expect(api.addedLabels).toEqual([
      { issue: 11, labels: [labels['in-progress']] },
    ]);
  });

  it('does not re-add a canonical label that is already present', async () => {
    const api = new FakeGitHubApi({
      issues: {
        11: fakeIssue({ number: 11, labelNames: [labels.todo] }),
      },
    });
    await adapterFor(api).setCanonicalState(11, labels.todo);
    expect(api.addedLabels).toEqual([]);
    expect(api.removedLabels).toEqual([]);
  });

  it('closes an issue as completed', async () => {
    const api = new FakeGitHubApi();
    await adapterFor(api).closeIssueAsCompleted(11);
    expect(api.stateChanges).toEqual([
      { issue: 11, open: false, closedReason: 'completed' },
    ]);
  });

  it('creates a status comment with a hidden marker when none exists', async () => {
    const api = new FakeGitHubApi({ comments: { 11: [] } });
    await adapterFor(api).upsertStatusComment(11, 'progress', 'Working on it');
    expect(api.createdComments).toHaveLength(1);
    const body = api.createdComments[0].body;
    expect(hasStatusMarker(body, 'progress')).toBe(true);
    expect(body).toContain('Working on it');
  });

  it('updates the existing status comment with the same marker', async () => {
    const api = new FakeGitHubApi({
      comments: {
        11: [
          { id: 50, body: 'unrelated comment' },
          { id: 51, body: '<!-- feature-loop:status:progress -->\nold' },
        ],
      },
    });
    await adapterFor(api).upsertStatusComment(11, 'progress', 'new status');
    expect(api.updatedComments).toEqual([
      { id: 51, body: '<!-- feature-loop:status:progress -->\nnew status' },
    ]);
    expect(api.createdComments).toEqual([]);
  });
});

describe('GitHubRepositoryAdapter error sanitization', () => {
  it('never leaks raw API bodies, tokens, or headers', async () => {
    const secret = 'token ghp_SECRET Authorization: ******';
    const failing = new FakeGitHubApi();
    failing.getRepository = async () => {
      throw Object.assign(new Error(secret), { status: 403 });
    };
    const error = await adapterFor(failing)
      .getRepositoryInfo()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepositoryApiError);
    const message = (error as RepositoryApiError).message;
    expect(message).not.toContain('ghp_SECRET');
    expect(message).not.toContain('Authorization');
    expect((error as RepositoryApiError).code).toBe('forbidden');
    expect((error as RepositoryApiError).status).toBe(403);
  });
});

describe('sanitizeError — GraphQL classification', () => {
  it('classifies a statusless GraphQL error and retains safe type/code', () => {
    const error = sanitizeError('reprioritize sub-issue', {
      errors: [
        {
          type: 'UNPROCESSABLE',
          message: 'secret detail ghp_LEAK',
          extensions: { code: 'unprocessable' },
        },
      ],
      response: {
        data: { secret: 'ghp_LEAK' },
        headers: { authorization: 'x' },
      },
    });
    expect(error.code).toBe('validation');
    expect(error.status).toBeNull();
    // Statusless GraphQL validation errors model the freshly-linked-sibling
    // race and are retryable.
    expect(error.retryable).toBe(true);
    expect(error.graphql).toEqual({
      type: 'UNPROCESSABLE',
      code: 'unprocessable',
    });
    // The safe type is surfaced in the message; raw data is never present.
    expect(error.message).toContain('reprioritize sub-issue');
    expect(error.message).toContain('UNPROCESSABLE');
    expect(error.message).not.toContain('ghp_LEAK');
    expect(error.message).not.toContain('authorization');
  });

  it('classifies a permanent GraphQL FORBIDDEN error as non-retryable', () => {
    const error = sanitizeError('reprioritize sub-issue', {
      errors: [{ type: 'FORBIDDEN', extensions: { code: 'forbidden' } }],
    });
    expect(error.code).toBe('forbidden');
    expect(error.retryable).toBe(false);
  });

  it('treats a statusless GraphQL error with no type as retryable unknown', () => {
    const error = sanitizeError('reprioritize sub-issue', {
      errors: [{ message: 'boom' }],
    });
    expect(error.code).toBe('unknown');
    expect(error.status).toBeNull();
    expect(error.retryable).toBe(true);
    expect(error.graphql).toEqual({ type: null, code: null });
  });

  it('rejects non-allowlisted GraphQL type/code values', () => {
    const error = sanitizeError('reprioritize sub-issue', {
      errors: [
        {
          type: 'has spaces and ghp_LEAK',
          extensions: { code: { nested: 'object' } },
        },
      ],
    });
    expect(error.graphql).toEqual({ type: null, code: null });
    expect(error.message).not.toContain('ghp_LEAK');
  });

  it('keeps REST 5xx and 429 retryable but 4xx validation permanent', () => {
    expect(
      sanitizeError('x', Object.assign(new Error(), { status: 503 })).retryable,
    ).toBe(true);
    expect(
      sanitizeError('x', Object.assign(new Error(), { status: 429 })).retryable,
    ).toBe(true);
    expect(
      sanitizeError('x', Object.assign(new Error(), { status: 422 })).retryable,
    ).toBe(false);
    expect(
      sanitizeError('x', Object.assign(new Error(), { status: 403 })).retryable,
    ).toBe(false);
  });
});

describe('GitHubRepositoryAdapter reprioritizeSubIssue transport', () => {
  it('sends the resolved parent, child, and after identifiers', async () => {
    const api = new FakeGitHubApi({
      issues: {
        1: fakeIssue({ number: 1 }),
        11: fakeIssue({ number: 11 }),
        12: fakeIssue({ number: 12 }),
      },
      subIssues: { 1: [11, 12] },
      parents: { 11: 1, 12: 1 },
    });
    await adapterFor(api).reprioritizeSubIssue(1, 'node-12', 'node-11');
    expect(api.reprioritized).toContainEqual({ parent: 1, sub: 12, after: 11 });
  });
});
