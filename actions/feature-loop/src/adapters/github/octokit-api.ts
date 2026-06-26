/**
 * Octokit-backed implementation of the narrow {@link GitHubApi} transport.
 *
 * This is the composition-layer binding that turns the repository adapter's
 * transport boundary into concrete GitHub REST and GraphQL calls. It is built
 * with the ordinary repository token (never the agent-assignment credential) and
 * is the only place in the repository adapter stack that depends on Octokit.
 *
 * Reads that target a missing resource (a deleted issue, an absent file, a
 * non-existent branch) resolve to `null`/`false` rather than throwing, matching
 * the {@link GitHubApi} contract; every other failure propagates so the adapter
 * can sanitize it. Relationship reads that GitHub only exposes through GraphQL
 * (native sub-issues, the native parent, a pull request's closing references, and
 * the pull requests linked to an issue) are issued as GraphQL queries; the
 * page-oriented list methods return the full result on page one so the adapter's
 * pagination loop terminates deterministically.
 */

import type { getOctokit } from '@actions/github';

import type { ClosedReason } from '../../domain/issues.js';
import type {
  ApiComment,
  ApiIssue,
  ApiLabel,
  ApiNumberRef,
  ApiPage,
  ApiPullRequest,
  ApiRepository,
  GitHubApi,
} from './api.js';

/** The authenticated client surface this transport depends on. */
export type OctokitClient = ReturnType<typeof getOctokit>;

const PER_PAGE = 100;

/** A single empty page used by GraphQL-backed list methods after page one. */
const EMPTY_PAGE: ApiPage<never> = { items: [], hasNextPage: false };

interface GraphQlNumberNode {
  readonly number: number;
}

interface SubIssuesQuery {
  readonly repository: {
    readonly issue: {
      readonly subIssues: {
        readonly nodes: readonly GraphQlNumberNode[];
        readonly pageInfo: {
          readonly hasNextPage: boolean;
          readonly endCursor: string | null;
        };
      };
    } | null;
  } | null;
}

interface ParentQuery {
  readonly repository: {
    readonly issue: {
      readonly parent: GraphQlNumberNode | null;
    } | null;
  } | null;
}

interface IssueNodeIdQuery {
  readonly repository: {
    readonly issue: {
      readonly id: string;
    } | null;
  } | null;
}

interface ClosingReferencesQuery {
  readonly repository: {
    readonly pullRequest: {
      readonly closingIssuesReferences: {
        readonly nodes: readonly GraphQlNumberNode[];
        readonly pageInfo: {
          readonly hasNextPage: boolean;
          readonly endCursor: string | null;
        };
      };
    } | null;
  } | null;
}

interface LinkedPullRequestsQuery {
  readonly repository: {
    readonly issue: {
      readonly closedByPullRequestsReferences: {
        readonly nodes: readonly GraphQlNumberNode[];
        readonly pageInfo: {
          readonly hasNextPage: boolean;
          readonly endCursor: string | null;
        };
      };
    } | null;
  } | null;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function closedReasonFromStateReason(
  stateReason: string | null | undefined,
): ClosedReason | null {
  if (stateReason === 'completed') {
    return 'completed';
  }
  if (stateReason === 'not_planned') {
    return 'not-planned';
  }
  return null;
}

function stateReasonFromClosedReason(
  closedReason: ClosedReason | null,
): 'completed' | 'not_planned' | undefined {
  if (closedReason === 'completed') {
    return 'completed';
  }
  if (closedReason === 'not-planned') {
    return 'not_planned';
  }
  return undefined;
}

/**
 * Construction options for {@link OctokitGitHubApi}.
 */
export interface OctokitGitHubApiOptions {
  readonly octokit: OctokitClient;
  readonly owner: string;
  readonly repo: string;
}

export class OctokitGitHubApi implements GitHubApi {
  private readonly octokit: OctokitClient;
  private readonly owner: string;
  private readonly repo: string;

  constructor(options: OctokitGitHubApiOptions) {
    this.octokit = options.octokit;
    this.owner = options.owner;
    this.repo = options.repo;
  }

  async getRepository(): Promise<ApiRepository> {
    const { data } = await this.octokit.rest.repos.get({
      owner: this.owner,
      repo: this.repo,
    });
    const push = data.permissions?.push;
    return {
      owner: data.owner.login,
      name: data.name,
      defaultBranch: data.default_branch,
      canPush: typeof push === 'boolean' ? push : null,
    };
  }

