/**
 * Action input parsing and validation.
 *
 * Inputs arrive as raw strings from the host runner. {@link readActionInputs}
 * validates them, masks the credentials so they can never be logged, and returns
 * a typed {@link ActionInputs}, or a list of actionable messages when an input is
 * invalid. Validation fails closed: an invalid input never produces a partial
 * configuration that could start work against the wrong epic.
 */

import type { ActionCore } from './core.js';

/** The validated, typed action inputs. */
export interface ActionInputs {
  /** Token used for repository reads and writes. */
  readonly githubToken: string;
  /** Token used for coding-agent assignment; defaults to the repository token. */
  readonly agentToken: string;
  /** The epic issue number for a manual start, when provided. */
  readonly epicIssue?: number;
  /** When `true`, the run is strictly read-only. */
  readonly dryRun: boolean;
  /** Optional configuration path on the default branch. */
  readonly configPath?: string;
}

/** The outcome of validating the raw action inputs. */
export type ReadInputsResult =
  | { readonly ok: true; readonly inputs: ActionInputs }
  | { readonly ok: false; readonly messages: readonly string[] };

function parseBoolean(value: string, name: string, errors: string[]): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'false') {
    return false;
  }
  if (normalized === 'true') {
    return true;
  }
  errors.push(`Input "${name}" must be "true" or "false".`);
  return false;
}

function parseEpicIssue(value: string, errors: string[]): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    errors.push('Input "epic-issue" must be a positive integer.');
    return undefined;
  }
  return parsed;
}

/**
 * Read and validate the action inputs from the host runner.
 *
 * The credential inputs are registered as secrets before any further use so the
 * runner masks them in logs. The returned result is either the validated inputs
 * or the accumulated validation messages.
 */
export function readActionInputs(core: ActionCore): ReadInputsResult {
  const errors: string[] = [];

  const githubToken = core.getInput('github-token').trim();
  if (githubToken !== '') {
    core.setSecret(githubToken);
  } else {
    errors.push('Input "github-token" is required.');
  }

  // The agent-assignment credential defaults to the repository token when it is
  // not provided separately.
  const agentTokenRaw = core.getInput('agent-token').trim();
  if (agentTokenRaw !== '') {
    core.setSecret(agentTokenRaw);
  }
  const agentToken = agentTokenRaw === '' ? githubToken : agentTokenRaw;

  const epicIssue = parseEpicIssue(core.getInput('epic-issue'), errors);
  const dryRun = parseBoolean(core.getInput('dry-run'), 'dry-run', errors);
  const configPathRaw = core.getInput('config-path').trim();

  if (errors.length > 0) {
    return { ok: false, messages: errors };
  }

  return {
    ok: true,
    inputs: {
      githubToken,
      agentToken,
      epicIssue,
      dryRun,
      configPath: configPathRaw === '' ? undefined : configPathRaw,
    },
  };
}
