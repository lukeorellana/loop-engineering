/**
 * In-memory fake of the {@link GitHubApi} transport boundary.
 *
 * Tests configure mocked GitHub responses (including multi-page list results and
 * deliberate transport failures) and pass this fake to the adapter, exercising
 * pagination, parsing, normalization, and error sanitization without any network
 * access.
 */
import type {
  ApiComment,
  ApiIssue,
  ApiLabel,
  ApiNumberRef,
  ApiPage,
  ApiPullRequest,
  ApiRepository,
  GitHubApi,
} from '../../src/adapters/github/api.js';
import { parseClosingKeywords } from '../../src/domain/index.js';
import type { ClosedReason } from '../../src/domain/index.js';

/** Split a list into pages of `size` items, reporting `hasNextPage`. */
export function paginate<T>(items: readonly T[], size: number) {
  return (page: number): ApiPage<T> => {
    const start = (page - 1) * size;
    const slice = items.slice(start, start + size);
    return { items: slice, hasNextPage: start + size < items.length };
  };
}

export interface FakeIssue {
  number: number;
  title: string;
  open: boolean;
  closedReason: ClosedReason | null;
  body: string | null;
  labelNames: string[];
}

export interface FakeConfig {
  repository?: Partial<ApiRepository>;
  files?: Record<string, string>;
  branches?: string[];
  repoLabels?: string[];
  issues?: Record<number, FakeIssue>;
  subIssues?: Record<number, number[]>;
  parents?: Record<number, number>;
  pulls?: Record<number, ApiPullRequest>;
  linkedPulls?: Record<number, number[]>;
  comments?: Record<number, ApiComment[]>;
  pageSize?: number;
}

export interface FakeCall {
  op: string;
  args: unknown[];
}

/**
 * A configurable fake implementing {@link GitHubApi} entirely in memory.
 */
export class FakeGitHubApi implements GitHubApi {
  readonly calls: FakeCall[] = [];
  readonly createdLabels: string[] = [];
  readonly addedLabels: { issue: number; labels: string[] }[] = [];
  readonly removedLabels: { issue: number; label: string }[] = [];
  readonly stateChanges: {
    issue: number;
    open: boolean;
    closedReason: ClosedReason | null;
  }[] = [];
  readonly createdComments: { issue: number; body: string }[] = [];
  readonly updatedComments: { id: number; body: string }[] = [];
  readonly updatedPulls: { pull: number; body: string }[] = [];

  constructor(private readonly config: FakeConfig = {}) {}

