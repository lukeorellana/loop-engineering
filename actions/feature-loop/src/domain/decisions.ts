/**
 * Loop decisions and action outcomes.
 *
 * A {@link LoopDecision} is the structured result of evaluating an epic. Each
 * decision maps to exactly one {@link ActionOutcome}, the coarse-grained value
 * the action reports to its caller.
 */

import type { AgentStartRequest } from './agent.js';
import type { Epic, SubIssue } from './issues.js';

/**
 * The set of outcomes the action can report.
 *
 * - `started`: a new sub-issue was started.
 * - `already-running`: the head-of-line issue is already active; no-op start.
 * - `complete`: every sub-issue is done.
 * - `needs-human`: head-of-line work requires human attention.
 * - `dry-run`: evaluation only; no mutations were performed.
 * - `no-op`: nothing to do (for example, not triggered by a relevant event).
 * - `configuration-error`: configuration was missing a required value, invalid,
 *   or an unsupported version. Fails closed.
 * - `operational-error`: an unexpected runtime/provider failure occurred.
 */
export const ACTION_OUTCOMES = [
  'started',
  'already-running',
  'complete',
  'needs-human',
  'dry-run',
  'no-op',
  'configuration-error',
  'operational-error',
] as const;

export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];

/**
 * Why head-of-line work paused the epic. Mirrors the pausing canonical states.
 */
export type PauseReason =
  | 'blocked'
  | 'invalid'
  | 'skipped'
  | 'needs-human'
  | 'not-planned'
  | 'multiple-canonical-state-labels'
  | 'multiple-linked-pull-requests'
  | 'ambiguous-completion';

/**
 * A structured loop decision. Each variant's `outcome` is the canonical
 * {@link ActionOutcome} it maps to.
 *
 * Note: there is no `start` variant that bypasses configuration validation.
 * Invalid configuration can only produce a `configuration-error` decision, so
 * invalid configuration can never produce a start decision.
 */
export type LoopDecision =
  | {
      readonly outcome: 'started';
      readonly epic: Epic;
      readonly issue: SubIssue;
      readonly request: AgentStartRequest;
    }
  | {
      readonly outcome: 'already-running';
      readonly epic: Epic;
      readonly issue: SubIssue;
    }
  | { readonly outcome: 'complete'; readonly epic: Epic }
  | {
      readonly outcome: 'needs-human';
      readonly epic: Epic;
      readonly issue: SubIssue;
      readonly reason: PauseReason;
    }
  | {
      readonly outcome: 'dry-run';
      readonly epic: Epic;
      /** The request that would have been issued, if any. */
      readonly wouldStart?: AgentStartRequest;
    }
  | { readonly outcome: 'no-op'; readonly reason: string }
  | {
      readonly outcome: 'configuration-error';
      readonly messages: readonly string[];
    }
  | { readonly outcome: 'operational-error'; readonly message: string };

/**
 * Extract the {@link ActionOutcome} from a {@link LoopDecision}.
 */
export function outcomeOf(decision: LoopDecision): ActionOutcome {
  return decision.outcome;
}
