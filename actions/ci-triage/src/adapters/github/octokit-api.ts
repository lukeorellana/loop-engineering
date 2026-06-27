/**
 * Octokit-backed implementation of the narrow {@link TriageGitHubApi} transport.
 *
 * This composition-layer binding turns the resolver's transport boundary into
 * concrete GitHub REST reads. It is built with the ordinary repository token
 * (never the `agent-token`) and is the only place in the resolver stack that
 * depends on Octokit. It performs read-only metadata reads and never checks out
 * or executes failed-branch code.
 *
 * Reads that target a missing resource (a deleted run, pull request, or branch)
 * resolve to `null` rather than throwing, matching the {@link TriageGitHubApi}
 * contract; every other failure propagates to the caller.
 */

import type { getOctokit } from '@actions/github';

import type { CandidatePullRequest } from '../../domain/index.js';
import type { TriageGitHubApi, TriageWorkflowRun } from './api.js';

/** The authenticated client surface this transport depends on. */
export type OctokitClient = ReturnType<typeof getOctokit>;

/** Construction options for {@link OctokitTriageGitHubApi}. */
export interface OctokitTriageGitHubApiOptions {
  readonly octokit: OctokitClient;
  readonly owner: string;
  readonly repo: string;
}

function statusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return null;
}

interface RestPullRequest {
  readonly number: number;
  readonly state: string;
  readonly base: {
    readonly ref: string;
    readonly repo: { readonly id: number } | null;
  };
  readonly head: {
    readonly ref: string;
    readonly sha: string;
    readonly repo: { readonly id: number } | null;
  };
}

function normalizePullRequest(pull: RestPullRequest): CandidatePullRequest {
  const baseRepoId = pull.base.repo?.id ?? null;
  const headRepoId = pull.head.repo?.id ?? null;
  // A fork pull request has a head repository different from the base
  // repository (or no head repository at all, for a deleted fork).
  const isFork = headRepoId === null || headRepoId !== baseRepoId;
  return {
    number: pull.number,
    state: pull.state === 'open' ? 'open' : 'closed',
    isFork,
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
  };
}

export class OctokitTriageGitHubApi implements TriageGitHubApi {
  private readonly octokit: OctokitClient;
  private readonly owner: string;
  private readonly repo: string;

  constructor(options: OctokitTriageGitHubApiOptions) {
    this.octokit = options.octokit;
    this.owner = options.owner;
    this.repo = options.repo;
  }

  async getWorkflowRun(runId: number): Promise<TriageWorkflowRun | null> {
    try {
      const { data } = await this.octokit.rest.actions.getWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        run_id: runId,
      });
      const pullRequestNumbers = (data.pull_requests ?? []).map(
        (pull: { readonly number: number }) => pull.number,
      );
      return {
        id: data.id,
        name: data.name ?? '',
        runAttempt: data.run_attempt ?? 1,
        htmlUrl: data.html_url,
        event: data.event,
        status: data.status ?? '',
        conclusion: data.conclusion,
        headBranch: data.head_branch,
        headSha: data.head_sha,
        pullRequestNumbers,
      };
    } catch (error) {
      if (statusOf(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  async getPullRequest(
    pullNumber: number,
  ): Promise<CandidatePullRequest | null> {
    try {
      const { data } = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
      });
      return normalizePullRequest(data as RestPullRequest);
    } catch (error) {
      if (statusOf(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  async listPullRequestsForCommit(
    headSha: string,
  ): Promise<readonly CandidatePullRequest[]> {
    const { data } =
      await this.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner: this.owner,
        repo: this.repo,
        commit_sha: headSha,
        per_page: 100,
      });
    return data.map((pull: unknown) =>
      normalizePullRequest(pull as RestPullRequest),
    );
  }

  async getBranchHeadSha(branch: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.repos.getBranch({
        owner: this.owner,
        repo: this.repo,
        branch,
      });
      return data.commit.sha;
    } catch (error) {
      if (statusOf(error) === 404) {
        return null;
      }
      throw error;
    }
  }
}