  private record(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args });
  }

  private get pageSize(): number {
    return this.config.pageSize ?? 100;
  }

  // Comments are stateful so that listing reflects created/updated comments
  // within a run, exercising status-comment upsert/dedupe end to end.
  private commentStore: Map<number, ApiComment[]> | null = null;
  private nextCommentId = 1_000_000;

  private comments(issueNumber: number): ApiComment[] {
    if (this.commentStore === null) {
      this.commentStore = new Map();
      for (const [key, list] of Object.entries(this.config.comments ?? {})) {
        this.commentStore.set(
          Number(key),
          list.map((comment) => ({ ...comment })),
        );
      }
    }
    let list = this.commentStore.get(issueNumber);
    if (list === undefined) {
      list = [];
      this.commentStore.set(issueNumber, list);
    }
    return list;
  }

  async getRepository(): Promise<ApiRepository> {
    this.record('getRepository');
    return {
      owner: 'octo',
      name: 'demo',
      defaultBranch: 'main',
      canPush: true,
      ...this.config.repository,
    };
  }

  async getFileContent(path: string, ref: string): Promise<string | null> {
    this.record('getFileContent', path, ref);
    const files = this.config.files ?? {};
    return Object.prototype.hasOwnProperty.call(files, path)
      ? files[path]
      : null;
  }

  async branchExists(branch: string): Promise<boolean> {
    this.record('branchExists', branch);
    return (this.config.branches ?? ['main']).includes(branch);
  }

  async listRepositoryLabels(page: number): Promise<ApiPage<ApiLabel>> {
    this.record('listRepositoryLabels', page);
    const labels = (this.config.repoLabels ?? []).map((name) => ({ name }));
    return paginate(labels, this.pageSize)(page);
  }

  async createLabel(name: string): Promise<void> {
    this.record('createLabel', name);
    this.createdLabels.push(name);
  }

  async getIssue(issueNumber: number): Promise<ApiIssue | null> {
    this.record('getIssue', issueNumber);
    const issue = this.config.issues?.[issueNumber];
    return issue ? { ...issue, labelNames: [...issue.labelNames] } : null;
  }

  async setIssueState(
    issueNumber: number,
    open: boolean,
    closedReason: ClosedReason | null,
  ): Promise<void> {
    this.record('setIssueState', issueNumber, open, closedReason);
    this.stateChanges.push({ issue: issueNumber, open, closedReason });
  }

  async listIssueLabels(
    issueNumber: number,
    page: number,
  ): Promise<ApiPage<ApiLabel>> {
    this.record('listIssueLabels', issueNumber, page);
    const labels = (this.config.issues?.[issueNumber]?.labelNames ?? []).map(
      (name) => ({ name }),
    );
    return paginate(labels, this.pageSize)(page);
  }

  async addIssueLabels(
    issueNumber: number,
    labels: readonly string[],
  ): Promise<void> {
    this.record('addIssueLabels', issueNumber, labels);
    this.addedLabels.push({ issue: issueNumber, labels: [...labels] });
  }

  async removeIssueLabel(issueNumber: number, label: string): Promise<void> {
    this.record('removeIssueLabel', issueNumber, label);
    this.removedLabels.push({ issue: issueNumber, label });
  }

  async listSubIssues(
    issueNumber: number,
    page: number,
  ): Promise<ApiPage<ApiNumberRef>> {
    this.record('listSubIssues', issueNumber, page);
    const refs = (this.config.subIssues?.[issueNumber] ?? []).map((number) => ({
      number,
    }));
    return paginate(refs, this.pageSize)(page);
  }

  async getParentIssueNumber(issueNumber: number): Promise<number | null> {
    this.record('getParentIssueNumber', issueNumber);
    return this.config.parents?.[issueNumber] ?? null;
  }

  // Pull requests are stateful so that a body update recomputes the closing
  // references the way GitHub indexes a closing keyword, exercising the
  // link → re-read → verify path end to end.
  private pullStore: Map<number, ApiPullRequest> | null = null;

  private pulls(): Map<number, ApiPullRequest> {
    if (this.pullStore === null) {
      this.pullStore = new Map();
      for (const [key, pull] of Object.entries(this.config.pulls ?? {})) {
        this.pullStore.set(Number(key), { ...pull });
      }
    }
    return this.pullStore;
  }

  async getPullRequest(pullNumber: number): Promise<ApiPullRequest | null> {
    this.record('getPullRequest', pullNumber);
    return this.pulls().get(pullNumber) ?? null;
  }

  async updatePullRequestBody(pullNumber: number, body: string): Promise<void> {
    this.record('updatePullRequestBody', pullNumber, body);
    this.updatedPulls.push({ pull: pullNumber, body });
    const pulls = this.pulls();
    const existing = pulls.get(pullNumber);
    const repo = {
      owner: this.config.repository?.owner ?? 'octo',
      name: this.config.repository?.name ?? 'demo',
    };
    // Recompute closing references from the new body's closing keywords, as
    // GitHub does when a pull-request body records a closing relationship.
    const closesIssueNumbers = parseClosingKeywords(body, repo);
    if (existing !== undefined) {
      pulls.set(pullNumber, { ...existing, body, closesIssueNumbers });
    }
  }

  async listIssuesWithLabel(
    label: string,
    page: number,
  ): Promise<ApiPage<ApiNumberRef>> {
    this.record('listIssuesWithLabel', label, page);
    const refs = Object.values(this.config.issues ?? {})
      .filter((issue) => issue.open && issue.labelNames.includes(label))
      .map((issue) => ({ number: issue.number }));
    return paginate(refs, this.pageSize)(page);
  }

  async listLinkedPullRequests(
    issueNumber: number,
    page: number,
  ): Promise<ApiPage<ApiNumberRef>> {
    this.record('listLinkedPullRequests', issueNumber, page);
    const refs = (this.config.linkedPulls?.[issueNumber] ?? []).map(
      (number) => ({ number }),
    );
    return paginate(refs, this.pageSize)(page);
  }

  async listIssueComments(
    issueNumber: number,
    page: number,
  ): Promise<ApiPage<ApiComment>> {
    this.record('listIssueComments', issueNumber, page);
    return paginate(this.comments(issueNumber), this.pageSize)(page);
  }

  async createComment(issueNumber: number, body: string): Promise<void> {
    this.record('createComment', issueNumber, body);
    this.createdComments.push({ issue: issueNumber, body });
    this.comments(issueNumber).push({ id: (this.nextCommentId += 1), body });
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    this.record('updateComment', commentId, body);
    this.updatedComments.push({ id: commentId, body });
    if (this.commentStore !== null) {
      for (const list of this.commentStore.values()) {
        const index = list.findIndex((comment) => comment.id === commentId);
        if (index !== -1) {
          list[index] = { id: commentId, body };
          break;
        }
      }
    }
  }
}

/** Build a {@link FakeIssue} with sensible defaults. */
export function fakeIssue(
  overrides: Partial<FakeIssue> & { number: number },
): FakeIssue {
  return {
    title: `Issue ${overrides.number}`,
    open: true,
    closedReason: null,
    body: null,
    labelNames: [],
    ...overrides,
  };
}
