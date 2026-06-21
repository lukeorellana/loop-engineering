/**
 * Octokit-backed implementation of the narrow {@link CopilotAgentApi} GraphQL
 * boundary.
 *
 * This composition-layer binding translates the provider's transport boundary
 * into concrete GitHub GraphQL operations: discovering the repository's
 * assignable actors, reading an issue's node id and current assignees, and
 * assigning an actor to an issue. It is constructed with the dedicated
 * agent-assignment credential, kept separate from the ordinary repository token,
 * and is the only place in the Copilot provider stack that depends on Octokit.
 *
 * The provider sanitizes every failure before it reaches a log or an issue, so
 * this transport intentionally performs no logging and surfaces raw transport
 * errors to its caller.
 */

import type { getOctokit } from '@actions/github';

import type {
  AssignActorRequest,
  AssignActorResult,
  AssignableActor,
  AssignableIssue,
  CopilotAgentApi,
} from './api.js';

/** The authenticated client surface this transport depends on. */
export type OctokitClient = ReturnType<typeof getOctokit>;

interface SuggestedActorsQuery {
  readonly repository: {
    readonly suggestedActors: {
      readonly nodes: readonly ({
        readonly login: string;
        readonly __typename: string;
        readonly id?: string;
      } | null)[];
    };
  } | null;
}

interface AssignableIssueQuery {
  readonly repository: {
    readonly issue: {
      readonly id: string;
      readonly assignees: {
        readonly nodes: readonly { readonly login: string }[];
      };
    } | null;
  } | null;
}

interface ReplaceActorsMutation {
  readonly replaceActorsForAssignable: {
    readonly assignable: {
      readonly assignees?: {
        readonly nodes: readonly { readonly login: string }[];
      };
    } | null;
  } | null;
}

/**
 * Construction options for {@link OctokitCopilotAgentApi}.
 */
export interface OctokitCopilotAgentApiOptions {
  readonly octokit: OctokitClient;
  readonly owner: string;
  readonly repo: string;
}

export class OctokitCopilotAgentApi implements CopilotAgentApi {
  private readonly octokit: OctokitClient;
  private readonly owner: string;
  private readonly repo: string;

  constructor(options: OctokitCopilotAgentApiOptions) {
    this.octokit = options.octokit;
    this.owner = options.owner;
    this.repo = options.repo;
  }

  async getAssignableActors(): Promise<readonly AssignableActor[]> {
    const result = await this.octokit.graphql<SuggestedActorsQuery>(
      `query($owner:String!,$repo:String!){
        repository(owner:$owner,name:$repo){
          suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){
            nodes{
              login
              __typename
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
    const nodes = result.repository?.suggestedActors.nodes ?? [];
    const actors: AssignableActor[] = [];
    for (const node of nodes) {
      if (node !== null && typeof node.id === 'string') {
        actors.push({
          id: node.id,
          login: node.login,
          typename: node.__typename,
        });
      }
    }
    return actors;
  }

  async getAssignableIssue(
    issueNumber: number,
  ): Promise<AssignableIssue | null> {
    const result = await this.octokit.graphql<AssignableIssueQuery>(
      `query($owner:String!,$repo:String!,$number:Int!){
        repository(owner:$owner,name:$repo){
          issue(number:$number){
            id
            assignees(first:100){ nodes{ login } }
          }
        }
      }`,
      { owner: this.owner, repo: this.repo, number: issueNumber },
    );
    const issue = result.repository?.issue;
    if (issue === null || issue === undefined) {
      return null;
    }
    return {
      id: issue.id,
      assigneeLogins: issue.assignees.nodes.map((node) => node.login),
    };
  }

  async assignActor(request: AssignActorRequest): Promise<AssignActorResult> {
    const result = await this.octokit.graphql<ReplaceActorsMutation>(
      `mutation($assignableId:ID!,$actorIds:[ID!]!){
        replaceActorsForAssignable(input:{assignableId:$assignableId,actorIds:$actorIds}){
          assignable{
            ... on Issue { assignees(first:100){ nodes{ login } } }
          }
        }
      }`,
      { assignableId: request.assignableId, actorIds: [request.actorId] },
    );
    const nodes =
      result.replaceActorsForAssignable?.assignable?.assignees?.nodes ?? [];
    return { assigneeLogins: nodes.map((node) => node.login) };
  }
}
