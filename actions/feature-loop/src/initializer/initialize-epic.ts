/**
 * Idempotent epic initialization.
 *
 * The initial manual run normalizes an epic exactly once and persists a frozen
 * execution plan. {@link initializeEpic} follows a strict transactional pattern:
 *
 *     read desired state
 *     -> calculate mutations
 *     -> apply only missing changes
 *     -> re-read
 *     -> verify exact match
 *     -> persist the initialized marker last
 *
 * It is safe to rerun after a partial failure: every mutation is idempotent and
 * the plan is only persisted after the native hierarchy is verified. Later runs
 * read the persisted plan instead of re-resolving competing issue sources.
 */

import { RepositoryApiError } from '../adapters/github/errors.js';
import type { CanonicalStateLabels } from '../config/schema.js';
import {
  buildExecutionPlan,
  validatePlannedIssues,
  type ExecutionPlan,
} from '../domain/plan.js';
import type { GitHubRepositoryPort } from '../ports/github-repository.js';
import type { NativeSubIssue } from '../ports/github-repository.js';
import type { Logger } from '../ports/logger.js';
import {
  HIERARCHY_BACKOFF,
  backoffDelayMs,
  realTiming,
  retryExhaustedMessage,
  retryTransient,
  type BackoffPolicy,
  type RetryTiming,
} from './retry.js';

/** Inputs to {@link initializeEpic}. */
export interface InitializeEpicInput {
  readonly repository: GitHubRepositoryPort;
  readonly logger: Logger;
  /** The epic issue number to initialize. */
  readonly epicNumber: number;
  /** The intended ordered sub-issue list (the authoring source). */
  readonly intendedIssues: readonly number[];
  /** Canonical-state label mapping used to normalize issue state. */
  readonly labels: CanonicalStateLabels;
  /** When `true`, remove native sub-issues not present in the plan. */
  readonly exactSync: boolean;
  /** When `true`, report proposed changes and perform zero writes. */
  readonly dryRun: boolean;
  /** When `true`, reinitialize even if a plan already exists. */
  readonly forceReinitialize: boolean;
  /**
   * Backoff policy for transient hierarchy mutations and convergence polling.
   * Defaults to {@link HIERARCHY_BACKOFF}.
   */
  readonly backoff?: BackoffPolicy;
  /**
   * Injected timing for retries and polling. Defaults to real wall-clock
   * timing; tests pass a deterministic, zero-delay implementation.
   */
  readonly timing?: RetryTiming;
}

/** The structured outcome of an initialization attempt. */
export type InitializeEpicResult =
  | {
      readonly kind: 'already-initialized';
      readonly plan: ExecutionPlan;
      readonly details: readonly string[];
    }
  | {
      readonly kind: 'initialized';
      readonly plan: ExecutionPlan;
      readonly details: readonly string[];
    }
  | {
      readonly kind: 'dry-run';
      readonly issues: readonly number[];
      readonly details: readonly string[];
    }
  | {
      readonly kind: 'failed';
      readonly reason: 'initialization-failed';
      readonly messages: readonly string[];
    }
  | {
      readonly kind: 'unexpected-active-issue';
      readonly issueNumber: number;
      readonly messages: readonly string[];
    };

function listsEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** `true` when `sub` immediately follows `after` in `native`. */
function adjacencySatisfied(
  native: readonly number[],
  sub: number,
  after: number,
): boolean {
  const afterIndex = native.indexOf(after);
  return afterIndex !== -1 && native[afterIndex + 1] === sub;
}

interface HierarchyContext {
  readonly repository: GitHubRepositoryPort;
  readonly logger: Logger;
  readonly epicNumber: number;
  readonly policy: BackoffPolicy;
  readonly timing: RetryTiming;
}

/** A bounded hierarchy operation either succeeds or yields safe messages. */
type HierarchyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly messages: readonly string[] };

/**
 * Poll native sub-issues with bounded backoff until `isSatisfied` accepts the
 * visible membership. Transient read failures are retried; permanent failures
 * stop immediately. Returns the converged membership or a safe failure.
 */
async function waitForMembership(
  ctx: HierarchyContext,
  isSatisfied: (native: readonly number[]) => boolean,
): Promise<
  | { readonly ok: true; readonly native: readonly number[] }
  | { readonly ok: false; readonly messages: readonly string[] }
