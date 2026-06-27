/**
 * Action input parsing and validation.
 *
 * Inputs arrive as raw strings from the host runner. {@link readActionInputs}
 * validates them, masks the credentials so they can never be logged, and returns
 * a typed {@link ActionInputs}, or a list of actionable messages when an input is
 * invalid. Validation fails closed: an invalid input never produces a partial
 * configuration that could start work against the wrong run.
 */

import { PULL_REQUEST_MODES, type PullRequestMode } from '../domain/index.js';
import type { ActionCore } from './core.js';

/** The validated, typed action inputs. */
export interface ActionInputs {
  /** Token used for repository, workflow-run, and pull-request reads. */
  readonly githubToken: string;
  /** Credential used for Agent Tasks reads and writes. */
  readonly agentToken: string;
  /**
   * The model identifier passed unchanged to the Agent Tasks API, when
   * provided. Absent means no model override is sent.
   */
  readonly model?: string;
  /** How the fix pull request is resolved. */
  readonly pullRequestMode: PullRequestMode;
  /** Optional trusted repository-owner prompt instructions. */
  readonly promptInstructions?: string;
  /** Optional bounded, untrusted operational evidence. */
  readonly additionalContext?: string;
  /** When `true`, include prior attempts and related history. */
  readonly includeHistory: boolean;
  /** When `true`, the run is strictly read-only. */
  readonly dryRun: boolean;
}

/** The outcome of validating the raw action inputs. */
export type ReadInputsResult =
  | { readonly ok: true; readonly inputs: ActionInputs }
  | { readonly ok: false; readonly messages: readonly string[] };

function parseBoolean(
  value: string,
  name: string,
  defaultValue: boolean,
  errors: string[],
): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') {
    return defaultValue;
  }
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  errors.push(`Input "${name}" must be "true" or "false".`);
  return defaultValue;
}

function parsePullRequestMode(
  value: string,
  errors: string[],
): PullRequestMode {
  const normalized = value.trim();
  if (normalized === '') {
    return 'auto';
  }
  if ((PULL_REQUEST_MODES as readonly string[]).includes(normalized)) {
    return normalized as PullRequestMode;
  }
  errors.push(
    `Input "pull-request-mode" must be one of ${PULL_REQUEST_MODES.map(
      (mode) => `"${mode}"`,
    ).join(', ')}.`,
  );
  return 'auto';
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

  const agentToken = core.getInput('agent-token').trim();
  if (agentToken !== '') {
    core.setSecret(agentToken);
  } else {
    errors.push('Input "agent-token" is required.');
  }

  // A non-empty model string is retained exactly; the action keeps no
  // model-name allowlist. An empty (or whitespace-only) value means no override.
  const modelRaw = core.getInput('model').trim();
  const model = modelRaw === '' ? undefined : modelRaw;

  const pullRequestMode = parsePullRequestMode(
    core.getInput('pull-request-mode'),
    errors,
  );

  const promptInstructionsRaw = core.getInput('prompt-instructions');
  const promptInstructions =
    promptInstructionsRaw.trim() === '' ? undefined : promptInstructionsRaw;

  const additionalContextRaw = core.getInput('additional-context');
  const additionalContext =
    additionalContextRaw.trim() === '' ? undefined : additionalContextRaw;

  const includeHistory = parseBoolean(
    core.getInput('include-history'),
    'include-history',
    true,
    errors,
  );
  const dryRun = parseBoolean(
    core.getInput('dry-run'),
    'dry-run',
    false,
    errors,
  );

  if (errors.length > 0) {
    return { ok: false, messages: errors };
  }

  return {
    ok: true,
    inputs: {
      githubToken,
      agentToken,
      ...(model !== undefined ? { model } : {}),
      pullRequestMode,
      ...(promptInstructions !== undefined ? { promptInstructions } : {}),
      ...(additionalContext !== undefined ? { additionalContext } : {}),
      includeHistory,
      dryRun,
    },
  };
}
