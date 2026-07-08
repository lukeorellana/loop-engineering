import type { AgentAssignGitHubApi } from '../adapters/github/api.js';
import type { ActionCore } from './core.js';
import { readActionInputs, type ActionInputs } from './inputs.js';
import { setActionOutputs } from './outputs.js';
import type { AssignResult } from './result.js';
import { buildStepSummary } from './summary.js';

const FAILURE_MARKER = '<!-- copilot-agent-assign:failed -->';
const INSTRUCTIONS_MARKER = '<!-- copilot-agent-assign:instructions -->';

export interface ActionEnvironment {
  readonly core: ActionCore;
  readonly issueNumber?: number;
  readonly buildApi: (token: string) => AgentAssignGitHubApi;
}

function isCopilotLogin(
  login: string,
  copilotLogins: readonly string[],
): boolean {
  return copilotLogins.some(
    (known) => known.toLowerCase() === login.trim().toLowerCase(),
  );
}

function findCopilotActor(
  actors: readonly { id: string; login: string }[],
  copilotLogins: readonly string[],
): { id: string; login: string } | null {
  for (const login of copilotLogins) {
    const found = actors.find(
      (actor) => actor.login.toLowerCase() === login.toLowerCase(),
    );
    if (found) {
      return found;
    }
  }
  return null;
}

function sanitizeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'an unexpected error occurred';

  let sanitized =
    message.trim() === '' ? 'an unexpected error occurred' : message;
  sanitized = sanitized.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]');
  sanitized = sanitized.replace(/bearer\s+\S+/gi, 'bearer [redacted]');
  return sanitized.length > 500 ? `${sanitized.slice(0, 500)}…` : sanitized;
}

function evaluateEligibility(
  issue: {
    state: string;
    labels: readonly string[];
    assignees: readonly string[];
  },
  inputs: ActionInputs,
):
  { eligible: true } | { eligible: false; reasonCode: string; detail: string } {
  const labelsLower = issue.labels.map((label) => label.toLowerCase());
  if (issue.state !== 'open') {
    return {
      eligible: false,
      reasonCode: 'issue-not-open',
      detail: 'Issue is not open.',
    };
  }
  if (!labelsLower.includes(inputs.implementLabel.toLowerCase())) {
    return {
      eligible: false,
      reasonCode: 'missing-implement-label',
      detail: `Issue is missing "${inputs.implementLabel}".`,
    };
  }

  const suppressing = inputs.suppressLabels.find((label) =>
    labelsLower.includes(label.toLowerCase()),
  );
  if (suppressing !== undefined) {
    return {
      eligible: false,
      reasonCode: 'suppression-label-present',
      detail: `Issue has suppression label "${suppressing}".`,
    };
  }

  if (
    issue.assignees.some((login) => isCopilotLogin(login, inputs.copilotLogins))
  ) {
    return {
      eligible: false,
      reasonCode: 'already-assigned',
      detail: 'Copilot is already assigned.',
    };
  }

  return { eligible: true };
}

function hasMarker(comments: readonly string[], marker: string): boolean {
  return comments.some((comment) => comment.includes(marker));
}

function buildInstructionsBody(inputs: ActionInputs): string {
  const extras = [
    ...(inputs.baseRef === undefined
      ? []
      : [`- Preferred base branch: \`${inputs.baseRef}\``]),
    ...(inputs.model === undefined
      ? []
      : [`- Preferred model hint: \`${inputs.model}\``]),
  ];
  return [
    INSTRUCTIONS_MARKER,
    '### Copilot implementation guidance',
    '',
    inputs.customInstructions,
    ...(extras.length === 0 ? [] : ['', ...extras]),
  ].join('\n');
}

async function ensureCommentWithMarker(
  api: AgentAssignGitHubApi,
  issueNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  const comments = await api.listComments(issueNumber);
  if (hasMarker(comments, marker)) {
    return;
  }
  await api.createComment(issueNumber, body);
}

