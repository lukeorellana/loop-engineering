import { describe, expect, it } from 'vitest';

import { DEFAULT_CANONICAL_STATE_LABELS } from '../src/config/schema.js';
import { GitHubRepositoryAdapter } from '../src/adapters/github/index.js';
import { preflight } from '../src/preflight/index.js';
import {
  FakeGitHubApi,
  fakeIssue,
  type FakeConfig,
} from './helpers/fake-github-api.js';

const labels = DEFAULT_CANONICAL_STATE_LABELS;
const allLabelNames = Object.values(labels);
const CONFIG_PATH = '.github/feature-loop.yml';

function repositoryFor(config: FakeConfig): GitHubRepositoryAdapter {
  return new GitHubRepositoryAdapter({
    api: new FakeGitHubApi(config),
    labels,
  });
}

function baseConfig(overrides: Partial<FakeConfig> = {}): FakeConfig {
  return {
    issues: {
      1: fakeIssue({ number: 1, title: 'Epic' }),
      11: fakeIssue({ number: 11 }),
    },
    subIssues: { 1: [11] },
    branches: ['main'],
    repoLabels: allLabelNames,
    ...overrides,
  };
}

describe('preflight success', () => {
  it('passes with native sub-issues, labels, and base branch', async () => {
    const result = await preflight({
      repository: repositoryFor(baseConfig()),
      epicNumber: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('native');
      expect(result.issues).toEqual([11]);
      expect(result.baseBranch).toBe('main');
      expect(result.createdLabels).toEqual([]);
    }
  });

  it('falls back to the Markdown source when native is empty', async () => {
    const config = baseConfig({
      issues: {
        1: fakeIssue({
          number: 1,
          body: ['## Ordered sub-issues', '- #11', '- #12'].join('\n'),
        }),
        11: fakeIssue({ number: 11 }),
        12: fakeIssue({ number: 12 }),
      },
      subIssues: { 1: [] },
    });
    const result = await preflight({
      repository: repositoryFor(config),
      epicNumber: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('markdown');
      expect(result.issues).toEqual([11, 12]);
    }
  });

  it('creates missing labels when labels.auto-create is enabled', async () => {
    const config = baseConfig({
      files: {
        [CONFIG_PATH]: ['version: 1', 'labels:', '  auto-create: true'].join(
          '\n',
        ),
      },
      repoLabels: [labels.todo],
    });
    const api = new FakeGitHubApi(config);
    const result = await preflight({
      repository: new GitHubRepositoryAdapter({ api, labels }),
      epicNumber: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.createdLabels.length).toBe(allLabelNames.length - 1);
    }
    expect(api.createdLabels.length).toBe(allLabelNames.length - 1);
  });

  it('delegates provider checks and passes when the provider is ok', async () => {
    const result = await preflight({
      repository: repositoryFor(baseConfig()),
      epicNumber: 1,
      providerCheck: async () => ({ ok: true }),
    });
    expect(result.ok).toBe(true);
  });
});

describe('preflight failures', () => {
  it('reports an invalid configuration as a configuration error', async () => {
    const config = baseConfig({ files: { [CONFIG_PATH]: 'version: 2' } });
    const result = await preflight({
      repository: repositoryFor(config),
      epicNumber: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('configuration-error');
      expect(result.messages.join('\n')).toMatch(
        /Unsupported configuration version/,
      );
    }
  });

  it('fails when the epic is missing', async () => {
    const result = await preflight({
      repository: repositoryFor(baseConfig({ issues: {}, subIssues: {} })),
      epicNumber: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('configuration-error');
      expect(result.messages.join('\n')).toMatch(/was not found/);
    }
  });

  it('fails when the epic is closed', async () => {
    const config = baseConfig({
      issues: {
        1: fakeIssue({ number: 1, open: false, closedReason: 'completed' }),
        11: fakeIssue({ number: 11 }),
      },
    });
    const result = await preflight({
      repository: repositoryFor(config),
      epicNumber: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.messages.join('\n')).toMatch(/is closed/);
    }
  });

  it('fails closed on ambiguous native/markdown sources in auto mode', async () => {
    const config = baseConfig({
      issues: {
        1: fakeIssue({
          number: 1,
          body: ['## Ordered sub-issues', '- #12', '- #11'].join('\n'),
        }),
        11: fakeIssue({ number: 11 }),
        12: fakeIssue({ number: 12 }),
      },
      subIssues: { 1: [11, 12] },
    });
    const result = await preflight({
      repository: repositoryFor(config),
      epicNumber: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.messages.join('\n')).toMatch(/both present but differ/);
    }
  });

  it('rejects cross-repository Markdown references', async () => {
    const config = baseConfig({
      issues: {
        1: fakeIssue({
          number: 1,
          body: ['## Ordered sub-issues', '- other/repo#9'].join('\n'),
        }),
      },
      subIssues: { 1: [] },
    });
    const result = await preflight({
      repository: repositoryFor(config),
      epicNumber: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.messages.join('\n')).toMatch(/Cross-repository/);
    }
  });

  it('reports missing labels when auto-create is disabled', async () => {
    const config = baseConfig({ repoLabels: [labels.todo] });
    const result = await preflight({
      repository: repositoryFor(config),
      epicNumber: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.messages.join('\n')).toMatch(/Missing required labels/);
    }
  });

  it('reports a missing base branch', async () => {
    const config = baseConfig({
      files: {
        [CONFIG_PATH]: ['version: 1', 'base:', '  branch: release'].join('\n'),
      },
      branches: ['main'],
    });
    const result = await preflight({
      repository: repositoryFor(config),
      epicNumber: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.messages.join('\n')).toMatch(
        /base branch "release" does not exist/,
      );
    }
  });

  it('reports missing write access when it can be determined', async () => {
    const config = baseConfig({ repository: { canPush: false } });
    const result = await preflight({
      repository: repositoryFor(config),
      epicNumber: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.messages.join('\n')).toMatch(/does not have write access/);
    }
  });

  it('surfaces provider-specific failures', async () => {
    const result = await preflight({
      repository: repositoryFor(baseConfig()),
      epicNumber: 1,
      providerCheck: async () => ({
        ok: false,
        messages: ['Copilot is not enabled for this repository.'],
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.messages).toContain(
        'Copilot is not enabled for this repository.',
      );
    }
  });

  it('returns an operational error when a transport call fails', async () => {
    const api = new FakeGitHubApi(baseConfig());
    api.getRepository = async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    };
    const result = await preflight({
      repository: new GitHubRepositoryAdapter({ api, labels }),
      epicNumber: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('operational-error');
    }
  });
});
