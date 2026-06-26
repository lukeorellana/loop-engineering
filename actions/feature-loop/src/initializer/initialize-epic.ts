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

import type { CanonicalStateLabels } from '../config/schema.js';
import {
  buildExecutionPlan,
  validatePlannedIssues,
  type ExecutionPlan,
} from '../domain/plan.js';
import type { GitHubRepositoryPort } from '../ports/github-repository.js';
import type { Logger } from '../ports/logger.js';

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

  // Apply attach/reparent mutations.
  for (const item of attach) {
    const subId = nodeIds.get(item.number);
    if (subId === undefined) {
      continue;
    }
    await repository.addSubIssue(epicNumber, subId, item.replaceParent);
    logger.info('Feature Loop: linked sub-issue to epic', {
      epic: epicNumber,
      issue: item.number,
      reparented: item.replaceParent,
    });
  }

  // Remove unexpected native sub-issues.
  for (const number of unexpected) {
    const identity = await repository.getIssueIdentity(number);
    if (identity === null) {
      continue;
    }
    await repository.removeSubIssue(epicNumber, identity.nodeId);
    logger.info('Feature Loop: removed unexpected native sub-issue', {
      epic: epicNumber,
      issue: number,
    });
  }

  // Reorder native sub-issues to exactly match the intended order. Walking the
  // chain so each issue immediately follows its predecessor fully determines the
  // order when the membership is exact.
  const nativeAfterLinks =
    await repository.getNativeSubIssueNumbers(epicNumber);
  if (!listsEqual(nativeAfterLinks, intendedIssues)) {
    for (let index = 1; index < intendedIssues.length; index += 1) {
      const subId = nodeIds.get(intendedIssues[index]);
      const afterId = nodeIds.get(intendedIssues[index - 1]);
      if (subId === undefined || afterId === undefined) {
        continue;
      }
      await repository.reprioritizeSubIssue(epicNumber, subId, afterId);
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
