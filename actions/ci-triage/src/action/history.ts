/**
 * Best-effort collection of bounded, redacted previous-attempt context.
 *
 * {@link collectTriageHistory} gathers the diagnostic history a new triage task
 * may use to avoid repeating a failed fix: recent commits ending at the resolved
 * target, recent matching CI Triage tasks (and their state and pull request),
 * and — only as a fallback for attempts created before fingerprints existed —
 * legacy `copilot/*` pull requests discovered by branch convention.
 *
 * Every source is strictly best effort: a failure to read one source is recorded
 * as a safe, sourceless note and never blocks a new task. Output is bounded and
 * redacted — commit author emails and complete prior prompts are never carried
 * here; only short SHAs, author names, dates, subjects, task state/URL, PR
 * number/state/URL, and a truncated approach summary are exposed.
 */

import type {
  AgentTasksProvider,
  ExistingTask,
} from '../adapters/agent-tasks/index.js';
import type {
  LegacyCopilotPullRequest,
  TriageCommit,
  TriageHistoryGitHubApi,
} from '../adapters/github/index.js';
import type { PreviousTaskSummary, RecentCommit } from '../domain/index.js';

/** The maximum number of recent commits surfaced as bounded history. */
export const MAX_HISTORY_COMMITS = 10;

/** The maximum number of previous attempts surfaced as bounded history. */
export const MAX_HISTORY_TASKS = 10;

/** The bounded, redacted previous-attempt context fed into the prompt. */
export interface TriageHistory {
  readonly recentCommits: readonly RecentCommit[];
  readonly previousTasks: readonly PreviousTaskSummary[];
  /**
   * Stable, sourceless identifiers for any optional history source that could
   * not be retrieved. Never contains credentials, payloads, or error text.
   */
  readonly unavailable: readonly string[];
}

/** Inputs for {@link collectTriageHistory}. */
export interface CollectHistoryParams {
  /** The Agent Tasks provider used to list recent tasks. */
  readonly provider: AgentTasksProvider;
  /** Optional history reads; absent means commit/legacy history is unavailable. */
  readonly historyApi?: TriageHistoryGitHubApi;
  /** The fingerprint of the task being created, excluded from prior attempts. */
  readonly currentFingerprint: string;
  /** The resolved target ref or SHA the recent commits should end at. */
  readonly targetRef: string;
}

function commitToEvidence(commit: TriageCommit): RecentCommit {
  return {
    sha: commit.sha,
    message: commit.subject,
    ...(commit.authorName !== '' ? { authorName: commit.authorName } : {}),
    ...(commit.date !== '' ? { date: commit.date } : {}),
  };
}

function taskToEvidence(task: ExistingTask): PreviousTaskSummary {
  return {
    taskId: task.taskId,
    summary: task.summary ?? 'previous CI Triage task',
    ...(task.state !== undefined ? { state: task.state } : {}),
    url: task.taskUrl,
    ...(task.pullRequest !== undefined
      ? {
          pullRequest: {
            number: task.pullRequest.number,
            state: task.pullRequest.state,
            url: task.pullRequest.url,
          },
        }
      : {}),
  };
}

function legacyToEvidence(pr: LegacyCopilotPullRequest): PreviousTaskSummary {
  return {
    taskId: `legacy-pr-${pr.number}`,
    summary: 'Legacy Copilot pull request (predates CI Triage fingerprints).',
    state: pr.state,
    pullRequest: { number: pr.number, state: pr.state, url: pr.url },
  };
}

/**
 * Collect bounded previous-attempt history. Never throws: every source is
 * isolated so an individual failure only adds an `unavailable` note.
 */
export async function collectTriageHistory(
  params: CollectHistoryParams,
): Promise<TriageHistory> {
  const unavailable: string[] = [];

  // 1. Recent commits ending at the resolved target.
  let recentCommits: readonly RecentCommit[] = [];
  if (params.historyApi === undefined) {
    unavailable.push('recent-commits');
  } else {
    try {
      const commits = await params.historyApi.listRecentCommits(
        params.targetRef,
        MAX_HISTORY_COMMITS,
      );
      recentCommits = commits
        .slice(0, MAX_HISTORY_COMMITS)
        .map(commitToEvidence);
    } catch {
      unavailable.push('recent-commits');
    }
  }

  // 2. Recent matching CI Triage tasks (those carrying a fingerprint), excluding
  //    the exact task being created.
  let previousTasks: PreviousTaskSummary[] = [];
  const recent = await params.provider.listRecentTasks();
  if (!recent.ok) {
    unavailable.push('previous-tasks');
  } else {
    previousTasks = recent.tasks
      .filter(
        (task) =>
          task.fingerprint !== undefined &&
          task.fingerprint !== params.currentFingerprint,
      )
      .slice(0, MAX_HISTORY_TASKS)
      .map(taskToEvidence);
  }

  // 3. Legacy fallback: only when no fingerprinted prior task was found.
  if (previousTasks.length === 0) {
    if (params.historyApi === undefined) {
      unavailable.push('legacy-pull-requests');
    } else {
      try {
        const legacy = await params.historyApi.listLegacyCopilotPullRequests();
        previousTasks = legacy
          .slice(0, MAX_HISTORY_TASKS)
          .map(legacyToEvidence);
      } catch {
        unavailable.push('legacy-pull-requests');
      }
    }
  }

  return { recentCommits, previousTasks, unavailable };
}
