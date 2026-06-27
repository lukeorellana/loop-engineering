/**
 * The narrow GitHub API boundary the triage target resolver depends on.
 *
 * The resolver depends only on this interface, never on Octokit types or raw
 * HTTP responses, so it can be exercised deterministically with mocked event and
 * API fixtures. Implementations translate these operations to REST/GraphQL
 * calls and normalize the responses into the small shapes below. None of these
 * operations checks out or executes failed-branch code; they only read metadata.
 *
 * Operations return `null` for a missing resource where absence is a normal,
 * expected outcome (a deleted run, pull request, or branch).
 */

import type { CandidatePullRequest } from '../../domain/index.js';

/**
 * The authoritative failed workflow run, as refetched before acting. The
 * resolver re-reads this rather than trusting the triage event payload, so it
 * never acts on a run that has since changed.
 */
export interface TriageWorkflowRun {
  readonly id: number;
  readonly name: string;
  readonly runAttempt: number;
  readonly htmlUrl: string;
  /** The event that triggered the run (for example `pull_request` or `push`). */
  readonly event: string;
  /** The run lifecycle status (for example `completed`). */
  readonly status: string;
  /** The run conclusion (for example `failure`), or `null` while not concluded. */
  readonly conclusion: string | null;
  /** The run's head branch, or `null` when GitHub reports none (for example a tag). */
  readonly headBranch: string | null;
  /** The run's head SHA. */
  readonly headSha: string;
  /**
   * The numbers of same-repository pull requests GitHub attached to the run.
   * Fork pull requests are never attached here, matching GitHub's behavior.
   */
  readonly pullRequestNumbers: readonly number[];
}

/**
 * The transport-level GitHub reads the resolver consumes. Implementations
 * sanitize any transport failure before it reaches the resolver.
 */
export interface TriageGitHubApi {
  /** Refetch the failed workflow run, or `null` when it no longer exists. */
  getWorkflowRun(runId: number): Promise<TriageWorkflowRun | null>;

  /** Read a pull request, or `null` when it does not exist. */
  getPullRequest(pullNumber: number): Promise<CandidatePullRequest | null>;

  /** The pull requests associated with `headSha`, in any order. */
  listPullRequestsForCommit(
    headSha: string,
  ): Promise<readonly CandidatePullRequest[]>;

  /** The head SHA a branch currently points to, or `null` when it is missing. */
  getBranchHeadSha(branch: string): Promise<string | null>;
}
