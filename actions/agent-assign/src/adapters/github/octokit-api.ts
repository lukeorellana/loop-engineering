import type { getOctokit } from '@actions/github';

import type {
  AgentAssignGitHubApi,
  AssignableIssue,
  IssueAssigneeNode,
  IssueSnapshot,
} from './api.js';

export class OctokitAgentAssignGitHubApi implements AgentAssignGitHubApi {
  constructor(
    private readonly octokit: ReturnType<typeof getOctokit>,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  async getIssue(issueNumber: number): Promise<IssueSnapshot> {
    const issue = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });

    const labels = (issue.data.labels ?? [])
      .map((label) =>
        typeof label === 'string' ? label : (label.name ?? '').trim(),
      )
      .filter((label: string) => label !== '');

    return {
      state: issue.data.state,
      labels,
      assignees: (issue.data.assignees ?? []).map(
        (assignee: { login: string }) => assignee.login,
      ),
    };
  }

  async addLabels(
    issueNumber: number,
    labels: readonly string[],
  ): Promise<void> {
    if (labels.length === 0) {
      return;
    }
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels: [...labels],
    });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch {
      // Best-effort cleanup; missing label should not fail assignment.
    }
  }

  async listComments(issueNumber: number): Promise<readonly string[]> {
    const comments = await this.octokit.paginate(
      this.octokit.rest.issues.listComments,
      {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100,
      },
    );

    return comments
      .map((comment: { body?: string | null }) => comment.body ?? '')
      .filter((body: string): body is string => body.trim() !== '');
  }

  async createComment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  async listSuggestedActors(): Promise<readonly IssueAssigneeNode[]> {
    const result = await this.octokit.graphql<{
      repository?: {
        suggestedActors?: {
          nodes?: Array<{ id?: string; login?: string } | null>;
        };
      };
    }>(
      `query($owner:String!,$repo:String!){
        repository(owner:$owner,name:$repo){
          suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){
            nodes{
              login
              ... on Bot { id }
              ... on User { id }
              ... on Mannequin { id }
              ... on Organization { id }
            }
          }
        }
      }`,
      { owner: this.owner, repo: this.repo },
    );

    return (
      result.repository?.suggestedActors?.nodes
        ?.filter((node): node is { id: string; login: string } =>
          Boolean(node?.id && node.login),
        )
        .map((node: { id: string; login: string }) => ({
          id: node.id,
          login: node.login,
        })) ?? []
    );
  }

  async getAssignableIssue(
    issueNumber: number,
  ): Promise<AssignableIssue | null> {
    const result = await this.octokit.graphql<{
      repository?: {
        issue?: {
          id: string;
          assignees?: {
            nodes?: Array<{ id?: string; login?: string } | null>;
          };
        } | null;
      };
    }>(
      `query($owner:String!,$repo:String!,$number:Int!){
        repository(owner:$owner,name:$repo){
          issue(number:$number){
            id
            assignees(first:100){
              nodes { id login }
            }
          }
        }
      }`,
      { owner: this.owner, repo: this.repo, number: issueNumber },
    );

    const issue = result.repository?.issue;
    if (!issue) {
      return null;
    }

    return {
      id: issue.id,
      assignees:
        issue.assignees?.nodes
          ?.filter((node): node is { id: string; login: string } =>
            Boolean(node?.id && node.login),
          )
          .map((node: { id: string; login: string }) => ({
            id: node.id,
            login: node.login,
          })) ?? [],
    };
  }

  async replaceActors(
    assignableId: string,
    actorIds: readonly string[],
  ): Promise<readonly string[]> {
    const result = await this.octokit.graphql<{
      replaceActorsForAssignable?: {
        assignable?: {
          assignees?: {
            nodes?: Array<{ login?: string } | null>;
          };
        };
      };
    }>(
      `mutation($assignableId:ID!,$actorIds:[ID!]!){
        replaceActorsForAssignable(input:{assignableId:$assignableId,actorIds:$actorIds}){
          assignable{
            ... on Issue {
              assignees(first:100){ nodes { login } }
            }
          }
        }
      }`,
      { assignableId, actorIds: [...actorIds] },
    );

    return (
      result.replaceActorsForAssignable?.assignable?.assignees?.nodes
        ?.map((node) => node?.login ?? '')
        .filter((login: string) => login !== '') ?? []
    );
  }
}
