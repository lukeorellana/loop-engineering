/**
 * The pure, ordered Feature Loop state machine.
 *
 * {@link decideLoop} is the deterministic decision engine: given an epic, its
 * ordered sub-issues with their canonical states, and an optional completion
 * context, it produces exactly one {@link LoopDecision}. It is pure by
 * construction — it performs no GitHub, agent-provider, filesystem,
 * environment-variable, network, or clock access. The result is fully
 * determined by its inputs.
 *
 * The machine enforces strict head-of-line ordering:
 *
 * 1. Sub-issues are examined from the beginning (by {@link SubIssue.order}).
 * 2. Only successfully completed (`done`) issues are skipped.
 * 3. The first issue that is not successfully completed controls the result.
 * 4. Blocked, invalid, skipped, closed-not-planned, or human-attention work is
 *    never bypassed; it pauses the epic so a human can intervene.
 */

import type { AgentModelSelection, AgentStartRequest } from './agent.js';
import type { LoopDecision, PauseReason } from './decisions.js';
import type { Epic, PullRequestCompletionContext, SubIssue } from './issues.js';
import { isComplete } from './state.js';

/**
 * The evaluation context the state machine needs to shape a start request and
 * to interpret the triggering event.
 *
 * These values originate from resolved configuration and the triggering event;
 * the machine never reads them from the environment. None of them cause I/O.
 */
export interface LoopEvaluation {
  /** Coding-agent provider id (for example `github-copilot`). */
  readonly provider: string;
  /** Model selection; `auto` lets the provider choose. */
  readonly model: AgentModelSelection;
  /** Base branch any resulting pull request must target. */
  readonly baseBranch: string;
  /** When `true`, only a read-only preview decision may be produced. */
  readonly dryRun: boolean;
  /**
   * Whether the triggering event applies to this epic. Defaults to `true`. When
   * `false`, the machine produces a `no-op` decision without examining the epic.
   */
  readonly eventApplies?: boolean;
  /**
   * Optional completion context for a pull-request event. When present and its
   * `epicNumber` does not match the epic under evaluation, the event belongs to
   * a foreign parent epic and cannot affect this epic (it is ignored as a
   * `no-op`).
   */
  readonly completion?: PullRequestCompletionContext;
}

function buildRequest(
  epic: Epic,
  issue: SubIssue,
  evaluation: LoopEvaluation,
): AgentStartRequest {
  return {
    epic,
    issue,
    provider: evaluation.provider,
    model: evaluation.model,
    baseBranch: evaluation.baseBranch,
    dryRun: evaluation.dryRun,
  };
}

/**
 * Map the head-of-line issue's pausing state to its {@link PauseReason}.
 *
 * `invalid` is refined to `multiple-canonical-state-labels` when the issue
 * carries more than one canonical state label, surfacing the precise reason the
 * state could not be resolved.
 */
function pauseReasonFor(issue: SubIssue): PauseReason {
  switch (issue.state) {
    case 'blocked':
      return 'blocked';
    case 'needs-human':
      return 'needs-human';
    case 'skipped':
      return 'skipped';
    case 'not-planned':
      return 'not-planned';
    case 'invalid':
      return issue.canonicalStateLabels.length > 1
        ? 'multiple-canonical-state-labels'
        : 'invalid';
    default:
      // `todo`, `in-progress`, and `done` are not pausing states; the caller
      // never reaches here for them.
      return 'invalid';
  }
}

/**
 * Decide what the loop should do for a single epic.
 *
 * Exactly one {@link LoopDecision} is returned. The first incomplete ordered
 * sub-issue always controls the result:
 *
 * - `todo` → start it (`started`, or a read-only `dry-run` preview).
 * - `in-progress` → it is already running (`already-running`); no new start.
 * - `blocked` / `needs-human` / `skipped` / `invalid` / `not-planned` →
 *   `needs-human` with a stable {@link PauseReason}; later work cannot start.
 *
 * When every sub-issue is `done`, the epic is `complete`. When the event does
 * not apply, the epic is closed or empty, or the completion event belongs to a
 * foreign parent, the result is a `no-op` with a stable reason code.
 */
export function decideLoop(
  epic: Epic,
  evaluation: LoopEvaluation,
): LoopDecision {
  if (evaluation.eventApplies === false) {
    return { outcome: 'no-op', reason: 'event-not-applicable' };
  }

  // A completion event that targets a different epic cannot affect this one.
  if (
    evaluation.completion !== undefined &&
    evaluation.completion.epicNumber !== epic.number
  ) {
    return { outcome: 'no-op', reason: 'foreign-parent' };
  }

  if (!epic.open) {
    return { outcome: 'no-op', reason: 'epic-not-open' };
  }

  if (epic.subIssues.length === 0) {
    return { outcome: 'no-op', reason: 'epic-empty' };
  }

  // Examine sub-issues in canonical order, skipping only completed work.
  const ordered = [...epic.subIssues].sort((a, b) => a.order - b.order);

  for (const issue of ordered) {
    if (isComplete(issue.state)) {
      continue;
    }

    // The first incomplete issue controls the result.
    if (issue.state === 'in-progress') {
      return { outcome: 'already-running', epic, issue };
    }

    if (issue.state === 'todo') {
      const request = buildRequest(epic, issue, evaluation);
      if (evaluation.dryRun) {
        return { outcome: 'dry-run', epic, wouldStart: request };
      }
      return { outcome: 'started', epic, issue, request };
    }

    // blocked, needs-human, skipped, invalid, or not-planned: pause the epic.
    return {
      outcome: 'needs-human',
      epic,
      issue,
      reason: pauseReasonFor(issue),
    };
  }

  // Every sub-issue is done.
  return { outcome: 'complete', epic };
}
