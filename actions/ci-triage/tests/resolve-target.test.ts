import { describe, expect, it } from 'vitest';

import {
  resolveTriageTarget,
  type TriageEvent,
  type TriageWorkflowRun,
} from '../src/adapters/github/index.js';
import type {
  CandidatePullRequest,
  PullRequestMode,
} from '../src/domain/index.js';
import { FakeTriageGitHubApi } from './helpers/fake-triage-api.js';

const RUN_ID = 4242;
const HEAD_SHA = 'a'.repeat(40);
const HEAD_BRANCH = 'feature/login';

function makeRun(
  overrides: Partial<TriageWorkflowRun> = {},
): TriageWorkflowRun {
  return {
    id: RUN_ID,
    name: 'CI',
    runAttempt: 2,
    htmlUrl: `https://github.com/acme/app/actions/runs/${RUN_ID}`,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    pullRequestNumbers: [],
    ...overrides,
  };
}

function makePr(
  overrides: Partial<CandidatePullRequest> = {},
): CandidatePullRequest {
  return {
    number: 7,
    state: 'open',
    isFork: false,
    baseRef: 'main',
    headRef: HEAD_BRANCH,
    headSha: HEAD_SHA,
    ...overrides,
  };
}

const COMPLETED_EVENT: TriageEvent = {
  name: 'workflow_run',
  action: 'completed',
  workflowRunId: RUN_ID,
};

function resolve(
  mode: PullRequestMode,
  api: FakeTriageGitHubApi,
  event: TriageEvent = COMPLETED_EVENT,
) {
  return resolveTriageTarget(event, mode, api);
}

const READ_ONLY_OPS = new Set([
  'getWorkflowRun',
  'getPullRequest',
  'listPullRequestsForCommit',
  'getBranchHeadSha',
]);

function assertNoWrites(api: FakeTriageGitHubApi): void {
  for (const call of api.calls) {
    expect(READ_ONLY_OPS.has(call.op)).toBe(true);
  }
}

describe('resolveTriageTarget — event gating', () => {
  it('ignores a non-workflow_run event', async () => {
    const api = new FakeTriageGitHubApi();
    const result = await resolve('auto', api, {
      name: 'push',
      action: 'completed',
      workflowRunId: RUN_ID,
    });
    expect(result).toEqual({
      status: 'ignored',
      reason: 'not-a-workflow-run-event',
    });
    expect(api.calls).toHaveLength(0);
  });

  it('ignores a non-completed workflow_run action', async () => {
    const api = new FakeTriageGitHubApi();
    const result = await resolve('auto', api, {
      name: 'workflow_run',
      action: 'requested',
      workflowRunId: RUN_ID,
    });
    expect(result).toEqual({
      status: 'ignored',
      reason: 'workflow-run-not-completed',
    });
  });

  it('ignores an event with no usable run id', async () => {
    const api = new FakeTriageGitHubApi();
    const result = await resolve('auto', api, {
      name: 'workflow_run',
      action: 'completed',
    });
    expect(result).toEqual({
      status: 'ignored',
      reason: 'not-a-workflow-run-event',
    });
  });
});

describe('resolveTriageTarget — refetched run state', () => {
  it('ignores a run that no longer exists', async () => {
    const api = new FakeTriageGitHubApi({ workflowRuns: {} });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({
      status: 'ignored',
      reason: 'workflow-run-not-completed',
    });
    expect(api.calls[0]).toEqual({ op: 'getWorkflowRun', args: [RUN_ID] });
  });

  it('ignores a run that refetches as not completed', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ status: 'in_progress' }) },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({ reason: 'workflow-run-not-completed' });
  });

  it('ignores a run that did not fail', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ conclusion: 'success' }) },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({ reason: 'workflow-run-not-failed' });
  });

  it('ignores an unsupported triggering event', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ event: 'schedule' }) },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({ reason: 'unsupported-triggering-event' });
  });

  it('fails closed when the run has no head branch (for example a tag)', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ event: 'push', headBranch: null }) },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: 'target-branch-not-found',
    });
  });

  it('uses failed-run metadata rather than the event payload', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: {
        [RUN_ID]: makeRun({
          pullRequestNumbers: [7],
          name: 'Build & Test',
          runAttempt: 5,
        }),
      },
      pullRequests: { 7: makePr() },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({
      status: 'resolved',
      metadata: {
        workflowName: 'Build & Test',
        workflowRunId: RUN_ID,
        workflowRunAttempt: 5,
        triggeringEvent: 'pull_request',
        headBranch: HEAD_BRANCH,
        headSha: HEAD_SHA,
      },
    });
  });
});

