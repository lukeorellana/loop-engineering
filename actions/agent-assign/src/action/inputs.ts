import type { ActionCore } from './core.js';

export const DEFAULT_COPILOT_LOGINS = ['copilot-swe-agent', 'copilot'] as const;
export const DEFAULT_SUPPRESS_LABELS = [
  'agent: manual',
  'agent: blocked',
] as const;

export const DEFAULT_CUSTOM_INSTRUCTIONS = [
  'Implement the issue with the smallest safe change.',
  '',
  'Project priorities:',
  '- reliability and maintainability over speed',
  '- accessibility matters',
  '- keep operating cost low',
  '- avoid scope creep',
  '- include or update tests where practical',
  '- do not introduce paid services or new infrastructure unless the issue explicitly requests it',
  '- open a focused pull request and reference this issue',
].join('\n');

export interface ActionInputs {
  readonly githubToken: string;
  readonly agentToken: string;
  readonly dryRun: boolean;
  readonly implementLabel: string;
  readonly queuedLabel: string;
  readonly assignedLabel: string;
  readonly failedLabel: string;
  readonly suppressLabels: readonly string[];
  readonly copilotLogins: readonly string[];
  readonly replaceAssignees: boolean;
  readonly postInstructions: boolean;
  readonly customInstructions: string;
  readonly model?: string;
  readonly baseRef?: string;
}

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

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function nonEmptyOrDefault(value: string, defaultValue: string): string {
  const trimmed = value.trim();
  return trimmed === '' ? defaultValue : trimmed;
}

export function readActionInputs(core: ActionCore): ReadInputsResult {
  const errors: string[] = [];

  const githubToken = core.getInput('github-token').trim();
  if (githubToken === '') {
    errors.push('Input "github-token" is required.');
  } else {
    core.setSecret(githubToken);
  }

  const agentTokenRaw = core.getInput('agent-token').trim();
  const agentToken = agentTokenRaw === '' ? githubToken : agentTokenRaw;
  if (agentToken !== '') {
    core.setSecret(agentToken);
  }

  const dryRun = parseBoolean(
    core.getInput('dry-run'),
    'dry-run',
    false,
    errors,
  );
  const replaceAssignees = parseBoolean(
    core.getInput('replace-assignees'),
    'replace-assignees',
    false,
    errors,
  );
  const postInstructions = parseBoolean(
    core.getInput('post-instructions'),
    'post-instructions',
    true,
    errors,
  );

  const suppressRaw = core.getInput('suppress-labels');
  const suppressLabels =
    suppressRaw.trim() === ''
      ? [...DEFAULT_SUPPRESS_LABELS]
      : splitList(suppressRaw);

  const copilotLoginsRaw = core.getInput('copilot-logins');
  const copilotLogins =
    copilotLoginsRaw.trim() === ''
      ? [...DEFAULT_COPILOT_LOGINS]
      : splitList(copilotLoginsRaw);

  if (copilotLogins.length === 0) {
    errors.push('Input "copilot-logins" must include at least one login.');
  }

  const customInstructionsRaw = core.getInput('custom-instructions');
  const customInstructions =
    customInstructionsRaw.trim() === ''
      ? DEFAULT_CUSTOM_INSTRUCTIONS
      : customInstructionsRaw;

  const modelRaw = core.getInput('model').trim();
  const baseRefRaw = core.getInput('base-ref').trim();

  if (errors.length > 0) {
    return { ok: false, messages: errors };
  }

  return {
    ok: true,
    inputs: {
      githubToken,
      agentToken,
      dryRun,
      replaceAssignees,
      postInstructions,
      implementLabel: nonEmptyOrDefault(
        core.getInput('implement-label'),
        'agent: implement',
      ),
      queuedLabel: nonEmptyOrDefault(
        core.getInput('queued-label'),
        'agent: queued',
      ),
      assignedLabel: nonEmptyOrDefault(
        core.getInput('assigned-label'),
        'agent: assigned',
      ),
      failedLabel: nonEmptyOrDefault(
        core.getInput('failed-label'),
        'agent: failed',
      ),
      suppressLabels,
      copilotLogins,
      customInstructions,
      ...(modelRaw === '' ? {} : { model: modelRaw }),
      ...(baseRefRaw === '' ? {} : { baseRef: baseRefRaw }),
    },
  };
}
