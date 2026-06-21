/**
 * Sanitized repository API errors.
 *
 * Transport failures must never leak raw API response bodies, credentials, or
 * authorization headers into user-facing messages or logs. The adapter wraps
 * every GitHub call and converts any failure into a {@link RepositoryApiError}
 * whose message is derived only from the operation name and a coarse,
 * status-based category.
 */

/**
 * A coarse classification of a GitHub API failure, derived from the HTTP status
 * code without exposing any response content.
 */
export type RepositoryErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'validation'
  | 'unavailable'
  | 'unknown';

/**
 * An error raised when a repository operation fails. Its message contains only
 * the operation name and a generic, status-based reason — never raw bodies,
 * tokens, or headers.
 */
export class RepositoryApiError extends Error {
  readonly operation: string;
  readonly code: RepositoryErrorCode;
  readonly status: number | null;

  constructor(
    operation: string,
    code: RepositoryErrorCode,
    status: number | null,
  ) {
    super(
      `GitHub API request failed during ${operation}: ${describe(code, status)}.`,
    );
    this.name = 'RepositoryApiError';
    this.operation = operation;
    this.code = code;
    this.status = status;
  }
}

function describe(code: RepositoryErrorCode, status: number | null): string {
  const suffix = status === null ? '' : ` (HTTP ${status})`;
  switch (code) {
    case 'unauthorized':
      return `authentication failed${suffix}`;
    case 'forbidden':
      return `access is forbidden${suffix}`;
    case 'not-found':
      return `the resource was not found${suffix}`;
    case 'rate-limited':
      return `the request was rate limited${suffix}`;
    case 'validation':
      return `the request was rejected as invalid${suffix}`;
    case 'unavailable':
      return `the service is unavailable${suffix}`;
    default:
      return `an unexpected error occurred${suffix}`;
  }
}

/**
 * An error raised when the epic body references a sub-issue in another
 * repository. Cross-repository references are rejected in v1. The message is
 * safe to surface: it contains no API response content.
 */
export class CrossRepositoryReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrossRepositoryReferenceError';
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

function codeForStatus(status: number | null): RepositoryErrorCode {
  if (status === null) {
    return 'unknown';
  }
  if (status === 401) {
    return 'unauthorized';
  }
  if (status === 403 || status === 429) {
    // GitHub uses 403 for both forbidden and secondary rate limits.
    return status === 429 ? 'rate-limited' : 'forbidden';
  }
  if (status === 404) {
    return 'not-found';
  }
  if (status === 422) {
    return 'validation';
  }
  if (status >= 500) {
    return 'unavailable';
  }
  return 'unknown';
}

/**
 * Convert an arbitrary thrown value into a {@link RepositoryApiError} that is
 * safe to surface to users. Existing {@link RepositoryApiError}s pass through
 * unchanged.
 */
export function sanitizeError(
  operation: string,
  error: unknown,
): RepositoryApiError {
  if (error instanceof RepositoryApiError) {
    return error;
  }
  const status = statusOf(error);
  return new RepositoryApiError(operation, codeForStatus(status), status);
}
