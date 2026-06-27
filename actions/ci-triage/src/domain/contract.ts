/**
 * CI Triage public contract.
 *
 * This module defines the stable, machine-readable vocabulary the action
 * reports to its caller: the coarse-grained {@link TriageOutcome} values, the
 * {@link PullRequestMode} the caller may request, and the
 * {@link TriageReasonCode} values that explain an outcome. It intentionally
 * exports only types and constants; no workflow-run resolution, prompt
 * generation, or Agent Tasks behavior is implemented here.
 */

/**
 * The set of outcomes the action can report.
 *
 * - `started`: a new Agent Tasks task was started for the failed run.
 * - `duplicate`: an in-flight or completed task already covers the failed run;
 *   no new task was started.
 * - `ignored`: the triggering event or run did not warrant triage; no-op.
 * - `needs-human`: triage cannot proceed safely and requires human attention.
 * - `dry-run`: evaluation only; no Agent Tasks writes or pull-request mutations
 *   were performed.
 * - `configuration-error`: an input was missing, invalid, or out of range.
 *   Fails closed.
 * - `operational-error`: an unexpected runtime or provider failure occurred.
 */
export const TRIAGE_OUTCOMES = [
  'started',
  'duplicate',
  'ignored',
  'needs-human',
  'dry-run',
  'configuration-error',
  'operational-error',
] as const;

export type TriageOutcome = (typeof TRIAGE_OUTCOMES)[number];

/**
 * How the fix pull request is resolved.
 *
 * - `auto`: reuse an existing fix pull request when present, otherwise open a
 *   new one.
 * - `existing`: only reuse an existing fix pull request; never open a new one.
 * - `new`: always open a new fix pull request.
 */
export const PULL_REQUEST_MODES = ['auto', 'existing', 'new'] as const;

export type PullRequestMode = (typeof PULL_REQUEST_MODES)[number];

/**
 * Stable, machine-readable reason codes explaining a {@link TriageOutcome}.
 *
 * These codes form part of the public contract and are safe to branch on. Only
 * a subset is emitted by the current entry point; the remainder reserve stable
 * vocabulary for the resolver and Agent Tasks behavior added in later versions.
 *
 * - `invalid-input`: one or more inputs failed validation (configuration-error).
 * - `orchestration-not-implemented`: inputs were valid but triage orchestration
 *   is not yet implemented in this version (operational-error).
 * - `dry-run-preview`: a dry run reported what would happen without writes
 *   (dry-run).
 * - `task-started`: a new Agent Tasks task was started (started).
 * - `task-already-exists`: an existing task already covers the run (duplicate).
 * - `not-a-failed-run`: the triggering run did not fail, so triage was skipped
 *   (ignored).
 * - `unsupported-event`: the triggering event is not a triagable workflow run
 *   (ignored).
 * - `ambiguous-pull-request`: more than one candidate fix pull request matched
 *   (needs-human).
 * - `pull-request-not-found`: `existing` mode found no fix pull request to reuse
 *   (needs-human).
 * - `agent-tasks-unavailable`: the Agent Tasks API could not be reached or
 *   rejected the request (operational-error).
 */
export const TRIAGE_REASON_CODES = [
  'invalid-input',
  'orchestration-not-implemented',
  'dry-run-preview',
  'task-started',
  'task-already-exists',
  'not-a-failed-run',
  'unsupported-event',
  'ambiguous-pull-request',
  'pull-request-not-found',
  'agent-tasks-unavailable',
] as const;

export type TriageReasonCode = (typeof TRIAGE_REASON_CODES)[number];
