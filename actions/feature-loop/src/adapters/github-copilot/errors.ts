/**
 * Sanitized Copilot provider errors.
 *
 * GraphQL failures must never leak raw response bodies, credentials, or
 * authorization headers into user-facing messages, logs, or issue comments. The
 * provider wraps every transport call and converts any failure into a
 * {@link CopilotProviderError} whose message is derived only from the operation
 * name and a coarse, status-based {@link AgentReasonCode} — never from raw
 * response content.
 */
import type { AgentReasonCode } from '../../domain/agent.js';

/**
 * An error raised when a Copilot provider operation fails. Its message contains
 * only the operation name and a generic, reason-based description — never raw
 * bodies, tokens, or headers. Transports may throw this directly to signal a
 * specific {@link AgentReasonCode} (for example `invalid-base-branch`).
 */
export class CopilotProviderError extends Error {
  readonly operation: string;
  readonly reason: AgentReasonCode;
  readonly status: number | null;

  constructor(
    operation: string,
    reason: AgentReasonCode,
    status: number | null = null,
  ) {
    super(
      `Copilot provider request failed during ${operation}: ${describe(reason)}.`,
    );
    this.name = 'CopilotProviderError';
    this.operation = operation;
    this.reason = reason;
    this.status = status;
  }
}

function describe(reason: AgentReasonCode): string {
  switch (reason) {
    case 'actor-not-found':
      return 'the Copilot coding agent is not available to this repository';
    case 'unauthenticated':
      return 'the agent-assignment credential is missing or invalid';
    case 'unauthorized':
      return 'the agent-assignment credential is not authorized to assign Copilot';
    case 'invalid-base-branch':
      return 'the configured base branch was rejected';
    case 'unavailable':
      return 'the service is temporarily unavailable';
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

function reasonForStatus(status: number | null): AgentReasonCode {
  if (status === null) {
    return 'unknown';
  }
  if (status === 401) {
    return 'unauthenticated';
  }
  if (status === 403) {
    return 'unauthorized';
  }
  if (status === 422) {
    // The base branch is the only user-controlled value in the assignment
    // mutation, so a validation rejection is reported as an invalid base branch.
    return 'invalid-base-branch';
  }
  if (status === 429 || status === 404 || status >= 500) {
    return 'unavailable';
  }
  return 'unknown';
}

/**
 * Convert an arbitrary thrown value into a {@link CopilotProviderError} that is
 * safe to surface. Existing {@link CopilotProviderError}s pass through unchanged
 * so transports can signal a precise {@link AgentReasonCode}.
 */
export function sanitizeCopilotError(
  operation: string,
  error: unknown,
): CopilotProviderError {
  if (error instanceof CopilotProviderError) {
    return error;
  }
  const status = statusOf(error);
  return new CopilotProviderError(operation, reasonForStatus(status), status);
}