async function orchestrate(
  env: ActionEnvironment,
  inputs: ActionInputs,
): Promise<AssignResult> {
  const issueNumber = env.issueNumber;
  if (issueNumber === undefined) {
    return {
      outcome: 'skipped',
      reasonCode: 'no-issue-in-event',
      details: ['No issue payload was provided by the triggering event.'],
    };
  }

  const api = env.buildApi(inputs.agentToken);
  const issue = await api.getIssue(issueNumber);
  const eligibility = evaluateEligibility(issue, inputs);
  if (!eligibility.eligible) {
    return {
      outcome: 'skipped',
      reasonCode: eligibility.reasonCode,
      issueNumber,
      details: [eligibility.detail],
    };
  }

  if (inputs.dryRun) {
    return {
      outcome: 'dry-run',
      reasonCode: 'dry-run-preview',
      issueNumber,
      details: [
        `Dry run: would add "${inputs.queuedLabel}", assign Copilot, and add "${inputs.assignedLabel}".`,
      ],
    };
  }

  await api.addLabels(issueNumber, [inputs.queuedLabel]);

  if (inputs.postInstructions) {
    await ensureCommentWithMarker(
      api,
      issueNumber,
      INSTRUCTIONS_MARKER,
      buildInstructionsBody(inputs),
    );
  }

  const actors = await api.listSuggestedActors();
  const copilotActor = findCopilotActor(actors, inputs.copilotLogins);
  if (copilotActor === null) {
    await api.addLabels(issueNumber, [inputs.failedLabel]);
    await ensureCommentWithMarker(
      api,
      issueNumber,
      FAILURE_MARKER,
      [
        FAILURE_MARKER,
        '**Copilot agent assignment failed.**',
        '',
        'Reason: the Copilot coding agent is not assignable in this repository.',
        '',
        'Check token permissions and repository Copilot availability, then retry.',
      ].join('\n'),
    );
    return {
      outcome: 'operational-error',
      reasonCode: 'actor-unavailable',
      issueNumber,
      details: ['Copilot suggested actor was not found.'],
    };
  }

  const assignableIssue = await api.getAssignableIssue(issueNumber);
  if (assignableIssue === null) {
    throw new Error(
      'Issue could not be resolved to a GraphQL assignable node.',
    );
  }

  const preservedActorIds = inputs.replaceAssignees
    ? []
    : assignableIssue.assignees
        .filter(
          (assignee) => !isCopilotLogin(assignee.login, inputs.copilotLogins),
        )
        .map((assignee) => assignee.id);

  const assignedLogins = await api.replaceActors(assignableIssue.id, [
    ...preservedActorIds,
    copilotActor.id,
  ]);

  if (
    !assignedLogins.some((login) => isCopilotLogin(login, inputs.copilotLogins))
  ) {
    throw new Error(
      'Assignment mutation completed but Copilot is still not assigned.',
    );
  }

  await api.addLabels(issueNumber, [inputs.assignedLabel]);
  await api.removeLabel(issueNumber, inputs.failedLabel);

  return {
    outcome: 'assigned',
    reasonCode: 'assigned',
    issueNumber,
    details: ['Copilot was assigned to the issue.'],
  };
}

function failsStep(result: AssignResult): boolean {
  return (
    result.outcome === 'configuration-error' ||
    result.outcome === 'operational-error'
  );
}

async function finalize(
  core: ActionCore,
  result: AssignResult,
): Promise<AssignResult> {
  setActionOutputs(core, result);
  try {
    await core.summary.addRaw(buildStepSummary(result)).write();
  } catch {
    // Summary failures should not change the action outcome.
  }
  if (failsStep(result)) {
    core.setFailed(
      result.details[0] ?? `Agent assign failed: ${result.reasonCode}.`,
    );
  }
  return result;
}

export async function executeAction(
  env: ActionEnvironment,
): Promise<AssignResult> {
  const parsed = readActionInputs(env.core);
  if (!parsed.ok) {
    return finalize(env.core, {
      outcome: 'configuration-error',
      reasonCode: 'invalid-input',
      issueNumber: env.issueNumber,
      details: [...parsed.messages],
    });
  }

  try {
    return await finalize(env.core, await orchestrate(env, parsed.inputs));
  } catch (error) {
    const message = sanitizeError(error);
    const issueNumber = env.issueNumber;
    if (issueNumber !== undefined) {
      try {
        const api = env.buildApi(parsed.inputs.agentToken);
        await api.addLabels(issueNumber, [parsed.inputs.failedLabel]);
        await ensureCommentWithMarker(
          api,
          issueNumber,
          FAILURE_MARKER,
          [
            FAILURE_MARKER,
            '**Copilot agent assignment failed.**',
            '',
            `Reason: ${message}`,
            '',
            'Check the action inputs and token permissions, then retry.',
          ].join('\n'),
        );
      } catch {
        // Best-effort failure signaling only.
      }
    }

    env.core.error(`Assignment failed: ${message}`);
    return finalize(env.core, {
      outcome: 'operational-error',
      reasonCode: 'assignment-failed',
      issueNumber,
      details: [message],
    });
  }
}