> {
  const { repository, logger, epicNumber, policy, timing } = ctx;
  let lastError: RepositoryApiError | null = null;
  let lastNative: readonly number[] | null = null;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const native = await repository.getNativeSubIssueNumbers(epicNumber);
      lastNative = native;
      if (isSatisfied(native)) {
        return { ok: true, native };
      }
    } catch (error) {
      if (!(error instanceof RepositoryApiError)) {
        throw error;
      }
      if (!error.retryable) {
        return { ok: false, messages: [error.message] };
      }
      lastError = error;
    }
    if (attempt >= policy.maxAttempts) {
      break;
    }
    await timing.sleep(backoffDelayMs(policy, attempt, timing.random));
  }
  const reason =
    lastError !== null
      ? retryExhaustedMessage(lastError, policy)
      : `Epic #${epicNumber} hierarchy did not converge after linking; ` +
        `last visible native sub-issues were [${(lastNative ?? []).join(', ')}].`;
  logger.warning('Feature Loop: hierarchy convergence timed out', {
    epic: epicNumber,
  });
  return { ok: false, messages: [reason] };
}

/**
 * Poll the authoritative native sub-issue order with bounded backoff until
 * `isSatisfied` accepts the observed order. Each successful read is reported to
 * `onObserve` so callers can log the observed issue-number order. The outcome
 * distinguishes three terminal states so callers can build precise diagnostics:
 *
 *   - `ok`: the predicate was satisfied; the converged order is returned.
 *   - `!ok` with `error`: a read failed permanently, or transient read failures
 *     exhausted the budget.
 *   - `!ok` with `error: null`: reads succeeded but the predicate never held
 *     within the budget (a convergence timeout); `lastNative` is the last order.
 */
async function pollNativeOrder(
  ctx: HierarchyContext,
  isSatisfied: (native: readonly NativeSubIssue[]) => boolean,
  onObserve?: (native: readonly NativeSubIssue[]) => void,
): Promise<
  | { readonly ok: true; readonly native: readonly NativeSubIssue[] }
  | {
      readonly ok: false;
      readonly lastNative: readonly NativeSubIssue[] | null;
      readonly error: RepositoryApiError | null;
    }
> {
  const { repository, epicNumber, policy, timing } = ctx;
  let lastNative: readonly NativeSubIssue[] | null = null;
  let lastError: RepositoryApiError | null = null;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const native = await repository.getNativeSubIssues(epicNumber);
      lastNative = native;
      onObserve?.(native);
      if (isSatisfied(native)) {
        return { ok: true, native };
      }
      // A successful but unsatisfied read is a convergence timeout, not a
      // transport failure: clear any prior transient error.
      lastError = null;
    } catch (error) {
      if (!(error instanceof RepositoryApiError)) {
        throw error;
      }
      if (!error.retryable) {
        return { ok: false, lastNative, error };
      }
      lastError = error;
    }
    if (attempt >= policy.maxAttempts) {
      break;
    }
    await timing.sleep(backoffDelayMs(policy, attempt, timing.random));
  }
  return { ok: false, lastNative, error: lastError };
}

/** Render an observed native order as its issue-number list for logging. */
function observedNumbers(native: readonly NativeSubIssue[]): number[] {
  return native.map((sub) => sub.number);
}

/**
 * Move `sub` so it immediately follows `after`, separating mutation retry from
 * verification polling against one authoritative REST surface:
 *
 *   1. read the current order and log it;
 *   2. skip the write when adjacency already holds, or wait for both endpoints
 *      to become visible;
 *   3. send exactly one priority mutation, retrying only when that mutation
 *      throws a retryable error (permanent errors stop immediately);
 *   4. after the mutation is accepted, poll the order — without resending the
 *      mutation — until adjacency converges, logging each observed order.
 *
 * A convergence timeout reports the expected adjacency, the last observed order,
 * and that the mutation was accepted, so the failure is actionable.
 */
