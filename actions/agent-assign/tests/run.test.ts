import { describe, expect, it } from 'vitest';

import { executeAction } from '../src/action/run.js';
import { FakeActionCore } from './helpers/fake-action-core.js';
import {
  FakeGitHubApi,
  buildDefaultFakeState,
} from './helpers/fake-github-api.js';

function createEnv(
  inputs: Record<string, string>,
  overrides?: Partial<ReturnType<typeof buildDefaultFakeState>>,
  issueNumber = 42,
) {
  const state = { ...buildDefaultFakeState(), ...overrides };
  const core = new FakeActionCore({
    'github-token': 'gh-token',
    ...inputs,
  });
  const api = new FakeGitHubApi(state);

  return {
    core,
    api,
    env: {
      core,
      issueNumber,
      buildApi: () => api,
    },
  };
}

describe('executeAction', () => {
  it('skips when event has no issue payload', async () => {
    const { core, env } = createEnv(
      {},
      undefined,
      undefined as unknown as number,
    );
    const result = await executeAction({ ...env, issueNumber: undefined });

    expect(result.outcome).toBe('skipped');
    expect(result.reasonCode).toBe('no-issue-in-event');
    expect(core.outputs['issue-number']).toBe('');
  });

  it('skips when a default suppression label is present', async () => {
    const { env, core } = createEnv(
      {},
      {
        issue: {
          state: 'open',
          labels: ['agent: implement', 'agent: manual'],
          assignees: [],
        },
      },
    );
    const result = await executeAction(env);

    expect(result.outcome).toBe('skipped');
    expect(result.reasonCode).toBe('suppression-label-present');
    expect(core.failed).toBeNull();
  });

  it('is read-only in dry-run mode', async () => {
    const { env, api } = createEnv({ 'dry-run': 'true' });
    const result = await executeAction(env);

    expect(result.outcome).toBe('dry-run');
    expect(api.labelsAdded).toHaveLength(0);
    expect(api.replaceActorCalls).toHaveLength(0);
  });

  it('assigns Copilot and preserves human assignees by default', async () => {
    const { env, api, core } = createEnv({});
    const result = await executeAction(env);

    expect(result.outcome).toBe('assigned');
    expect(api.replaceActorCalls[0]).toEqual(['human-id', 'copilot-id']);
    expect(core.outputs.outcome).toBe('assigned');
  });

  it('replaces assignees when replace-assignees is true', async () => {
    const { env, api } = createEnv({ 'replace-assignees': 'true' });
    await executeAction(env);

    expect(api.replaceActorCalls[0]).toEqual(['copilot-id']);
  });

  it('posts instructions once using an idempotency marker', async () => {
    const existing = '<!-- copilot-agent-assign:instructions --> already there';
    const { env, api } = createEnv({}, { comments: [existing] });

    await executeAction(env);
    expect(
      api.createdComments.some((body) =>
        body.includes('implementation guidance'),
      ),
    ).toBe(false);
  });

  it('marks failure when Copilot actor is unavailable', async () => {
    const { env, api, core } = createEnv({}, { suggestedActors: [] });
    const result = await executeAction(env);

    expect(result.outcome).toBe('operational-error');
    expect(result.reasonCode).toBe('actor-unavailable');
    expect(api.labelsAdded.flat()).toContain('agent: failed');
    expect(core.failed).toContain('Copilot suggested actor was not found.');
  });
});
