import { describe, expect, it } from 'vitest';

import {
  buildAgentTaskRequestBody,
  GitHubAgentTasksProvider,
  type StartTaskInput,
} from '../src/adapters/agent-tasks/index.js';
import {
  AgentTasksError,
  classifyAgentTasksStatus,
  sanitizeAgentTasksError,
} from '../src/adapters/agent-tasks/errors.js';
import {
  mapTaskList,
  mapTaskListItem,
  PREVIOUS_APPROACH_SUMMARY_MAX,
} from '../src/adapters/agent-tasks/api.js';
import {
  FakeAgentTasksTransport,
  FakeHttpError,
} from './helpers/fake-agent-tasks.js';

const PROMPT = '# CI Triage task\n... full prompt ...';

function existingInput(
  overrides: Partial<StartTaskInput> = {},
): StartTaskInput {
  return {
    baseRef: 'main',
    headRef: 'feature/login',
    prompt: PROMPT,
    ...overrides,
  };
}

function newInput(overrides: Partial<StartTaskInput> = {}): StartTaskInput {
  return { baseRef: 'main', prompt: PROMPT, ...overrides };
}

describe('buildAgentTaskRequestBody — existing PR mode', () => {
  it('sends both base and head refs and does not request a new PR', () => {
    const body = buildAgentTaskRequestBody(existingInput());
    expect(body.base_ref).toBe('main');
    expect(body.head_ref).toBe('feature/login');
    expect(body).not.toHaveProperty('create_pull_request');
  });
});

describe('buildAgentTaskRequestBody — new PR mode', () => {
  it('sends only the base ref and requests a new PR', () => {
    const body = buildAgentTaskRequestBody(newInput({ baseRef: 'develop' }));
    expect(body.base_ref).toBe('develop');
    expect(body).not.toHaveProperty('head_ref');
    expect(body.create_pull_request).toBe(true);
  });
});

describe('buildAgentTaskRequestBody — model handling', () => {
  it('passes a non-empty model unchanged', () => {
    const body = buildAgentTaskRequestBody(
      newInput({ model: 'custom/Model-X:latest' }),
    );
    expect(body.model).toBe('custom/Model-X:latest');
  });

  it('omits the model entirely when undefined', () => {
    const body = buildAgentTaskRequestBody(newInput());
    expect(body).not.toHaveProperty('model');
  });

  it('omits the model when it is empty or whitespace-only', () => {
    expect(
      buildAgentTaskRequestBody(newInput({ model: '' })),
    ).not.toHaveProperty('model');
    expect(
      buildAgentTaskRequestBody(newInput({ model: '   ' })),
    ).not.toHaveProperty('model');
  });
});

