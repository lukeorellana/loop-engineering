/**
 * Hidden machine-readable persistence of the frozen execution plan.
 *
 * The initialization plan is stored using the same status-comment mechanism as
 * other Feature Loop state: a dedicated per-epic marker scopes a comment whose
 * body embeds the plan JSON inside an HTML comment, invisible in rendered
 * Markdown but recoverable on later runs. These helpers are pure.
 */

import {
  decodeExecutionPlan,
  type ExecutionPlan,
} from '../../domain/plan.js';

/** The logical marker name used to scope a per-epic plan comment. */
export function epicPlanMarker(epicNumber: number): string {
  return `plan-${epicNumber}`;
}

// The payload is embedded inside an HTML comment. JSON never contains the `-->`
// sequence, so it is always safe to embed and recover.
const DATA_PREFIX = '<!-- feature-loop:plan:';
const DATA_SUFFIX = ' -->';
const DATA_PATTERN = /<!-- feature-loop:plan:(.*?) -->/s;

/** Serialize an execution plan into a hidden HTML comment token. */
export function encodePlanData(plan: ExecutionPlan): string {
  return `${DATA_PREFIX}${JSON.stringify(plan)}${DATA_SUFFIX}`;
}

/**
 * Recover the execution plan embedded in a comment body, or `null` when no
 * valid plan is present.
 */
export function decodePlanData(body: string | null): ExecutionPlan | null {
  if (body === null) {
    return null;
  }
  const match = DATA_PATTERN.exec(body);
  if (match === null) {
    return null;
  }
  try {
    return decodeExecutionPlan(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

/**
 * Build the human-readable body of a plan comment, with the machine-readable
 * plan payload embedded as a hidden HTML comment.
 */
export function buildPlanCommentBody(plan: ExecutionPlan): string {
  const issues = plan.issues.map((n) => `#${n}`).join(', ');
  return (
    `${encodePlanData(plan)}\n\n` +
    `Feature Loop initialized epic #${plan.epic} with a frozen execution plan ` +
    `of ${plan.issues.length} ordered sub-issue${
      plan.issues.length === 1 ? '' : 's'
    }: ${issues}. ` +
    'Later runs follow this plan; intentional changes require explicit ' +
    'reinitialization.'
  );
}