async function ensureAdjacency(
  ctx: HierarchyContext,
  move: {
    readonly sub: number;
    readonly after: number;
  },
): Promise<HierarchyOutcome> {
  const { logger, epicNumber, policy, timing, repository } = ctx;
  const { sub, after } = move;

  // 1-2. Read the current order; skip when already adjacent; otherwise wait for
  // both endpoints to be visible before attempting a move.
  const ready = await pollNativeOrder(
    ctx,
    (native) => {
      const numbers = observedNumbers(native);
      return (
        adjacencySatisfied(numbers, sub, after) ||
        (numbers.includes(sub) && numbers.includes(after))
      );
    },
    (native) =>
      logger.info('Feature Loop: observed native order before reorder', {
        epic: epicNumber,
        sub,
        after,
        order: observedNumbers(native),
      }),
  );
  if (!ready.ok) {
    return {
      ok: false,
      messages: [readFailureMessage(ctx, ready, sub, after)],
    };
  }

  const current = observedNumbers(ready.native);
  if (adjacencySatisfied(current, sub, after)) {
    // Adjacency already holds (possibly converged asynchronously): no write.
    return { ok: true };
  }

  const subId = ready.native.find((entry) => entry.number === sub)?.databaseId;
  const afterId = ready.native.find(
    (entry) => entry.number === after,
  )?.databaseId;
  if (subId === undefined || afterId === undefined) {
    // Unreachable: the read predicate guarantees both endpoints are visible.
    return {
      ok: false,
      messages: [
        `Epic #${epicNumber} reorder of issue #${sub} after #${after} could ` +
          `not resolve sub-issue database ids from the native order ` +
          `[${current.join(', ')}].`,
      ],
    };
  }

  // 3. Send exactly one priority mutation, retrying only retryable failures.
  logger.info(`Feature Loop: reprioritizing issue #${sub} after #${after}`, {
    epic: epicNumber,
  });
  const mutation = await retryTransient(
    () => repository.reprioritizeSubIssue(epicNumber, subId, afterId),
    policy,
    timing,
    (nextAttempt) =>
      logger.info(
        `Feature Loop: reprioritize retry ${nextAttempt}/${policy.maxAttempts}`,
        { epic: epicNumber, issue: sub },
      ),
  );
  if (!mutation.ok) {
    const message = mutation.error.retryable
      ? retryExhaustedMessage(mutation.error, policy)
      : mutation.error.message;
    return { ok: false, messages: [message] };
  }

  // 4. Poll for convergence without resending the mutation.
  let lastObserved: readonly number[] = current;
  const verified = await pollNativeOrder(
    ctx,
    (native) => adjacencySatisfied(observedNumbers(native), sub, after),
    (native) => {
      lastObserved = observedNumbers(native);
      logger.info('Feature Loop: observed native order during verification', {
        epic: epicNumber,
        sub,
        after,
        order: lastObserved,
      });
    },
  );
  if (verified.ok) {
    return { ok: true };
  }
  if (verified.error !== null) {
    const message = verified.error.retryable
      ? retryExhaustedMessage(verified.error, policy)
      : verified.error.message;
    return { ok: false, messages: [message] };
  }
  const observed = verified.lastNative
    ? observedNumbers(verified.lastNative)
    : lastObserved;
  return {
    ok: false,
    messages: [
      `Epic #${epicNumber} reorder did not converge within ` +
        `${policy.maxAttempts} verification attempts: expected issue #${sub} ` +
        `immediately after #${after}; last observed order [${observed.join(
          ', ',
        )}]; priority mutation accepted: true.`,
    ],
  };
}

/**
 * Build a safe message for a failed pre-move read: an exhausted/permanent read
 * error, or a visibility timeout where both endpoints never became visible.
 */
function readFailureMessage(
  ctx: HierarchyContext,
  outcome: {
    readonly lastNative: readonly NativeSubIssue[] | null;
    readonly error: RepositoryApiError | null;
  },
  sub: number,
  after: number,
): string {
  if (outcome.error !== null) {
    return outcome.error.retryable
      ? retryExhaustedMessage(outcome.error, ctx.policy)
      : outcome.error.message;
  }
  const observed = outcome.lastNative
    ? observedNumbers(outcome.lastNative)
    : [];
  return (
    `Epic #${ctx.epicNumber} reorder of issue #${sub} after #${after} could ` +
    `not begin: both sub-issues were not visible within ` +
    `${ctx.policy.maxAttempts} attempts; last observed order ` +
    `[${observed.join(', ')}]; priority mutation accepted: false.`
  );
}

/**
 * Run the idempotent epic initialization transaction.
 */
