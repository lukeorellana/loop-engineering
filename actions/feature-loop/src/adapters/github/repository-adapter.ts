/**
 * GitHub repository adapter.
 *
 * Implements {@link GitHubRepositoryPort} on top of the narrow {@link GitHubApi}
 * transport boundary. The adapter owns pagination, Markdown parsing, canonical
 * label normalization, status-comment upserts, and error sanitization; it never
 * exposes Octokit types or raw API responses.
 *
 * Configuration is always read from the repository default branch, so it can
 * never come from a pull-request head, a fork, an arbitrary ref, or checked-out
 * pull-request code.
 */

import type { CanonicalStateLabels } from '../../config/schema.js';
import {
  parseMarkdownSubIssues,
  resolveIssueState,
  type Epic,
  type PullRequestCompletionContext,
  type MergedPullRequest,
  type SubIssue,
} from '../../domain/index.js';
import type {
  GitHubRepositoryPort,
  RepositoryInfo,
} from '../../ports/github-repository.js';
import type { ApiPage, GitHubApi } from './api.js';
import { CrossRepositoryReferenceError, sanitizeError } from './errors.js';
import { buildStatusCommentBody, hasStatusMarker } from './status-comment.js';

/** A defensive cap on paginated reads to avoid unbounded loops. */
const MAX_PAGES = 1000;

/**
 * Construction options for {@link GitHubRepositoryAdapter}.
 */
export interface GitHubRepositoryAdapterOptions {
  /** The transport boundary the adapter calls. */
  readonly api: GitHubApi;
  /**
   * The configured canonical-state label mapping, used to resolve issue state
   * and to normalize labels to a single canonical state.
   */
  readonly labels: CanonicalStateLabels;
}

export class GitHubRepositoryAdapter implements GitHubRepositoryPort {
  private readonly api: GitHubApi;
  private readonly labels: CanonicalStateLabels;
  private readonly canonicalLabelNames: readonly string[];

  constructor(options: GitHubRepositoryAdapterOptions) {
    this.api = options.api;
    this.labels = options.labels;
    this.canonicalLabelNames = Object.values(options.labels);
  }

  async getRepositoryInfo(): Promise<RepositoryInfo> {
    const repo = await this.run('get repository', () =>
      this.api.getRepository(),
    );
    return {
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
    };
  }

  async getDefaultBranchFile(path: string): Promise<string | null> {
    const repo = await this.run('get repository', () =>
      this.api.getRepository(),
    );
    return this.run('read configuration file', () =>
      this.api.getFileContent(path, repo.defaultBranch),
    );
  }

  async branchExists(branch: string): Promise<boolean> {
    return this.run('check branch', () => this.api.branchExists(branch));
  }

  async getRepositoryLabelNames(): Promise<readonly string[]> {
    const labels = await this.collectAll('list repository labels', (page) =>
      this.api.listRepositoryLabels(page),
    );
    return labels.map((label) => label.name);
  }

  async hasWriteAccess(): Promise<boolean | null> {
    const repo = await this.run('get repository', () =>
      this.api.getRepository(),
    );
    return repo.canPush;
  }

  async getEpic(epicNumber: number): Promise<Epic | null> {
    const epicIssue = await this.run('get epic', () =>
      this.api.getIssue(epicNumber),
    );
    if (epicIssue === null) {
      return null;
    }
    const subNumbers = await this.getNativeSubIssueNumbers(epicNumber);
    const subIssues = await this.buildSubIssues(subNumbers);
    return {
      number: epicIssue.number,
      title: epicIssue.title,
      open: epicIssue.open,
      subIssues,
    };
  }

  async getEpicWithSubIssues(
    epicNumber: number,
    orderedSubIssueNumbers: readonly number[],
  ): Promise<Epic | null> {
    const epicIssue = await this.run('get epic', () =>
      this.api.getIssue(epicNumber),
    );
    if (epicIssue === null) {
      return null;
    }
    const subIssues = await this.buildSubIssues(orderedSubIssueNumbers);
    return {
      number: epicIssue.number,
      title: epicIssue.title,
      open: epicIssue.open,
      subIssues,
    };
  }

  private async buildSubIssues(
    orderedSubIssueNumbers: readonly number[],
  ): Promise<SubIssue[]> {
    const subIssues: SubIssue[] = [];
    for (const subNumber of orderedSubIssueNumbers) {
      const issue = await this.run('get sub-issue', () =>
        this.api.getIssue(subNumber),
      );
      if (issue === null) {
        continue;
      }
      const resolved = resolveIssueState(
        {
          open: issue.open,
          closedReason: issue.closedReason ?? undefined,
          labelNames: issue.labelNames,
        },
        this.labels,
      );
      subIssues.push({
        number: issue.number,
        title: issue.title,
        order: subIssues.length,
        open: issue.open,
        closedReason: issue.closedReason ?? undefined,
        state: resolved.state,
        canonicalStateLabels: resolved.canonicalStateLabels,
      });
    }
    return subIssues;
  }

  async getNativeSubIssueNumbers(
    epicNumber: number,
  ): Promise<readonly number[]> {
    const refs = await this.collectAll('list native sub-issues', (page) =>
      this.api.listSubIssues(epicNumber, page),
    );
    return refs.map((ref) => ref.number);
  }

