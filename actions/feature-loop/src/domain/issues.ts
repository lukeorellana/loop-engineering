/**
 * Epic, sub-issue, and pull-request completion representations.
 *
 * These types are provider-independent. Adapters (for example a GitHub
 * repository adapter) translate API responses into these shapes; the loop
 * reasons only about the shapes here.
 */

import type { IssueState } from './state.js';

/**
 * How a closed issue was resolved, mirroring GitHub's `state_reason`.
 *
 * - `completed`: closed because the work was finished successfully.
 * - `not-planned`: closed without completing the work.
 */
export type ClosedReason = 'completed' | 'not-planned';

/**
 * A single ordered sub-issue belonging to an epic.
 *
 * The `order` field is the canonical position used by the loop; the first
 * incomplete sub-issue by `order` controls the loop.
 */
export interface SubIssue {
  /** The GitHub issue number. */
  readonly number: number;
  /** The issue title. */
  readonly title: string;
  /** Zero-based position within the epic's ordered list. */
  readonly order: number;
  /** Whether the issue is open or closed. */
  readonly open: boolean;
  /** If closed, why it was closed; otherwise `undefined`. */
  readonly closedReason?: ClosedReason;
  /** The single canonical state resolved for this issue. */
  readonly state: IssueState;
  /**
   * The canonical state label names currently present on the issue. Used to
   * detect the "more than one canonical state label" violation, which is
   * treated as `invalid` (fail closed).
   */
  readonly canonicalStateLabels: readonly string[];
}

/**
 * An epic and its ordered sub-issues.
 */
export interface Epic {
  /** The GitHub issue number of the epic. */
  readonly number: number;
  /** The epic title. */
  readonly title: string;
  /** Whether the epic issue is open. */
  readonly open: boolean;
  /** Ordered sub-issues; index order matches {@link SubIssue.order}. */
  readonly subIssues: readonly SubIssue[];
}

/**
 * Context describing a pull request that may complete a sub-issue.
 *
 * The loop only completes work through formal GitHub closing relationships and
 * only when a human has merged the pull request into the expected base branch.
 */
export interface PullRequestCompletionContext {
  /** The pull request number. */
  readonly pullRequestNumber: number;
  /** Whether the pull request has been merged. */
  readonly merged: boolean;
  /** Login of the human who merged the pull request, if merged. */
  readonly mergedBy?: string;
  /** The base branch the pull request targeted. */
  readonly baseRef: string;
  /** The head branch of the pull request. */
  readonly headRef: string;
  /** The epic this pull request is associated with. */
  readonly epicNumber: number;
  /**
   * Issue numbers this pull request closes through formal GitHub closing
   * relationships. Multiple distinct closing relationships for one sub-issue,
   * or relationships that do not match the head-of-line issue, pause the loop.
   */
  readonly closesIssueNumbers: readonly number[];
}
