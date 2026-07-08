export interface IssueSnapshot {
  readonly state: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
}

export interface IssueAssigneeNode {
  readonly id: string;
  readonly login: string;
}

export interface AssignableIssue {
  readonly id: string;
  readonly assignees: readonly IssueAssigneeNode[];
}

export interface AgentAssignGitHubApi {
  getIssue(issueNumber: number): Promise<IssueSnapshot>;
  addLabels(issueNumber: number, labels: readonly string[]): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  listComments(issueNumber: number): Promise<readonly string[]>;
  createComment(issueNumber: number, body: string): Promise<void>;
  listSuggestedActors(): Promise<readonly IssueAssigneeNode[]>;
  getAssignableIssue(issueNumber: number): Promise<AssignableIssue | null>;
  replaceActors(
    assignableId: string,
    actorIds: readonly string[],
  ): Promise<readonly string[]>;
}