describe('GitHubAgentTasksProvider — exact payloads', () => {
  it('builds a stacked new-PR payload with a model', async () => {
    const transport = new FakeAgentTasksTransport({
      response: { id: 't1', html_url: 'https://example.com/t1' },
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    await provider.startTask(
      newInput({ baseRef: 'feature/x', model: 'gpt-test' }),
    );
    expect(transport.requests).toEqual([
      {
        problem_statement: PROMPT,
        base_ref: 'feature/x',
        create_pull_request: true,
        model: 'gpt-test',
      },
    ]);
  });

  it('builds an existing-PR payload with no model', async () => {
    const transport = new FakeAgentTasksTransport({
      response: { id: 't2', html_url: 'https://example.com/t2' },
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    await provider.startTask(existingInput());
    expect(transport.requests).toEqual([
      {
        problem_statement: PROMPT,
        base_ref: 'main',
        head_ref: 'feature/login',
      },
    ]);
  });
});

describe('GitHubAgentTasksProvider — response mapping', () => {
  it('maps a started task from id and html_url', async () => {
    const transport = new FakeAgentTasksTransport({
      response: { id: 'abc', html_url: 'https://github.com/x/y/agents/abc' },
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    const result = await provider.startTask(newInput());
    expect(result).toEqual({
      ok: true,
      task: {
        taskId: 'abc',
        taskUrl: 'https://github.com/x/y/agents/abc',
      },
    });
  });

  it('accepts a numeric id and a url fallback', async () => {
    const transport = new FakeAgentTasksTransport({
      response: { id: 42, url: 'https://example.com/42' },
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    const result = await provider.startTask(newInput());
    expect(result).toEqual({
      ok: true,
      task: { taskId: '42', taskUrl: 'https://example.com/42' },
    });
  });

  it('classifies a malformed response as agent-unexpected-response', async () => {
    const transport = new FakeAgentTasksTransport({
      response: { id: 'no-url' },
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    const result = await provider.startTask(newInput());
    expect(result).toEqual({
      ok: false,
      reason: 'agent-unexpected-response',
      message: expect.stringContaining('unexpected response'),
    });
  });

  it('classifies a non-object response as agent-unexpected-response', async () => {
    const transport = new FakeAgentTasksTransport({ response: 'oops' });
    const provider = new GitHubAgentTasksProvider({ transport });
    const result = await provider.startTask(newInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('agent-unexpected-response');
    }
  });
});

describe('classifyAgentTasksStatus — stable reason codes', () => {
  const cases: Array<[number | null, string]> = [
    [401, 'agent-auth-failed'],
    [403, 'agent-forbidden'],
    [404, 'agent-unsupported'],
    [415, 'agent-unsupported'],
    [501, 'agent-unsupported'],
    [400, 'agent-invalid-request'],
    [422, 'agent-invalid-request'],
    [429, 'agent-rate-limited'],
    [500, 'agent-transient'],
    [503, 'agent-transient'],
    [null, 'agent-transient'],
  ];
  for (const [status, reason] of cases) {
    it(`maps ${String(status)} to ${reason}`, () => {
      expect(classifyAgentTasksStatus(status)).toBe(reason);
    });
  }
});

describe('GitHubAgentTasksProvider — error classification', () => {
  it('classifies a 401 transport failure as agent-auth-failed', async () => {
    const transport = new FakeAgentTasksTransport({
      error: new FakeHttpError(401),
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    const result = await provider.startTask(newInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('agent-auth-failed');
    }
  });

  it('classifies a 422 (invalid model) without falling back', async () => {
    const transport = new FakeAgentTasksTransport({
      error: new FakeHttpError(422),
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    const result = await provider.startTask(newInput({ model: 'bogus' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('agent-invalid-request');
    }
    // The model is sent exactly once; there is no retry without the model.
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0].model).toBe('bogus');
  });

  it('classifies a network failure (no status) as agent-transient', async () => {
    const transport = new FakeAgentTasksTransport({
      error: new Error('ECONNRESET'),
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    const result = await provider.startTask(newInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('agent-transient');
    }
  });
});

describe('sanitizeAgentTasksError — redaction', () => {
  it('never echoes raw error content into the message', () => {
    const secret = 'token=ghs_SUPERSECRET response body with prompt text';
    const sanitized = sanitizeAgentTasksError(
      Object.assign(new Error(secret), { status: 403 }),
    );
    expect(sanitized).toBeInstanceOf(AgentTasksError);
    expect(sanitized.message).not.toContain('ghs_SUPERSECRET');
    expect(sanitized.message).not.toContain(secret);
    expect(sanitized.reason).toBe('agent-forbidden');
  });

  it('passes an existing AgentTasksError through unchanged', () => {
    const original = new AgentTasksError('agent-rate-limited', 429);
    expect(sanitizeAgentTasksError(original)).toBe(original);
  });
});

const FP = 'ci-triage-abcd1234';
const OTHER_FP = 'ci-triage-99998888';

function marker(fingerprint: string): string {
  return `<!-- ci-triage-fingerprint: ${fingerprint} -->`;
}

function taskRecord(
  id: string,
  fingerprint: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    html_url: `https://github.com/x/y/agents/${id}`,
    ...(fingerprint !== null
      ? { problem_statement: `prompt body\n${marker(fingerprint)}` }
      : {}),
    ...extra,
  };
}

describe('mapTaskList — bounded, defensive parsing', () => {
  it('maps a bare array and extracts the fingerprint from the prompt body', () => {
    const items = mapTaskList([taskRecord('t1', FP)]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('t1');
    expect(items[0].fingerprint).toBe(FP);
    expect(items[0].htmlUrl).toBe('https://github.com/x/y/agents/t1');
  });

  it('accepts an envelope under agent_tasks/tasks/items', () => {
    expect(mapTaskList({ agent_tasks: [taskRecord('a', FP)] })).toHaveLength(1);
    expect(mapTaskList({ tasks: [taskRecord('b', FP)] })).toHaveLength(1);
    expect(mapTaskList({ items: [taskRecord('c', FP)] })).toHaveLength(1);
  });

  it('drops records lacking the minimal identity', () => {
    expect(mapTaskList([{ id: 't', html_url: '' }, 'nope', null])).toEqual([]);
  });

  it('truncates the approach summary and never carries the full prompt body', () => {
    const longSummary = 'S'.repeat(PREVIOUS_APPROACH_SUMMARY_MAX + 50);
    const item = mapTaskListItem(
      taskRecord('t', FP, {
        summary: longSummary,
        problem_statement: `SECRET FULL PROMPT BODY\n${marker(FP)}`,
      }),
    );
    expect(item).not.toBeNull();
    expect(item?.summary?.length).toBeLessThanOrEqual(
      PREVIOUS_APPROACH_SUMMARY_MAX + 1,
    );
    expect(item?.summary).not.toContain('SECRET FULL PROMPT BODY');
  });

  it('maps the associated pull request when present', () => {
    const item = mapTaskListItem(
      taskRecord('t', FP, {
        state: 'completed',
        pull_request: { number: 12, state: 'open', html_url: 'https://pr/12' },
      }),
    );
    expect(item?.state).toBe('completed');
    expect(item?.pullRequest).toEqual({
      number: 12,
      state: 'open',
      url: 'https://pr/12',
    });
  });
});

describe('GitHubAgentTasksProvider — findTaskByFingerprint', () => {
  it('returns the matching task directly from the list', async () => {
    const transport = new FakeAgentTasksTransport({
      listResponse: [taskRecord('t1', OTHER_FP), taskRecord('t2', FP)],
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    const result = await provider.findTaskByFingerprint(FP);
    expect(result).toEqual({
      ok: true,
      task: expect.objectContaining({ taskId: 't2', fingerprint: FP }),
    });
    expect(transport.getCalls).toHaveLength(0);
  });

  it('resolves details for a fingerprint-less candidate', async () => {
    const transport = new FakeAgentTasksTransport({
      listResponse: [taskRecord('t1', null)],
      taskDetails: { t1: taskRecord('t1', FP) },
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    const result = await provider.findTaskByFingerprint(FP);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task?.taskId).toBe('t1');
    }
    expect(transport.getCalls).toEqual(['t1']);
  });

  it('returns task: null when no candidate matches', async () => {
    const transport = new FakeAgentTasksTransport({
      listResponse: [taskRecord('t1', OTHER_FP)],
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    expect(await provider.findTaskByFingerprint(FP)).toEqual({
      ok: true,
      task: null,
    });
  });

  it('reports ok: false (so dedup fails closed) when the list read fails', async () => {
    const transport = new FakeAgentTasksTransport({
      listError: new FakeHttpError(503),
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    const result = await provider.findTaskByFingerprint(FP);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('agent-transient');
    }
  });
});

describe('GitHubAgentTasksProvider — listRecentTasks', () => {
  it('returns bounded mapped tasks', async () => {
    const transport = new FakeAgentTasksTransport({
      listResponse: [taskRecord('t1', FP), taskRecord('t2', OTHER_FP)],
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    const result = await provider.listRecentTasks();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tasks.map((task) => task.taskId)).toEqual(['t1', 't2']);
    }
  });

  it('reports ok: false when the list read fails (history is best-effort)', async () => {
    const transport = new FakeAgentTasksTransport({
      listError: new FakeHttpError(429),
    });
    const provider = new GitHubAgentTasksProvider({ transport });
    const result = await provider.listRecentTasks();
    expect(result.ok).toBe(false);
  });
});
