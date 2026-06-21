import { describe, expect, it } from 'vitest';

import { DEFAULT_CANONICAL_STATE_LABELS } from '../src/config/schema.js';
import { resolveIssueState } from '../src/domain/issue-state-resolution.js';

const labels = DEFAULT_CANONICAL_STATE_LABELS;

describe('resolveIssueState', () => {
  it('resolves an open issue with no canonical label to todo', () => {
    expect(
      resolveIssueState({ open: true, labelNames: ['bug'] }, labels),
    ).toEqual({ state: 'todo', canonicalStateLabels: [] });
  });

  it('resolves an open issue with a single canonical label', () => {
    expect(
      resolveIssueState(
        { open: true, labelNames: ['bug', labels['in-progress']] },
        labels,
      ),
    ).toEqual({
      state: 'in-progress',
      canonicalStateLabels: [labels['in-progress']],
    });
  });

  it('resolves more than one canonical label to invalid (fail closed)', () => {
    const result = resolveIssueState(
      { open: true, labelNames: [labels.todo, labels.blocked] },
      labels,
    );
    expect(result.state).toBe('invalid');
    expect(result.canonicalStateLabels).toEqual([labels.todo, labels.blocked]);
  });

  it('resolves a closed-completed issue to done regardless of labels', () => {
    expect(
      resolveIssueState(
        { open: false, closedReason: 'completed', labelNames: [labels.todo] },
        labels,
      ),
    ).toEqual({ state: 'done', canonicalStateLabels: [labels.todo] });
  });

  it('treats a closed issue with no close reason as done', () => {
    expect(resolveIssueState({ open: false, labelNames: [] }, labels)).toEqual({
      state: 'done',
      canonicalStateLabels: [],
    });
  });

  it('resolves a closed not-planned issue to not-planned', () => {
    expect(
      resolveIssueState(
        { open: false, closedReason: 'not-planned', labelNames: [] },
        labels,
      ),
    ).toEqual({ state: 'not-planned', canonicalStateLabels: [] });
  });
});
