import { describe, expect, it } from 'vitest';

import { resolveIssueSource } from '../src/domain/issue-source.js';

describe('deterministic issue source resolution', () => {
  it('native uses only native sub-issues', () => {
    const result = resolveIssueSource('native', [1, 2, 3], [9]);
    expect(result).toEqual({ ok: true, source: 'native', issues: [1, 2, 3] });
  });

  it('markdown uses only the markdown section', () => {
    const result = resolveIssueSource('markdown', [1], [4, 5]);
    expect(result).toEqual({ ok: true, source: 'markdown', issues: [4, 5] });
  });

  it('auto prefers native when non-empty', () => {
    const result = resolveIssueSource('auto', [1, 2], []);
    expect(result).toEqual({ ok: true, source: 'native', issues: [1, 2] });
  });

  it('auto falls back to markdown when native is empty', () => {
    const result = resolveIssueSource('auto', [], [7, 8]);
    expect(result).toEqual({ ok: true, source: 'markdown', issues: [7, 8] });
  });

  it('auto accepts identical native and markdown lists', () => {
    const result = resolveIssueSource('auto', [1, 2], [1, 2]);
    expect(result).toEqual({ ok: true, source: 'native', issues: [1, 2] });
  });

  it('auto fails closed when both are non-empty and differ', () => {
    const result = resolveIssueSource('auto', [1, 2], [2, 1]);
    expect(result).toEqual({
      ok: false,
      reason: 'ambiguous-sources',
      message: expect.any(String),
    });
  });

  it('auto resolves to an empty markdown list when both are empty', () => {
    const result = resolveIssueSource('auto', [], []);
    expect(result).toEqual({ ok: true, source: 'markdown', issues: [] });
  });
});
