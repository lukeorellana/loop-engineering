import type {
  AgentAssignGitHubApi,
  AssignableIssue,
  IssueAssigneeNode,
  IssueSnapshot,
} from '../../src/adapters/github/api.js';

interface FakeState {
  issue: IssueSnapshot;
  assignableIssue: AssignableIssue | null;
  suggestedActors: IssueAssigneeNode[];
  comments: string[];
  replacedAssigneeLogins: string[];
}

export class FakeGitHubApi implements AgentAssignGitHubApi {
  readonly labelsAdded: Array<readonly string[]> = [];
  readonly labelsRemoved: string[] = [];
  readonly createdComments: string[] = [];
  readonly replaceActorCalls: Array<readonly string[]> = [];

  constructor(private readonly state: FakeState) {}

  async getIssue(): Promise<IssueSnapshot> {
    return this.state.issue;
  }

  async addLabels(
    _issueNumber: number,
    labels: readonly string[],
  ): Promise<void> {
    this.labelsAdded.push(labels);
  }

  async removeLabel(_issueNumber: number, label: string): Promise<void> {
    this.labelsRemoved.push(label);
  }

  async listComments(): Promise<readonly string[]> {
    return this.state.comments;
  }

  async createComment(_issueNumber: number, body: string): Promise<void> {
    this.state.comments.push(body);
    this.createdComments.push(body);
  }

  async listSuggestedActors(): Promise<readonly IssueAssigneeNode[]> {
    return this.state.suggestedActors;
  }

  async getAssignableIssue(): Promise<AssignableIssue | null> {
    return this.state.assignableIssue;
  }

  async replaceActors(
    _assignableId: string,
    actorIds: readonly string[],
  ): Promise<readonly string[]> {
    this.replaceActorCalls.push(actorIds);
    return this.state.replacedAssigneeLogins;
  }
}

export function buildDefaultFakeState(): FakeState {
  return {
    issue: {
      state: 'open',
      labels: ['agent: implement'],
      assignees: ['octocat'],
    },
    assignableIssue: {
      id: 'issue-node-id',
      assignees: [{ id: 'human-id', login: 'octocat' }],
    },
    suggestedActors: [{ id: 'copilot-id', login: 'copilot-swe-agent' }],
    comments: [],
    replacedAssigneeLogins: ['octocat', 'copilot-swe-agent'],
  };
}
