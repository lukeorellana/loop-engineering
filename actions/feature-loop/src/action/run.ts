/**
 * The action composition root.
 *
 * {@link executeAction} wires the validated inputs, the triggering event, and
 * the host-supplied transports into one idempotent Feature Loop iteration, then
 * publishes the outputs and step summary and decides the step's exit status. It
 * depends only on the {@link ActionEnvironment} seam, so the same orchestration
 * runs under the real Actions toolkit and under in-memory test doubles.
 *
 * Exit behavior:
 * - Expected pauses (`needs-human`) and no-op outcomes complete successfully so
 *   the workflow does not fail when the repository simply needs a human or the
 *   event does not apply.
 * - Invalid configuration and unrecoverable operational errors fail the step.
 *
 * Configuration is always read from the repository default branch, and the
 * pull-request body is re-read through the repository port, so the action never
 * trusts or executes checked-out pull-request code.
 */

import { GitHubRepositoryAdapter } from '../adapters/github/index.js';
import type { GitHubApi } from '../adapters/github/index.js';
import { GitHubCopilotProvider } from '../adapters/github-copilot/index.js';
import type { CopilotAgentApi } from '../adapters/github-copilot/index.js';
import type { CanonicalStateLabels } from '../config/index.js';
import {
  DEFAULT_CANONICAL_STATE_LABELS,
  parseConfig,
} from '../config/index.js';
import type { MergedPullRequest } from '../domain/index.js';
import {
  runFeatureLoop,
  type LoopEventInput,
  type OrchestratorResult,
} from '../orchestrator/index.js';
import type { Clock } from '../ports/clock.js';
import { DEFAULT_CONFIG_PATH } from '../preflight/index.js';
import { CoreLogger, type ActionCore } from './core.js';
import { readActionInputs } from './inputs.js';
import { setActionOutputs } from './outputs.js';
import { buildStepSummary } from './summary.js';

/** The normalized triggering event for the action. */
export interface ActionEvent {
  /** The GitHub event name, for example `workflow_dispatch` or `pull_request`. */
  readonly eventName: string;
  /** The event action, when present, for example `closed`. */
  readonly action?: string;
  /** The pull request carried by a `pull_request` event, when present. */
  readonly pullRequest?: MergedPullRequest;
}

/**
 * The host seam the action composition depends on. The entry point binds the
 * real Actions toolkit and Octokit transports; tests bind in-memory doubles.
 */
export interface ActionEnvironment {
  readonly core: ActionCore;
  readonly clock: Clock;
  readonly event: ActionEvent;
  /** Build the repository transport from the validated repository token. */
  buildRepositoryApi(token: string): GitHubApi;
  /** Build the agent-assignment transport from the validated agent token. */
  buildAgentApi(token: string): CopilotAgentApi;
}

function invalidInputResult(messages: readonly string[]): OrchestratorResult {
  return {
    outcome: 'configuration-error',
    reasonCode: 'invalid-input',
    dryRun: false,
    details: messages,
  };
}

/**
 * Resolve the configured canonical-state labels from the default branch so the
 * repository adapter resolves issue state consistently with the loop. Any
 * failure (a missing or invalid file, or a transport error) falls back to the
 * documented defaults; the controller re-reads and re-validates configuration
 * and reports the authoritative outcome.
 */
async function resolveLabels(
  api: GitHubApi,
  configPath: string | undefined,
): Promise<CanonicalStateLabels> {
  try {
    const repo = await api.getRepository();
    const text = await api.getFileContent(
      configPath ?? DEFAULT_CONFIG_PATH,
      repo.defaultBranch,
    );
    if (text === null) {
      return DEFAULT_CANONICAL_STATE_LABELS;
    }
    return parseConfig(text).labels.names;
  } catch {
    // ConfigurationError (invalid file) and transport failures both fall back to
    // defaults here; the controller re-reads configuration and reports the
    // authoritative configuration-error or operational-error outcome.
    return DEFAULT_CANONICAL_STATE_LABELS;
  }
}

function buildEventInput(
  event: ActionEvent,
  epicIssue: number | undefined,
): LoopEventInput {
  return {
    name: event.eventName,
    ...(event.action !== undefined ? { action: event.action } : {}),
    ...(epicIssue !== undefined ? { epicNumber: epicIssue } : {}),
    ...(event.pullRequest !== undefined
      ? { pullRequest: event.pullRequest }
      : {}),
  };
}

function failsStep(result: OrchestratorResult): boolean {
  return (
    result.outcome === 'configuration-error' ||
    result.outcome === 'operational-error'
  );
}

export async function finalize(
  core: ActionCore,
  result: OrchestratorResult,
): Promise<OrchestratorResult> {
  setActionOutputs(core, result);
  try {
    await core.summary.addRaw(buildStepSummary(result)).write();
  } catch {
    // A failure to write the step summary must never mask the loop outcome.
  }
  if (failsStep(result)) {
    core.setFailed(
      result.details[0] ?? `Feature Loop failed: ${result.reasonCode}.`,
    );
  }
  return result;
}

/**
 * Run one Feature Loop iteration and report its result through the host runner.
 */
export async function executeAction(
  env: ActionEnvironment,
): Promise<OrchestratorResult> {
  const { core } = env;

  const parsed = readActionInputs(core);
  if (!parsed.ok) {
    return finalize(core, invalidInputResult(parsed.messages));
  }
  const inputs = parsed.inputs;

  const repositoryApi = env.buildRepositoryApi(inputs.githubToken);
  const labels = await resolveLabels(repositoryApi, inputs.configPath);
  const repository = new GitHubRepositoryAdapter({
    api: repositoryApi,
    labels,
  });

  const provider = new GitHubCopilotProvider({
    api: env.buildAgentApi(inputs.agentToken),
    clock: env.clock,
  });

  const result = await runFeatureLoop({
    repository,
    provider,
    clock: env.clock,
    logger: new CoreLogger(core),
    request: {
      event: buildEventInput(env.event, inputs.epicIssue),
      dryRun: inputs.dryRun,
      forceReinitialize: inputs.forceReinitialize,
    },
    ...(inputs.configPath !== undefined
      ? { configPath: inputs.configPath }
      : {}),
  });

  return finalize(core, result);
}
