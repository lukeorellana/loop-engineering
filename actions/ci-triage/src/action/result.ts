/**
 * The structured outcome of a triage iteration.
 *
 * Every field other than {@link TriageResult.outcome},
 * {@link TriageResult.reasonCode}, and {@link TriageResult.details} is optional
 * and maps to one action output. Optional fields are emitted as empty strings
 * when they do not apply, so consumers can branch on a stable, complete output
 * set regardless of outcome.
 */

import type {
  PullRequestMode,
  TriageOutcome,
  TriageReasonCode,
} from '../domain/index.js';

export interface TriageResult {
  /** The coarse-grained outcome. */
  readonly outcome: TriageOutcome;
  /** A stable, machine-readable reason code. */
  readonly reasonCode: TriageReasonCode;
  /** When `true`, the iteration was strictly read-only (no writes). */
  readonly dryRun: boolean;
  /** The Agent Tasks task identifier, when a task was started or reused. */
  readonly taskId?: string;
  /** The Agent Tasks task URL, when a task was started or reused. */
  readonly taskUrl?: string;
  /** The failed workflow run id the triage acted on, when resolved. */
  readonly workflowRunId?: number;
  /** The failed workflow run attempt the triage acted on, when resolved. */
  readonly workflowRunAttempt?: number;
  /** The pull-request mode actually applied, when resolved. */
  readonly resolvedMode?: PullRequestMode;
  /** The base ref the fix pull request targets, when resolved. */
  readonly targetBaseRef?: string;
  /** The head ref of the fix pull request, when resolved. */
  readonly targetHeadRef?: string;
  /** The reused existing fix pull-request number, when one applied. */
  readonly existingPrNumber?: number;
  /**
   * Summary-only fields below carry safe operational metadata for the step
   * summary. They are never published as outputs and never include secrets,
   * prompt text, or untrusted context.
   */
  /** The failed workflow's name, when resolved. */
  readonly workflowName?: string;
  /** The failed workflow run's HTML URL, when resolved. */
  readonly workflowRunUrl?: string;
  /**
   * Whether a model override was supplied. This records only that an override
   * was requested, never that GitHub accepted it.
   */
  readonly modelOverrideProvided?: boolean;
  /** Whether optional history was included when building the prompt. */
  readonly historyIncluded?: boolean;
  /** Whether some optional previous-attempt history could not be retrieved. */
  readonly historyUnavailable?: boolean;
  /** Whether optional additional context was included when building the prompt. */
  readonly additionalContextIncluded?: boolean;
  /** Whether any prompt section was truncated to fit its size limit. */
  readonly promptTruncated?: boolean;
  /** Sanitized, human-readable diagnostics safe to surface anywhere. */
  readonly details: readonly string[];
}
