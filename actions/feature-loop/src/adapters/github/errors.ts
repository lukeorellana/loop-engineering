/**
 * Sanitized repository API errors.
 *
 * Transport failures must never leak raw API response bodies, credentials, or
 * authorization headers into user-facing messages or logs. The adapter wraps
 * every GitHub call and converts any failure into a {@link RepositoryApiError}
 * whose message is derived only from the operation name, a coarse category, and
 * a small allowlist of structured GraphQL metadata (the GraphQL error `type` and
 * extension `code`). REST failures are classified from the HTTP status; GraphQL
 * failures frequently carry no HTTP status, so they are additionally classified
 * from their safe `type`/`code` fields.
 */

/**
 * A coarse classification of a GitHub API failure, derived from the HTTP status
 * code (or a safe GraphQL error type) without exposing any response content.
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
 * The allowlisted, non-sensitive GraphQL error metadata retained for
 * observability. Only the stable `type` and extension `code` are kept; the
 * GraphQL error message, locations, path, and any response data are discarded so
 * no arbitrary server data can leak.
 */
export interface GraphQlErrorInfo {
  readonly type: string | null;
  readonly code: string | null;
}

/** Options carrying the additional, safe classification of a failure. */
export interface RepositoryApiErrorOptions {
  /**
   * Whether the failure is classified as transient and therefore worth a bounded
   * retry (rate limiting, service unavailability, or a statusless GraphQL error
   * consistent with an eventual-consistency race after linking sub-issues).
   */
  readonly retryable?: boolean;
  /** Safe structured GraphQL metadata, when the failure came from GraphQL. */
  readonly graphql?: GraphQlErrorInfo | null;
}

/**
 * An error raised when a repository operation fails. Its message contains only
 * the operation name, a generic status/type-based reason, and allowlisted
 * GraphQL `type`/`code` metadata — never raw bodies, tokens, or headers.
 */
export class RepositoryApiError extends Error {
  readonly operation: string;
  readonly code: RepositoryErrorCode;
  readonly status: number | null;
  /** Whether a bounded retry is appropriate for this failure. */
  readonly retryable: boolean;
  /** Safe GraphQL metadata, when present. */
  readonly graphql: GraphQlErrorInfo | null;

  constructor(
    operation: string,
    code: RepositoryErrorCode,
    status: number | null,
    options: RepositoryApiErrorOptions = {},
  ) {
    const graphql = options.graphql ?? null;
    super(
      `GitHub API request failed during ${operation}: ${describe(
        code,
        status,
        graphql,
      )}.`,
    );
    this.name = 'RepositoryApiError';
    this.operation = operation;
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.graphql = graphql;
  }
}

function describe(
  code: RepositoryErrorCode,
  status: number | null,
  graphql: GraphQlErrorInfo | null,
): string {
  const statusSuffix = status === null ? '' : ` (HTTP ${status})`;
  const detail: string[] = [];
  if (graphql?.type) {
    detail.push(`type=${graphql.type}`);
  }
  if (graphql?.code) {
    detail.push(`code=${graphql.code}`);
  }
  const graphqlSuffix = detail.length === 0 ? '' : ` [${detail.join(', ')}]`;
  return `${reason(code)}${statusSuffix}${graphqlSuffix}`;
}

function reason(code: RepositoryErrorCode): string {
  switch (code) {
    case 'unauthorized':
      return 'authentication failed';
    case 'forbidden':
      return 'access is forbidden';
    case 'not-found':
      return 'the resource was not found';
    case 'rate-limited':
      return 'the request was rate limited';
    case 'validation':
      return 'the request was rejected as invalid';
    case 'unavailable':
      return 'the service is unavailable';
    default:
      return 'an unexpected error occurred';
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

/**
 * An error raised when ordered-issue discovery from the epic body fails closed
 * for a reason other than a cross-repository reference — for example multiple or
 * empty markers, ambiguous structural candidates, or a duplicate or
 * self-referential issue number. The message is derived from the epic body
 * structure only and is safe to surface; it carries the stable `reason` so the
 * caller can report it without re-deriving it.
 */
export class MarkdownDiscoveryError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'MarkdownDiscoveryError';
    this.reason = reason;
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

/** A defensive cap so an attacker cannot smuggle a large blob through `type`. */
const MAX_GRAPHQL_FIELD_LENGTH = 64;

function safeField(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  // Allowlist a conservative shape (GitHub GraphQL error types and codes are
  // SCREAMING_SNAKE_CASE identifiers) so arbitrary server data can never leak.
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    return null;
  }
  return value.slice(0, MAX_GRAPHQL_FIELD_LENGTH);
}

/**
 * Extract only the safe, allowlisted GraphQL `type` and extension `code` from an
 * Octokit GraphQL failure. Returns `null` when the error carries no GraphQL
 * error array. The GraphQL message, locations, path, and any response data are
 * intentionally never read.
 */
function extractGraphqlInfo(error: unknown): GraphQlErrorInfo | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const candidate = error as {
    errors?: unknown;
    response?: { errors?: unknown } | null;
  };
  const list = Array.isArray(candidate.errors)
    ? candidate.errors
    : Array.isArray(candidate.response?.errors)
      ? candidate.response?.errors
      : null;
  if (list === null || list.length === 0) {
    return null;
  }
  const first = list[0];
  if (typeof first !== 'object' || first === null) {
    return null;
  }
  const typed = first as {
    type?: unknown;
    extensions?: { code?: unknown } | null;
  };
  return {
    type: safeField(typed.type),
    code: safeField(typed.extensions?.code),
  };
}

function codeForStatus(status: number): RepositoryErrorCode {
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

function codeForGraphqlType(type: string | null): RepositoryErrorCode | null {
  switch (type) {
    case 'UNAUTHORIZED':
      return 'unauthorized';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'NOT_FOUND':
      return 'not-found';
    case 'RATE_LIMITED':
      return 'rate-limited';
    case 'UNPROCESSABLE':
      return 'validation';
    case 'SERVICE_UNAVAILABLE':
    case 'UNAVAILABLE':
    case 'INTERNAL':
      return 'unavailable';
    default:
      return null;
  }
}

/**
 * Decide whether a failure should be retried with bounded backoff. Rate limiting
 * and service unavailability are always transient. A statusless GraphQL error
 * that classifies as `validation` or `unknown` is treated as transient too,
 * because the hierarchy reorder race surfaces as a statusless GraphQL error when
 * a freshly linked sibling is not yet visible. Permanent authorization,
 * forbidden, and not-found failures are never retried.
 */
function isRetryable(
  code: RepositoryErrorCode,
  status: number | null,
): boolean {
  if (code === 'rate-limited' || code === 'unavailable') {
    return true;
  }
  if (status === null && (code === 'validation' || code === 'unknown')) {
    return true;
  }
  return false;
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
  const graphql = extractGraphqlInfo(error);
  let code: RepositoryErrorCode | null =
    status === null ? null : codeForStatus(status);
  if (code === null || code === 'unknown') {
    const graphqlCode = graphql ? codeForGraphqlType(graphql.type) : null;
    if (graphqlCode !== null) {
      code = graphqlCode;
    }
  }
  if (code === null) {
    code = 'unknown';
  }
  return new RepositoryApiError(operation, code, status, {
    retryable: isRetryable(code, status),
    graphql,
  });
}
