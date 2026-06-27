/**
 * Single source of truth for the public-preview Copilot Agent Tasks endpoint.
 *
 * The preview API path and the pinned GitHub API version live here and only
 * here, so the action can be repointed in one place if the preview surface
 * evolves (a new path, a new `X-GitHub-Api-Version`). Nothing outside the
 * agent-tasks transport should hard-code these values.
 */

/**
 * The documented GitHub REST API version sent as `X-GitHub-Api-Version`. Pinned
 * so a server-side default change never silently alters request handling.
 */
export const AGENT_TASKS_API_VERSION = '2022-11-28';

/** The HTTP method used to start an Agent Tasks task. */
export const AGENT_TASKS_CREATE_METHOD = 'POST';

/**
 * Build the create-task path for a repository. Centralized so the preview path
 * is defined exactly once.
 */
export function agentTasksCreatePath(owner: string, repo: string): string {
  return `/repos/${owner}/${repo}/copilot/agents`;
}
