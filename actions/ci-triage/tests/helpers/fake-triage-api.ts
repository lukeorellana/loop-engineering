/**
 * In-memory fake of the {@link TriageGitHubApi} transport boundary.
 *
 * Tests configure mocked workflow-run, pull-request, and branch responses and
 * pass this fake to the resolver, exercising failed-run resolution, pull-request
 * selection, and stale-run protection without any network access. Every call is
 * recorded so a test can assert that fail-closed paths perform zero writes (the
 * resolver only ever reads).
 */
import type {
  LegacyCopilotPullRequest,
  TriageCommit,
  TriageGitHubApi,
  TriageHistoryGitHubApi,
  TriageWorkflowRun,
} from '../../src/adapters/github/api.js';
import type { CandidatePullRequest } from '../../src/domain/index.js';

export interface FakeTriageConfig {
  workflowRuns?: Record<number, TriageWorkflowRun>;
  pullRequests?: Record<number, CandidatePullRequest>;
  pullRequestsForCommit?: Record<string, readonly CandidatePullRequest[]>;
  branchHeads?: Record<string, string>;
}

export interface FakeCall {
  op: string;
  args: unknown[];
}

export class FakeTriageGitHubApi implements TriageGitHubApi {
  readonly calls: FakeCall[] = [];

  constructor(private readonly config: FakeTriageConfig = {}) {}

  private record(op: string, args: unknown[]): void {
    this.calls.push({ op, args });
  }

  async getWorkflowRun(runId: number): Promise<TriageWorkflowRun | null> {
    this.record('getWorkflowRun', [runId]);
    return this.config.workflowRuns?.[runId] ?? null;
  }

  async getPullRequest(
    pullNumber: number,
  ): Promise<CandidatePullRequest | null> {
    this.record('getPullRequest', [pullNumber]);
    return this.config.pullRequests?.[pullNumber] ?? null;
  }

  async listPullRequestsForCommit(
    headSha: string,
  ): Promise<readonly CandidatePullRequest[]> {
    this.record('listPullRequestsForCommit', [headSha]);
    return this.config.pullRequestsForCommit?.[headSha] ?? [];
  }

  async getBranchHeadSha(branch: string): Promise<string | null> {
    this.record('getBranchHeadSha', [branch]);
    return this.config.branchHeads?.[branch] ?? null;
  }
}

export interface FakeHistoryConfig {
  /** Commits returned by `listRecentCommits`, keyed by ref or SHA. */
  recentCommits?: Record<string, readonly TriageCommit[]>;
  /** Legacy Copilot pull requests returned by the fallback discovery. */
  legacyPullRequests?: readonly LegacyCopilotPullRequest[];
  /** When set, `listRecentCommits` throws this. */
  commitsError?: unknown;
  /** When set, `listLegacyCopilotPullRequests` throws this. */
  legacyError?: unknown;
}

/** In-memory fake of the optional {@link TriageHistoryGitHubApi} boundary. */
export class FakeTriageHistoryGitHubApi implements TriageHistoryGitHubApi {
  readonly calls: FakeCall[] = [];

  constructor(private readonly config: FakeHistoryConfig = {}) {}

  async listRecentCommits(
    refOrSha: string,
    limit: number,
  ): Promise<readonly TriageCommit[]> {
    this.calls.push({ op: 'listRecentCommits', args: [refOrSha, limit] });
    if (this.config.commitsError !== undefined) {
      throw this.config.commitsError;
    }
    return this.config.recentCommits?.[refOrSha] ?? [];
  }

  async listLegacyCopilotPullRequests(): Promise<
    readonly LegacyCopilotPullRequest[]
  > {
    this.calls.push({ op: 'listLegacyCopilotPullRequests', args: [] });
    if (this.config.legacyError !== undefined) {
      throw this.config.legacyError;
    }
    return this.config.legacyPullRequests ?? [];
  }
}
