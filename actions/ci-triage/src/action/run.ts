/**
 * The action composition root.
 *
 * {@link executeAction} validates the action inputs, resolves the failed
 * workflow run into a concrete delivery target, builds the hardened Copilot
 * prompt, and either previews (dry run) or starts a Copilot Agent Tasks task,
 * then publishes the outputs and step summary and decides the step's exit
 * status. It depends only on the {@link ActionEnvironment} seam, so the same
 * orchestration runs under the real Actions toolkit and Octokit transports and
 * under in-memory test doubles.
 *
 * Separation of credentials is preserved through the seam: the repository token
 * builds the read-only {@link TriageGitHubApi}, while the dedicated agent token
 * builds the {@link AgentTasksProvider}. Neither token, nor the full prompt, nor
 * any untrusted context is ever written to a log or the step summary.
 *
 * Exit behavior:
 * - A successful start, a benign ignore, a needs-human pause, and a dry run all
 *   succeed (the step does not fail).
 * - Invalid configuration and unrecoverable operational errors fail the step.
 */

import type {
  AgentTasksFailureReason,
  AgentTasksProvider,
  StartTaskInput,
} from '../adapters/agent-tasks/index.js';
import type {
  TriageGitHubApi,
  TriageHistoryGitHubApi,
  TriageEvent,
} from '../adapters/github/index.js';
import { resolveTriageTarget } from '../adapters/github/index.js';
import type {
  FailedRunMetadata,
  PromptDeliveryTarget,
  TargetResolution,
  TriageOutcome,
  TriagePromptContext,
} from '../domain/index.js';
import { buildTriagePrompt, computeTaskFingerprint } from '../domain/index.js';
import type { ActionCore } from './core.js';
import { collectTriageHistory, type TriageHistory } from './history.js';
import type { ActionInputs } from './inputs.js';
import { readActionInputs } from './inputs.js';
import { setActionOutputs } from './outputs.js';
import type { TriageResult } from './result.js';
import { buildStepSummary } from './summary.js';

/**
 * The host seam the action composition depends on. The entry point binds the
 * real Actions toolkit, the triggering event, and the Octokit-backed transports;
 * tests bind in-memory doubles.
 */
export interface ActionEnvironment {
  readonly core: ActionCore;
  /** The `owner/repo` slug of the repository running the action. */
  readonly repository: string;
  /** The normalized triggering event (must be `workflow_run: completed`). */
  readonly event: TriageEvent;
  /** Build the read-only GitHub API from the repository token. */
  readonly buildTriageApi: (token: string) => TriageGitHubApi;
  /**
   * Build the optional best-effort history reads from the repository token. When
   * omitted, commit and legacy-pull-request history is simply unavailable.
   */
  readonly buildHistoryApi?: (token: string) => TriageHistoryGitHubApi;
  /** Build the Agent Tasks provider from the dedicated agent token. */
  readonly buildAgentTasksProvider: (token: string) => AgentTasksProvider;
}

function invalidInputResult(messages: readonly string[]): TriageResult {
  return {
    outcome: 'configuration-error',
    reasonCode: 'invalid-input',
    dryRun: false,
    details: messages,
  };
}

/** The result fields derived from the (possibly absent) failed-run metadata. */
function metadataFields(metadata?: FailedRunMetadata): Partial<TriageResult> {
  if (metadata === undefined) {
    return {};
  }
  return {
    workflowName: metadata.workflowName,
    workflowRunId: metadata.workflowRunId,
    workflowRunAttempt: metadata.workflowRunAttempt,
    workflowRunUrl: metadata.workflowRunUrl,
  };
}

type ResolvedTarget = Extract<TargetResolution, { status: 'resolved' }>;

/** The resolved-target fields published as outputs and summary rows. */
function targetFields(resolution: ResolvedTarget): Partial<TriageResult> {
  return {
    resolvedMode: resolution.resolvedMode,
    targetBaseRef: resolution.targetBaseRef,
    targetHeadRef: resolution.targetHeadRef,
    ...(resolution.existingPullRequestNumber !== undefined
      ? { existingPrNumber: resolution.existingPullRequestNumber }
      : {}),
  };
}

/** The summary-only flags describing what optional content the prompt included. */
function promptFlags(
  inputs: ActionInputs,
  truncated: boolean,
): Partial<TriageResult> {
  return {
    modelOverrideProvided: inputs.model !== undefined,
    historyIncluded: inputs.includeHistory,
    additionalContextIncluded: inputs.additionalContext !== undefined,
    promptTruncated: truncated,
  };
}

/**
 * The flattened delivery target the prompt builder consumes. The existing pull
 * request is intentionally summarized only by its refs; the prompt never embeds
 * a fetched title or body, and no extra read is performed to enrich it.
 */
function deliveryTarget(resolution: ResolvedTarget): PromptDeliveryTarget {
  return {
    action: resolution.action,
    resolvedMode: resolution.resolvedMode,
    targetBaseRef: resolution.targetBaseRef,
    targetHeadRef: resolution.targetHeadRef,
  };
}

