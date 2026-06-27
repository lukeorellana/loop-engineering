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
  TriageGitHubApi,
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
