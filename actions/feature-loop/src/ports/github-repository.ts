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
import type { MergedPullRequest } from '../domain/merged-pr.js';
import type { OpenedPullRequest } from '../domain/pr-link.js';

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

  /**
   * The epic with its sub-issues resolved from an explicit, already-ordered list
   * of sub-issue numbers, or `null` if the epic does not exist.
   *
   * The orchestrator resolves the controlling ordered sub-issue list during
   * preflight (which may come from native sub-issues or the Markdown section) and
   * re-reads the epic through this method so canonical state always reflects the
   * configured source rather than the native sub-issue list alone.
   */
  getEpicWithSubIssues(
    epicNumber: number,
    orderedSubIssueNumbers: readonly number[],
  ): Promise<Epic | null>;

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
   * The raw, untrusted merged-pull-request view used by trusted merged-PR
   * resolution, or `null` if the pull request does not exist. Carries the pull
   * request body and GitHub's formal closing references so the pure resolver can
   * reconcile closing keywords against `closingIssuesReferences`.
   */
  getMergedPullRequest(
    pullRequestNumber: number,
  ): Promise<MergedPullRequest | null>;

  /**
   * The raw, untrusted opened-pull-request view used by pull-request link
   * reconciliation, or `null` if the pull request does not exist. Carries the
   * author login, base branch, body, and GitHub's formal closing references so
   * the pure resolver can decide whether a closing relationship must be
   * recorded.
   */
  getOpenedPullRequest(
    pullRequestNumber: number,
  ): Promise<OpenedPullRequest | null>;

  /**
   * Open sub-issue numbers currently carrying `inProgressLabel`, the canonical
   * active state. Used to resolve the active Feature Loop sub-issue from
   * canonical state when reconciling a pull request's closing relationship.
   * Exactly one result is an unambiguous active issue.
   */
  findActiveSubIssues(inProgressLabel: string): Promise<readonly number[]>;

  /**
   * Numbers of pull requests linked to a sub-issue. More than one linked pull
   * request pauses the loop.
   */
  getLinkedPullRequestNumbers(issueNumber: number): Promise<readonly number[]>;

  /**
   * The body of the most recent status comment on an issue carrying the hidden
   * marker for `marker`, or `null` when no such comment exists. Used to recover
   * the machine-readable status the loop previously recorded (for example the
   * start timestamp used to report the age of stalled active work).
   */
  getStatusComment(issueNumber: number, marker: string): Promise<string | null>;
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

  /**
   * Replace the body of a pull request. Used to record a formal closing
   * relationship (`Closes #<issue>`) with the active sub-issue.
   */
  updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void>;

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
