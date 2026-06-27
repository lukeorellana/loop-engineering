/**
 * The frozen Feature Loop execution plan.
 *
 * Once an epic is initialized, the ordered sub-issue list is the execution
 * contract: native GitHub sub-issues are only the visible operational
 * representation of that contract. These helpers are pure — they validate an
 * authored ordered issue list, derive a stable plan hash, and decode a
 * persisted plan. They perform no I/O.
 */

import { createHash } from 'node:crypto';

/** The only execution-plan schema version this build understands. */
export const PLAN_VERSION = 1 as const;

/**
 * A persisted, frozen execution plan. The ordered {@link issues} list is the
 * authoritative execution contract for the epic after initialization.
 */
export interface ExecutionPlan {
  /** The plan schema version. */
  readonly version: typeof PLAN_VERSION;
  /** The epic issue number this plan controls. */
  readonly epic: number;
  /** The frozen ordered sub-issue numbers, in execution order. */
  readonly issues: readonly number[];
  /** A stable content hash over the epic and ordered issues. */
  readonly planHash: string;
  /** Always `true` once persisted; a plan is only written after verification. */
  readonly initialized: boolean;
}

/** The outcome of validating an authored ordered issue list. */
export type PlanValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly messages: readonly string[] };

/**
 * Validate the authored ordered issue list for an epic, failing closed.
 *
 * Rejects an empty list, non-positive or non-integer references, duplicate issue
 * numbers, and the epic appearing as one of its own sub-issues. Existence and
 * same-repository checks require I/O and are performed by the initializer.
 */
export function validatePlannedIssues(
  epicNumber: number,
  issues: readonly number[],
): PlanValidation {
  const messages: string[] = [];

  if (issues.length === 0) {
    messages.push('The epic has no ordered sub-issues to initialize.');
  }

  const invalid = issues.filter(
    (value) => !Number.isInteger(value) || value <= 0,
  );
  if (invalid.length > 0) {
    messages.push(
      `Ordered sub-issue references must be positive integers; found: ${invalid.join(
        ', ',
      )}.`,
    );
  }

  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const value of issues) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  if (duplicates.size > 0) {
    messages.push(
      `Duplicate sub-issue references are not allowed: ${[...duplicates]
        .sort((a, b) => a - b)
        .map((n) => `#${n}`)
        .join(', ')}.`,
    );
  }

  if (issues.includes(epicNumber)) {
    messages.push(
      `Epic #${epicNumber} cannot appear as one of its own sub-issues.`,
    );
  }

  if (messages.length > 0) {
    return { ok: false, messages };
  }
  return { ok: true };
}

/**
 * Derive a stable content hash over the epic and its ordered issue list.
 *
 * The hash is computed over a canonical JSON representation so that the same
 * epic and order always produce the same value, and any change to the order or
 * membership changes the hash.
 */
export function computePlanHash(
  epicNumber: number,
  issues: readonly number[],
): string {
  const canonical = JSON.stringify({ epic: epicNumber, issues });
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `sha256:${digest}`;
}

/**
 * Build a frozen {@link ExecutionPlan} from an epic and its ordered issues.
 */
export function buildExecutionPlan(
  epicNumber: number,
  issues: readonly number[],
): ExecutionPlan {
  return {
    version: PLAN_VERSION,
    epic: epicNumber,
    issues: [...issues],
    planHash: computePlanHash(epicNumber, issues),
    initialized: true,
  };
}

/**
 * Decode an untrusted value into an {@link ExecutionPlan}, or `null` when the
 * value is not a well-formed plan of the supported version with a hash that
 * matches its contents.
 */
export function decodeExecutionPlan(value: unknown): ExecutionPlan | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== PLAN_VERSION) {
    return null;
  }
  if (typeof candidate.epic !== 'number' || !Number.isInteger(candidate.epic)) {
    return null;
  }
  if (
    !Array.isArray(candidate.issues) ||
    !candidate.issues.every(
      (item) => typeof item === 'number' && Number.isInteger(item),
    )
  ) {
    return null;
  }
  if (typeof candidate.planHash !== 'string') {
    return null;
  }
  const issues = candidate.issues as number[];
  if (computePlanHash(candidate.epic, issues) !== candidate.planHash) {
    return null;
  }
  return {
    version: PLAN_VERSION,
    epic: candidate.epic,
    issues,
    planHash: candidate.planHash,
    initialized: candidate.initialized === true,
  };
}
