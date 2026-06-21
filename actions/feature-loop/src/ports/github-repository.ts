/**
 * GitHub repository port.
 *
 * The loop reasons about epics, sub-issues, labels, and pull requests through
 * this port instead of calling the GitHub API directly. Read and write
 * operations are split so that dry-run mode can depend only on the read port and
 * is, by construction, strictly read-only.
 *
 * Configuration is read from the repository default branch; the port never
 * checks out or executes pull-request code.
 */
import type { Epic, PullRequestCompletionContext } from '../domain/issues.js';

/**
 * Identifying information about the repository, including the default branch
 * used when no base branch is configured.
 */
export interface RepositoryInfo {
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
}

/**
 * Read-only repository operations. Dry-run mode uses only these.
 */
export interface GitHubRepositoryReadPort {
  /** Repository identity and default branch. */
  getRepositoryInfo(): Promise<RepositoryInfo>;

  /**
   * Contents of `path` on the repository default branch, decoded as UTF-8 text,
   * or `null` when the file does not exist.
   *
   * Configuration is always read through this method so it comes from the
   * default branch and never from a pull-request head, a fork, an arbitrary ref,
   * or checked-out pull-request code.
   */
  getDefaultBranchFile(path: string): Promise<string | null>;

  /** Whether a branch with the given name exists in the repository. */
  branchExists(branch: string): Promise<boolean>;

  /** All label names defined in the repository (paginated internally). */
  getRepositoryLabelNames(): Promise<readonly string[]>;

  /**
   * Whether the configured token has write access to the repository, or `null`
   * when this cannot be determined from the available API responses.
   */
  hasWriteAccess(): Promise<boolean | null>;

  /** The epic and its ordered sub-issues, or `null` if not found. */
  getEpic(epicNumber: number): Promise<Epic | null>;

  /** Ordered native GitHub sub-issue numbers for an epic. */
  getNativeSubIssueNumbers(epicNumber: number): Promise<readonly number[]>;

  /**
   * The native GitHub parent issue number for an issue, or `null` when the issue
   * has no parent. Uses GitHub parent/sub-issue metadata rather than any
   * `Parent epic:` body text.
   */
  getParentEpicNumber(issueNumber: number): Promise<number | null>;

  /**
   * Ordered sub-issue numbers parsed from the epic body's Markdown section
   * identified by `heading`.
   */
  getMarkdownSubIssueNumbers(
    epicNumber: number,
    heading: string,
  ): Promise<readonly number[]>;

  /**
   * The canonical state label names currently present on an issue. More than one
   * indicates an invalid state.
   */
  getCanonicalStateLabels(
    issueNumber: number,
    canonicalLabels: readonly string[],
  ): Promise<readonly string[]>;

  /**
   * Pull-request completion context, or `null` if the pull request does not
   * exist. Used to verify human merges and formal closing relationships.
   */
  getPullRequestCompletion(
    pullRequestNumber: number,
  ): Promise<PullRequestCompletionContext | null>;

  /**
   * Numbers of pull requests linked to a sub-issue. More than one linked pull
   * request pauses the loop.
   */
  getLinkedPullRequestNumbers(issueNumber: number): Promise<readonly number[]>;
}

/**
 * Mutating repository operations. Never used during a dry run.
 */
export interface GitHubRepositoryWritePort {
  /**
   * Set the single canonical state label on an issue, removing any other
   * canonical state labels so that exactly one remains.
   */
  setCanonicalState(issueNumber: number, label: string): Promise<void>;

  /** Close a sub-issue as completed. */
  closeIssueAsCompleted(issueNumber: number): Promise<void>;

  /** Create a repository label if it does not already exist. */
  createLabel(name: string): Promise<void>;

  /**
   * Create or update a status comment on an issue. The comment carries a hidden
   * machine-readable marker so that a previous status comment with the same
   * marker is updated in place instead of duplicated.
   */
  upsertStatusComment(
    issueNumber: number,
    marker: string,
    body: string,
  ): Promise<void>;
}

/**
 * The combined read/write GitHub repository port.
 */
export interface GitHubRepositoryPort
  extends GitHubRepositoryReadPort, GitHubRepositoryWritePort {}
