import { describe, expect, it } from 'vitest';

import { DEFAULT_CANONICAL_STATE_LABELS } from '../src/config/schema.js';
import {
  GitHubRepositoryAdapter,
  RepositoryApiError,
  CrossRepositoryReferenceError,
  hasStatusMarker,
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
    ).toEqual([11, 12]);
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
