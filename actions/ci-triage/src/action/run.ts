/**
 * The action composition root.
 *
 * {@link executeAction} validates the action inputs, then publishes the outputs
 * and step summary and decides the step's exit status. It depends only on the
 * {@link ActionEnvironment} seam, so the same orchestration runs under the real
 * Actions toolkit and under in-memory test doubles.
 *
 * This version intentionally stops short of workflow-run resolution, prompt
 * generation, and Agent Tasks calls: when inputs are valid it reports that
 * triage orchestration is not implemented yet, while still exposing the full,
 * stable action metadata contract (inputs, outputs, outcomes, and reason codes).
 *
 * Exit behavior:
 * - A dry run reports a successful preview so the workflow does not fail.
 * - Invalid configuration and unrecoverable operational errors fail the step.
 */

import type { ActionCore } from './core.js';
import { readActionInputs } from './inputs.js';
import { setActionOutputs } from './outputs.js';
import type { TriageResult } from './result.js';
import { buildStepSummary } from './summary.js';

/**
 * The host seam the action composition depends on. The entry point binds the
 * real Actions toolkit; tests bind in-memory doubles.
 */
export interface ActionEnvironment {
  readonly core: ActionCore;
}

function invalidInputResult(messages: readonly string[]): TriageResult {
  return {
    outcome: 'configuration-error',
    reasonCode: 'invalid-input',
    dryRun: false,
    details: messages,
  };
}

function dryRunResult(): TriageResult {
  return {
    outcome: 'dry-run',
    reasonCode: 'dry-run-preview',
    dryRun: true,
    details: [
      'Dry run: inputs are valid. Triage orchestration is not implemented yet, so no Agent Tasks writes were performed.',
    ],
  };
}

function notImplementedResult(): TriageResult {
  return {
    outcome: 'operational-error',
    reasonCode: 'orchestration-not-implemented',
    dryRun: false,
    details: ['Triage orchestration is not implemented yet.'],
  };
}

function failsStep(result: TriageResult): boolean {
  return (
    result.outcome === 'configuration-error' ||
    result.outcome === 'operational-error'
  );
}

export async function finalize(
  core: ActionCore,
  result: TriageResult,
): Promise<TriageResult> {
  setActionOutputs(core, result);
  try {
    await core.summary.addRaw(buildStepSummary(result)).write();
  } catch {
    // A failure to write the step summary must never mask the triage outcome.
  }
  if (failsStep(result)) {
    core.setFailed(
      result.details[0] ?? `CI Triage failed: ${result.reasonCode}.`,
    );
  }
  return result;
}

/**
 * Validate inputs and report the triage result through the host runner.
 */
export async function executeAction(
  env: ActionEnvironment,
): Promise<TriageResult> {
  const { core } = env;

  const parsed = readActionInputs(core);
  if (!parsed.ok) {
    return finalize(core, invalidInputResult(parsed.messages));
  }

  if (parsed.inputs.dryRun) {
    return finalize(core, dryRunResult());
  }

  return finalize(core, notImplementedResult());
}
