/**
 * The GitHub triage target resolver.
 *
 * {@link resolveTriageTarget} turns a `workflow_run: completed` delivery into the
 * exact base and head refs (and existing pull request, when reused) Copilot
 * should modify, or a fail-closed `ignored`/`needs-human` result that performs
 * no write. It refetches the failed run before acting, reads only failed-run
 * metadata (never the triage workflow's own ref and SHA), and never checks out
 * or executes failed-branch code.
 *
 * Delivery targets, by triggering event and requested mode:
 *
 * - PR + `auto`/`existing`: update the existing pull request using its base and
 *   head refs.
 * - PR + `new`: open a remediation pull request stacked on the original pull
 *   request's head branch.
 * - push + `auto`/`new`: open a remediation pull request targeting the failed
 *   branch.
 * - push + `existing`: `needs-human` (`existing-mode-requires-pull-request`).
 *
 * `auto` follows the triggering event — not merely whether a commit happens to
 * be associated with a pull request — and explicit `existing`/`new` requests are
 * never silently redirected.
 */

import type {
  CandidatePullRequest,
  FailedRunMetadata,
  PullRequestMode,
  TargetResolution,
} from '../../domain/index.js';
import {
  remediationBranchName,
  selectPullRequest,
} from '../../domain/index.js';
import type { TriageGitHubApi, TriageWorkflowRun } from './api.js';

/**
 * The triage triggering event, reduced to what the resolver needs: the event
 * name, its action, and the failed run id. Everything else is read
 * authoritatively by refetching the run.
 */
export interface TriageEvent {
  /** The GitHub event name; must be `workflow_run`. */
  readonly name: string;
  /** The event action; must be `completed`. */
  readonly action?: string;
  /** The failed workflow run id carried by the event payload. */
  readonly workflowRunId?: number;
}

function isPositiveInteger(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

async function resolveCandidatePullRequests(
  run: TriageWorkflowRun,
  api: TriageGitHubApi,
): Promise<readonly CandidatePullRequest[]> {
  // Resolve from workflow-run metadata first.
  if (run.pullRequestNumbers.length > 0) {
    const pulls = await Promise.all(
      run.pullRequestNumbers.map((number) => api.getPullRequest(number)),
    );
    return pulls.filter((pull): pull is CandidatePullRequest => pull !== null);
  }
  // No clearly attached pull request: query pull requests for the failed commit.
  return api.listPullRequestsForCommit(run.headSha);
}

function resolvePullRequestTarget(
  pullRequest: CandidatePullRequest,
  mode: PullRequestMode,
  metadata: FailedRunMetadata,
): TargetResolution {
  if (mode === 'new') {
    return {
      status: 'resolved',
      action: 'create-stacked-pull-request',
      resolvedMode: 'new',
      metadata,
      targetBaseRef: pullRequest.headRef,
      targetHeadRef: remediationBranchName(pullRequest.headRef),
    };
  }
  // `auto` and `existing` both update the existing pull request in place.
  return {
    status: 'resolved',
    action: 'update-existing-pull-request',
    resolvedMode: 'existing',
    metadata,
    targetBaseRef: pullRequest.baseRef,
    targetHeadRef: pullRequest.headRef,
    existingPullRequestNumber: pullRequest.number,
  };
}

/**
 * Resolve the failed run into a delivery target, or a fail-closed no-op.
 *
 * The resolution order is: validate the event is a completed, failed
 * `workflow_run`; refetch the run; confirm a supported triggering event; resolve
 * the pull request or branch; guard against a stale run; and only then emit the
 * refs to write.
 */
export async function resolveTriageTarget(
  event: TriageEvent,
  mode: PullRequestMode,
  api: TriageGitHubApi,
): Promise<TargetResolution> {
  if (event.name !== 'workflow_run') {
    return { status: 'ignored', reason: 'not-a-workflow-run-event' };
  }
  if (event.action !== 'completed') {
    return { status: 'ignored', reason: 'workflow-run-not-completed' };
  }
  if (!isPositiveInteger(event.workflowRunId)) {
    return { status: 'ignored', reason: 'not-a-workflow-run-event' };
  }

  // Refetch the failed run; never trust the triage event payload.
  const run = await api.getWorkflowRun(event.workflowRunId);
  if (run === null || run.status !== 'completed') {
    return { status: 'ignored', reason: 'workflow-run-not-completed' };
  }
  if (run.conclusion !== 'failure') {
    return { status: 'ignored', reason: 'workflow-run-not-failed' };
  }
  if (run.event !== 'pull_request' && run.event !== 'push') {
    return { status: 'ignored', reason: 'unsupported-triggering-event' };
  }
  if (run.headBranch === null || run.headBranch === '') {
    return { status: 'needs-human', reason: 'target-branch-not-found' };
  }

  const metadata: FailedRunMetadata = {
    workflowName: run.name,
    workflowRunId: run.id,
    workflowRunAttempt: run.runAttempt,
    workflowRunUrl: run.htmlUrl,
    triggeringEvent: run.event,
    headBranch: run.headBranch,
    headSha: run.headSha,
  };

  if (run.event === 'pull_request') {
    const candidates = await resolveCandidatePullRequests(run, api);
    const selection = selectPullRequest(
      candidates,
      run.headBranch,
      run.headSha,
    );
    if (!selection.ok) {
      return { status: 'needs-human', reason: selection.reason, metadata };
    }
    // Stale-run protection: the pull request must still point to the failed SHA.
    if (selection.pullRequest.headSha !== run.headSha) {
      return { status: 'ignored', reason: 'stale-workflow-run', metadata };
    }
    return resolvePullRequestTarget(selection.pullRequest, mode, metadata);
  }

  // Push-triggered run.
  if (mode === 'existing') {
    return {
      status: 'needs-human',
      reason: 'existing-mode-requires-pull-request',
      metadata,
    };
  }
  const branchSha = await api.getBranchHeadSha(run.headBranch);
  if (branchSha === null) {
    return {
      status: 'needs-human',
      reason: 'target-branch-not-found',
      metadata,
    };
  }
  // Stale-run protection: the branch must still point to the failed SHA.
  if (branchSha !== run.headSha) {
    return { status: 'ignored', reason: 'stale-workflow-run', metadata };
  }
  return {
    status: 'resolved',
    action: 'create-remediation-pull-request',
    resolvedMode: 'new',
    metadata,
    targetBaseRef: run.headBranch,
    targetHeadRef: remediationBranchName(run.headBranch),
  };
}
