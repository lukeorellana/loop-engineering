/**
 * Narrow GitHub API client boundary used by the repository adapter.
 *
 * The adapter depends only on this interface, never on Octokit types or raw HTTP
 * responses. This keeps the loop core decoupled from the transport and lets
 * tests drive the adapter with mocked API responses (including multi-page
 * results) through a simple in-memory fake.
 *
 * List operations are page-oriented so the adapter owns pagination and it can be
 * exercised deterministically in tests.
 */

import type { ClosedReason } from '../../domain/issues.js';

/**
 * A single page of a paginated list result.
 */
export interface ApiPage<T> {
  readonly items: readonly T[];
  /** Whether a subsequent page exists. */
  readonly hasNextPage: boolean;
}

/**
 * Repository identity plus the viewer's push capability when it can be
 * determined from the API response (`null` when unknown).
 */
export interface ApiRepository {
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly canPush: boolean | null;
}

/**
 * The minimal issue shape the adapter needs.
 */
export interface ApiIssue {
  readonly number: number;
  readonly title: string;
  readonly open: boolean;
  readonly closedReason: ClosedReason | null;
  readonly body: string | null;
  readonly labelNames: readonly string[];
}

/** A repository or issue label. */
export interface ApiLabel {
  readonly name: string;
}

/** A reference to an issue by number (native sub-issue, linked PR, etc.). */
export interface ApiNumberRef {
  readonly number: number;
}

/** The minimal pull-request shape the adapter needs. */
export interface ApiPullRequest {
  readonly number: number;
  readonly merged: boolean;
  readonly mergedBy: string | null;
  readonly baseRef: string;
  readonly headRef: string;
  readonly closesIssueNumbers: readonly number[];
}

/** A single issue comment. */
export interface ApiComment {
  readonly id: number;
  readonly body: string;
}

/**
 * The transport-level GitHub operations the adapter consumes. Implementations
 * translate these to REST/GraphQL calls. Methods may throw transport errors;
 * the adapter sanitizes them before they reach callers. Operations that target a
 * missing resource return `null` rather than throwing where a missing resource
 * is a normal outcome.
 */
export interface GitHubApi {
  /** Repository identity, default branch, and push capability. */
  getRepository(): Promise<ApiRepository>;

  /**
   * Decoded UTF-8 contents of `path` at `ref`, or `null` when the file does not
   * exist.
   */
  getFileContent(path: string, ref: string): Promise<string | null>;

  /** Whether a branch exists. */
  branchExists(branch: string): Promise<boolean>;

  /** One page of repository labels. */
  listRepositoryLabels(page: number): Promise<ApiPage<ApiLabel>>;

  /**
   * Create a repository label. Implementations must be idempotent on conflict.
   */
  createLabel(name: string): Promise<void>;

  /** An issue, or `null` when it does not exist. */
  getIssue(issueNumber: number): Promise<ApiIssue | null>;

  /** Update an issue's open/closed state and close reason. */
  setIssueState(
    issueNumber: number,
    open: boolean,
    closedReason: ClosedReason | null,
  ): Promise<void>;

  /** One page of the labels present on an issue. */
  listIssueLabels(
    issueNumber: number,
    page: number,
  ): Promise<ApiPage<ApiLabel>>;

  /** Add labels to an issue. */
  addIssueLabels(issueNumber: number, labels: readonly string[]): Promise<void>;

  /** Remove a single label from an issue. */
  removeIssueLabel(issueNumber: number, label: string): Promise<void>;

  /** One page of native GitHub sub-issues, in GitHub order. */
  listSubIssues(
    issueNumber: number,
    page: number,
  ): Promise<ApiPage<ApiNumberRef>>;

  /** The native parent issue number, or `null` when there is none. */
  getParentIssueNumber(issueNumber: number): Promise<number | null>;

  /** A pull request, or `null` when it does not exist. */
  getPullRequest(pullNumber: number): Promise<ApiPullRequest | null>;

  /** One page of pull requests linked to an issue. */
  listLinkedPullRequests(
    issueNumber: number,
    page: number,
  ): Promise<ApiPage<ApiNumberRef>>;

  /** One page of an issue's comments. */
  listIssueComments(
    issueNumber: number,
    page: number,
  ): Promise<ApiPage<ApiComment>>;

  /** Create a new comment on an issue. */
  createComment(issueNumber: number, body: string): Promise<void>;

  /** Update an existing comment. */
  updateComment(commentId: number, body: string): Promise<void>;
}
