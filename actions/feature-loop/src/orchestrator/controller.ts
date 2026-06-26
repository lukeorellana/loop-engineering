/**
 * The transactional Feature Loop controller.
 *
 * {@link runFeatureLoop} composes the repository adapter, the trusted merged-PR
 * resolver, the pure ordered state machine, and the coding-agent provider into a
 * single idempotent loop iteration. It follows a strict orchestration pattern:
 *
 *     read → decide → re-read → mutate → verify
 *
 * and reconciles stale and inconsistent state before acting. Exactly one issue
 * can become active per epic; manual reruns and duplicate webhook deliveries are
 * safe; a strict dry run performs no comments, labels, assignments, or issue
 * updates; assignment uncertainty is reconciled before any rollback; and a failed
 * assignment leaves a recoverable `needs-human` state.
 *
 * V1 reports stalled active work but never automatically times out, cancels, or
 * reassigns it. Detailed diagnostics stay in the Actions log; issue comments are
 * sanitized.
 */

import type { CanonicalStateLabels } from '../config/schema.js';
import {
  ConfigurationError,
  defaultConfig,
  parseConfig,
  type FeatureLoopConfig,
} from '../config/index.js';
import type {
  AgentModelSelection,
  AgentStartRequest,
} from '../domain/agent.js';
import type { ActionOutcome, LoopDecision } from '../domain/decisions.js';
import type { Epic, SubIssue } from '../domain/issues.js';
import {
  parseClosingKeywords,
  resolveMergedPullRequest,
  type MergedPullRequest,
} from '../domain/merged-pr.js';
import { resolvePullRequestLink } from '../domain/pr-link.js';
import { detectPlanDrift } from '../domain/plan.js';
import { decideLoop, type LoopEvaluation } from '../domain/state-machine.js';
import type { MarkdownDiscoverySource } from '../domain/markdown.js';
import { initializeEpic } from '../initializer/index.js';
import { DEFAULT_CONFIG_PATH, preflight } from '../preflight/index.js';
import type { AgentProviderPort } from '../ports/agent-provider.js';
import type { Clock } from '../ports/clock.js';
import type { GitHubRepositoryPort } from '../ports/github-repository.js';
import type { Logger } from '../ports/logger.js';
import { resolveEvent, type LoopEventInput } from './event.js';
import { readOnlyRepository } from './read-only-repository.js';
import {
  buildStatusComment,
  decodeStatusData,
  epicStatusMarker,
  type LoopStatusData,
} from './status.js';

/**
 * The triggering inputs and run mode for a single loop iteration.
 */
export interface LoopRequest {
  /** The normalized triggering event inputs. */
  readonly event: LoopEventInput;
  /** When `true`, the iteration is strictly read-only (no mutations). */
  readonly dryRun: boolean;
  /**
   * When `true`, a manual dispatch reinitializes an already-initialized epic,
   * rewriting the frozen execution plan. A normal rerun is idempotent.
   */
  readonly forceReinitialize?: boolean;
}

/**
 * Everything the controller depends on. The repository and provider are ports,
 * so the loop can be exercised end-to-end with in-memory fakes.
 */
export interface OrchestratorInput {
  readonly repository: GitHubRepositoryPort;
  readonly provider: AgentProviderPort;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly request: LoopRequest;
  /** Optional configuration path on the default branch. */
  readonly configPath?: string;
}

/**
 * The structured outcome of a loop iteration. `details` are sanitized,
 * human-readable summary lines safe to surface anywhere.
 */
export interface OrchestratorResult {
  readonly outcome: ActionOutcome;
  /** A stable machine-readable reason code. */
  readonly reasonCode: string;
  readonly dryRun: boolean;
  readonly epicNumber?: number;
  /** The sub-issue the loop is acting on (started, running, or paused). */
  readonly issueNumber?: number;
  /**
   * The sub-issue completed during this iteration from a trusted merged pull
   * request, when one was completed. Independent of {@link issueNumber}, which
   * is the issue the loop continues to act on after the completion.
   */
  readonly completedIssueNumber?: number;
  readonly details: readonly string[];
}