describe('resolveTriageTarget — pull-request modes', () => {
  it('PR + auto updates the existing pull request', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ pullRequestNumbers: [7] }) },
      pullRequests: { 7: makePr({ baseRef: 'main', headRef: HEAD_BRANCH }) },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({
      status: 'resolved',
      action: 'update-existing-pull-request',
      resolvedMode: 'existing',
      targetBaseRef: 'main',
      targetHeadRef: HEAD_BRANCH,
      existingPullRequestNumber: 7,
    });
  });

  it('PR + existing updates the existing pull request', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ pullRequestNumbers: [7] }) },
      pullRequests: { 7: makePr() },
    });
    const result = await resolve('existing', api);
    expect(result).toMatchObject({
      resolvedMode: 'existing',
      existingPullRequestNumber: 7,
    });
  });

  it('PR + new creates a stacked pull request and leaves the PR number empty', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ pullRequestNumbers: [7] }) },
      pullRequests: { 7: makePr({ headRef: HEAD_BRANCH }) },
    });
    const result = await resolve('new', api);
    expect(result).toMatchObject({
      status: 'resolved',
      action: 'create-stacked-pull-request',
      resolvedMode: 'new',
      targetBaseRef: HEAD_BRANCH,
      targetHeadRef: `ci-triage/${HEAD_BRANCH}`,
    });
    expect(result).not.toHaveProperty('existingPullRequestNumber');
  });

  it('resolves a PR from the failed commit when none is attached', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ pullRequestNumbers: [] }) },
      pullRequestsForCommit: { [HEAD_SHA]: [makePr({ number: 9 })] },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({
      status: 'resolved',
      existingPullRequestNumber: 9,
    });
    expect(
      api.calls.some((call) => call.op === 'listPullRequestsForCommit'),
    ).toBe(true);
  });

  it('matches a pull request by head SHA after a branch rename', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ pullRequestNumbers: [7] }) },
      pullRequests: {
        7: makePr({ headRef: 'renamed-branch', headSha: HEAD_SHA }),
      },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({ status: 'resolved' });
  });
});

describe('resolveTriageTarget — pull-request fail-closed paths', () => {
  it('needs human when no pull request matches', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ pullRequestNumbers: [] }) },
      pullRequestsForCommit: { [HEAD_SHA]: [] },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: 'pull-request-not-found',
    });
    assertNoWrites(api);
  });

  it('needs human when multiple open same-repository pull requests match', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ pullRequestNumbers: [7, 8] }) },
      pullRequests: {
        7: makePr({ number: 7 }),
        8: makePr({ number: 8 }),
      },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({ reason: 'pull-request-ambiguous' });
    assertNoWrites(api);
  });

  it('needs human when the only matching pull request is closed', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ pullRequestNumbers: [7] }) },
      pullRequests: { 7: makePr({ state: 'closed' }) },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({ reason: 'pull-request-closed' });
    assertNoWrites(api);
  });

  it('needs human when the matching pull request comes from a fork', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ pullRequestNumbers: [] }) },
      pullRequestsForCommit: { [HEAD_SHA]: [makePr({ isFork: true })] },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({ reason: 'fork-pull-request' });
    assertNoWrites(api);
  });

  it('ignores a stale PR run whose pull request advanced past the failed SHA', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ pullRequestNumbers: [7] }) },
      pullRequests: {
        7: makePr({ headRef: HEAD_BRANCH, headSha: 'b'.repeat(40) }),
      },
    });
    const result = await resolve('auto', api);
    expect(result).toMatchObject({
      status: 'ignored',
      reason: 'stale-workflow-run',
    });
    assertNoWrites(api);
  });
});

describe('resolveTriageTarget — push modes', () => {
  function pushApi(branchSha: string | null): FakeTriageGitHubApi {
    return new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ event: 'push' }) },
      branchHeads: branchSha === null ? {} : { [HEAD_BRANCH]: branchSha },
    });
  }

  it('push + auto creates a remediation pull request on the failed branch', async () => {
    const api = pushApi(HEAD_SHA);
    const result = await resolve('auto', api);
    expect(result).toMatchObject({
      status: 'resolved',
      action: 'create-remediation-pull-request',
      resolvedMode: 'new',
      targetBaseRef: HEAD_BRANCH,
      targetHeadRef: `ci-triage/${HEAD_BRANCH}`,
    });
    expect(result).not.toHaveProperty('existingPullRequestNumber');
  });

  it('push + new creates a remediation pull request on the failed branch', async () => {
    const api = pushApi(HEAD_SHA);
    const result = await resolve('new', api);
    expect(result).toMatchObject({
      action: 'create-remediation-pull-request',
      resolvedMode: 'new',
    });
  });

  it('push + existing needs a human because there is no pull request to reuse', async () => {
    const api = pushApi(HEAD_SHA);
    const result = await resolve('existing', api);
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: 'existing-mode-requires-pull-request',
    });
    assertNoWrites(api);
  });

  it('fails closed when the failed branch no longer exists', async () => {
    const api = pushApi(null);
    const result = await resolve('auto', api);
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: 'target-branch-not-found',
    });
    assertNoWrites(api);
  });

  it('ignores a stale push run whose branch advanced past the failed SHA', async () => {
    const api = pushApi('c'.repeat(40));
    const result = await resolve('auto', api);
    expect(result).toMatchObject({
      status: 'ignored',
      reason: 'stale-workflow-run',
    });
    assertNoWrites(api);
  });
});

describe('resolveTriageTarget — explicit modes are never redirected', () => {
  it('keeps existing mode on a PR run (returns the PR number)', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ pullRequestNumbers: [7] }) },
      pullRequests: { 7: makePr() },
    });
    const result = await resolve('existing', api);
    expect(result).toMatchObject({
      resolvedMode: 'existing',
      existingPullRequestNumber: 7,
    });
  });

  it('keeps new mode on a PR run (leaves the PR number empty)', async () => {
    const api = new FakeTriageGitHubApi({
      workflowRuns: { [RUN_ID]: makeRun({ pullRequestNumbers: [7] }) },
      pullRequests: { 7: makePr() },
    });
    const result = await resolve('new', api);
    expect(result).toMatchObject({ resolvedMode: 'new' });
    expect(result).not.toHaveProperty('existingPullRequestNumber');
  });
});
