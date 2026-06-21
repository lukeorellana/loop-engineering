import { describe, expect, it } from 'vitest';

import type {
  AgentModelSelection,
  AgentStartRequest,
  AgentPreflightRequest,
  Epic,
  SubIssue,
} from '../src/domain/index.js';
import {
  COPILOT_ACTOR_LOGINS,
  CopilotProviderError,
  GitHubCopilotProvider,
  GITHUB_COPILOT_PROVIDER_ID,
  type AssignableActor,
} from '../src/adapters/github-copilot/index.js';
import type { Clock } from '../src/ports/index.js';
import {
  FakeCopilotAgentApi,
  type FakeCopilotConfig,
} from './helpers/fake-copilot-api.js';

const FIXED_NOW = new Date('2024-05-01T12:00:00.000Z');
const fixedClock: Clock = { now: () => FIXED_NOW };

const copilotActor: AssignableActor = {
  id: 'BOT_copilot',
  login: 'copilot-swe-agent',
  typename: 'Bot',
};

const humanActor: AssignableActor = {
  id: 'USER_octocat',
  login: 'octocat',
  typename: 'User',
};

function subIssue(): SubIssue {
  return {
    number: 11,
    title: 'Implement feature',
    order: 0,
    open: true,
    state: 'todo',
    canonicalStateLabels: ['feature-loop:todo'],
  };
}

function epic(): Epic {
  return { number: 1, title: 'Epic', open: true, subIssues: [subIssue()] };
}

function startRequest(
  overrides: Partial<AgentStartRequest> = {},
): AgentStartRequest {
  return {
    epic: epic(),
    issue: subIssue(),
    provider: GITHUB_COPILOT_PROVIDER_ID,
    model: { kind: 'auto' } satisfies AgentModelSelection,
    baseBranch: 'main',
    dryRun: false,
    ...overrides,
  };
}

function preflightRequest(): AgentPreflightRequest {
  return {
    epic: epic(),
    provider: GITHUB_COPILOT_PROVIDER_ID,
    baseBranch: 'main',
    model: { kind: 'auto' },
  };
}

function providerFor(config: FakeCopilotConfig): {
  provider: GitHubCopilotProvider;
  api: FakeCopilotAgentApi;
} {
  const api = new FakeCopilotAgentApi(config);
  const provider = new GitHubCopilotProvider({ api, clock: fixedClock });
  return { provider, api };
}

describe('GitHubCopilotProvider preflight', () => {
  it('passes when the Copilot actor is assignable', async () => {
    const { provider } = providerFor({ actors: [humanActor, copilotActor] });
    const result = await provider.preflight(preflightRequest());
    expect(result.ok).toBe(true);
  });

  it('matches documented legacy Copilot logins case-insensitively', async () => {
    const { provider } = providerFor({
      actors: [{ id: 'BOT_legacy', login: 'Copilot', typename: 'Bot' }],
    });
    const result = await provider.preflight(preflightRequest());
    expect(result.ok).toBe(true);
  });

  it('reports an unavailable provider when no Copilot actor exists', async () => {
    const { provider } = providerFor({ actors: [humanActor] });
    const result = await provider.preflight(preflightRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('actor-not-found');
      expect(result.messages.join('\n')).toMatch(/not available/);
    }
  });

  it('reports insufficient access on an authentication failure', async () => {
    const { provider } = providerFor({
      getActorsError: Object.assign(new Error('bad creds'), { status: 401 }),
    });
    const result = await provider.preflight(preflightRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthenticated');
    }
  });

  it('reports an authorization failure', async () => {
    const { provider } = providerFor({
      getActorsError: Object.assign(new Error('forbidden'), { status: 403 }),
    });
    const result = await provider.preflight(preflightRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
    }
  });
});

