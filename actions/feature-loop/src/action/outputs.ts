/**
 * Action output mapping.
 *
 * Every normal exit path sets all five outputs so consumers can branch on a
 * stable contract regardless of outcome. Numeric outputs are emitted as strings
 * and omitted (set to the empty string) when they do not apply to the outcome.
 */

import type { OrchestratorResult } from '../orchestrator/index.js';
import type { ActionCore } from './core.js';

/** The stable set of output names the action publishes. */
export const ACTION_OUTPUT_NAMES = [
  'outcome',
  'epic-issue',
  'active-issue',
  'completed-issue',
  'reason',
] as const;

function numberOutput(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/**
 * Publish the five action outputs from a loop result.
 *
 * - `outcome`: the coarse-grained {@link OrchestratorResult.outcome}.
 * - `epic-issue`: the epic the loop acted on, when resolved.
 * - `active-issue`: the sub-issue the loop is driving (started, running, paused).
 * - `completed-issue`: the sub-issue completed from a trusted merged pull request.
 * - `reason`: the stable machine-readable reason code.
 */
export function setActionOutputs(
  core: ActionCore,
  result: OrchestratorResult,
): void {
  core.setOutput('outcome', result.outcome);
  core.setOutput('epic-issue', numberOutput(result.epicNumber));
  core.setOutput('active-issue', numberOutput(result.issueNumber));
  core.setOutput('completed-issue', numberOutput(result.completedIssueNumber));
  core.setOutput('reason', result.reasonCode);
}