export async function initializeEpic(
  input: InitializeEpicInput,
): Promise<InitializeEpicResult> {
  const {
    repository,
    logger,
    epicNumber,
    intendedIssues,
    labels,
    exactSync,
    dryRun,
    forceReinitialize,
  } = input;
  const policy = input.backoff ?? HIERARCHY_BACKOFF;
  const timing = input.timing ?? realTiming;
  const hierarchy: HierarchyContext = {
    repository,
    logger,
    epicNumber,
    policy,
    timing,
  };

  // A normal rerun of an already-initialized epic is idempotent: the persisted
  // plan is the execution contract and is not rewritten unless reinitialization
  // was explicitly requested.
  const existing = await repository.getInitializationPlan(epicNumber);
  if (existing !== null && !forceReinitialize) {
    logger.info('Feature Loop: epic already initialized', { epic: epicNumber });
    return {
      kind: 'already-initialized',
      plan: existing,
      details: [
        `Epic #${epicNumber} is already initialized with ${existing.issues.length} planned issue(s).`,
      ],
    };
  }

  // Validate the authored list before any I/O-dependent checks.
  const validation = validatePlannedIssues(epicNumber, intendedIssues);
  if (!validation.ok) {
    return {
      kind: 'failed',
      reason: 'initialization-failed',
      messages: validation.messages,
    };
  }

  // Verify existence and resolve the node id of every planned issue.
  const nodeIds = new Map<number, string>();
  for (const issueNumber of intendedIssues) {
    const identity = await repository.getIssueIdentity(issueNumber);
    if (identity === null) {
      return {
        kind: 'failed',
        reason: 'initialization-failed',
        messages: [
          `Planned sub-issue #${issueNumber} was not found in this repository.`,
        ],
      };
    }
    nodeIds.set(issueNumber, identity.nodeId);
  }

  // Read the native parent of every planned issue and calculate attach/reparent
  // mutations.
  const attach: { number: number; replaceParent: boolean }[] = [];
  for (const issueNumber of intendedIssues) {
    const parent = await repository.getParentEpicNumber(issueNumber);
    if (parent === epicNumber) {
      continue;
    }
    attach.push({ number: issueNumber, replaceParent: parent !== null });
  }

  // Calculate unexpected native sub-issues to remove under exact synchronization.
  const nativeBefore = await repository.getNativeSubIssueNumbers(epicNumber);
  const plannedSet = new Set(intendedIssues);
  const unexpected = exactSync
    ? nativeBefore.filter((number) => !plannedSet.has(number))
    : [];

  // Read canonical state and calculate normalization mutations. An unexpected
  // active (in-progress) issue fails closed unless this is an explicit recovery.
  const epicState = await repository.getEpicWithSubIssues(
    epicNumber,
    intendedIssues,
  );
  if (epicState === null) {
    return {
      kind: 'failed',
      reason: 'initialization-failed',
      messages: [`Epic #${epicNumber} could not be loaded for initialization.`],
    };
  }

  const stateChanges: { number: number; label: string }[] = [];
  for (const sub of epicState.subIssues) {
    if (sub.open) {
      if (
        sub.canonicalStateLabels.length === 1 &&
        sub.canonicalStateLabels[0] === labels['in-progress'] &&
        !forceReinitialize
      ) {
        return {
          kind: 'unexpected-active-issue',
          issueNumber: sub.number,
          messages: [
            `Issue #${sub.number} is already marked in-progress before initialization. ` +
              'Resolve the active work, or reinitialize explicitly to recover.',
          ],
        };
      }
      // Open issues with no canonical label are canonically `todo`; deliberate
      // blocked/needs-human and an invalid multi-label state are preserved for
      // the state machine to handle.
      continue;
    }
    const desired =
      sub.closedReason === 'not-planned' ? labels['not-planned'] : labels.done;
    const present = sub.canonicalStateLabels;
    const consistent = present.length === 1 && present[0] === desired;
    if (!consistent) {
      stateChanges.push({ number: sub.number, label: desired });
    }
  }

  // Determine whether native ordering already matches the plan (so an already
  // ordered epic performs no reorder writes).
  const expectedMembership = exactSync
    ? intendedIssues
    : [...intendedIssues, ...nativeBefore.filter((n) => !plannedSet.has(n))];
  const orderMatches =
    attach.length === 0 &&
    unexpected.length === 0 &&
    listsEqual(nativeBefore, expectedMembership);

  const details: string[] = [];
  for (const item of attach) {
    details.push(
      item.replaceParent
        ? `Reparent issue #${item.number} to epic #${epicNumber}.`
        : `Attach issue #${item.number} to epic #${epicNumber}.`,
    );
  }
  for (const number of unexpected) {
    details.push(
      `Remove unexpected native sub-issue #${number} from epic #${epicNumber}.`,
    );
  }
  if (!orderMatches) {
    details.push(
      `Reorder native sub-issues to match [${intendedIssues.join(', ')}].`,
    );
  }
  for (const change of stateChanges) {
    details.push(`Normalize issue #${change.number} to "${change.label}".`);
  }
  details.push(
    `Persist the frozen execution plan for epic #${epicNumber}: [${intendedIssues.join(
      ', ',
    )}].`,
  );

  if (dryRun) {
    logger.info('Feature Loop: dry-run initialization preview', {
      epic: epicNumber,
      changes: details.length,
    });
    return { kind: 'dry-run', issues: [...intendedIssues], details };
  }

  // Apply attach/reparent mutations, retrying transient transport failures.
  for (const item of attach) {
    const subId = nodeIds.get(item.number);
    if (subId === undefined) {
      continue;
    }
    const attached = await retryTransient(
      () => repository.addSubIssue(epicNumber, subId, item.replaceParent),
      policy,
      timing,
      (nextAttempt) =>
        logger.info(
          `Feature Loop: add sub-issue retry ${nextAttempt}/${policy.maxAttempts}`,
          { epic: epicNumber, issue: item.number },
        ),
    );
    if (!attached.ok) {
      return {
        kind: 'failed',
        reason: 'initialization-failed',
        messages: [retryExhaustedMessage(attached.error, policy)],
      };
    }
    logger.info('Feature Loop: linked sub-issue to epic', {
      epic: epicNumber,
      issue: item.number,
      reparented: item.replaceParent,
    });
  }

  // Remove unexpected native sub-issues, retrying transient transport failures.
  for (const number of unexpected) {
    const identity = await repository.getIssueIdentity(number);
    if (identity === null) {
      continue;
    }
    const removed = await retryTransient(
      () => repository.removeSubIssue(epicNumber, identity.nodeId),
      policy,
      timing,
      (nextAttempt) =>
        logger.info(
          `Feature Loop: remove sub-issue retry ${nextAttempt}/${policy.maxAttempts}`,
          { epic: epicNumber, issue: number },
        ),
    );
    if (!removed.ok) {
      return {
        kind: 'failed',
        reason: 'initialization-failed',
        messages: [retryExhaustedMessage(removed.error, policy)],
      };
    }
    logger.info('Feature Loop: removed unexpected native sub-issue', {
      epic: epicNumber,
      issue: number,
    });
  }

  // After linking/removing, wait for the native hierarchy to converge before any
  // reorder. Freshly linked relationships are eventually consistent: a reorder
  // that references a sibling GitHub has not yet stabilized fails transiently.
  if (attach.length > 0 || unexpected.length > 0) {
    logger.info('Feature Loop: waiting for native hierarchy convergence', {
      epic: epicNumber,
    });
    const convergence = await waitForMembership(hierarchy, (native) => {
      const allVisible = intendedIssues.every((number) =>
        native.includes(number),
      );
      const noUnexpected = exactSync
        ? native.every((number) => plannedSet.has(number))
        : true;
      return allVisible && noUnexpected;
    });
    if (!convergence.ok) {
      return {
        kind: 'failed',
        reason: 'initialization-failed',
        messages: convergence.messages,
      };
    }
    logger.info('Feature Loop: hierarchy membership visible', {
      epic: epicNumber,
    });
  }

  // Reorder native sub-issues to match the intended order. Each move reads the
  // authoritative order, skips already-satisfied adjacency, sends one priority
  // mutation, then polls the same surface until the move is verified.
  for (let index = 1; index < intendedIssues.length; index += 1) {
    const sub = intendedIssues[index];
    const after = intendedIssues[index - 1];
    const moved = await ensureAdjacency(hierarchy, { sub, after });
    if (!moved.ok) {
      return {
        kind: 'failed',
        reason: 'initialization-failed',
        messages: moved.messages,
      };
    }
  }

  // Apply canonical state normalization.
  for (const change of stateChanges) {
    await repository.setCanonicalState(change.number, change.label);
    logger.info('Feature Loop: normalized issue state', {
      issue: change.number,
      label: change.label,
    });
  }

  // Re-read and verify the final native hierarchy before persisting the plan.
  const nativeFinal = await repository.getNativeSubIssueNumbers(epicNumber);
  const verified = exactSync
    ? listsEqual(nativeFinal, intendedIssues)
    : intendedIssues.every((number) => nativeFinal.includes(number));
  if (!verified) {
    return {
      kind: 'failed',
      reason: 'initialization-failed',
      messages: [
        `Epic #${epicNumber} hierarchy verification failed after initialization. ` +
          `Expected [${intendedIssues.join(', ')}] but found [${nativeFinal.join(
            ', ',
          )}].`,
      ],
    };
  }
  logger.info('Feature Loop: verified native order', {
    epic: epicNumber,
    order: nativeFinal,
  });

  // Persist the frozen execution plan last.
  const plan = buildExecutionPlan(epicNumber, intendedIssues);
  await repository.upsertInitializationPlan(epicNumber, plan);
  logger.info('Feature Loop: epic initialized', {
    epic: epicNumber,
    issues: intendedIssues.length,
    reinitialized: forceReinitialize,
  });

  return { kind: 'initialized', plan, details };
}