describe('GitHubCopilotProvider isAlreadyStarted', () => {
  it('detects an existing Copilot assignment', async () => {
    const { provider } = providerFor({
      issues: { 11: { id: 'I_11', assigneeLogins: ['copilot-swe-agent'] } },
    });
    expect(await provider.isAlreadyStarted(startRequest())).toBe(true);
  });

  it('returns false when Copilot is not assigned', async () => {
    const { provider } = providerFor({
      issues: { 11: { id: 'I_11', assigneeLogins: ['octocat'] } },
    });
    expect(await provider.isAlreadyStarted(startRequest())).toBe(false);
  });

  it('returns false when the issue does not exist', async () => {
    const { provider } = providerFor({});
    expect(await provider.isAlreadyStarted(startRequest())).toBe(false);
  });
});

describe('GitHubCopilotProvider startAgent', () => {
  it('assigns Copilot and reports the assignment time', async () => {
    const { provider, api } = providerFor({
      actors: [copilotActor],
      issues: { 11: { id: 'I_11', assigneeLogins: [] } },
    });
    const result = await provider.startAgent(startRequest());
    expect(result).toEqual({
      status: 'started',
      issueNumber: 11,
      assignedAt: FIXED_NOW.toISOString(),
    });
    expect(api.assignments).toHaveLength(1);
    expect(api.assignments[0]).toMatchObject({
      assignableId: 'I_11',
      actorId: copilotActor.id,
      baseRef: 'main',
    });
  });

  it('uses the configured base branch', async () => {
    const { provider, api } = providerFor({
      actors: [copilotActor],
      issues: { 11: { id: 'I_11', assigneeLogins: [] } },
    });
    await provider.startAgent(startRequest({ baseBranch: 'develop' }));
    expect(api.assignments[0].baseRef).toBe('develop');
  });

  it('omits the model field for automatic model selection', async () => {
    const { provider, api } = providerFor({
      actors: [copilotActor],
      issues: { 11: { id: 'I_11', assigneeLogins: [] } },
    });
    await provider.startAgent(startRequest({ model: { kind: 'auto' } }));
    expect('model' in api.assignments[0]).toBe(false);
  });

  it('includes the model field only when explicitly configured', async () => {
    const { provider, api } = providerFor({
      actors: [copilotActor],
      issues: { 11: { id: 'I_11', assigneeLogins: [] } },
    });
    await provider.startAgent(
      startRequest({ model: { kind: 'explicit', name: 'gpt-5' } }),
    );
    expect(api.assignments[0].model).toBe('gpt-5');
  });

  it('is idempotent when Copilot is already assigned', async () => {
    const { provider, api } = providerFor({
      actors: [copilotActor],
      issues: { 11: { id: 'I_11', assigneeLogins: ['copilot-swe-agent'] } },
    });
    const result = await provider.startAgent(startRequest());
    expect(result).toEqual({ status: 'already-running', issueNumber: 11 });
    expect(api.assignments).toHaveLength(0);
  });

  it('fails closed when the Copilot actor is missing', async () => {
    const { provider, api } = providerFor({
      actors: [humanActor],
      issues: { 11: { id: 'I_11', assigneeLogins: [] } },
    });
    const result = await provider.startAgent(startRequest());
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'actor-not-found',
    });
    expect(api.assignments).toHaveLength(0);
  });

  it('returns a sanitized authentication failure', async () => {
    const { provider } = providerFor({
      actors: [copilotActor],
      issues: { 11: { id: 'I_11', assigneeLogins: [] } },
      assignError: Object.assign(new Error('token leak: ghp_secret'), {
        status: 401,
      }),
    });
    const result = await provider.startAgent(startRequest());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.reason).toBe('unauthenticated');
      expect(result.error).not.toContain('ghp_secret');
    }
  });

  it('returns a sanitized authorization failure', async () => {
    const { provider } = providerFor({
      actors: [copilotActor],
      issues: { 11: { id: 'I_11', assigneeLogins: [] } },
      assignError: Object.assign(new Error('forbidden'), { status: 403 }),
    });
    const result = await provider.startAgent(startRequest());
    expect(result).toMatchObject({ status: 'failed', reason: 'unauthorized' });
  });

  it('returns an invalid-base-branch failure on a validation error', async () => {
    const { provider } = providerFor({
      actors: [copilotActor],
      issues: { 11: { id: 'I_11', assigneeLogins: [] } },
      assignError: Object.assign(new Error('unprocessable'), { status: 422 }),
    });
    const result = await provider.startAgent(startRequest());
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'invalid-base-branch',
    });
  });

  it('recovers an uncertain mutation when reconciliation shows the assignment', async () => {
    const api = new FakeCopilotAgentApi({
      actors: [copilotActor],
      issues: { 11: { id: 'I_11', assigneeLogins: [] } },
      assignError: Object.assign(new Error('gateway timeout'), { status: 502 }),
    });
    // The pre-mutation read shows no assignment; the mutation "loses" its
    // response, and the reconciliation read observes a successful assignment.
    let issueReads = 0;
    api.getAssignableIssue = async () => {
      issueReads += 1;
      const logins = issueReads > 1 ? ['copilot-swe-agent'] : [];
      return { id: 'I_11', assigneeLogins: logins };
    };
    const provider = new GitHubCopilotProvider({ api, clock: fixedClock });
    const result = await provider.startAgent(startRequest());
    expect(result).toEqual({
      status: 'started',
      issueNumber: 11,
      assignedAt: FIXED_NOW.toISOString(),
    });
  });

  it('does not blindly retry; a lost response with no assignment fails closed', async () => {
    const { provider, api } = providerFor({
      actors: [copilotActor],
      issues: { 11: { id: 'I_11', assigneeLogins: [] } },
      // The mutation returns without confirming the Copilot assignment.
      assignResultLogins: [],
    });
    const result = await provider.startAgent(startRequest());
    expect(result.status).toBe('failed');
    // Exactly one mutation attempt: the provider never retries.
    expect(api.assignments).toHaveLength(1);
  });

  it('stays uncertain when reconciliation cannot read the issue', async () => {
    const api = new FakeCopilotAgentApi({
      actors: [copilotActor],
      issues: { 11: { id: 'I_11', assigneeLogins: [] } },
      assignResultLogins: [],
    });
    let issueReads = 0;
    const originalGetIssue = api.getAssignableIssue.bind(api);
    api.getAssignableIssue = async (issueNumber: number) => {
      issueReads += 1;
      // First read (pre-mutation) succeeds; the reconciliation read fails.
      if (issueReads > 1) {
        throw Object.assign(new Error('unavailable'), { status: 503 });
      }
      return originalGetIssue(issueNumber);
    };
    const provider = new GitHubCopilotProvider({ api, clock: fixedClock });
    const result = await provider.startAgent(startRequest());
    expect(result.status).toBe('uncertain');
  });

  it('does not mutate during a dry run', async () => {
    const { provider, api } = providerFor({
      actors: [copilotActor],
      issues: { 11: { id: 'I_11', assigneeLogins: [] } },
    });
    const result = await provider.startAgent(startRequest({ dryRun: true }));
    expect(result.status).toBe('uncertain');
    expect(api.assignments).toHaveLength(0);
  });

  it('reports already-running during a dry run when assigned', async () => {
    const { provider, api } = providerFor({
      issues: { 11: { id: 'I_11', assigneeLogins: ['copilot-swe-agent'] } },
    });
    const result = await provider.startAgent(startRequest({ dryRun: true }));
    expect(result).toEqual({ status: 'already-running', issueNumber: 11 });
    expect(api.assignments).toHaveLength(0);
  });
});

describe('CopilotProviderError', () => {
  it('never includes raw response content', () => {
    const error = new CopilotProviderError('assign Copilot', 'unauthenticated');
    expect(error.message).not.toMatch(/token|ghp_|secret/i);
    expect(error.reason).toBe('unauthenticated');
  });

  it('exposes the known Copilot logins, current first', () => {
    expect(COPILOT_ACTOR_LOGINS[0]).toBe('copilot-swe-agent');
    expect(COPILOT_ACTOR_LOGINS).toContain('copilot');
  });
});