  async getParentEpicNumber(issueNumber: number): Promise<number | null> {
    return this.run('get parent issue', () =>
      this.api.getParentIssueNumber(issueNumber),
    );
  }

  async getMarkdownSubIssueNumbers(
    epicNumber: number,
    heading: string,
  ): Promise<readonly number[]> {
    const repo = await this.run('get repository', () =>
      this.api.getRepository(),
    );
    const issue = await this.run('get epic', () =>
      this.api.getIssue(epicNumber),
    );
    const result = parseMarkdownSubIssues(issue?.body, heading, {
      owner: repo.owner,
      name: repo.name,
    });
    if (!result.ok) {
      throw new CrossRepositoryReferenceError(result.message);
    }
    return result.numbers;
  }

  async getCanonicalStateLabels(
    issueNumber: number,
    canonicalLabels: readonly string[],
  ): Promise<readonly string[]> {
    const canonical = new Set(canonicalLabels);
    const labels = await this.collectAll('list issue labels', (page) =>
      this.api.listIssueLabels(issueNumber, page),
    );
    const present: string[] = [];
    for (const label of labels) {
      if (canonical.has(label.name) && !present.includes(label.name)) {
        present.push(label.name);
      }
    }
    return present;
  }

  async getPullRequestCompletion(
    pullRequestNumber: number,
  ): Promise<PullRequestCompletionContext | null> {
    const pr = await this.run('get pull request', () =>
      this.api.getPullRequest(pullRequestNumber),
    );
    if (pr === null) {
      return null;
    }
    let epicNumber = 0;
    if (pr.closesIssueNumbers.length > 0) {
      const parent = await this.run('get parent issue', () =>
        this.api.getParentIssueNumber(pr.closesIssueNumbers[0]),
      );
      epicNumber = parent ?? 0;
    }
    return {
      pullRequestNumber: pr.number,
      merged: pr.merged,
      mergedBy: pr.mergedBy ?? undefined,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      epicNumber,
      closesIssueNumbers: pr.closesIssueNumbers,
    };
  }

  async getMergedPullRequest(
    pullRequestNumber: number,
  ): Promise<MergedPullRequest | null> {
    const pr = await this.run('get pull request', () =>
      this.api.getPullRequest(pullRequestNumber),
    );
    if (pr === null) {
      return null;
    }
    return {
      number: pr.number,
      merged: pr.merged,
      mergedBy: pr.mergedBy ?? undefined,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      body: pr.body,
      closingIssueReferences: pr.closesIssueNumbers,
    };
  }

  async getLinkedPullRequestNumbers(
    issueNumber: number,
  ): Promise<readonly number[]> {
    const refs = await this.collectAll('list linked pull requests', (page) =>
      this.api.listLinkedPullRequests(issueNumber, page),
    );
    return refs.map((ref) => ref.number);
  }

  async setCanonicalState(issueNumber: number, label: string): Promise<void> {
    const present = await this.getCanonicalStateLabels(
      issueNumber,
      this.canonicalLabelNames,
    );
    for (const existing of present) {
      if (existing !== label) {
        await this.run('remove issue label', () =>
          this.api.removeIssueLabel(issueNumber, existing),
        );
      }
    }
    if (!present.includes(label)) {
      await this.run('add issue label', () =>
        this.api.addIssueLabels(issueNumber, [label]),
      );
    }
  }

  async closeIssueAsCompleted(issueNumber: number): Promise<void> {
    await this.run('close issue', () =>
      this.api.setIssueState(issueNumber, false, 'completed'),
    );
  }

  async createLabel(name: string): Promise<void> {
    await this.run('create label', () => this.api.createLabel(name));
  }

  async getStatusComment(
    issueNumber: number,
    marker: string,
  ): Promise<string | null> {
    const comments = await this.collectAll('list issue comments', (page) =>
      this.api.listIssueComments(issueNumber, page),
    );
    const existing = comments
      .filter((comment) => hasStatusMarker(comment.body, marker))
      .at(-1);
    return existing?.body ?? null;
  }

  async upsertStatusComment(
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<void> {
    const newBody = buildStatusCommentBody(marker, body);
    const comments = await this.collectAll('list issue comments', (page) =>
      this.api.listIssueComments(issueNumber, page),
    );
    const existing = comments.find((comment) =>
      hasStatusMarker(comment.body, marker),
    );
    if (existing !== undefined) {
      await this.run('update status comment', () =>
        this.api.updateComment(existing.id, newBody),
      );
      return;
    }
    await this.run('create status comment', () =>
      this.api.createComment(issueNumber, newBody),
    );
  }

  private async collectAll<T>(
    operation: string,
    fetchPage: (page: number) => Promise<ApiPage<T>>,
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (; page <= MAX_PAGES; page += 1) {
      const result = await this.run(operation, () => fetchPage(page));
      items.push(...result.items);
      if (!result.hasNextPage) {
        return items;
      }
    }
    return items;
  }

  private async run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw sanitizeError(operation, error);
    }
  }
}
