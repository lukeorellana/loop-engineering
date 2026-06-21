import { afterEach, describe, expect, it, vi } from 'vitest';

const { executeAction } = vi.hoisted(() => ({
  executeAction: vi.fn(async () => undefined),
}));

vi.mock('@actions/github', () => ({
  context: {
    eventName: 'pull_request',
    repo: { owner: 'octo', repo: 'demo' },
    payload: {
      action: 'closed',
      pull_request: {
        number: 42,
        merged: true,
        merged_by: { login: 'octocat' },
        base: { ref: 'main' },
        head: { ref: 'feature' },
        body: 'Closes #7',
      },
    },
  },
  getOctokit: vi.fn(() => ({})),
}));

vi.mock('../src/action/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/action/index.js')>();
  return { ...actual, executeAction };
});

import { run } from '../src/main.js';
import type { ActionEnvironment } from '../src/action/index.js';
import { OctokitGitHubApi } from '../src/adapters/github/index.js';
import { OctokitCopilotAgentApi } from '../src/adapters/github-copilot/index.js';

describe('run', () => {
  afterEach(() => {
    executeAction.mockClear();
  });

  it('binds the GitHub context and Octokit transports to the action', async () => {
    await expect(run()).resolves.toBeUndefined();

    expect(executeAction).toHaveBeenCalledTimes(1);
    const env = (
      executeAction.mock.calls[0] as unknown[]
    )[0] as ActionEnvironment;

    // The pull_request payload is normalized into the action event.
    expect(env.event.eventName).toBe('pull_request');
    expect(env.event.action).toBe('closed');
    expect(env.event.pullRequest).toMatchObject({
      number: 42,
      merged: true,
      mergedBy: 'octocat',
      baseRef: 'main',
      headRef: 'feature',
      // Closing references come from the authoritative re-read, not the payload.
      closingIssueReferences: [],
    });

    // The transports are the Octokit-backed bindings.
    expect(env.buildRepositoryApi('token')).toBeInstanceOf(OctokitGitHubApi);
    expect(env.buildAgentApi('token')).toBeInstanceOf(OctokitCopilotAgentApi);
  });
});
