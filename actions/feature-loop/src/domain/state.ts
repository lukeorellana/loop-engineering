/**
 * Canonical issue and epic state model.
 *
 * Feature Loop tracks the progress of each sub-issue with exactly one canonical
 * state. The canonical state is an internal, provider-independent value; it is
 * projected onto a repository label whose name is configurable (see
 * {@link CanonicalStateLabels}). The invariant "only one canonical state label
 * may exist on an issue at a time" is enforced by validation logic, not by the
 * label names themselves.
 */

/**
 * The canonical state of a single sub-issue.
 *
 * - `todo`: not yet started; eligible to become the active issue.
 * - `in-progress`: currently assigned to the coding agent (the active issue).
 * - `blocked`: head-of-line work that cannot proceed; pauses the epic.
 * - `needs-human`: requires human attention; pauses the epic.
 * - `skipped`: explicitly skipped by a human; pauses the epic so the skip is
 *   acknowledged before later work proceeds.
 * - `invalid`: ambiguous or inconsistent state; fails closed and pauses the epic.
 * - `done`: successfully completed (issue closed as completed).
 * - `not-planned`: closed as not planned; head-of-line `not-planned` work pauses
 *   the epic until a human resolves the ordering.
 */
export const CANONICAL_ISSUE_STATES = [
  'todo',
  'in-progress',
  'blocked',
  'needs-human',
  'skipped',
  'invalid',
  'done',
  'not-planned',
] as const;

export type IssueState = (typeof CANONICAL_ISSUE_STATES)[number];

/**
 * The canonical state of an epic, derived from the states of its sub-issues.
 *
 * - `idle`: no sub-issue is active and none have started.
 * - `running`: exactly one sub-issue is `in-progress`.
 * - `paused`: head-of-line work is blocked, invalid, skipped, needs human
 *   attention, or otherwise prevents automatic advancement.
 * - `complete`: every sub-issue is `done`.
 */
export const CANONICAL_EPIC_STATES = [
  'idle',
  'running',
  'paused',
  'complete',
] as const;

export type EpicState = (typeof CANONICAL_EPIC_STATES)[number];

/**
 * States that count as "successfully completed" for loop advancement.
 *
 * Only `done` advances the loop. `not-planned` is a closed state but is not a
 * success: head-of-line `not-planned` work pauses the epic so a human can
 * confirm the ordering before later sub-issues run.
 */
export function isComplete(state: IssueState): boolean {
  return state === 'done';
}

/**
 * Head-of-line states that pause the epic instead of advancing it.
 *
 * Invariant: blocked, invalid, skipped, needs-human, or not-planned work at the
 * head of the line pauses the epic. Ambiguous state (`invalid`) fails closed.
 */
export function isPausing(state: IssueState): boolean {
  return (
    state === 'blocked' ||
    state === 'invalid' ||
    state === 'skipped' ||
    state === 'needs-human' ||
    state === 'not-planned'
  );
}

/**
 * Whether a state represents the single active issue assigned to the agent.
 */
export function isActive(state: IssueState): boolean {
  return state === 'in-progress';
}

/**
 * Type guard for {@link IssueState}.
 */
export function isIssueState(value: unknown): value is IssueState {
  return (
    typeof value === 'string' &&
    (CANONICAL_ISSUE_STATES as readonly string[]).includes(value)
  );
}
