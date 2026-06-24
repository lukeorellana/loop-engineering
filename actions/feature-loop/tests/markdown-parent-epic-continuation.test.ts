import { describe, expect, it } from 'vitest';

import {
  CrossRepositoryReferenceError,
  GitHubRepositoryAdapter,
} from '../src/adapters/github/index.js';
import { DEFAULT_CANONICAL_STATE_LABELS } from '../src/config/schema.js';
import { runFeatureLoop } from '../src/orchestrator/index.js';
import type { Logger } from '../src/ports/logger.js';
import { FakeAgentProvider } from './helpers/fake-agent-provider.js';
import { FakeGitHubApi, fakeIssue } from './helpers/fake-github-api.js';

const labels = DEFAULT_CANONICAL_STATE_LABELS;
const allLabels = Object.values(labels);

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warning: () => {},
  error: () => {},
};

const clock = {
  now: () => new Date('2026-06-24T01:00:00.000Z'),
};

function adapterFor(api: FakeGitHubApi): GitHubRepositoryAdapter {
  return new GitHubRepositoryAdapter({ api, labels });
}

describe('Markdown parent epic resolution', () => {
  it('prefers the native GitHub parent when one exists', async () => {
    const api = new FakeGitHubApi({
      parents: { 11: 1 },
      issues: {
        11: fakeIssue({ number: 11, body: 'Parent epic: #99' }),
      },
    });

    expect(await adapterFor(api).getParentEpicNumber(11)).toBe(1);
    expect(api.calls.filter((call) => call.op === 'getIssue')).toHaveLength(0);
  });

  it.each([
    ['inline form', 'Parent epic: #108'],
    ['heading form', '## Parent epic\n\n- #108'],
    ['same-repository shorthand', 'Parent epic: OCTO/Demo#108'],
    [
      'same-repository URL',
      'Parent epic: https://github.com/octo/demo/issues/108',
    ],
  ])('falls back to the issue body for the %s', async (_name, body) => {
    const api = new FakeGitHubApi({
      issues: { 117: fakeIssue({ number: 117, body }) },
    });

    expect(await adapterFor(api).getParentEpicNumber(117)).toBe(108);
  });

  it('rejects a cross-repository Markdown parent', async () => {
    const api = new FakeGitHubApi({
      issues: {
        117: fakeIssue({ number: 117, body: 'Parent epic: other/repo#108' }),
      },
    });

    await expect(
      adapterFor(api).getParentEpicNumber(117),
    ).rejects.toBeInstanceOf(CrossRepositoryReferenceError);
  });
});

describe('merged PR continuation with Markdown-only issue hierarchy', () => {
  it('marks the completed issue done and starts the next ordered issue', async () => {
    const api = new FakeGitHubApi({
      branches: ['main'],
      repoLabels: allLabels,
      issues: {
        108: fakeIssue({
          number: 108,
          title: 'Phase 6 epic',
          body: [
            '## Ordered sub-issues',
            '1. #117 Schedule assignments',
            '2. #118 Add integrated acceptance',
          ].join('\n'),
        }),
        117: fakeIssue({
          number: 117,
          open: false,
          closedReason: 'completed',
          body: 'Parent epic: #108',
          labelNames: [labels['in-progress']],
        }),
        118: fakeIssue({
          number: 118,
          body: 'Parent epic: #108',
        }),
      },
      pulls: {
        157: {
          number: 157,
          merged: true,
          mergedBy: 'lukeorellana',
          baseRef: 'main',
          headRef: 'copilot/phase-6-9',
          body: 'Closes #117\n\nParent epic: #108',
          closesIssueNumbers: [117],
        },
      },
    });
    const repository = adapterFor(api);
    const provider = new FakeAgentProvider();

    const result = await runFeatureLoop({
      repository,
      provider,
      clock,
      logger,
      request: {
        event: {
          name: 'pull_request',
          action: 'closed',
          pullRequest: {
            number: 157,
            merged: true,
            baseRef: 'main',
            headRef: 'copilot/phase-6-9',
            body: 'Closes #117\n\nParent epic: #108',
            closingIssueReferences: [117],
          },
        },
        dryRun: false,
      },
    });

    expect(result.outcome).toBe('started');
    expect(result.epicNumber).toBe(108);
    expect(result.completedIssueNumber).toBe(117);
    expect(result.issueNumber).toBe(118);
    expect(
      provider.startRequests.map((request) => request.issue.number),
    ).toEqual([118]);
    expect(api.removedLabels).toContainEqual({
      issue: 117,
      label: labels['in-progress'],
    });
    expect(api.addedLabels).toContainEqual({
      issue: 117,
      labels: [labels.done],
    });
    expect(api.addedLabels).toContainEqual({
      issue: 118,
      labels: [labels['in-progress']],
    });
  });
});