/** Map a stable Agent Tasks failure reason to the coarse-grained outcome. */
function outcomeForAgentFailure(
  reason: AgentTasksFailureReason,
): TriageOutcome {
  switch (reason) {
    case 'agent-auth-failed':
    case 'agent-forbidden':
    case 'agent-unsupported':
    case 'agent-invalid-request':
      // Credential, permission, plan, and request-validation problems (including
      // an invalid model) are configuration errors that fail closed.
      return 'configuration-error';
    default:
      // Rate-limiting, transient failures, and malformed responses are
      // operational and may succeed on a later attempt.
      return 'operational-error';
  }
}

/** Build the start-task input from a resolved target and the validated inputs. */
function startTaskInput(
  resolution: ResolvedTarget,
  inputs: ActionInputs,
  prompt: string,
): StartTaskInput {
  const usesExistingPullRequest =
    resolution.action === 'update-existing-pull-request';
  return {
    baseRef: resolution.targetBaseRef,
    ...(usesExistingPullRequest ? { headRef: resolution.targetHeadRef } : {}),
    ...(inputs.model !== undefined ? { model: inputs.model } : {}),
    prompt,
  };
}

/**
 * Whether a create failure is *uncertain*, meaning the task may or may not have
 * been created (a network timeout or an undecodable response). These are the
 * outcomes a follow-up fingerprint search reconciles; a definitive rejection
 * (auth, forbidden, invalid request, rate limit) is not reconciled.
 */
function isUncertainCreateFailure(reason: AgentTasksFailureReason): boolean {
  return reason === 'agent-transient' || reason === 'agent-unexpected-response';
}

/** Safe, sourceless detail lines describing the collected history, if any. */
function historyDetails(history?: TriageHistory): string[] {
  if (history === undefined) {
    return [];
  }
  const lines: string[] = [];
  if (history.recentCommits.length > 0 || history.previousTasks.length > 0) {
    lines.push(
      `Included bounded previous-attempt history (${history.recentCommits.length} commit(s), ${history.previousTasks.length} prior attempt(s)).`,
    );
  }
  if (history.unavailable.length > 0) {
    lines.push(
      `Some optional history was unavailable (${history.unavailable.join(
        ', ',
      )}); this did not block triage [agent-task-history-unavailable].`,
    );
  }
  return lines;
}

/**
 * Resolve, preview, or start a triage task. Returns a complete triage result;
 * the caller publishes outputs, writes the summary, and sets the exit status.
 */
