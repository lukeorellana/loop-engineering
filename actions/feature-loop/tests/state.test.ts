import { describe, expect, it } from 'vitest';

import {
  CANONICAL_EPIC_STATES,
  CANONICAL_ISSUE_STATES,
  isActive,
  isComplete,
  isIssueState,
  isPausing,
  type IssueState,
} from '../src/domain/state.js';

describe('canonical state model', () => {
  it('treats only done as complete', () => {
    const complete = CANONICAL_ISSUE_STATES.filter(isComplete);
    expect(complete).toEqual(['done']);
  });

  it('pauses on blocked, invalid, skipped, needs-human, and not-planned head-of-line work', () => {
    const pausing = CANONICAL_ISSUE_STATES.filter(isPausing);
    expect(new Set(pausing)).toEqual(
      new Set(['blocked', 'invalid', 'skipped', 'needs-human', 'not-planned']),
    );
  });

  it('treats only in-progress as the single active issue', () => {
    const active = CANONICAL_ISSUE_STATES.filter(isActive);
    expect(active).toEqual(['in-progress']);
  });

  it('does not classify a state as both complete and pausing', () => {
    for (const state of CANONICAL_ISSUE_STATES) {
      expect(isComplete(state) && isPausing(state)).toBe(false);
    }
  });

  it('not-planned is closed but never complete (closed-not-planned pauses)', () => {
    expect(isComplete('not-planned')).toBe(false);
    expect(isPausing('not-planned')).toBe(true);
  });

  it('recognizes valid issue states and rejects others', () => {
    expect(isIssueState('done')).toBe(true);
    expect(isIssueState('nonsense')).toBe(false);
    expect(isIssueState(undefined)).toBe(false);
  });

  it('exposes the four canonical epic states', () => {
    expect(CANONICAL_EPIC_STATES).toEqual([
      'idle',
      'running',
      'paused',
      'complete',
    ]);
  });

  it('classifies every issue state as exactly one of active, complete, pausing, or todo', () => {
    for (const state of CANONICAL_ISSUE_STATES) {
      const categories = [
        isActive(state),
        isComplete(state),
        isPausing(state),
        state === ('todo' as IssueState),
      ].filter(Boolean);
      expect(categories).toHaveLength(1);
    }
  });
});
