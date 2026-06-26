import { describe, expect, it } from 'vitest';

import {
  buildExecutionPlan,
  computePlanHash,
  decodeExecutionPlan,
  detectPlanDrift,
  PLAN_VERSION,
  validatePlannedIssues,
} from '../src/domain/plan.js';

describe('validatePlannedIssues', () => {
  it('accepts a non-empty, unique, positive list that excludes the epic', () => {
    expect(validatePlannedIssues(1, [2, 3, 4])).toEqual({ ok: true });
  });

  it('rejects an empty list', () => {
    const result = validatePlannedIssues(1, []);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.messages.join(' ')).toContain(
      'no ordered sub-issues',
    );
  });

  it('rejects duplicate references', () => {
    const result = validatePlannedIssues(1, [2, 3, 2]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.messages.join(' ')).toContain('#2');
  });

  it('rejects non-positive or non-integer references', () => {
    const result = validatePlannedIssues(1, [2, -3, 4.5]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.messages.join(' ')).toContain(
      'positive integers',
    );
  });

  it('rejects the epic appearing as its own sub-issue', () => {
    const result = validatePlannedIssues(1, [2, 1, 3]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.messages.join(' ')).toContain(
      'its own sub-issues',
    );
  });
});

describe('computePlanHash', () => {
  it('is deterministic for the same epic and order', () => {
    expect(computePlanHash(1, [2, 3, 4])).toBe(computePlanHash(1, [2, 3, 4]));
  });

  it('changes when the order changes', () => {
    expect(computePlanHash(1, [2, 3, 4])).not.toBe(
      computePlanHash(1, [2, 4, 3]),
    );
  });

  it('changes when the epic changes', () => {
    expect(computePlanHash(1, [2, 3])).not.toBe(computePlanHash(9, [2, 3]));
  });

  it('is prefixed with the algorithm name', () => {
    expect(computePlanHash(1, [2])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('buildExecutionPlan / decodeExecutionPlan', () => {
  it('round-trips through decode', () => {
    const plan = buildExecutionPlan(1, [2, 3, 4]);
    expect(plan).toEqual({
      version: PLAN_VERSION,
      epic: 1,
      issues: [2, 3, 4],
      planHash: computePlanHash(1, [2, 3, 4]),
      initialized: true,
    });
    expect(decodeExecutionPlan(plan)).toEqual(plan);
  });

  it('rejects a plan whose hash does not match its contents', () => {
    const plan = buildExecutionPlan(1, [2, 3, 4]);
    expect(decodeExecutionPlan({ ...plan, issues: [2, 3] })).toBeNull();
  });

  it('rejects an unsupported version or malformed value', () => {
    expect(decodeExecutionPlan(null)).toBeNull();
    expect(decodeExecutionPlan({ version: 99 })).toBeNull();
    expect(
      decodeExecutionPlan({ version: 1, epic: 1, issues: ['x'] }),
    ).toBeNull();
  });
});

describe('detectPlanDrift', () => {
  it('reports no drift when native order matches the plan', () => {
    const plan = buildExecutionPlan(1, [2, 3, 4]);
    expect(detectPlanDrift(plan, [2, 3, 4])).toEqual({ drifted: false });
  });

  it('reports drift when the native order differs', () => {
    const plan = buildExecutionPlan(1, [2, 3, 4]);
    const result = detectPlanDrift(plan, [2, 4, 3]);
    expect(result.drifted).toBe(true);
    expect(result.drifted === true && result.message).toContain('#1');
  });

  it('reports drift when native membership differs', () => {
    const plan = buildExecutionPlan(1, [2, 3, 4]);
    expect(detectPlanDrift(plan, [2, 3]).drifted).toBe(true);
  });
});
