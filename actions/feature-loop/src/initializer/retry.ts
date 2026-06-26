/**
 * Bounded retry, exponential backoff with jitter, and convergence polling for
 * eventually-consistent GitHub hierarchy mutations.
 *
 * Freshly linked native sub-issues are not always immediately readable, and a
 * reorder that references a sibling GitHub has not yet stabilized fails with a
 * statusless GraphQL error. These helpers retry only failures the adapter
 * classified as transient ({@link RepositoryApiError.retryable}); permanent
 * authorization, validation, and not-found failures fail immediately. All loops
 * are bounded — there is no unbounded sleep or retry.
 */

import { RepositoryApiError } from '../adapters/github/errors.js';

/**
 * Injected timing so tests run without real delays. Production uses
 * {@link realTiming}; tests pass a deterministic, zero-delay implementation.
 */
export interface RetryTiming {
  sleep(ms: number): Promise<void>;
  random(): number;
}

/** Real wall-clock timing for production use. */
export const realTiming: RetryTiming = {
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/** A bounded exponential-backoff policy. */
export interface BackoffPolicy {
  /** Maximum number of attempts, inclusive of the first. */
  readonly maxAttempts: number;
  /** Delay before the first retry, in milliseconds. */
  readonly initialDelayMs: number;
  /** Upper bound on any single delay, in milliseconds. */
  readonly maxDelayMs: number;
}

/** The default policy for hierarchy mutations and convergence polling. */
export const HIERARCHY_BACKOFF: BackoffPolicy = {
  maxAttempts: 5,
  initialDelayMs: 200,
  maxDelayMs: 4000,
};

/**
 * Compute the backoff delay for a 1-based attempt using capped exponential
 * growth and equal jitter (half fixed, half random) so concurrent runs do not
 * synchronize while a positive lower bound is preserved.
 */
export function backoffDelayMs(
  policy: BackoffPolicy,
  attempt: number,
  random: () => number,
): number {
  const exponential = policy.initialDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(policy.maxDelayMs, exponential);
  const half = capped / 2;
  return Math.floor(half + random() * half);
}

/** The outcome of a bounded retry. */
export type RetryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RepositoryApiError };

/**
 * Run `fn` with bounded retries, retrying only transient
 * {@link RepositoryApiError}s. Non-`RepositoryApiError` throwables propagate
 * unchanged (they indicate a programming error, not a transport failure).
 * `onRetry` is invoked before each backoff sleep with the upcoming attempt
 * number so callers can emit safe progress logs.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  policy: BackoffPolicy,
  timing: RetryTiming,
  onRetry?: (nextAttempt: number, error: RepositoryApiError) => void,
): Promise<RetryResult<T>> {
  let lastError: RepositoryApiError | null = null;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      if (!(error instanceof RepositoryApiError)) {
        throw error;
      }
      lastError = error;
      if (!error.retryable || attempt >= policy.maxAttempts) {
        return { ok: false, error };
      }
      onRetry?.(attempt + 1, error);
      await timing.sleep(backoffDelayMs(policy, attempt, timing.random));
    }
  }
  // Unreachable: the loop always returns. Present only for exhaustiveness.
  return {
    ok: false,
    error:
      lastError ??
      new RepositoryApiError('retry', 'unknown', null, { retryable: false }),
  };
}

/**
 * Build a safe, actionable message for an exhausted retry budget. It carries the
 * sanitized failure reason plus the attempt count, never raw response data.
 */
export function retryExhaustedMessage(
  error: RepositoryApiError,
  policy: BackoffPolicy,
): string {
  return `${error.message} Retry ${policy.maxAttempts} of ${policy.maxAttempts} failed.`;
}
