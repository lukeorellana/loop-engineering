/**
 * Idempotent epic initialization.
 *
 * The initial manual run normalizes an epic exactly once and persists a frozen
 * execution plan. {@link initializeEpic} follows a strict transactional pattern:
 *
 *     read desired state
 *     -> validate the authored ordered issue list
 *     -> verify every planned issue exists in this repository
 *     -> read issue state directly from the planned issue numbers
 *     -> normalize canonical state
 *     -> persist the frozen plan last
 *
 * The authored Markdown ordered list is authoritative. Native GitHub sub-issue
 * links and ordering are presentation metadata outside Feature Loop's
 * orchestration responsibilities: initialization neither reads nor mutates the
 * native sub-issue hierarchy, so native linking, reparenting, removal,
 * reordering, and convergence failures can never block the loop. The frozen
 * plan is the sole execution-order source for every later run.
 */

import {
  buildExecutionPlan,
  validatePlannedIssues,
  type ExecutionPlan,
} from '../domain/plan.js';
import type { CanonicalStateLabels } from '../config/schema.js';
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
  /**
   * Retained for backward compatibility only. Native sub-issue hierarchy is no
   * longer authoritative orchestration state, so this flag is ignored.
   *
   * @deprecated Native sub-issue synchronization is no longer performed.
   */
  readonly exactSync?: boolean;
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

  // Verify that every planned issue exists in this repository.
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
  }

  // Read canonical state directly from the planned issue numbers and calculate
  // normalization mutations. An unexpected active (in-progress) issue fails
  // closed unless this is an explicit recovery. Native parent/child
  // relationships are not required.
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

  const details: string[] = [];
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

  // Apply canonical state normalization.
  for (const change of stateChanges) {
    await repository.setCanonicalState(change.number, change.label);
    logger.info('Feature Loop: normalized issue state', {
      issue: change.number,
      label: change.label,
    });
  }

  // Persist the frozen execution plan last. The ordered Markdown list is the
  // execution contract; the native hierarchy is never consulted.
  const plan = buildExecutionPlan(epicNumber, intendedIssues);
  await repository.upsertInitializationPlan(epicNumber, plan);
  logger.info('Feature Loop: epic initialized', {
    epic: epicNumber,
    issues: intendedIssues.length,
    reinitialized: forceReinitialize,
  });

  return { kind: 'initialized', plan, details };
}
