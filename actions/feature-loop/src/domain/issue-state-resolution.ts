/**
 * Pure canonical-state resolution.
 *
 * Translates the raw GitHub status of an issue (open/closed, close reason, and
 * the label names present) into the single canonical {@link IssueState} the loop
 * reasons about, using the configurable label mapping. This is pure: it performs
 * no I/O and is fully determined by its inputs.
 *
 * The "exactly one canonical state label" invariant is enforced here: an open
 * issue carrying more than one canonical-state label resolves to `invalid`
 * (fail closed).
 */

import type { CanonicalStateLabels } from '../config/schema.js';
import type { ClosedReason } from './issues.js';
import type { IssueState } from './state.js';

/**
 * The raw GitHub status used to derive a canonical state.
 */
export interface RawIssueStatus {
  /** Whether the issue is open. */
  readonly open: boolean;
  /** When closed, GitHub's close reason; otherwise `undefined`. */
  readonly closedReason?: ClosedReason;
  /** All label names currently present on the issue. */
  readonly labelNames: readonly string[];
}

/**
 * The canonical state plus the canonical-state label names actually present on
 * the issue (used to detect the "more than one canonical label" violation).
 */
export interface ResolvedIssueState {
  readonly state: IssueState;
  readonly canonicalStateLabels: readonly string[];
}

/**
 * Resolve the single canonical state for an issue.
 *
 * Closed issues are resolved from their close reason: `not-planned` maps to
 * `not-planned`; any other close reason maps to `done`. Open issues are resolved
 * from the canonical-state labels present: none maps to `todo`, exactly one maps
 * to that label's state, and more than one maps to `invalid`.
 */
export function resolveIssueState(
  status: RawIssueStatus,
  labels: CanonicalStateLabels,
): ResolvedIssueState {
  const byLabel = new Map<string, IssueState>();
  for (const [state, label] of Object.entries(labels)) {
    byLabel.set(label, state as IssueState);
  }

  const present: string[] = [];
  for (const name of status.labelNames) {
    if (byLabel.has(name) && !present.includes(name)) {
      present.push(name);
    }
  }

  if (!status.open) {
    const state: IssueState =
      status.closedReason === 'not-planned' ? 'not-planned' : 'done';
    return { state, canonicalStateLabels: present };
  }

  if (present.length > 1) {
    return { state: 'invalid', canonicalStateLabels: present };
  }
  if (present.length === 1) {
    return {
      state: byLabel.get(present[0]) as IssueState,
      canonicalStateLabels: present,
    };
  }
  return { state: 'todo', canonicalStateLabels: present };
}
