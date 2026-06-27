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
import type { MarkdownDiscoverySource } from '../domain/markdown.js';
import type { MergedPullRequest } from '../domain/merged-pr.js';
import type { ExecutionPlan } from '../domain/plan.js';
import type { OpenedPullRequest } from '../domain/pr-link.js';

/**
 * The ordered sub-issue numbers discovered from the epic body's Markdown,
 * together with how they were discovered. `source` is `none` when the body has
 * no ordered-issue section, so callers can report whether discovery came from
 * the marker, the configured heading, or the structural fallback.
 */
export interface MarkdownSubIssueDiscovery {
  readonly numbers: readonly number[];
  readonly source: MarkdownDiscoverySource | 'none';
}

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
 * The stable identity of an issue within the repository, including the GraphQL
 * node id used to address native sub-issue hierarchy mutations.
 */
export interface IssueIdentity {
  /** The issue number. */
  readonly number: number;
  /** The GraphQL node id of the issue. */
  readonly nodeId: string;
}

/**
 * A native sub-issue of an epic, carrying both its issue number and its REST
 * database id. The database id is the integer identifier the authoritative REST
 * sub-issue endpoints use to reorder a sub-issue; it is kept distinct from the
 * issue number and from the GraphQL node id ({@link IssueIdentity.nodeId}).
 */
export interface NativeSubIssue {
  /** The sub-issue issue number. */
  readonly number: number;
  /** The REST database id used to address reorder operations. */
  readonly databaseId: number;
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
   * Ordered native GitHub sub-issues for an epic, read from the authoritative
   * REST sub-issue list. Each entry carries both the issue number and the REST
   * database id, so a reorder addresses the same authoritative surface that is
   * read back for verification.
   */
  getNativeSubIssues(epicNumber: number): Promise<readonly NativeSubIssue[]>;

  /**
   * The stable identity (number and GraphQL node id) of an issue, or `null` when
   * the issue does not exist in this repository. Existence within the repository
   * is confirmed by a non-`null` result.
   */
  getIssueIdentity(issueNumber: number): Promise<IssueIdentity | null>;

  /**
   * The persisted frozen execution plan for an epic, or `null` when the epic has
   * not been initialized. Used so continuation runs follow the frozen plan
   * instead of re-resolving competing issue sources.
   */
  getInitializationPlan(epicNumber: number): Promise<ExecutionPlan | null>;

  /**
   * The native GitHub parent issue number for an issue, or `null` when the issue
   * has no parent. Uses GitHub parent/sub-issue metadata rather than any
   * `Parent epic:` body text.
   */
  getParentEpicNumber(issueNumber: number): Promise<number | null>;

  /**
   * Ordered sub-issue numbers parsed from the epic body's Markdown using the
   * marker-first discovery precedence (marker, then the configured `heading`,
   * then a single structural ordered list), together with how they were
   * discovered. Fails closed when discovery is ambiguous or a reference is
   * invalid.
   */
  getMarkdownSubIssueNumbers(
    epicNumber: number,
    heading: string,
  ): Promise<MarkdownSubIssueDiscovery>;

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
   * Attach a planned sub-issue to the epic's native hierarchy. When
   * `replaceParent` is `true`, an existing parent on the sub-issue is replaced
   * (reparenting); otherwise the sub-issue must have no parent. Idempotent when
   * the relationship already exists.
   */
  addSubIssue(
    epicNumber: number,
    subIssueId: string,
    replaceParent: boolean,
  ): Promise<void>;

  /** Detach a native sub-issue from the epic. Idempotent when already absent. */
  removeSubIssue(epicNumber: number, subIssueId: string): Promise<void>;

  /**
   * Reorder a native sub-issue within the epic so that it immediately follows
   * the sibling identified by `afterDatabaseId`, or moves to the first position
   * when `afterDatabaseId` is `null`. The sub-issue and the sibling are
   * addressed by their REST database ids — the same authoritative surface
   * {@link GitHubRepositoryReadPort.getNativeSubIssues} reads back.
   */
  reprioritizeSubIssue(
    epicNumber: number,
    subIssueDatabaseId: number,
    afterDatabaseId: number | null,
  ): Promise<void>;

  /**
   * Persist the frozen execution plan for an epic. Written only after the
   * hierarchy has been verified, using the per-epic plan marker so a prior plan
   * comment is updated in place.
   */
  upsertInitializationPlan(
    epicNumber: number,
    plan: ExecutionPlan,
  ): Promise<void>;

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
