import { describe, expect, it } from 'vitest';

import { collectTriageHistory } from '../src/action/history.js';
import { FakeAgentTasksProvider } from './helpers/fake-agent-tasks.js';
import { FakeTriageHistoryGitHubApi } from './helpers/fake-triage-api.js';

const FP = 'ci-triage-current0';
const TARGET = 'a'.repeat(40);

describe('collectTriageHistory — bounded, redacted, best-effort', () => {
  it('collects recent commits and matching prior tasks, excluding the current fingerprint', async () => {
    const provider = new FakeAgentTasksProvider({
      recentResult: {
        ok: true,
        tasks: [
          {
            taskId: 'old',
            taskUrl: 'https://tasks/old',
            fingerprint: 'ci-triage-older00',
            state: 'completed',
            summary: 'tried X',
          },
          {
            taskId: 'self',
            taskUrl: 'https://tasks/self',
            fingerprint: FP,
          },
          { taskId: 'nofp', taskUrl: 'https://tasks/nofp' },
        ],
      },
    });
    const historyApi = new FakeTriageHistoryGitHubApi({
      recentCommits: {
        [TARGET]: [
          {
            sha: 'c'.repeat(40),
            authorName: 'Dev',
            date: '2026-01-01',
            subject: 'fix',
          },
        ],
      },
    });
    const history = await collectTriageHistory({
      provider,
      historyApi,
      currentFingerprint: FP,
      targetRef: TARGET,
    });
    expect(history.recentCommits).toHaveLength(1);
    expect(history.recentCommits[0]).toEqual({
      sha: 'c'.repeat(40),
      message: 'fix',
      authorName: 'Dev',
      date: '2026-01-01',
    });
    // Only the fingerprinted, non-current task survives.
    expect(history.previousTasks.map((task) => task.taskId)).toEqual(['old']);
    expect(history.unavailable).toEqual([]);
  });

  it('falls back to legacy copilot pull requests only when no prior task matched', async () => {
    const provider = new FakeAgentTasksProvider({
      recentResult: { ok: true, tasks: [] },
    });
    const historyApi = new FakeTriageHistoryGitHubApi({
      legacyPullRequests: [
        {
          number: 9,
          state: 'open',
          url: 'https://pr/9',
          headRef: 'copilot/fix',
        },
      ],
    });
    const history = await collectTriageHistory({
      provider,
      historyApi,
      currentFingerprint: FP,
      targetRef: TARGET,
    });
    expect(history.previousTasks).toHaveLength(1);
    expect(history.previousTasks[0].taskId).toBe('legacy-pr-9');
    expect(history.previousTasks[0].pullRequest).toEqual({
      number: 9,
      state: 'open',
      url: 'https://pr/9',
    });
  });

  it('does not use the legacy fallback when a fingerprinted task exists', async () => {
    const provider = new FakeAgentTasksProvider({
      recentResult: {
        ok: true,
        tasks: [
          {
            taskId: 'fp',
            taskUrl: 'https://tasks/fp',
            fingerprint: 'ci-triage-prev0000',
          },
        ],
      },
    });
    const historyApi = new FakeTriageHistoryGitHubApi({
      legacyPullRequests: [
        {
          number: 9,
          state: 'open',
          url: 'https://pr/9',
          headRef: 'copilot/fix',
        },
      ],
    });
    const history = await collectTriageHistory({
      provider,
      historyApi,
      currentFingerprint: FP,
      targetRef: TARGET,
    });
    expect(history.previousTasks.map((task) => task.taskId)).toEqual(['fp']);
    expect(
      historyApi.calls.some(
        (call) => call.op === 'listLegacyCopilotPullRequests',
      ),
    ).toBe(false);
  });

  it('records unavailable sources without throwing and never leaks error text', async () => {
    const provider = new FakeAgentTasksProvider({
      recentResult: {
        ok: false,
        reason: 'agent-transient',
        message: 'token=ghs_SECRET boom',
      },
    });
    const historyApi = new FakeTriageHistoryGitHubApi({
      commitsError: new Error('token=ghs_SECRET commits boom'),
      legacyError: new Error('token=ghs_SECRET legacy boom'),
    });
    const history = await collectTriageHistory({
      provider,
      historyApi,
      currentFingerprint: FP,
      targetRef: TARGET,
    });
    expect(history.recentCommits).toEqual([]);
    expect(history.previousTasks).toEqual([]);
    expect(history.unavailable).toEqual([
      'recent-commits',
      'previous-tasks',
      'legacy-pull-requests',
    ]);
    expect(JSON.stringify(history)).not.toContain('ghs_SECRET');
  });

  it('marks commit and legacy history unavailable when no history API is provided', async () => {
    const provider = new FakeAgentTasksProvider({
      recentResult: { ok: true, tasks: [] },
    });
    const history = await collectTriageHistory({
      provider,
      currentFingerprint: FP,
      targetRef: TARGET,
    });
    expect(history.unavailable).toContain('recent-commits');
    expect(history.unavailable).toContain('legacy-pull-requests');
  });
});
