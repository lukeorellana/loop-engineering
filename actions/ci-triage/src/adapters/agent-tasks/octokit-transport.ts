/**
 * Octokit-backed implementation of the narrow {@link AgentTasksTransport}.
 *
 * This composition-layer binding is the only place in the Agent Tasks stack that
 * depends on Octokit and on the concrete preview endpoint. It is constructed with
 * the dedicated `agent-token`, kept separate from the repository token, pins the
 * documented API version header, and targets the isolated preview path from
 * {@link ./endpoint.ts}.
 *
 * The provider sanitizes every failure before it reaches a log or the step
 * summary, so this transport performs no logging and surfaces raw transport
 * errors (which carry a numeric `status`) to its caller. It never sets, logs, or
 * echoes the authorization header.
 */

import type { getOctokit } from '@actions/github';

import type { AgentTaskRequestBody, AgentTasksTransport } from './api.js';
import {
  AGENT_TASKS_API_VERSION,
  AGENT_TASKS_CREATE_METHOD,
  agentTasksCreatePath,
} from './endpoint.js';

/** The authenticated client surface this transport depends on. */
export type OctokitClient = ReturnType<typeof getOctokit>;

/** Construction options for {@link OctokitAgentTasksTransport}. */
export interface OctokitAgentTasksTransportOptions {
  readonly octokit: OctokitClient;
  readonly owner: string;
  readonly repo: string;
}

export class OctokitAgentTasksTransport implements AgentTasksTransport {
  private readonly octokit: OctokitClient;
  private readonly owner: string;
  private readonly repo: string;

  constructor(options: OctokitAgentTasksTransportOptions) {
    this.octokit = options.octokit;
    this.owner = options.owner;
    this.repo = options.repo;
  }

  async createTask(body: AgentTaskRequestBody): Promise<unknown> {
    const path = agentTasksCreatePath(this.owner, this.repo);
    const response = await this.octokit.request(
      `${AGENT_TASKS_CREATE_METHOD} ${path}`,
      {
        ...body,
        headers: { 'X-GitHub-Api-Version': AGENT_TASKS_API_VERSION },
      },
    );
    return response.data;
  }
}
