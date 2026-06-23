/**
 * Pure resolution of the triggering event into a normalized loop context.
 *
 * The orchestrator supports these execution contexts:
 *
 * - **Manual start**: a `workflow_dispatch` (or comparable) trigger carrying the
 *   epic issue number to advance.
 * - **Merged pull-request continuation**: a `pull_request: closed` delivery whose
 *   merged pull request may complete the active sub-issue and continue the loop.
 * - **Pull-request link reconciliation**: a `pull_request: opened` or
 *   `pull_request: reopened` delivery whose pull request may need a formal
 *   closing relationship with the active sub-issue recorded before merge.
 * - **Unrelated**: anything else, which must produce a strict no-op.
 *
 * {@link resolveEvent} is pure: it classifies the raw inputs without any I/O. The
 * epic number for a merged pull-request continuation is not known from the event
 * alone (it is derived from the closing issue's parent epic), so it is resolved
 * by the orchestrator through the repository port after classification.
 */

import type {
  MergedPullRequest,
  MergedPullRequestEvent,
} from '../domain/merged-pr.js';

/**
 * The raw triggering inputs the orchestrator receives from the host workflow.
 */
export interface LoopEventInput {
  /** The GitHub event name (for example `workflow_dispatch` or `pull_request`). */
  readonly name: string;
  /** The event action, when present (for example `closed`). */
  readonly action?: string;
  /**
   * The epic issue number for a manual start. Present on a manual dispatch; the
   * value must be a positive integer to be honored.
   */
  readonly epicNumber?: number;
  /** The pull request carried by a `pull_request` event, when present. */
  readonly pullRequest?: MergedPullRequest;
}

/**
 * The normalized event context after classification.
 */
export type ResolvedEvent =
  | { readonly kind: 'manual'; readonly epicNumber: number }
  | { readonly kind: 'merged-pr'; readonly event: MergedPullRequestEvent }
  | { readonly kind: 'pr-opened'; readonly pullRequestNumber: number }
  | { readonly kind: 'unrelated'; readonly reason: string };

function isPositiveInteger(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Classify the triggering event into a normalized {@link ResolvedEvent}.
 *
 * A closed `pull_request` event is always treated as a merged-PR continuation
 * candidate; the trusted resolver decides whether it actually advances the loop.
 * An opened or reopened `pull_request` event is a pull-request link
 * reconciliation candidate; the controller re-reads the authoritative pull
 * request and decides whether to record a formal closing relationship.
 * Otherwise a positive epic number is treated as a manual start. Everything else
 * is unrelated and produces a no-op.
 */
export function resolveEvent(input: LoopEventInput): ResolvedEvent {
  if (
    input.name === 'pull_request' &&
    input.action === 'closed' &&
    input.pullRequest !== undefined
  ) {
    return {
      kind: 'merged-pr',
      event: {
        name: input.name,
        action: input.action,
        pullRequest: input.pullRequest,
      },
    };
  }

  if (
    input.name === 'pull_request' &&
    (input.action === 'opened' || input.action === 'reopened') &&
    input.pullRequest !== undefined
  ) {
    return {
      kind: 'pr-opened',
      pullRequestNumber: input.pullRequest.number,
    };
  }

  if (isPositiveInteger(input.epicNumber)) {
    return { kind: 'manual', epicNumber: input.epicNumber };
  }

  return { kind: 'unrelated', reason: 'event-not-applicable' };
}