function dedupe(values: readonly number[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function modelFromConfig(model: string | null): AgentModelSelection {
  return model === null ? { kind: 'auto' } : { kind: 'explicit', name: model };
}

function formatAge(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/** A human-readable description of how the Markdown list was discovered. */
function describeDiscovery(source: MarkdownDiscoverySource | 'none'): string {
  switch (source) {
    case 'marker':
      return 'the feature-loop:ordered-issues marker';
    case 'configured-heading':
      return 'the configured heading';
    case 'structural':
      return 'the structural fallback';
    default:
      return 'Markdown';
  }
}

/**
 * Run one idempotent iteration of the Feature Loop.
 */
export async function runFeatureLoop(
  input: OrchestratorInput,
): Promise<OrchestratorResult> {
  try {
    return await new Controller(input).run();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'An unexpected error occurred.';
    input.logger.error('Feature Loop failed with an unexpected error', {
      message,
    });
    return {
      outcome: 'operational-error',
      reasonCode: 'operational-error',
      dryRun: input.request.dryRun,
      details: [message],
    };
  }
}

class Controller {
  private readonly repository: GitHubRepositoryPort;
  private readonly provider: AgentProviderPort;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly dryRun: boolean;
  private readonly forceReinitialize: boolean;
  private readonly configPath?: string;
  private readonly event: LoopEventInput;

  // Resolved during preflight.
  private labels!: CanonicalStateLabels;
  private baseBranch!: string;
  private model!: AgentModelSelection;
  private epicNumber!: number;
  private issues!: readonly number[];
  private evaluation!: LoopEvaluation;

  // Set when a trusted merged pull request completes a prior sub-issue.
  private completedIssueNumber?: number;

  // Details from epic initialization, surfaced on the final result.
  private initDetails: readonly string[] = [];

  // A human-readable note describing how the Markdown ordered-issue list was
  // discovered (marker, configured heading, or structural fallback), surfaced on
  // the final result so dry-run output reports the discovery source.
  private discoveryNote?: string;

  constructor(input: OrchestratorInput) {
    // Dry-run uses a read-only repository view so the zero-write invariant holds
    // by construction, even for code paths without an explicit dry-run guard.
    this.repository = input.request.dryRun
      ? readOnlyRepository(input.repository)
      : input.repository;
    this.provider = input.provider;
    this.clock = input.clock;
    this.logger = input.logger;
    this.dryRun = input.request.dryRun;
    this.forceReinitialize = input.request.forceReinitialize ?? false;
    this.configPath = input.configPath;
    this.event = input.request.event;
  }

  async run(): Promise<OrchestratorResult> {
    let result = await this.runLoop();
    // Surface initialization details (e.g. epic-initialized / already-initialized)
    // and the Markdown discovery source on the final result so manual dispatch
    // reports what the transaction did.
    const leadingDetails = [
      ...(this.discoveryNote !== undefined ? [this.discoveryNote] : []),
      ...this.initDetails,
    ];
    if (leadingDetails.length > 0) {
      result = { ...result, details: [...leadingDetails, ...result.details] };
    }
    // Surface the issue completed from a trusted merged pull request on every
    // exit path that continued past the completion (start, already-running,
    // complete, no-op, or pause), without overwriting an explicit value.
    if (
      this.completedIssueNumber !== undefined &&
      result.completedIssueNumber === undefined
    ) {
      return { ...result, completedIssueNumber: this.completedIssueNumber };
    }
    return result;
  }

  private async runLoop(): Promise<OrchestratorResult> {
    // 1. Resolve and validate the event context.
    const resolved = resolveEvent(this.event);
    if (resolved.kind === 'unrelated') {
      this.logger.info('Feature Loop: event does not apply', {
        reason: resolved.reason,
      });
      return this.noOp(resolved.reason);
    }

    // Pull-request link reconciliation: an opened or reopened pull request may
    // need a formal closing relationship with the active sub-issue recorded
    // before merge. This path is self-contained and does not advance the loop.
    if (resolved.kind === 'pr-opened') {
      return this.reconcilePullRequestLink(resolved.pullRequestNumber);
    }

    const info = await this.repository.getRepositoryInfo();

    // Resolve the epic number for each execution context.
    let mergedPr: MergedPullRequest | undefined;
    if (resolved.kind === 'manual') {
      this.epicNumber = resolved.epicNumber;
    } else {
      // Re-read the authoritative merged pull request from the repository so the
      // trusted resolver reconciles closing keywords against GitHub's
      // authoritative closingIssuesReferences rather than the (possibly
      // incomplete) webhook payload. Fall back to the delivered payload only when
      // the repository has no record of the pull request.
      const eventPr = resolved.event.pullRequest;
      mergedPr =
        (await this.repository.getMergedPullRequest(eventPr.number)) ?? eventPr;
      const epicNumber = await this.resolveEpicForPullRequest(info, mergedPr);
      if (epicNumber === null) {
        this.logger.info('Feature Loop: merged pull request has no epic', {
          pullRequest: mergedPr.number,
        });
        return this.noOp('event-not-applicable');
      }
      this.epicNumber = epicNumber;
    }

    // 2. Repository preflight.
    const pre = await preflight({
      repository: this.repository,
      epicNumber: this.epicNumber,
      configPath: this.configPath,
    });
    if (!pre.ok) {
      this.logger.warning('Feature Loop preflight failed', {
        kind: pre.kind,
      });
      return {
        outcome: pre.kind,
        reasonCode: pre.kind,
        dryRun: this.dryRun,
        epicNumber: this.epicNumber,
        details: [...pre.messages],
      };
    }

    this.labels = pre.config.labels.names;
    this.baseBranch = pre.baseBranch;
    this.model = modelFromConfig(pre.config.agent.model);
    this.issues = pre.issues;
    // Report how the Markdown ordered-issue list was discovered during a manual
    // initialization (or force-reinitialize). Continuation runs follow the frozen
    // plan and do not re-derive discovery, so the note is omitted there.
    if (
      resolved.kind === 'manual' &&
      pre.source === 'markdown' &&
      pre.markdownDiscovery !== undefined &&
      pre.markdownDiscovery !== 'none'
    ) {
      this.discoveryNote = `Ordered sub-issues discovered from Markdown via ${describeDiscovery(
        pre.markdownDiscovery,
      )}.`;
    }
    this.evaluation = {
      provider: this.provider.id,
      model: this.model,
      baseBranch: this.baseBranch,
      dryRun: this.dryRun,
      eventApplies: true,
    };

    // 2 (continued). Provider preflight, delegated to the provider port.
    const providerPreflight = await this.provider.preflight({
      epic: pre.epic,
      provider: this.provider.id,
      baseBranch: this.baseBranch,
      model: this.model,
    });
    if (!providerPreflight.ok) {
      this.logger.warning('Feature Loop provider preflight failed', {
        reason: providerPreflight.reason,
      });
      return {
        outcome: 'configuration-error',
        reasonCode: 'configuration-error',
        dryRun: this.dryRun,
        epicNumber: this.epicNumber,
        details: [...providerPreflight.messages],
      };
    }

    // 2 (continued). Epic plan: a manual dispatch initializes (or verifies) the
    // frozen execution plan; a continuation run reads the frozen plan and pauses
    // on drift. Both establish the controlling ordered issue list before any
    // epic read so the loop never re-resolves competing issue sources.
    if (resolved.kind === 'manual') {
      const initialized = await this.initializeEpicPlan(pre.issues);
      if (initialized !== null) {
        return initialized;
      }
    } else {
      const continued = await this.loadFrozenPlanForContinuation();
      if (continued !== null) {
        return continued;
      }
    }

    // Read: load the epic with the controlling ordered sub-issue list.
    const epic = await this.loadEpic();

    // 3. Complete the prior active issue when a trusted merged PR applies.
    if (mergedPr !== undefined) {
      const completed = await this.completeFromMergedPr(epic, info, mergedPr);
      if (completed !== null) {
        return completed;
      }
    }

    // 5. Reconcile stale and inconsistent state.
    await this.reconcileStaleLabels(epic);

    // 6–11. Decide and act.
    return this.decideAndDispatch(true);
  }

  /**
   * Initialize (or verify) the frozen execution plan for a manual dispatch.
   *
   * Returns a terminal {@link OrchestratorResult} when initialization fails
   * closed or pauses for human attention; otherwise returns `null` after the
   * controlling ordered issue list has been established from the frozen plan.
   */
  private async initializeEpicPlan(
    intendedIssues: readonly number[],
  ): Promise<OrchestratorResult | null> {
    const result = await initializeEpic({
      repository: this.repository,
      logger: this.logger,
      epicNumber: this.epicNumber,
      intendedIssues,
      labels: this.labels,
      exactSync: true,
      dryRun: this.dryRun,
      forceReinitialize: this.forceReinitialize,
    });

    switch (result.kind) {
      case 'failed':
        return {
          outcome: 'configuration-error',
          reasonCode: 'initialization-failed',
          dryRun: this.dryRun,
          epicNumber: this.epicNumber,
          details: [...result.messages],
        };
      case 'unexpected-active-issue':
        await this.postStatus(this.epicNumber, {
          state: 'needs-human',
          reason: 'unexpected-active-issue',
          humanText: result.messages.join(' '),
        });
        return {
          outcome: 'needs-human',
          reasonCode: 'unexpected-active-issue',
          dryRun: this.dryRun,
          epicNumber: this.epicNumber,
          issueNumber: result.issueNumber,
          details: [...result.messages],
        };
      case 'dry-run':
        this.issues = result.issues;
        this.initDetails = result.details;
        return null;
      case 'already-initialized':
        this.issues = result.plan.issues;
        this.initDetails = result.details;
        return null;
      case 'initialized':
        this.issues = result.plan.issues;
        this.initDetails = result.details;
        return null;
    }
  }

  /**
   * Load the frozen execution plan for a continuation run and verify the native
   * hierarchy has not drifted. Returns a terminal {@link OrchestratorResult}
   * when the plan and native hierarchy differ (`plan-drift`); otherwise returns
   * `null` after adopting the planned order, or leaves the preflight-resolved
   * order in place when no plan has been persisted yet.
   */
  private async loadFrozenPlanForContinuation(): Promise<OrchestratorResult | null> {
    const plan = await this.repository.getInitializationPlan(this.epicNumber);
    if (plan === null) {
      // Backward compatible: an epic initialized before this feature continues
      // on the preflight-resolved order.
      return null;
    }

    this.issues = plan.issues;

    const nativeOrder = await this.repository.getNativeSubIssueNumbers(
      this.epicNumber,
    );
    const drift = detectPlanDrift(plan, nativeOrder);
    if (drift.drifted) {
      const messages = [
        drift.message,
        'Reinitialize the epic with force-reinitialize to adopt the new hierarchy.',
      ];
      await this.postStatus(this.epicNumber, {
        state: 'needs-human',
        reason: 'plan-drift',
        humanText: messages.join(' '),
      });
      return {
        outcome: 'needs-human',
        reasonCode: 'plan-drift',
        dryRun: this.dryRun,
        epicNumber: this.epicNumber,
        details: messages,
      };
    }

    return null;
  }

  /**
   * Decide on freshly read state and dispatch the resulting action. When
   * `allowReReadForStart` is set, a `started` decision triggers exactly one
   * additional re-read immediately before mutation (the "re-read" step).
   */
  private async decideAndDispatch(
    allowReReadForStart: boolean,
  ): Promise<OrchestratorResult> {
    const epic = await this.loadEpic();
    const decision = decideLoop(epic, this.evaluation);
    return this.dispatch(epic, decision, allowReReadForStart);
  }

  private async dispatch(
    epic: Epic,
    decision: LoopDecision,
    allowReReadForStart: boolean,
  ): Promise<OrchestratorResult> {
    switch (decision.outcome) {
      case 'no-op':
        return this.noOp(decision.reason);
      case 'configuration-error':
        return {
          outcome: 'configuration-error',
          reasonCode: 'configuration-error',
          dryRun: this.dryRun,
          epicNumber: this.epicNumber,
          details: [...decision.messages],
        };
      case 'operational-error':
        return {
          outcome: 'operational-error',
          reasonCode: 'operational-error',
          dryRun: this.dryRun,
          epicNumber: this.epicNumber,
          details: [decision.message],
        };
      case 'dry-run':
        return this.handleDryRun(decision);
      case 'complete':
        return this.handleComplete(epic);
      case 'needs-human':
        return this.handlePaused(decision.issue, decision.reason);
      case 'already-running':
        return this.reconcileRunning(epic, decision.issue);
      case 'started': {
        if (allowReReadForStart) {
          // Re-read: decide again on the very latest state before mutating.
          return this.decideAndDispatch(false);
        }
        return this.startIssue(epic, decision);
      }
      default:
        return this.noOp('event-not-applicable');
    }
  }

  // ---- Merged pull-request completion -------------------------------------

  /**
   * Resolve and, when trusted, apply the completion of the prior active issue.
   * Returns a terminal {@link OrchestratorResult} when the merged PR is a no-op
   * or pauses the loop, or `null` when completion was applied and the loop should
   * continue to the next decision.
   */
  private async completeFromMergedPr(
    epic: Epic,
    info: { owner: string; name: string },
    pullRequest: MergedPullRequest,
  ): Promise<OrchestratorResult | null> {
    const resolution = resolveMergedPullRequest(
      { name: 'pull_request', action: 'closed', pullRequest },
      {
        repository: { owner: info.owner, name: info.name },
        baseBranch: this.baseBranch,
        epic,
        doneLabel: this.labels.done,
      },
    );

    if (resolution.outcome === 'no-op') {
      this.logger.info('Feature Loop: merged pull request does not advance', {
        reason: resolution.reason,
      });
      return this.noOp(resolution.reason);
    }

    if (resolution.outcome === 'needs-human') {
      this.logger.warning('Feature Loop: merged pull request needs human', {
        reason: resolution.reason,
        detail: resolution.message,
      });
      await this.postStatus(this.epicNumber, {
        state: 'paused',
        reason: resolution.reason,
        humanText: `Feature Loop paused on pull request #${pullRequest.number}: ${resolution.message}`,
      });
      return {
        outcome: 'needs-human',
        reasonCode: resolution.reason,
        dryRun: this.dryRun,
        epicNumber: this.epicNumber,
        details: [resolution.message],
      };
    }

    // Apply the idempotent completion preparation. Replays request no mutations.
    const prep = resolution.preparation;
    if (prep.closeAsCompleted) {
      await this.repository.closeIssueAsCompleted(prep.issueNumber);
    }
    if (prep.normalizeDoneLabel) {
      await this.repository.setCanonicalState(
        prep.issueNumber,
        this.labels.done,
      );
    }
    this.logger.info('Feature Loop: completed prior issue from merged PR', {
      issue: prep.issueNumber,
      pullRequest: pullRequest.number,
      alreadyComplete: prep.alreadyComplete,
    });
    this.completedIssueNumber = prep.issueNumber;
    return null;
  }

  // ---- Pull-request link reconciliation -----------------------------------

  /**
   * Reconcile the closing relationship of an opened or reopened pull request.
   *
   * Re-reads the authoritative pull request, confirms it was opened by the
   * configured coding-agent provider against the configured base branch with no
   * existing closing reference, resolves the single active sub-issue from
   * canonical Feature Loop state, and — outside dry run — appends an idempotent
   * `Closes #<issue>` line and verifies GitHub records the relationship. Zero or
   * multiple active issues never produce an inferred link; the path fails closed.
   */
  private async reconcilePullRequestLink(
    pullRequestNumber: number,
  ): Promise<OrchestratorResult> {
    const info = await this.repository.getRepositoryInfo();

    // Load configuration from the default branch. No epic is known yet, so the
    // active sub-issue is resolved from canonical state below rather than from a
    // pull-request closing reference (which is precisely what may be missing).
    let config: FeatureLoopConfig;
    try {
      const text = await this.repository.getDefaultBranchFile(
        this.configPath ?? DEFAULT_CONFIG_PATH,
      );
      config = text === null ? defaultConfig() : parseConfig(text);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        this.logger.warning('Feature Loop: invalid configuration for PR link', {
          pullRequest: pullRequestNumber,
        });
        return {
          outcome: 'configuration-error',
          reasonCode: 'configuration-error',
          dryRun: this.dryRun,
          details: [...error.messages],
        };
      }
      throw error;
    }

    const labels = config.labels.names;
    const baseBranch = config.base.branch ?? info.defaultBranch;

    // Re-read the authoritative pull request from GitHub; the webhook payload is
    // never trusted for the author, base branch, or closing references.
    const pr = await this.repository.getOpenedPullRequest(pullRequestNumber);
    if (pr === null) {
      this.logger.info('Feature Loop: pull request not found for link', {
        pullRequest: pullRequestNumber,
      });
      return this.linkNoOp('event-not-applicable');
    }

    // Resolve the active sub-issues from canonical Feature Loop state.
    const activeIssues = await this.repository.findActiveSubIssues(
      labels['in-progress'],
    );

    const resolution = resolvePullRequestLink(pr, {
      repository: { owner: info.owner, name: info.name },
      baseBranch,
      agentLogins: this.provider.authorLogins,
      activeIssues,
    });

    if (resolution.outcome === 'no-op') {
      this.logger.info('Feature Loop: pull request link not applied', {
        pullRequest: pullRequestNumber,
        reason: resolution.reason,
      });
      return this.linkNoOp(resolution.reason);
    }

    if (resolution.outcome === 'needs-human') {
      this.logger.warning('Feature Loop: pull request link is ambiguous', {
        pullRequest: pullRequestNumber,
        reason: resolution.reason,
      });
      return {
        outcome: 'needs-human',
        reasonCode: resolution.reason,
        dryRun: this.dryRun,
        details: [resolution.message],
      };
    }

    const issueNumber = resolution.issueNumber;
    // Best-effort epic resolution for reporting; native parent metadata is
    // absent for Markdown-sourced sub-issues, so a missing parent is not fatal.
    const epicNumber =
      (await this.repository.getParentEpicNumber(issueNumber)) ?? undefined;

    if (this.dryRun) {
      const detail =
        `Dry run: would link pull request #${pullRequestNumber} to issue ` +
        `#${issueNumber} with "Closes #${issueNumber}".`;
      this.logger.info('Feature Loop: dry run pull request link preview', {
        pullRequest: pullRequestNumber,
        issue: issueNumber,
      });
      return {
        outcome: 'dry-run',
        reasonCode: 'pull-request-link',
        dryRun: true,
        ...(epicNumber !== undefined ? { epicNumber } : {}),
        issueNumber,
        details: [detail],
      };
    }

    // Mutate: record the formal closing relationship.
    await this.repository.updatePullRequestBody(
      pullRequestNumber,
      resolution.body,
    );

    // Verify: re-read and confirm GitHub now reports the closing relationship.
    const verified =
      await this.repository.getOpenedPullRequest(pullRequestNumber);
    const linked =
      verified !== null &&
      verified.closingIssueReferences.includes(issueNumber);
    if (!linked) {
      const message =
        `Feature Loop updated pull request #${pullRequestNumber} to close ` +
        `issue #${issueNumber}, but GitHub has not yet reported the closing ` +
        'relationship. Confirm the link before merging.';
      this.logger.warning('Feature Loop: pull request link not verified', {
        pullRequest: pullRequestNumber,
        issue: issueNumber,
      });
      return {
        outcome: 'needs-human',
        reasonCode: 'link-not-verified',
        dryRun: false,
        ...(epicNumber !== undefined ? { epicNumber } : {}),
        issueNumber,
        details: [message],
      };
    }

    const detail =
      `Linked pull request #${pullRequestNumber} to active issue ` +
      `#${issueNumber} with "Closes #${issueNumber}".`;
    this.logger.info('Feature Loop: linked pull request to active issue', {
      pullRequest: pullRequestNumber,
      issue: issueNumber,
      epic: epicNumber,
    });
    return {
      outcome: 'already-running',
      reasonCode: 'pull-request-linked',
      dryRun: false,
      ...(epicNumber !== undefined ? { epicNumber } : {}),
      issueNumber,
      details: [detail],
    };
  }

  private linkNoOp(reason: string): OrchestratorResult {
    return {
      outcome: 'no-op',
      reasonCode: reason,
      dryRun: this.dryRun,
      details: [],
    };
  }

  // ---- Start flow (re-read → mutate → verify) -----------------------------

  private async startIssue(
    epic: Epic,
    decision: Extract<LoopDecision, { outcome: 'started' }>,
  ): Promise<OrchestratorResult> {
    const issue = decision.issue;
    const request = decision.request;

    // Multiple linked pull requests pause the loop before any assignment, even
    // when the provider is already assigned: the ambiguity needs a human.
    const linked = await this.repository.getLinkedPullRequestNumbers(
      issue.number,
    );
    if (linked.length > 1) {
      return this.pauseRunningIssue(
        issue,
        'multiple-linked-pull-requests',
        `Issue #${issue.number} has ${linked.length} linked pull requests; resolve the ambiguity before the loop continues.`,
      );
    }

    // Idempotency: the provider may already be assigned (manual rerun, replay).
    if (await this.provider.isAlreadyStarted(request)) {
      await this.repository.setCanonicalState(
        issue.number,
        this.labels['in-progress'],
      );
      const startedAt =
        (await this.preservedStartedAt(issue.number)) ??
        this.clock.now().toISOString();
      await this.postRunning(issue, startedAt);
      this.logger.info('Feature Loop: issue already assigned to provider', {
        issue: issue.number,
      });
      return this.runningResult('already-running', 'already-running', issue);
    }

    // Mutate: set the canonical running state and post scoped instructions.
    const startedAt = this.clock.now().toISOString();
    await this.repository.setCanonicalState(
      issue.number,
      this.labels['in-progress'],
    );
    await this.postRunning(issue, startedAt);

    // 10. Start the coding-agent provider. A thrown error is treated as a failed
    // assignment so the issue is left in a recoverable `needs-human` state.
    let result: Awaited<ReturnType<AgentProviderPort['startAgent']>>;
    try {
      result = await this.provider.startAgent(request);
    } catch (error) {
      this.logger.error('Feature Loop: assignment threw', {
        issue: issue.number,
        message: error instanceof Error ? error.message : String(error),
      });
      return this.pauseRunningIssue(
        issue,
        'assignment-failed',
        `The coding agent could not be assigned to issue #${issue.number}. A human can resume the loop.`,
      );
    }

    // 11. Verify the assignment and persist the final status.
    switch (result.status) {
      case 'started':
      case 'already-running': {
        const assignedAt =
          result.status === 'started' ? result.assignedAt : startedAt;
        await this.postRunning(issue, assignedAt);
        this.logger.info('Feature Loop: started issue', {
          issue: issue.number,
          epic: epic.number,
        });
        return this.runningResult('started', 'started', issue);
      }
      case 'uncertain': {
        // Reconcile the real state before any rollback; never blindly retry.
        this.logger.warning('Feature Loop: uncertain assignment, reconciling', {
          issue: issue.number,
          detail: result.detail,
        });
        if (await this.provider.isAlreadyStarted(request)) {
          await this.postRunning(issue, startedAt);
          this.logger.info('Feature Loop: assignment confirmed on reconcile', {
            issue: issue.number,
          });
          return this.runningResult('started', 'started', issue);
        }
        return this.pauseRunningIssue(
          issue,
          'assignment-failed',
          `The coding agent could not be confirmed as assigned to issue #${issue.number}. A human can resume the loop.`,
        );
      }
      case 'failed': {
        // Detailed diagnostics stay in the log; the comment is sanitized.
        this.logger.error('Feature Loop: assignment failed', {
          issue: issue.number,
          reason: result.reason,
          error: result.error,
        });
        return this.pauseRunningIssue(
          issue,
          'assignment-failed',
          `The coding agent could not be assigned to issue #${issue.number} (${result.reason}). A human can resume the loop.`,
        );
      }
    }
  }

  // ---- Reconciliation -----------------------------------------------------

  /**
   * Normalize stale canonical labels on closed sub-issues (for example a closed
   * issue that still carries a running label). This is idempotent and only
   * touches closed issues that carry a non-terminal canonical label.
   */
  private async reconcileStaleLabels(epic: Epic): Promise<void> {
    for (const issue of epic.subIssues) {
      if (issue.open) {
        continue;
      }
      const terminal =
        issue.state === 'not-planned'
          ? this.labels['not-planned']
          : this.labels.done;
      const present = issue.canonicalStateLabels;
      const consistent = present.length === 1 && present[0] === terminal;
      if (present.length > 0 && !consistent) {
        this.logger.info('Feature Loop: reconciling stale labels', {
          issue: issue.number,
          from: [...present],
          to: terminal,
        });
        await this.repository.setCanonicalState(issue.number, terminal);
      }
    }
  }

  /**
   * Reconcile an issue the state machine reports as already running: verify the
   * provider is still assigned, pause on multiple linked PRs, and report the age
   * of stalled active work. V1 never times out, cancels, or reassigns.
   */
  private async reconcileRunning(
    epic: Epic,
    issue: SubIssue,
  ): Promise<OrchestratorResult> {
    const linked = await this.repository.getLinkedPullRequestNumbers(
      issue.number,
    );
    if (linked.length > 1) {
      return this.pauseRunningIssue(
        issue,
        'multiple-linked-pull-requests',
        `Issue #${issue.number} has ${linked.length} linked pull requests; resolve the ambiguity before the loop continues.`,
      );
    }

    const request = this.requestFor(epic, issue);
    const details: string[] = [];

    const assigned = await this.provider.isAlreadyStarted(request);
    if (!assigned) {
      // Report the inconsistency; V1 does not reassign automatically.
      details.push(
        `The coding agent is no longer assigned to running issue #${issue.number}; a human can resume it.`,
      );
      this.logger.warning('Feature Loop: agent not assigned to running issue', {
        issue: issue.number,
      });
    }

    const startedAt = await this.preservedStartedAt(issue.number);
    const age =
      startedAt !== undefined
        ? formatAge(this.clock.now().getTime() - Date.parse(startedAt))
        : undefined;
    if (age !== undefined) {
      details.push(`Issue #${issue.number} has been active for ${age}.`);
      this.logger.info('Feature Loop: active work age', {
        issue: issue.number,
        startedAt,
        age,
      });
    }

    const humanText = assigned
      ? `Feature Loop is running issue #${issue.number}${age !== undefined ? ` (active for ${age})` : ''}.`
      : `Feature Loop issue #${issue.number} is marked running but the coding agent is no longer assigned. A human can resume it.`;
    await this.postStatus(issue.number, {
      state: 'running',
      reason: 'already-running',
      startedAt,
      issue: issue.number,
      humanText,
    });

    return {
      outcome: 'already-running',
      reasonCode: 'already-running',
      dryRun: this.dryRun,
      epicNumber: this.epicNumber,
      issueNumber: issue.number,
      details,
    };
  }

  // ---- Terminal handlers --------------------------------------------------

  private handleDryRun(
    decision: Extract<LoopDecision, { outcome: 'dry-run' }>,
  ): OrchestratorResult {
    const issueNumber = decision.wouldStart?.issue.number;
    const details =
      issueNumber !== undefined
        ? [
            `Dry run: would start issue #${issueNumber} for epic #${this.epicNumber}.`,
          ]
        : [`Dry run: no eligible issue to start for epic #${this.epicNumber}.`];
    this.logger.info('Feature Loop: dry run preview', {
      epic: this.epicNumber,
      issue: issueNumber,
    });
    return {
      outcome: 'dry-run',
      reasonCode: 'dry-run',
      dryRun: this.dryRun,
      epicNumber: this.epicNumber,
      issueNumber,
      details,
    };
  }

  private async handleComplete(epic: Epic): Promise<OrchestratorResult> {
    const humanText = `Feature Loop complete: every sub-issue in epic #${epic.number} is done.`;
    await this.postStatus(epic.number, {
      state: 'complete',
      reason: 'complete',
      humanText,
    });
    this.logger.info('Feature Loop: epic complete', { epic: epic.number });
    return {
      outcome: 'complete',
      reasonCode: 'complete',
      dryRun: this.dryRun,
      epicNumber: this.epicNumber,
      details: [humanText],
    };
  }

  private async handlePaused(
    issue: SubIssue,
    reason: string,
  ): Promise<OrchestratorResult> {
    const humanText = `Feature Loop paused at issue #${issue.number}: ${reason}. Human attention is required.`;
    // Do not mutate canonical labels here: the head-of-line state is already a
    // pausing state (and an `invalid` multi-label state must fail closed).
    await this.postStatus(issue.number, {
      state: 'paused',
      reason,
      issue: issue.number,
      humanText,
    });
    this.logger.warning('Feature Loop: paused for human attention', {
      issue: issue.number,
      reason,
    });
    return {
      outcome: 'needs-human',
      reasonCode: reason,
      dryRun: this.dryRun,
      epicNumber: this.epicNumber,
      issueNumber: issue.number,
      details: [humanText],
    };
  }

  /**
   * Pause an issue that the loop itself is driving (a failed assignment or a
   * multiple-linked-PR ambiguity): set the recoverable `needs-human` canonical
   * state and post a sanitized status.
   */
  private async pauseRunningIssue(
    issue: SubIssue,
    reason: string,
    humanText: string,
  ): Promise<OrchestratorResult> {
    await this.repository.setCanonicalState(
      issue.number,
      this.labels['needs-human'],
    );
    await this.postStatus(issue.number, {
      state: 'paused',
      reason,
      issue: issue.number,
      humanText,
    });
    this.logger.warning('Feature Loop: issue paused for human attention', {
      issue: issue.number,
      reason,
    });
    return {
      outcome: 'needs-human',
      reasonCode: reason,
      dryRun: this.dryRun,
      epicNumber: this.epicNumber,
      issueNumber: issue.number,
      details: [humanText],
    };
  }

  // ---- Helpers ------------------------------------------------------------

  private async loadEpic(): Promise<Epic> {
    const epic = await this.repository.getEpicWithSubIssues(
      this.epicNumber,
      this.issues,
    );
    if (epic === null) {
      throw new Error(`Epic #${this.epicNumber} could not be loaded.`);
    }
    return epic;
  }

  private requestFor(epic: Epic, issue: SubIssue): AgentStartRequest {
    return {
      epic,
      issue,
      provider: this.provider.id,
      model: this.model,
      baseBranch: this.baseBranch,
      dryRun: this.dryRun,
    };
  }

  private async resolveEpicForPullRequest(
    info: { owner: string; name: string },
    pullRequest: MergedPullRequest,
  ): Promise<number | null> {
    const refs = dedupe([
      ...parseClosingKeywords(pullRequest.body, {
        owner: info.owner,
        name: info.name,
      }),
      ...pullRequest.closingIssueReferences,
    ]);
    for (const issueNumber of refs) {
      const parent = await this.repository.getParentEpicNumber(issueNumber);
      if (parent !== null) {
        return parent;
      }
    }
    return null;
  }

  private async preservedStartedAt(
    issueNumber: number,
  ): Promise<string | undefined> {
    const body = await this.repository.getStatusComment(
      issueNumber,
      epicStatusMarker(this.epicNumber),
    );
    return decodeStatusData(body)?.startedAt;
  }

  private async postRunning(issue: SubIssue, startedAt: string): Promise<void> {
    await this.postStatus(issue.number, {
      state: 'running',
      reason: 'started',
      issue: issue.number,
      startedAt,
      humanText:
        `Feature Loop assigned issue #${issue.number} ("${issue.title}") to ` +
        `provider \`${this.provider.id}\` for epic #${this.epicNumber}. ` +
        'A human reviews and merges the pull request before the next issue starts.',
    });
  }

  private async postStatus(
    targetIssue: number,
    options: {
      state: string;
      reason: string;
      humanText: string;
      issue?: number;
      startedAt?: string;
    },
  ): Promise<void> {
    const data: LoopStatusData = {
      epic: this.epicNumber,
      provider: this.provider.id,
      state: options.state,
      reason: options.reason,
      ...(options.issue !== undefined ? { issue: options.issue } : {}),
      ...(options.startedAt !== undefined
        ? { startedAt: options.startedAt }
        : {}),
    };
    const { marker, body } = buildStatusComment(data, options.humanText);
    await this.repository.upsertStatusComment(targetIssue, marker, body);
  }

  private runningResult(
    outcome: ActionOutcome,
    reasonCode: string,
    issue: SubIssue,
  ): OrchestratorResult {
    return {
      outcome,
      reasonCode,
      dryRun: this.dryRun,
      epicNumber: this.epicNumber,
      issueNumber: issue.number,
      details: [
        `Issue #${issue.number} is the active issue for epic #${this.epicNumber}.`,
      ],
    };
  }

  private noOp(reason: string): OrchestratorResult {
    return {
      outcome: 'no-op',
      reasonCode: reason,
      dryRun: this.dryRun,
      epicNumber: this.epicNumber,
      details: [],
    };
  }
}
