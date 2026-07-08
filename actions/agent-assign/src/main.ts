import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';

import { OctokitAgentAssignGitHubApi } from './adapters/github/octokit-api.js';
import { executeAction, type ActionEnvironment } from './action/run.js';

function resolveIssueNumber(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const issue = (payload as { issue?: { number?: unknown } }).issue;
  return typeof issue?.number === 'number' ? issue.number : undefined;
}

export async function run(): Promise<void> {
  const { owner, repo } = context.repo;
  const issueNumber = resolveIssueNumber(context.payload);

  const env: ActionEnvironment = {
    core,
    issueNumber,
    buildApi: (token) =>
      new OctokitAgentAssignGitHubApi(getOctokit(token), owner, repo),
  };

  await executeAction(env);
}
