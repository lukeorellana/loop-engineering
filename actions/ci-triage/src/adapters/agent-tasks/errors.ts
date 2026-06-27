/**
 * Sanitized Agent Tasks provider errors and stable failure classification.
 *
 * Agent Tasks API failures must never leak authorization headers, raw response
 * bodies (which may echo prompt content), or credentials into messages, logs, or
 * the step summary. Every transport failure is converted into an
 * {@link AgentTasksError} whose message is derived only from a coarse,
 * status-based {@link AgentTasksFailureReason} — never from raw response
 * content.
 *
 * The classification is intentionally stable: each HTTP status maps to exactly
 * one reason code, so consumers can branch on a documented vocabulary. Credential
 * and request-validation failures (including an invalid model) are reported as
 * configuration problems with no silent fallback; rate-limit, transient, and
 * malformed-response failures are operational.
 */

import type { TriageReasonCode } from '../../domain/index.js';

/**
 * The stable Agent Tasks failure reasons, a subset of {@link TriageReasonCode}.
 */
export type AgentTasksFailureReason = Extract<
  TriageReasonCode,
  | 'agent-auth-failed'
  | 'agent-forbidden'
  | 'agent-unsupported'
  | 'agent-invalid-request'
  | 'agent-rate-limited'
  | 'agent-transient'
  | 'agent-unexpected-response'
>;

/**
 * An error raised when an Agent Tasks provider operation fails. Its message
 * contains only a generic, reason-based description — never raw bodies, tokens,
 * or headers. Transports (and the provider) may throw this directly to signal a
 * specific {@link AgentTasksFailureReason}.
 */
export class AgentTasksError extends Error {
  readonly reason: AgentTasksFailureReason;
  readonly status: number | null;

  constructor(reason: AgentTasksFailureReason, status: number | null = null) {
    super(`Agent Tasks request failed: ${describe(reason)}.`);
    this.name = 'AgentTasksError';
    this.reason = reason;
    this.status = status;
  }
}

function describe(reason: AgentTasksFailureReason): string {
  switch (reason) {
    case 'agent-auth-failed':
      return 'the agent-token is missing or invalid';
    case 'agent-forbidden':
      return 'the agent-token is not authorized to start Agent Tasks';
    case 'agent-unsupported':
      return 'Agent Tasks is unavailable for this credential, plan, or API preview';
    case 'agent-invalid-request':
      return 'the Agent Tasks request was rejected as invalid (for example an unsupported model)';
    case 'agent-rate-limited':
      return 'the Agent Tasks API rate-limited the request';
    case 'agent-transient':
      return 'a transient server or network error occurred';
    case 'agent-unexpected-response':
      return 'the Agent Tasks API returned an unexpected response';
    default:
      return 'an unexpected error occurred';
  }
}

function statusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return null;
}

/**
 * Map an HTTP status (or `null` for a network failure) to a stable failure
 * reason. The mapping is exhaustive and deterministic so the same status always
 * yields the same reason code.
 */
export function classifyAgentTasksStatus(
  status: number | null,
): AgentTasksFailureReason {
  if (status === null) {
    // No HTTP response at all: a network/transport failure is transient.
    return 'agent-transient';
  }
  if (status === 401) {
    return 'agent-auth-failed';
  }
  if (status === 403) {
    return 'agent-forbidden';
  }
  if (status === 404 || status === 415 || status === 501) {
    // Missing preview surface, unsupported media/credential type, or an API the
    // plan does not include: Agent Tasks is not available here.
    return 'agent-unsupported';
  }
  if (status === 429) {
    return 'agent-rate-limited';
  }
  if (status >= 500) {
    return 'agent-transient';
  }
  if (status >= 400) {
    // Any other 4xx (400, 422, ...) is a request the server rejected as invalid,
    // including an unsupported model. Never silently retry without the model.
    return 'agent-invalid-request';
  }
  // A non-error status that nonetheless could not be mapped to a task.
  return 'agent-unexpected-response';
}

/**
 * Convert an arbitrary thrown value into an {@link AgentTasksError} that is safe
 * to surface. Existing {@link AgentTasksError}s pass through unchanged so the
 * provider can signal a precise reason (for example `agent-unexpected-response`
 * for a malformed but successful response).
 */
export function sanitizeAgentTasksError(error: unknown): AgentTasksError {
  if (error instanceof AgentTasksError) {
    return error;
  }
  const status = statusOf(error);
  return new AgentTasksError(classifyAgentTasksStatus(status), status);
}