  async getFileContent(path: string, ref: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref,
      });
      if (Array.isArray(data) || data.type !== 'file') {
        return null;
      }
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (error) {
      if (statusOf(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.octokit.rest.repos.getBranch({
        owner: this.owner,
        repo: this.repo,
        branch,
      });
      return true;
    } catch (error) {
      if (statusOf(error) === 404) {
        return false;
      }
      throw error;
    }
  }

  async listRepositoryLabels(page: number): Promise<ApiPage<ApiLabel>> {
    const { data } = await this.octokit.rest.issues.listLabelsForRepo({
      owner: this.owner,
      repo: this.repo,
      per_page: PER_PAGE,
      page,
    });
    return {
      items: data.map((label) => ({ name: label.name })),
      hasNextPage: data.length === PER_PAGE,
    };
  }

  async createLabel(name: string): Promise<void> {
    try {
      await this.octokit.rest.issues.createLabel({
        owner: this.owner,
        repo: this.repo,
        name,
      });
    } catch (error) {
      // A label that already exists is reported as a 422 validation failure;
      // creation is idempotent, so treat an existing label as success.
      if (statusOf(error) === 422) {
        return;
      }
      throw error;
    }
  }

  async getIssue(issueNumber: number): Promise<ApiIssue | null> {
    try {
      const { data } = await this.octokit.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
      });
      const labelNames = data.labels
        .map((label) => (typeof label === 'string' ? label : label.name))
        .filter((name): name is string => typeof name === 'string');
      return {
        number: data.number,
        title: data.title,
        open: data.state === 'open',
        closedReason: closedReasonFromStateReason(data.state_reason),
        body: data.body ?? null,
        labelNames,
      };
    } catch (error) {
      if (statusOf(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  async setIssueState(
    issueNumber: number,
    open: boolean,
    closedReason: ClosedReason | null,
  ): Promise<void> {
    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      state: open ? 'open' : 'closed',
      ...(open
        ? {}
        : { state_reason: stateReasonFromClosedReason(closedReason) }),
    });
  }

  async listIssueLabels(
    issueNumber: number,
    page: number,
  ): Promise<ApiPage<ApiLabel>> {
    const { data } = await this.octokit.rest.issues.listLabelsOnIssue({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: PER_PAGE,
      page,
    });
    return {
      items: data.map((label) => ({ name: label.name })),
      hasNextPage: data.length === PER_PAGE,
    };
  }

  async addIssueLabels(
    issueNumber: number,
    labels: readonly string[],
  ): Promise<void> {
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels: [...labels],
    });
  }

  async removeIssueLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (error) {
      // The label is already absent; removal is idempotent.
      if (statusOf(error) === 404) {
        return;
      }
      throw error;
    }
  }

  async listSubIssues(
    issueNumber: number,
    page: number,
  ): Promise<ApiPage<ApiNumberRef>> {
    if (page > 1) {
      return EMPTY_PAGE;
    }
    const items = await this.collectGraphQl(async (after) => {
      const result = await this.octokit.graphql<SubIssuesQuery>(
        `query($owner:String!,$repo:String!,$number:Int!,$after:String){
          repository(owner:$owner,name:$repo){
            issue(number:$number){
              subIssues(first:100,after:$after){
                nodes{ number }
                pageInfo{ hasNextPage endCursor }
              }
            }
          }
        }`,
        { owner: this.owner, repo: this.repo, number: issueNumber, after },
      );
      return result.repository?.issue?.subIssues ?? null;
    });
    return { items, hasNextPage: false };
  }

  async getParentIssueNumber(issueNumber: number): Promise<number | null> {
    const result = await this.octokit.graphql<ParentQuery>(
      `query($owner:String!,$repo:String!,$number:Int!){
        repository(owner:$owner,name:$repo){
          issue(number:$number){ parent{ number } }
        }
      }`,
      { owner: this.owner, repo: this.repo, number: issueNumber },
    );
    return result.repository?.issue?.parent?.number ?? null;
  }

  async getIssueNodeId(issueNumber: number): Promise<string | null> {
    const result = await this.octokit.graphql<IssueNodeIdQuery>(
      `query($owner:String!,$repo:String!,$number:Int!){
        repository(owner:$owner,name:$repo){
          issue(number:$number){ id }
        }
      }`,
      { owner: this.owner, repo: this.repo, number: issueNumber },
    );
    return result.repository?.issue?.id ?? null;
  }

  async addSubIssue(
    parentId: string,
    subIssueId: string,
    replaceParent: boolean,
  ): Promise<void> {
    await this.octokit.graphql(
      `mutation($issueId:ID!,$subIssueId:ID!,$replaceParent:Boolean){
        addSubIssue(input:{issueId:$issueId,subIssueId:$subIssueId,replaceParent:$replaceParent}){
          clientMutationId
        }
      }`,
      { issueId: parentId, subIssueId, replaceParent },
    );
  }

  async removeSubIssue(parentId: string, subIssueId: string): Promise<void> {
    await this.octokit.graphql(
      `mutation($issueId:ID!,$subIssueId:ID!){
        removeSubIssue(input:{issueId:$issueId,subIssueId:$subIssueId}){
          clientMutationId
        }
      }`,
      { issueId: parentId, subIssueId },
    );
  }

  async reprioritizeSubIssue(
    parentId: string,
    subIssueId: string,
    afterId: string | null,
  ): Promise<void> {
    await this.octokit.graphql(
      `mutation($issueId:ID!,$subIssueId:ID!,$afterId:ID){
        reprioritizeSubIssue(input:{issueId:$issueId,subIssueId:$subIssueId,afterId:$afterId}){
          clientMutationId
        }
      }`,
      { issueId: parentId, subIssueId, afterId },
    );
  }

  async getPullRequest(pullNumber: number): Promise<ApiPullRequest | null> {
    let data;
    try {
      ({ data } = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
      }));
    } catch (error) {
      if (statusOf(error) === 404) {
        return null;
      }
      throw error;
    }
    const closesIssueNumbers = await this.collectGraphQl(async (after) => {
      const result = await this.octokit.graphql<ClosingReferencesQuery>(
        `query($owner:String!,$repo:String!,$number:Int!,$after:String){
          repository(owner:$owner,name:$repo){
            pullRequest(number:$number){
              closingIssuesReferences(first:100,after:$after){
                nodes{ number }
                pageInfo{ hasNextPage endCursor }
              }
            }
          }
        }`,
        { owner: this.owner, repo: this.repo, number: pullNumber, after },
      );
      return result.repository?.pullRequest?.closingIssuesReferences ?? null;
    });
    return {
      number: data.number,
      merged: data.merged,
      mergedBy: data.merged_by?.login ?? null,
      author: data.user?.login ?? null,
      baseRef: data.base.ref,
      headRef: data.head.ref,
      body: data.body ?? null,
      closesIssueNumbers: closesIssueNumbers.map((ref) => ref.number),
    };
  }

  async updatePullRequestBody(pullNumber: number, body: string): Promise<void> {
    await this.octokit.rest.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: pullNumber,
      body,
    });
  }

  async listIssuesWithLabel(
    label: string,
    page: number,
  ): Promise<ApiPage<ApiNumberRef>> {
    const { data } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: label,
      state: 'open',
      per_page: PER_PAGE,
      page,
    });
    // listForRepo returns both issues and pull requests; pull requests carry a
    // `pull_request` field and are excluded so only true issues are reported.
    const items = data
      .filter((item) => item.pull_request === undefined)
      .map((item) => ({ number: item.number }));
    return { items, hasNextPage: data.length === PER_PAGE };
  }

  async listLinkedPullRequests(
    issueNumber: number,
    page: number,
  ): Promise<ApiPage<ApiNumberRef>> {
    if (page > 1) {
      return EMPTY_PAGE;
    }
    const items = await this.collectGraphQl(async (after) => {
      const result = await this.octokit.graphql<LinkedPullRequestsQuery>(
        `query($owner:String!,$repo:String!,$number:Int!,$after:String){
          repository(owner:$owner,name:$repo){
            issue(number:$number){
              closedByPullRequestsReferences(first:100,after:$after,includeClosedPrs:true){
                nodes{ number }
                pageInfo{ hasNextPage endCursor }
              }
            }
          }
        }`,
        { owner: this.owner, repo: this.repo, number: issueNumber, after },
      );
      return result.repository?.issue?.closedByPullRequestsReferences ?? null;
    });
    return { items, hasNextPage: false };
  }

  async listIssueComments(
    issueNumber: number,
    page: number,
  ): Promise<ApiPage<ApiComment>> {
    const { data } = await this.octokit.rest.issues.listComments({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      per_page: PER_PAGE,
      page,
    });
    return {
      items: data.map((comment) => ({
        id: comment.id,
        body: comment.body ?? '',
      })),
      hasNextPage: data.length === PER_PAGE,
    };
  }

  async createComment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: commentId,
      body,
    });
  }

  /**
   * Drain a GraphQL `number`-node connection across all cursor pages.
   */
  private async collectGraphQl(
    fetchPage: (after: string | null) => Promise<{
      readonly nodes: readonly GraphQlNumberNode[];
      readonly pageInfo: {
        readonly hasNextPage: boolean;
        readonly endCursor: string | null;
      };
    } | null>,
  ): Promise<ApiNumberRef[]> {
    const items: ApiNumberRef[] = [];
    let after: string | null = null;
    for (;;) {
      const connection = await fetchPage(after);
      if (connection === null) {
        return items;
      }
      for (const node of connection.nodes) {
        items.push({ number: node.number });
      }
      if (
        !connection.pageInfo.hasNextPage ||
        connection.pageInfo.endCursor === null
      ) {
        return items;
      }
      after = connection.pageInfo.endCursor;
    }
  }
}
