/**
 * Pure pull-request link reconciliation.
 *
 * When the coding-agent provider opens a pull request for work Feature Loop
 * started, that pull request may have no formal GitHub closing relationship with
 * the active sub-issue. {@link resolvePullRequestLink} is the pure decision that
 * turns an opened (or reopened) pull request plus the canonical Feature Loop
 * state into either a fail-closed `no-op`/`needs-human` result, or a `link`
 * directive carrying the idempotent pull-request body that records
 * `Closes #<issue>`.
 *
 * It performs no I/O and is fully determined by its inputs. A pull request is
 * linked only when **all** of the following hold:
 *
 * - The pull request was authored by the configured coding-agent provider.
 * - The pull request targets the configured base branch.
 * - The pull request does not already carry a formal closing reference, either
 *   through GitHub's `closingIssuesReferences` or a closing keyword in its body.
 * - Exactly one active (in-progress) Feature Loop sub-issue is resolved from
 *   canonical state; zero or multiple candidates never produce an inferred link.
 *
 * The active sub-issue is resolved from canonical Feature Loop state (the issues
 * currently carrying the in-progress label), never from
 * `closedByPullRequestsReferences`, because that collection only contains pull
 * requests that are already formally linked.
 */

import { parseClosingKeywords, type RepositoryRef } from './merged-pr.js';

/**
 * The raw, untrusted view of an opened pull request needed to reconcile its
 * closing relationship.
 */
export interface OpenedPullRequest {
  readonly number: number;
  /** The pull-request author login, or `null` when it cannot be determined. */
  readonly author: string | null;
  /** The base branch the pull request targets. */
  readonly baseRef: string;
  /** The pull-request body used to detect existing closing keywords. */
  readonly body: string | null;
  /** GitHub's formal closing references for the pull request. */
  readonly closingIssueReferences: readonly number[];
}

/**
 * Everything the resolver needs to decide whether and how to link a pull
 * request to the active sub-issue.
 */
export interface PullRequestLinkContext {
  /** The repository the pull request belongs to. */
  readonly repository: RepositoryRef;
  /** The configured base branch a linkable pull request must target. */
  readonly baseBranch: string;
  /**
   * Logins recognized as the configured coding-agent provider's pull-request
   * author. Comparison is case-insensitive.
   */
  readonly agentLogins: readonly string[];
  /**
   * Open sub-issue numbers currently in the active (in-progress) canonical
   * state. Exactly one is required to resolve an unambiguous link.
   */
  readonly activeIssues: readonly number[];
}

/**
 * Why an opened pull request does not result in a link but is not an error.
 */
export type PullRequestLinkNoOpReason =
  | 'wrong-author'
  | 'wrong-base-branch'
  | 'already-linked'
  | 'no-active-issue';

/**
 * Why an opened pull request fails closed and pauses for human attention rather
 * than being linked.
 */
export type PullRequestLinkPauseReason = 'ambiguous-active-issue';

/**
 * The result of resolving an opened pull request against canonical state.
 */
export type PullRequestLinkResolution =
  | {
      readonly outcome: 'link';
      /** The single active sub-issue the pull request should close. */
      readonly issueNumber: number;
      /** The idempotent pull-request body recording `Closes #<issue>`. */
      readonly body: string;
    }
  | { readonly outcome: 'no-op'; readonly reason: PullRequestLinkNoOpReason }
  | {
      readonly outcome: 'needs-human';
      readonly reason: PullRequestLinkPauseReason;
      readonly message: string;
    };

function isAgentAuthor(
  author: string | null,
  agentLogins: readonly string[],
): boolean {
  if (author === null) {
    return false;
  }
  const normalized = author.toLowerCase();
  return agentLogins.some((login) => login.toLowerCase() === normalized);
}

function dedupe(values: readonly number[]): readonly number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

/**
 * The canonical closing line Feature Loop appends to record the relationship.
 */
export function closingLineFor(issueNumber: number): string {
  return `Closes #${issueNumber}`;
}

/**
 * Append the closing line to a pull-request body, separated by a blank line and
 * preserving any existing content. An empty or whitespace-only body becomes just
 * the closing line.
 */
export function appendClosingLine(
  body: string | null,
  issueNumber: number,
): string {
  const line = closingLineFor(issueNumber);
  const existing = (body ?? '').replace(/\s+$/, '');
  if (existing === '') {
    return `${line}\n`;
  }
  return `${existing}\n\n${line}\n`;
}

/**
 * Resolve whether an opened pull request should be linked to the active
 * Feature Loop sub-issue.
 *
 * Returns a `link` directive with the idempotent body only when every condition
 * in the module overview holds; otherwise returns a benign `no-op` or a
 * fail-closed `needs-human` result. The function never infers a link on
 * ambiguity, a wrong author, a wrong base branch, or an existing closing
 * reference.
 */
export function resolvePullRequestLink(
  pr: OpenedPullRequest,
  context: PullRequestLinkContext,
): PullRequestLinkResolution {
  if (!isAgentAuthor(pr.author, context.agentLogins)) {
    return { outcome: 'no-op', reason: 'wrong-author' };
  }

  if (pr.baseRef !== context.baseBranch) {
    return { outcome: 'no-op', reason: 'wrong-base-branch' };
  }

  // A pull request that already has any formal closing reference — through
  // GitHub's references or a closing keyword in its body — is left unchanged.
  // Detecting the keyword keeps a replayed opened/reopened event idempotent even
  // before GitHub has indexed the relationship.
  const keywordRefs = parseClosingKeywords(pr.body, context.repository);
  if (pr.closingIssueReferences.length > 0 || keywordRefs.length > 0) {
    return { outcome: 'no-op', reason: 'already-linked' };
  }

  const active = dedupe(context.activeIssues);
  if (active.length === 0) {
    return { outcome: 'no-op', reason: 'no-active-issue' };
  }
  if (active.length > 1) {
    return {
      outcome: 'needs-human',
      reason: 'ambiguous-active-issue',
      message:
        `More than one active sub-issue (${active
          .map((n) => `#${n}`)
          .join(', ')}) is in progress; ` +
        'Feature Loop cannot infer which issue this pull request completes.',
    };
  }

  const issueNumber = active[0];
  return {
    outcome: 'link',
    issueNumber,
    body: appendClosingLine(pr.body, issueNumber),
  };
}
