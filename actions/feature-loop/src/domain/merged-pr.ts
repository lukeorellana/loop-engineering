/**
 * Trusted merged-pull-request resolution.
 *
 * A merged pull request may complete the active Feature Loop sub-issue, but only
 * under a strict, fail-closed set of conditions. {@link resolveMergedPullRequest}
 * is the pure decision that turns a raw `pull_request: closed` event into either
 * a validated {@link PullRequestCompletionContext} (with an idempotent
 * {@link CompletionPreparation}), a stable `no-op`, or a fail-closed
 * `needs-human` result. It performs no I/O and is fully determined by its
 * inputs.
 *
 * A pull request advances the loop only when **all** of the following hold:
 *
 * - The event is `pull_request: closed`.
 * - The pull request was actually merged.
 * - The pull request was merged into the configured base branch.
 * - GitHub reports a formal closing relationship through a closing keyword or
 *   `closingIssuesReferences`.
 * - Exactly one issue is resolved.
 * - The resolved issue is the active head-of-line issue for its epic.
 * - The issue belongs to the same repository and parent epic (it is listed in
 *   the epic's ordered sub-issues).
 *
 * The trusted resolution order is:
 *
 * 1. Parse a GitHub closing keyword (for example `Closes owner/repo#123`) from
 *    the pull-request body, scoped to this repository.
 * 2. Read GitHub `closingIssuesReferences`.
 * 3. Require both methods to agree when both return a result (fail closed on
 *    conflict).
 *
 * Generic issue-timeline cross-references are never used as proof of completion.
 */

import type { Epic, PullRequestCompletionContext, SubIssue } from './issues.js';
import { isComplete } from './state.js';

/**
 * Repository identity used to scope closing-keyword references. Comparison is
 * case-insensitive, matching GitHub's handling of owners and repository names.
 */
export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

/**
 * The raw, untrusted view of a merged pull request needed to resolve completion.
 *
 * `closingIssueReferences` mirrors GitHub's `closingIssuesReferences`; `body`
 * carries the pull-request description used to parse closing keywords.
 */
export interface MergedPullRequest {
  readonly number: number;
  readonly merged: boolean;
  readonly mergedBy?: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly body: string | null;
  readonly closingIssueReferences: readonly number[];
}

/**
 * A `pull_request` webhook delivery: the event name, its action, and the pull
 * request it carries.
 */
export interface MergedPullRequestEvent {
  /** The GitHub event name (for example `pull_request`). */
  readonly name: string;
  /** The event action (for example `closed`). */
  readonly action: string;
  /** The pull request the event delivered. */
  readonly pullRequest: MergedPullRequest;
}

/**
 * Everything the resolver needs about the destination of the merge: which
 * repository and base branch are authoritative, the epic under evaluation, and
 * the canonical `done` label used to detect stale active labels.
 */
export interface MergedPullRequestContext {
  /** The repository the pull request was merged into. */
  readonly repository: RepositoryRef;
  /** The configured base branch a completing merge must target. */
  readonly baseBranch: string;
  /** The epic whose head-of-line issue the merge may complete. */
  readonly epic: Epic;
  /** The canonical `done` label name, used to detect stale active labels. */
  readonly doneLabel: string;
}

/**
 * Why a merged pull request does not advance the loop but is not an error. These
 * are benign outcomes: the event simply does not apply to this epic.
 */
export type MergedPrNoOpReason =
  | 'event-not-applicable'
  | 'not-merged'
  | 'wrong-base-branch'
  | 'no-closing-reference'
  | 'foreign-parent';

/**
 * Why a merged pull request fails closed and pauses for human attention rather
 * than advancing the loop.
 */
export type MergedPrPauseReason =
  | 'multiple-closing-issues'
  | 'conflicting-closing-references'
  | 'out-of-order'
  | 'ambiguous-completion';

/**
 * An idempotent description of the mutations needed to bring the resolved issue
 * to a consistent completed state. Applying it is safe to repeat: a replayed
 * merged-PR event recomputes the same preparation and, when the issue is already
 * consistent, requests no mutations.
 */
export interface CompletionPreparation {
  /** The resolved sub-issue number. */
  readonly issueNumber: number;
  /** Whether the issue is already resolved as `done` (auto-closed by GitHub). */
  readonly alreadyComplete: boolean;
  /** Whether the issue is still open and must be closed as completed. */
  readonly closeAsCompleted: boolean;
  /**
   * Whether the canonical state labels must be normalized to exactly the `done`
   * label (the issue is missing it or carries stale active labels).
   */
  readonly normalizeDoneLabel: boolean;
}

/**
 * The result of resolving a merged pull request against an epic.
 */
export type MergedPrResolution =
  | {
      readonly outcome: 'completed';
      readonly completion: PullRequestCompletionContext;
      readonly preparation: CompletionPreparation;
    }
  | { readonly outcome: 'no-op'; readonly reason: MergedPrNoOpReason }
  | {
      readonly outcome: 'needs-human';
      readonly reason: MergedPrPauseReason;
      readonly message: string;
    };

