/**
 * Pure resolution of the failed run's delivery target.
 *
 * This module holds the *pure*, I/O-free vocabulary and decisions the GitHub
 * triage adapter needs to answer one question: given an authoritative failed
 * workflow run, the requested {@link PullRequestMode}, and the pull requests and
 * branches GitHub reports, which exact base and head refs (and which existing
 * pull request, if any) should Copilot modify?
 *
 * Everything here is fully determined by its inputs, so the fail-closed rules —
 * fork pull requests, missing matches, ambiguous matches, closed pull requests,
 * missing branches, and stale runs — are exhaustively testable with fixtures.
 * The adapter ({@link ../adapters/github/resolve-target.ts}) supplies the data
 * by refetching the run and querying the GitHub API; it never checks out or
 * executes failed-branch code.
 */

import type { PullRequestMode, TriageReasonCode } from './contract.js';

/**
 * The triggering events the resolver supports in v1. A failed run triggered by
 * anything else resolves to `unsupported-triggering-event`.
 */
export const SUPPORTED_TRIGGERING_EVENTS = ['pull_request', 'push'] as const;

export type TriggeringEvent = (typeof SUPPORTED_TRIGGERING_EVENTS)[number];

/**
 * The authoritative metadata the resolver reads from the *refetched* failed
 * workflow run. It is derived from the failed run itself, never from the triage
 * workflow's own ref and SHA.
 */
export interface FailedRunMetadata {
  /** The failed workflow's name. */
  readonly workflowName: string;
  /** The failed workflow run id. */
  readonly workflowRunId: number;
  /** The failed workflow run attempt. */
  readonly workflowRunAttempt: number;
  /** The failed workflow run URL. */
  readonly workflowRunUrl: string;
  /** The event that triggered the failed run. */
  readonly triggeringEvent: TriggeringEvent;
  /** The failed run's head branch. */
  readonly headBranch: string;
  /** The failed run's head SHA. */
  readonly headSha: string;
}

/**
 * The concrete write the adapter should perform once a target is resolved.
 *
 * - `update-existing-pull-request`: reuse an open pull request, pushing the fix
 *   to its head branch (PR-triggered `auto`/`existing`).
 * - `create-stacked-pull-request`: open a remediation pull request stacked on
 *   the original pull request's head branch (PR-triggered `new`).
 * - `create-remediation-pull-request`: open a remediation pull request that
 *   targets the failed branch (push-triggered `auto`/`new`).
 */
export type TargetAction =
  | 'update-existing-pull-request'
  | 'create-stacked-pull-request'
  | 'create-remediation-pull-request';

/** A reason a target resolution is `ignored` (a benign no-op, no write). */
export type IgnoredTargetReason = Extract<
  TriageReasonCode,
  | 'not-a-workflow-run-event'
  | 'workflow-run-not-completed'
  | 'workflow-run-not-failed'
  | 'unsupported-triggering-event'
  | 'stale-workflow-run'
>;

/**
 * A reason a target resolution fails closed and needs human attention (no
 * write).
 */
export type NeedsHumanTargetReason = Extract<
  TriageReasonCode,
  | 'pull-request-not-found'
  | 'pull-request-ambiguous'
  | 'pull-request-closed'
  | 'fork-pull-request'
  | 'existing-mode-requires-pull-request'
  | 'target-branch-not-found'
>;

/**
 * The result of resolving a failed run into a delivery target.
 *
 * Only a `resolved` result carries refs to write; `ignored` and `needs-human`
 * results perform no write. The failed-run {@link FailedRunMetadata} is attached
 * whenever it is known, so callers can surface the run id and attempt even when
 * no target was resolved.
 */
export type TargetResolution =
  | {
      readonly status: 'resolved';
      readonly action: TargetAction;
      /** The pull-request mode actually applied (`auto` resolves to one of these). */
      readonly resolvedMode: Exclude<PullRequestMode, 'auto'>;
      readonly metadata: FailedRunMetadata;
      readonly targetBaseRef: string;
      readonly targetHeadRef: string;
      /** Present only when reusing an existing pull request. */
      readonly existingPullRequestNumber?: number;
    }
  | {
      readonly status: 'ignored';
      readonly reason: IgnoredTargetReason;
      readonly metadata?: FailedRunMetadata;
    }
  | {
      readonly status: 'needs-human';
      readonly reason: NeedsHumanTargetReason;
      readonly metadata?: FailedRunMetadata;
    };

/**
 * The minimal pull-request shape the resolver reasons about. The adapter
 * normalizes GitHub's pull-request payloads into this shape; `isFork` is `true`
 * when the head branch lives in a different repository than the failed run.
 */
export interface CandidatePullRequest {
  readonly number: number;
  readonly state: 'open' | 'closed';
  readonly isFork: boolean;
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
}

/** The result of selecting exactly one usable pull request from candidates. */
export type PullRequestSelection =
  | { readonly ok: true; readonly pullRequest: CandidatePullRequest }
  | { readonly ok: false; readonly reason: NeedsHumanTargetReason };

function dedupeByNumber(
  pulls: readonly CandidatePullRequest[],
): readonly CandidatePullRequest[] {
  const seen = new Set<number>();
  const result: CandidatePullRequest[] = [];
  for (const pull of pulls) {
    if (!seen.has(pull.number)) {
      seen.add(pull.number);
      result.push(pull);
    }
  }
  return result;
}

/**
 * Select exactly one open, same-repository pull request matching the failed
 * run's head branch or SHA.
 *
 * Matching is by head branch *or* head SHA so a run is paired with its pull
 * request even when the branch was force-pushed between trigger and resolution.
 * The selection fails closed with a specific reason when zero, many, forked, or
 * only-closed pull requests match, so no write is ever attempted on an ambiguous
 * or untrusted target.
 */
export function selectPullRequest(
  candidates: readonly CandidatePullRequest[],
  headBranch: string,
  headSha: string,
): PullRequestSelection {
  const matching = dedupeByNumber(
    candidates.filter(
      (pull) => pull.headRef === headBranch || pull.headSha === headSha,
    ),
  );

  if (matching.length === 0) {
    return { ok: false, reason: 'pull-request-not-found' };
  }

  const openSameRepository = matching.filter(
    (pull) => pull.state === 'open' && !pull.isFork,
  );
  if (openSameRepository.length === 1) {
    return { ok: true, pullRequest: openSameRepository[0] };
  }
  if (openSameRepository.length > 1) {
    return { ok: false, reason: 'pull-request-ambiguous' };
  }

  // No clean open same-repository match: report the most specific cause.
  if (matching.some((pull) => pull.isFork)) {
    return { ok: false, reason: 'fork-pull-request' };
  }
  if (matching.some((pull) => pull.state === 'closed')) {
    return { ok: false, reason: 'pull-request-closed' };
  }
  return { ok: false, reason: 'pull-request-not-found' };
}

/**
 * The deterministic remediation branch name stacked on `baseRef`.
 *
 * The name is a pure function of the base ref, so re-triaging the same target
 * reuses the same head branch and the downstream write stays idempotent.
 */
export function remediationBranchName(baseRef: string): string {
  return `ci-triage/${baseRef}`;
}
