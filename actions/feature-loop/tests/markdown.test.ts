import { describe, expect, it } from 'vitest';

import { parseMarkdownSubIssues } from '../src/domain/markdown.js';

const repo = { owner: 'octo', name: 'demo' };

describe('parseMarkdownSubIssues', () => {
  describe('empty and missing bodies', () => {
    it('returns an empty list for an empty or missing body', () => {
      expect(parseMarkdownSubIssues(null, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [],
        discovery: 'none',
      });
      expect(parseMarkdownSubIssues('', 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [],
        discovery: 'none',
      });
    });

    it('returns an empty list when no candidate section exists', () => {
      const body = ['## Something else', '- #1'].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [],
        discovery: 'none',
      });
    });
  });

  describe('configured heading (backward compatible)', () => {
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
      expect(result).toEqual({
        ok: true,
        numbers: [10, 11],
        discovery: 'configured-heading',
      });
    });

    it('matches the heading case-insensitively and at any level', () => {
      const body = ['# ORDERED SUB-ISSUES', '- #5', '- #6'].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [5, 6],
        discovery: 'configured-heading',
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
        discovery: 'configured-heading',
      });
    });
  });

  describe('machine-readable marker', () => {
    it('discovers a marked section regardless of heading wording', () => {
      const body = [
        '<!-- feature-loop:ordered-issues -->',
        '',
        '## Execution sequence',
        '',
        '1. octo/demo#101 — First task',
        '2. octo/demo#102 — Second task',
        '',
        '## Notes',
        '1. octo/demo#900',
      ].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [101, 102],
        discovery: 'marker',
      });
    });

    it('discovers a marked list that directly follows the marker', () => {
      const body = [
        '<!-- feature-loop:ordered-issues -->',
        '1. #1',
        '2. #2',
      ].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [1, 2],
        discovery: 'marker',
      });
    });

    it('tolerates leading and trailing whitespace around the marker', () => {
      const body = [
        '   <!--   feature-loop:ordered-issues   -->   ',
        '## Whatever',
        '1. #7',
      ].join('\n');
      const result = parseMarkdownSubIssues(body, 'Ordered sub-issues', repo);
      expect(result).toEqual({ ok: true, numbers: [7], discovery: 'marker' });
    });

    it('prevents unrelated structural candidates from causing ambiguity', () => {
      const body = [
        '<!-- feature-loop:ordered-issues -->',
        '## Plan',
        '1. #1',
        '2. #2',
        '',
        '## Implementation sequence',
        '1. #3',
        '2. #4',
      ].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [1, 2],
        discovery: 'marker',
      });
    });

    it('fails closed when the marker has no ordered issue list', () => {
      const body = [
        '<!-- feature-loop:ordered-issues -->',
        '## Plan',
        '- #1',
        '- #2',
      ].join('\n');
      const result = parseMarkdownSubIssues(body, 'Ordered sub-issues', repo);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('ordered-issues-marker-empty');
      }
    });

    it('fails closed when multiple markers are present', () => {
      const body = [
        '<!-- feature-loop:ordered-issues -->',
        '## A',
        '1. #1',
        '<!-- feature-loop:ordered-issues -->',
        '## B',
        '1. #2',
      ].join('\n');
      const result = parseMarkdownSubIssues(body, 'Ordered sub-issues', repo);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('multiple-ordered-issues-markers');
      }
    });

    it('ignores marker-like text inside fenced code blocks', () => {
      const body = [
        '## Example',
        '',
        '```md',
        '<!-- feature-loop:ordered-issues -->',
        '1. #999',
        '```',
        '',
        '## Implementation tasks',
        '1. #1',
        '2. #2',
      ].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [1, 2],
        discovery: 'structural',
      });
    });

    it('ignores marker-like text inside blockquotes', () => {
      const body = [
        '> <!-- feature-loop:ordered-issues -->',
        '> 1. #999',
        '',
        '## Implementation tasks',
        '1. #1',
        '2. #2',
      ].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [1, 2],
        discovery: 'structural',
      });
    });
  });

  describe('structural fallback', () => {
    it('discovers a single arbitrary heading followed by an ordered list', () => {
      const body = [
        '## Ordered child issues',
        '',
        '1. octo/demo#171 — Prove feasibility',
        '2. octo/demo#172 — Build the package',
      ].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [171, 172],
        discovery: 'structural',
      });
    });

    it('supports the 1) numbering style and trailing prose', () => {
      const body = [
        '### Implementation sequence',
        '',
        '1) octo/demo#201 First change',
        '2) octo/demo#202 Second change',
      ].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [201, 202],
        discovery: 'structural',
      });
    });

    it('does not select generic dependency bullet lists', () => {
      const body = [
        '## Dependencies',
        '',
        '- Depends on octo/demo#50',
        '- Related to octo/demo#60',
      ].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [],
        discovery: 'none',
      });
    });

    it('does not select acceptance-criteria checklists', () => {
      const body = [
        '## Acceptance criteria',
        '',
        '- [ ] Follow up in octo/demo#70',
        '- [ ] Documentation tracked by octo/demo#71',
      ].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [],
        discovery: 'none',
      });
    });

    it('does not select an ordered list of prose without issue references', () => {
      const body = [
        '## Steps',
        '',
        '1. Do the first thing',
        '2. Do the second thing',
      ].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [],
        discovery: 'none',
      });
    });

    it('fails closed when multiple structural candidates exist', () => {
      const body = [
        '## Implementation sequence',
        '1. #1',
        '2. #2',
        '',
        '## Feature tasks',
        '1. #3',
        '2. #4',
      ].join('\n');
      const result = parseMarkdownSubIssues(body, 'Ordered sub-issues', repo);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('ambiguous-ordered-issue-sections');
        expect(result.message).toContain('Implementation sequence');
        expect(result.message).toContain('Feature tasks');
        expect(result.message).toContain('line');
      }
    });
  });

  describe('precedence', () => {
    it('prefers the configured heading over a structural candidate', () => {
      const body = [
        '## Ordered sub-issues',
        '- #10',
        '- #11',
        '',
        '## Implementation tasks',
        '1. #20',
        '2. #21',
      ].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [10, 11],
        discovery: 'configured-heading',
      });
    });
  });

  describe('centralized validation', () => {
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

    it('rejects cross-repository references inside a structural list', () => {
      const body = ['## Plan', '1. other/repo#7', '2. #8'].join('\n');
      const result = parseMarkdownSubIssues(body, 'Ordered sub-issues', repo);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('cross-repository');
      }
    });

    it('fails closed on duplicate issue numbers', () => {
      const body = ['## Ordered sub-issues', '- #3', '- #1', '- #3'].join('\n');
      const result = parseMarkdownSubIssues(body, 'Ordered sub-issues', repo);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('duplicate-ordered-issue-reference');
      }
    });

    it('fails closed on a self-referential issue number', () => {
      const body = ['## Plan', '1. #5', '2. #6'].join('\n');
      const result = parseMarkdownSubIssues(
        body,
        'Ordered sub-issues',
        repo,
        5,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('self-referential-ordered-issue');
      }
    });

    it('preserves first-appearance order', () => {
      const body = ['## Plan', '1. #3', '2. #1', '3. #2'].join('\n');
      expect(parseMarkdownSubIssues(body, 'Ordered sub-issues', repo)).toEqual({
        ok: true,
        numbers: [3, 1, 2],
        discovery: 'structural',
      });
    });
  });
});
