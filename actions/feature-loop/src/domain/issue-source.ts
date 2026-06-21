/**
 * Deterministic issue-source resolution.
 *
 * Given the configured {@link IssueSource} and the ordered sub-issue numbers
 * discovered from native GitHub sub-issues and from the Markdown section, decide
 * which ordered list controls the loop. This is pure preflight logic; it does
 * not read from GitHub and does not select an individual issue.
 */

import type { IssueSource } from '../config/schema.js';

/**
 * The outcome of resolving which sub-issue source to use.
 */
export type IssueSourceResolution =
  | {
      readonly ok: true;
      readonly source: 'native' | 'markdown';
      readonly issues: readonly number[];
    }
  | {
      readonly ok: false;
      readonly reason: 'ambiguous-sources';
      readonly message: string;
    };

function listsEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

/**
 * Resolve the controlling ordered sub-issue list.
 *
 * - `native`: always use the native list.
 * - `markdown`: always use the Markdown list.
 * - `auto`: use native when non-empty; otherwise Markdown. When both are
 *   non-empty and differ, fail preflight (fail closed).
 */
export function resolveIssueSource(
  source: IssueSource,
  native: readonly number[],
  markdown: readonly number[],
): IssueSourceResolution {
  switch (source) {
    case 'native':
      return { ok: true, source: 'native', issues: native };
    case 'markdown':
      return { ok: true, source: 'markdown', issues: markdown };
    case 'auto': {
      const nativeNonEmpty = native.length > 0;
      const markdownNonEmpty = markdown.length > 0;
      if (nativeNonEmpty && markdownNonEmpty && !listsEqual(native, markdown)) {
        return {
          ok: false,
          reason: 'ambiguous-sources',
          message:
            'Native sub-issues and the Markdown section are both present but differ. ' +
            'Resolve the mismatch or set "issues.source" explicitly.',
        };
      }
      if (nativeNonEmpty) {
        return { ok: true, source: 'native', issues: native };
      }
      return { ok: true, source: 'markdown', issues: markdown };
    }
  }
}