// Matches a GitHub closing keyword immediately followed by an issue reference.
// Keywords (case-insensitive): close/closes/closed, fix/fixes/fixed,
// resolve/resolves/resolved. The reference may be a full issue URL, an
// owner/repo shorthand, or a bare `#<n>`. An optional colon and required
// whitespace separate the keyword from the reference, matching GitHub.
const CLOSING_REFERENCE =
  /(?<![\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::)?\s+(?:https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)|([\w.-]+)\/([\w.-]+)#(\d+)|#(\d+))/gi;

function sameRepository(
  owner: string,
  name: string,
  repo: RepositoryRef,
): boolean {
  return (
    owner.toLowerCase() === repo.owner.toLowerCase() &&
    name.toLowerCase() === repo.name.toLowerCase()
  );
}

/**
 * Parse the issue numbers referenced by GitHub closing keywords in `body`.
 *
 * Only references that resolve to `repo` are returned (closing keywords only
 * auto-close issues in the same repository, so cross-repository references are
 * ignored). Numbers are returned in first-appearance order with duplicates
 * removed. A missing body yields an empty list.
 */
export function parseClosingKeywords(
  body: string | null | undefined,
  repo: RepositoryRef,
): readonly number[] {
  if (!body) {
    return [];
  }
  const numbers: number[] = [];
  const seen = new Set<number>();
  CLOSING_REFERENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLOSING_REFERENCE.exec(body)) !== null) {
    const [, urlOwner, urlRepo, urlNumber, shortOwner, shortRepo, shortNumber] =
      match;
    const bareNumber = match[7];

    let number: number;
    if (urlNumber !== undefined) {
      if (!sameRepository(urlOwner, urlRepo, repo)) {
        continue;
      }
      number = Number(urlNumber);
    } else if (shortNumber !== undefined) {
      if (!sameRepository(shortOwner, shortRepo, repo)) {
        continue;
      }
      number = Number(shortNumber);
    } else {
      number = Number(bareNumber);
    }

    if (!seen.has(number)) {
      seen.add(number);
      numbers.push(number);
    }
  }
  return numbers;
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

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set(a);
  return b.every((value) => set.has(value));
}

function noOp(reason: MergedPrNoOpReason): MergedPrResolution {
  return { outcome: 'no-op', reason };
}

function needsHuman(
  reason: MergedPrPauseReason,
  message: string,
): MergedPrResolution {
  return { outcome: 'needs-human', reason, message };
}

function prepare(issue: SubIssue, doneLabel: string): CompletionPreparation {
  const alreadyComplete = issue.state === 'done';
  const normalizeDoneLabel =
    issue.canonicalStateLabels.length !== 1 ||
    issue.canonicalStateLabels[0] !== doneLabel;
  return {
    issueNumber: issue.number,
    alreadyComplete,
    closeAsCompleted: issue.open,
    normalizeDoneLabel,
  };
}

/**
 * Resolve whether a merged pull request completes the epic's head-of-line issue.
 *
 * Returns `completed` with a validated completion context and an idempotent
 * preparation only when every condition in the module overview holds; otherwise
 * returns a benign `no-op` or a fail-closed `needs-human` result. The function
 * never advances the loop on ambiguity, conflict, or missing data.
 */
export function resolveMergedPullRequest(
  event: MergedPullRequestEvent,
  context: MergedPullRequestContext,
): MergedPrResolution {
  if (event.name !== 'pull_request' || event.action !== 'closed') {
    return noOp('event-not-applicable');
  }

  const pr = event.pullRequest;
  if (!pr.merged) {
    return noOp('not-merged');
  }
  if (pr.baseRef !== context.baseBranch) {
    return noOp('wrong-base-branch');
  }

  // Trusted resolution: closing keywords from the body and GitHub's formal
  // closing references must agree when both are present.
  const keywordRefs = parseClosingKeywords(pr.body, context.repository);
  const metadataRefs = dedupe(pr.closingIssueReferences);
  if (
    keywordRefs.length > 0 &&
    metadataRefs.length > 0 &&
    !sameSet(keywordRefs, metadataRefs)
  ) {
    return needsHuman(
      'conflicting-closing-references',
      'The pull-request closing keyword and GitHub closing references disagree. ' +
        'Resolve the mismatch before the loop can advance.',
    );
  }

  const resolved = keywordRefs.length > 0 ? keywordRefs : metadataRefs;
  if (resolved.length === 0) {
    return noOp('no-closing-reference');
  }
  if (resolved.length > 1) {
    return needsHuman(
      'multiple-closing-issues',
      'The pull request formally closes more than one issue; exactly one is required.',
    );
  }

  const issueNumber = resolved[0];
  const ordered = [...context.epic.subIssues].sort((a, b) => a.order - b.order);
  const target = ordered.find((issue) => issue.number === issueNumber);
  if (target === undefined) {
    // The issue is not a sub-issue of this epic (foreign or unrelated).
    return noOp('foreign-parent');
  }

  // The resolved issue must be at the head of the line: every earlier sub-issue
  // must already be done.
  const earlierIncomplete = ordered.some(
    (issue) => issue.order < target.order && !isComplete(issue.state),
  );
  if (earlierIncomplete) {
    return needsHuman(
      'out-of-order',
      `Issue #${issueNumber} is not the head-of-line issue; an earlier sub-issue is not yet done.`,
    );
  }

  // A merge cannot complete an issue that GitHub records as closed-not-planned.
  if (!target.open && target.state === 'not-planned') {
    return needsHuman(
      'ambiguous-completion',
      `Issue #${issueNumber} is closed as not planned but a merged pull request claims completion.`,
    );
  }

  const completion: PullRequestCompletionContext = {
    pullRequestNumber: pr.number,
    merged: true,
    mergedBy: pr.mergedBy,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    epicNumber: context.epic.number,
    closesIssueNumbers: [issueNumber],
  };
  return {
    outcome: 'completed',
    completion,
    preparation: prepare(target, context.doneLabel),
  };
}
