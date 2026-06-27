import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';

import {
  GitHubAgentTasksProvider,
  OctokitAgentTasksTransport,
} from './adapters/agent-tasks/index.js';
import { OctokitTriageGitHubApi } from './adapters/github/index.js';
import type { TriageEvent } from './adapters/github/index.js';
import { executeAction, type ActionEnvironment } from './action/index.js';

/**
 * Build the normalized triage event from the GitHub Actions context.
 *
 * The resolver refetches the failed run authoritatively, so only the event name,
 * its action, and the failed run id are taken from the payload here; everything
 * else is re-read from the run itself and never executed as code.
 */
function resolveEvent(): TriageEvent {
  const workflowRun = context.payload.workflow_run as
    { readonly id?: number } | undefined;
  return {
    name: context.eventName,
    ...(typeof context.payload.action === 'string'
      ? { action: context.payload.action }
      : {}),
    ...(typeof workflowRun?.id === 'number'
      ? { workflowRunId: workflowRun.id }
      : {}),
  };
}

/**
 * Runs the CI Triage action.
 *
 * Binds the real GitHub Actions toolkit and Octokit transports to the action
 * composition root. The repository token drives the read-only workflow-run and
 * pull-request reads; the dedicated agent token drives the Copilot Agent Tasks
 * provider. The two credentials are never interchanged.
 */
export async function run(): Promise<void> {
  const { owner, repo } = context.repo;

  const env: ActionEnvironment = {
    core,
    repository: `${owner}/${repo}`,
    event: resolveEvent(),
    buildTriageApi: (token) =>
      new OctokitTriageGitHubApi({ octokit: getOctokit(token), owner, repo }),
    buildAgentTasksProvider: (token) =>
      new GitHubAgentTasksProvider({
        transport: new OctokitAgentTasksTransport({
          octokit: getOctokit(token),
          owner,
          repo,
        }),
      }),
  };

  await executeAction(env);
}
