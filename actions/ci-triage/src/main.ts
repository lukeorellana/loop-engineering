import * as core from '@actions/core';

import { executeAction, type ActionEnvironment } from './action/index.js';

/**
 * Runs the CI Triage action.
 *
 * Binds the real GitHub Actions toolkit to the action composition root. This
 * version validates the input contract and reports that triage orchestration is
 * not implemented yet; the full action metadata contract (inputs, outputs,
 * outcomes, and reason codes) is already exposed.
 */
export async function run(): Promise<void> {
  const env: ActionEnvironment = { core };
  await executeAction(env);
}
