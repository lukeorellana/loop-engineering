/**
 * Pure Markdown parsing for epic bodies.
 *
 * The loop can discover ordered sub-issues from a Markdown section of the epic
 * body. This module is pure: it takes the epic body text, the configured
 * heading, and the repository identity, and returns the ordered issue numbers it
 * finds within that section. It performs no I/O.
 *
 * Two rules are enforced here so that adapters cannot bypass them:
 * - References are scoped to the configured heading's section only.
 * - Cross-repository references are rejected in v1 (fail closed).
 */

/**
 * The repository a Markdown reference must belong to. Comparison is
 * case-insensitive, matching GitHub's handling of owners and repository names.
 */
export interface MarkdownRepository {
  readonly owner: string;
  readonly name: string;
}

/**
 * The result of parsing the Markdown sub-issue section.
 */
export type MarkdownSubIssuesResult =
  | { readonly ok: true; readonly numbers: readonly number[] }
  | {
      readonly ok: false;
      readonly reason: 'cross-repository';
      readonly message: string;
    };

const HEADING_LINE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

// Matches an issue reference as one of:
//   - a full GitHub issue URL:  https://github.com/<owner>/<repo>/issues/<n>
//   - an owner/repo shorthand:  <owner>/<repo>#<n>
//   - a bare reference:         #<n>
// The leading (?<![\w/]) avoids matching inside larger tokens (for example the
// `#<n>` part of an owner/repo shorthand or a path segment).
const REFERENCE =
  /(?<![\w/])(?:https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)|([\w.-]+)\/([\w.-]+)#(\d+)|#(\d+))/g;

function normalizeHeading(text: string): string {
  return text.trim().toLowerCase();
}

function sameRepository(
  owner: string,
  name: string,
  repo: MarkdownRepository,
): boolean {
  return (
    owner.toLowerCase() === repo.owner.toLowerCase() &&
    name.toLowerCase() === repo.name.toLowerCase()
  );
}

/**
 * Extract the lines belonging to the section introduced by `heading`.
 *
 * The section starts after the first heading line whose text matches `heading`
 * (case-insensitively) and ends at the next heading line of any level, or at the
 * end of the body. Returns `null` when no matching heading exists.
 */
function extractSection(body: string, heading: string): string | null {
  const target = normalizeHeading(heading);
  const lines = body.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = HEADING_LINE.exec(lines[i]);
    if (match && normalizeHeading(match[2]) === target) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    return null;
  }
  const collected: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    if (HEADING_LINE.test(lines[i])) {
      break;
    }
    collected.push(lines[i]);
  }
  return collected.join('\n');
}

/**
 * Parse the ordered sub-issue numbers from the Markdown section identified by
 * `heading` in the epic `body`.
 *
 * Numbers are returned in first-appearance order with duplicates removed. A
 * missing section yields an empty list. A reference to any other repository
 * fails closed with a `cross-repository` result.
 */
export function parseMarkdownSubIssues(
  body: string | null | undefined,
  heading: string,
  repo: MarkdownRepository,
): MarkdownSubIssuesResult {
  if (!body) {
    return { ok: true, numbers: [] };
  }
  const section = extractSection(body, heading);
  if (section === null) {
    return { ok: true, numbers: [] };
  }

  const numbers: number[] = [];
  const seen = new Set<number>();
  REFERENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE.exec(section)) !== null) {
    const [, urlOwner, urlRepo, urlNumber, shortOwner, shortRepo, shortNumber] =
      match;
    const bareNumber = match[7];

    let number: number;
    if (urlNumber !== undefined) {
      if (!sameRepository(urlOwner, urlRepo, repo)) {
        return crossRepository(`${urlOwner}/${urlRepo}`, repo);
      }
      number = Number(urlNumber);
    } else if (shortNumber !== undefined) {
      if (!sameRepository(shortOwner, shortRepo, repo)) {
        return crossRepository(`${shortOwner}/${shortRepo}`, repo);
      }
      number = Number(shortNumber);
    } else {
      number = Number(bareNumber);
    }

    if (!seen.has(number)) {
      seen.add(number);
      numbers.push(number);
    }
  }

  return { ok: true, numbers };
}

function crossRepository(
  found: string,
  repo: MarkdownRepository,
): MarkdownSubIssuesResult {
  return {
    ok: false,
    reason: 'cross-repository',
    message:
      `Cross-repository sub-issue reference to "${found}" is not allowed in v1. ` +
      `Only references within "${repo.owner}/${repo.name}" are supported.`,
  };
}
