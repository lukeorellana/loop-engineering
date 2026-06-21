import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';

import { OctokitGitHubApi } from './adapters/github/index.js';
import { OctokitCopilotAgentApi } from './adapters/github-copilot/index.js';
import type { MergedPullRequest } from './domain/index.js';
import { systemClock } from './ports/clock.js';
import { executeAction, type ActionEnvironment } from './action/index.js';

/**
 * Build the normalized triggering event from the GitHub Actions context.
 *
 * Only a `pull_request` event carries a pull request; its body and closing
 * references are re-read from the repository by the controller, so the payload
 * here is a fallback and is never executed as code.
 */
function resolveEvent(): ActionEnvironment['event'] {
  const payloadPr = context.payload.pull_request;
  let pullRequest: MergedPullRequest | undefined;
  if (context.eventName === 'pull_request' && payloadPr !== undefined) {
    pullRequest = {
      number: payloadPr.number,
      merged: payloadPr.merged === true,
      mergedBy: payloadPr.merged_by?.login ?? undefined,
      baseRef: payloadPr.base?.ref ?? '',
      headRef: payloadPr.head?.ref ?? '',
      body: payloadPr.body ?? null,
      closingIssueReferences: [],
    };
  }
  return {
    eventName: context.eventName,
    ...(typeof context.payload.action === 'string'
      ? { action: context.payload.action }
      : {}),
    ...(pullRequest !== undefined ? { pullRequest } : {}),
  };
}

/**
 * Runs the Feature Loop action.
 *
 * Binds the real GitHub Actions toolkit and Octokit transports to the action
 * composition root and advances the epic by exactly one idempotent step. The
 * repository token drives repository reads and writes; the agent token (which
 * defaults to the repository token) drives coding-agent assignment.
 */
export async function run(): Promise<void> {
  const { owner, repo } = context.repo;

  const env: ActionEnvironment = {
    core,
    clock: systemClock,
    event: resolveEvent(),
    buildRepositoryApi: (token) =>
      new OctokitGitHubApi({ octokit: getOctokit(token), owner, repo }),
    buildAgentApi: (token) =>
      new OctokitCopilotAgentApi({ octokit: getOctokit(token), owner, repo }),
  };

  await executeAction(env);
}
