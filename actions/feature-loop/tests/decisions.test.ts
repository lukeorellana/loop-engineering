import { describe, expect, it } from 'vitest';

import {
  ACTION_OUTCOMES,
  outcomeOf,
  type LoopDecision,
} from '../src/domain/decisions.js';

describe('loop decisions and outcomes', () => {
  it('enumerates all documented action outcomes', () => {
    expect(new Set(ACTION_OUTCOMES)).toEqual(
      new Set([
        'started',
        'already-running',
        'complete',
        'needs-human',
        'dry-run',
        'no-op',
        'configuration-error',
        'operational-error',
      ]),
    );
  });

  it('maps a configuration-error decision to its outcome without a start request', () => {
    const decision: LoopDecision = {
      outcome: 'configuration-error',
      messages: ['unsupported version'],
    };
    expect(outcomeOf(decision)).toBe('configuration-error');
    // A configuration-error decision has no request/issue, so it can never start work.
    expect('request' in decision).toBe(false);
  });

  it('carries a start request only on a started decision', () => {
    const decision: LoopDecision = {
      outcome: 'no-op',
      reason: 'not triggered',
    };
    expect(outcomeOf(decision)).toBe('no-op');
    expect('wouldStart' in decision).toBe(false);
  });
});
