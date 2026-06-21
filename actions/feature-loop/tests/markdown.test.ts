import { describe, expect, it } from 'vitest';

import { parseMarkdownSubIssues } from '../src/domain/markdown.js';

const repo = { owner: 'octo', name: 'demo' };

describe('parseMarkdownSubIssues', () => {
  it('returns an empty list for an empty or missing body', () => {
    expect(parseMarkdownSubIssues(null, 'Ordered sub-issues', repo)).toEqual({
      ok: true,
      numbers: [],
    });
    expect(parseMarkdownSubIssues('', 'Ordered sub-issues', repo)).toEqual({
      ok: true,
      numbers: [],
    });
  });

  it('scopes references to the configured heading section', () => {
    const body = [
      '## Background',
      'Unrelated #999 reference here.',
      '',
      '## Ordered sub-issues',
      '- #10 first',
      '- #11 second',
      '',
      '## Notes',
      '- #12 should be ignored',
    ].join('\n');
    const result = parseMarkdownSubIssues(body, 'Ordered sub-issues', repo);
    expect(result).toEqual({ ok: true, numbers: [10, 11] });
  });

  it('matches the heading case-insensitively and at any level', () => {
    const body = ['# ORDERED SUB-ISSUES', '- #5', '- #6'].join('\n');
    expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
      ok: true,
      numbers: [5, 6],
    });
  });

  it('preserves order and removes duplicates', () => {
    const body = ['## Ordered sub-issues', '- #3', '- #1', '- #3', '- #2'].join(
      '\n',
    );
    expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
      ok: true,
      numbers: [3, 1, 2],
    });
  });

  it('accepts same-repository full URLs and owner/repo shorthand', () => {
    const body = [
      '## Ordered sub-issues',
      '- https://github.com/octo/demo/issues/20',
      '- OCTO/Demo#21',
    ].join('\n');
    expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
      ok: true,
      numbers: [20, 21],
    });
  });

  it('rejects cross-repository URL references', () => {
    const body = [
      '## Ordered sub-issues',
      '- https://github.com/other/repo/issues/7',
    ].join('\n');
    const result = parseMarkdownSubIssues(body, 'Ordered sub-issues', repo);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cross-repository');
      expect(result.message).toContain('other/repo');
    }
  });

  it('rejects cross-repository shorthand references', () => {
    const body = ['## Ordered sub-issues', '- other/repo#7'].join('\n');
    const result = parseMarkdownSubIssues(body, 'Ordered sub-issues', repo);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cross-repository');
    }
  });

  it('returns an empty list when the heading is absent', () => {
    const body = ['## Something else', '- #1'].join('\n');
    expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
      ok: true,
      numbers: [],
    });
  });
});
