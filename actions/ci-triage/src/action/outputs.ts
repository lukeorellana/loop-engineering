/**
 * Action output mapping.
 *
 * Every normal exit path sets all ten outputs so consumers can branch on a
 * stable contract regardless of outcome. Numeric outputs are emitted as strings
 * and optional outputs are emitted as the empty string when they do not apply
 * to the outcome.
 */

import type { TriageResult } from './result.js';
import type { ActionCore } from './core.js';

/** The stable set of output names the action publishes. */
export const ACTION_OUTPUT_NAMES = [
  'outcome',
  'reason',
  'task-id',
  'task-url',
  'workflow-run-id',
  'workflow-run-attempt',
  'resolved-mode',
  'target-base-ref',
  'target-head-ref',
  'existing-pr-number',
] as const;

function stringOutput(value: string | undefined): string {
  return value ?? '';
}

function numberOutput(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/**
 * Publish the ten action outputs from a triage result.
 *
 * Outputs that do not apply to the outcome are set to the empty string, so the
 * complete output set is always populated.
 */
export function setActionOutputs(core: ActionCore, result: TriageResult): void {
  core.setOutput('outcome', result.outcome);
  core.setOutput('reason', result.reasonCode);
  core.setOutput('task-id', stringOutput(result.taskId));
  core.setOutput('task-url', stringOutput(result.taskUrl));
  core.setOutput('workflow-run-id', numberOutput(result.workflowRunId));
  core.setOutput(
    'workflow-run-attempt',
    numberOutput(result.workflowRunAttempt),
  );
  core.setOutput('resolved-mode', stringOutput(result.resolvedMode));
  core.setOutput('target-base-ref', stringOutput(result.targetBaseRef));
  core.setOutput('target-head-ref', stringOutput(result.targetHeadRef));
  core.setOutput('existing-pr-number', numberOutput(result.existingPrNumber));
}