async function orchestrate(
  env: ActionEnvironment,
  inputs: ActionInputs,
): Promise<TriageResult> {
  const api = env.buildTriageApi(inputs.githubToken);
  const resolution = await resolveTriageTarget(
    env.event,
    inputs.pullRequestMode,
    api,
  );

  if (resolution.status === 'ignored') {
    return {
      outcome: 'ignored',
      reasonCode: resolution.reason,
      dryRun: inputs.dryRun,
      ...metadataFields(resolution.metadata),
      details: [`No triage was performed: ${resolution.reason}.`],
    };
  }

  if (resolution.status === 'needs-human') {
    return {
      outcome: 'needs-human',
      reasonCode: resolution.reason,
      dryRun: inputs.dryRun,
      ...metadataFields(resolution.metadata),
      details: [`Triage paused for human attention: ${resolution.reason}.`],
    };
  }

  // A delivery target was resolved. The fingerprint is a pure function of the
  // run identity and target, independent of any optional history or evidence, so
  // it is stable for the same run attempt and changes for a new attempt.
  const baseContext: TriagePromptContext = {
    repository: env.repository,
    conclusion: 'failure',
    run: resolution.metadata,
    delivery: deliveryTarget(resolution),
    ...(inputs.promptInstructions !== undefined
      ? { promptInstructions: inputs.promptInstructions }
      : {}),
    ...(inputs.additionalContext !== undefined
      ? { additionalContext: inputs.additionalContext }
      : {}),
    includeHistory: inputs.includeHistory,
  };
  const fingerprint = computeTaskFingerprint(baseContext);

  if (inputs.dryRun) {
    // Strict dry run: the only reads were the target resolution above. No task is
    // listed or created and no history is collected; nothing is mutated.
    const prompt = buildTriagePrompt(baseContext);
    return {
      outcome: 'dry-run',
      reasonCode: 'dry-run-preview',
      dryRun: true,
      ...metadataFields(resolution.metadata),
      ...targetFields(resolution),
      ...promptFlags(inputs, prompt.truncatedSections.length > 0),
      details: [
        `Dry run: would start a triage task targeting ${resolution.targetBaseRef} (${resolution.resolvedMode} mode). No Agent Tasks writes were performed.`,
      ],
    };
  }

  const provider = env.buildAgentTasksProvider(inputs.agentToken);

  const dedupFields: Partial<TriageResult> = {
    ...metadataFields(resolution.metadata),
    ...targetFields(resolution),
    ...promptFlags(inputs, false),
  };

  // Best-effort idempotency: the public-preview API exposes no atomic
  // idempotency key, so reprocessing the same run attempt is deduplicated by
  // matching the fingerprint marker against recent Agent Tasks before creating.
  const existing = await provider.findTaskByFingerprint(fingerprint);
  if (!existing.ok) {
    // Deduplication itself could not be performed reliably; fail closed rather
    // than risk creating a duplicate task for this run attempt.
    return {
      outcome: outcomeForAgentFailure(existing.reason),
      reasonCode: existing.reason,
      dryRun: false,
      ...dedupFields,
      details: [
        `Could not verify whether a triage task already exists, so no new task was started: ${existing.message}`,
      ],
    };
  }
  if (existing.task !== null) {
    return {
      outcome: 'duplicate',
      reasonCode: 'agent-task-already-exists',
      dryRun: false,
      taskId: existing.task.taskId,
      taskUrl: existing.task.taskUrl,
      ...dedupFields,
      details: [
        'A triage task already exists for this exact failed run attempt; no new task was started.',
      ],
    };
  }

  // Best-effort previous-attempt history, only when enabled. A failure to gather
  // optional history never blocks a new task.
  let history: TriageHistory | undefined;
  if (inputs.includeHistory) {
    history = await collectTriageHistory({
      provider,
      ...(env.buildHistoryApi !== undefined
        ? { historyApi: env.buildHistoryApi(inputs.githubToken) }
        : {}),
      currentFingerprint: fingerprint,
      targetRef: resolution.metadata.headSha,
    });
  }

  const prompt = buildTriagePrompt({
    ...baseContext,
    ...(history !== undefined && history.recentCommits.length > 0
      ? { recentCommits: history.recentCommits }
      : {}),
    ...(history !== undefined && history.previousTasks.length > 0
      ? { previousTasks: history.previousTasks }
      : {}),
  });

  const resolvedFields: Partial<TriageResult> = {
    ...metadataFields(resolution.metadata),
    ...targetFields(resolution),
    ...promptFlags(inputs, prompt.truncatedSections.length > 0),
    ...(history !== undefined
      ? { historyUnavailable: history.unavailable.length > 0 }
      : {}),
  };
  const extraDetails = historyDetails(history);

  const started = await provider.startTask(
    startTaskInput(resolution, inputs, prompt.text),
  );

  if (started.ok) {
    return {
      outcome: 'started',
      reasonCode: 'task-started',
      dryRun: false,
      taskId: started.task.taskId,
      taskUrl: started.task.taskUrl,
      ...resolvedFields,
      details: ['Started a Copilot Agent Tasks triage task.', ...extraDetails],
    };
  }

  // An uncertain create result (timeout or undecodable response) may have
  // created the task anyway. Search again for the fingerprint to reconcile.
  if (isUncertainCreateFailure(started.reason)) {
    const reconciled = await provider.findTaskByFingerprint(fingerprint);
    if (reconciled.ok && reconciled.task !== null) {
      return {
        outcome: 'started',
        reasonCode: 'agent-task-create-reconciled',
        dryRun: false,
        taskId: reconciled.task.taskId,
        taskUrl: reconciled.task.taskUrl,
        ...resolvedFields,
        details: [
          'An uncertain create result was reconciled to an existing task by fingerprint.',
          ...extraDetails,
        ],
      };
    }
    return {
      outcome: 'operational-error',
      reasonCode: 'agent-task-reconciliation-failed',
      dryRun: false,
      ...resolvedFields,
      details: [
        'An uncertain create result could not be reconciled to an existing task; a retry may be required.',
        ...extraDetails,
      ],
    };
  }

  return {
    outcome: outcomeForAgentFailure(started.reason),
    reasonCode: started.reason,
    dryRun: false,
    ...resolvedFields,
    details: [started.message, ...extraDetails],
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
 * Validate inputs, run the triage orchestration, and report the result through
 * the host runner.
 */
export async function executeAction(
  env: ActionEnvironment,
): Promise<TriageResult> {
  const { core } = env;

  const parsed = readActionInputs(core);
  if (!parsed.ok) {
    return finalize(core, invalidInputResult(parsed.messages));
  }

  let result: TriageResult;
  try {
    result = await orchestrate(env, parsed.inputs);
  } catch (error) {
    // Any unexpected error from the read-only resolver is operational; the
    // message is sanitized to the error text only (never tokens or responses).
    const message =
      error instanceof Error ? error.message : 'an unexpected error occurred';
    result = {
      outcome: 'operational-error',
      reasonCode: 'agent-transient',
      dryRun: parsed.inputs.dryRun,
      details: [`CI Triage failed before starting a task: ${message}.`],
    };
  }

  return finalize(core, result);
}
