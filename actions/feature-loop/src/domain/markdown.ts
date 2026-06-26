/**
 * Pure Markdown parsing for epic bodies.
 *
 * The loop can discover the ordered sub-issue list from a Markdown section of
 * the epic body. This module is pure: it takes the epic body text, the
 * configured heading, the repository identity, and the epic number, and returns
 * the ordered issue numbers it finds. It performs no I/O.
 *
 * Discovery follows a strict precedence so that newly authored epics have a
 * stable machine contract while existing epics keep working:
 *
 *   1. A single machine-readable marker (`<!-- feature-loop:ordered-issues -->`)
 *      identifies the authoritative ordered-issue section, regardless of the
 *      heading wording that follows it.
 *   2. Otherwise the exact configured heading is used (backward compatible).
 *   3. Otherwise exactly one structurally valid section — a heading followed by
 *      an ordered list of issue references — is used.
 *   4. No candidates yields an empty list with an actionable diagnostic.
 *   5. Multiple candidates (or multiple markers) fail closed as ambiguous.
 *
 * Several rules are enforced here so adapters cannot bypass them and so every
 * mode follows identical validation:
 * - References are scoped to the selected section only.
 * - Cross-repository references are rejected in v1 (fail closed).
 * - Duplicate and self-referential issue numbers fail closed.
 * - Markers and headings inside fenced code blocks are ignored.
 */

/**
 * The repository a Markdown reference must belong to. Comparison is
 * case-insensitive, matching GitHub's handling of owners and repository names.
 */
export interface MarkdownRepository {
  readonly owner: string;
  readonly name: string;
}

/** How the ordered-issue section was discovered. */
export type MarkdownDiscoverySource =
  | 'marker'
  | 'configured-heading'
  | 'structural';

/** Stable, actionable reasons a Markdown discovery fails closed. */
export type MarkdownDiscoveryReason =
  | 'cross-repository'
  | 'ordered-issues-marker-empty'
  | 'multiple-ordered-issues-markers'
  | 'ambiguous-ordered-issue-sections'
  | 'duplicate-ordered-issue-reference'
  | 'self-referential-ordered-issue';

/**
 * The result of parsing the Markdown sub-issue section. On success, `discovery`
 * reports which precedence rule selected the list (or `none` when no section
 * was found) so callers can report it in dry-run output.
 */
export type MarkdownSubIssuesResult =
  | {
      readonly ok: true;
      readonly numbers: readonly number[];
      readonly discovery: MarkdownDiscoverySource | 'none';
    }
  | {
      readonly ok: false;
      readonly reason: MarkdownDiscoveryReason;
      readonly message: string;
    };

const HEADING_LINE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

// The authoritative parser marker. Recognized only on its own line (after
// optional leading/trailing whitespace) and outside fenced code blocks, so
// marker-like text inside code fences or blockquotes is never authoritative.
const MARKER_LINE = /^\s*<!--\s*feature-loop:ordered-issues\s*-->\s*$/;

// Opening or closing fence for a fenced code block (``` or ~~~).
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

// An ordered-list item: `1.`, `1)`, `2.`, etc., capturing the item text.
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*\S.*)$/;

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

/** A single scanned line annotated with its structural role. */
interface ScannedLine {
  readonly text: string;
  /** Whether the line is inside (or delimits) a fenced code block. */
  readonly code: boolean;
  /** The heading level when the line is a heading (outside code), else null. */
  readonly headingLevel: number | null;
  /** The heading text when the line is a heading, else null. */
  readonly headingText: string | null;
  /** Whether the line is an active Feature Loop marker (outside code). */
  readonly marker: boolean;
}

/**
 * Scan the body into annotated lines, tracking fenced code blocks so headings
 * and markers inside fences are not treated as structure.
 */
function scanLines(body: string): ScannedLine[] {
  const lines = body.split(/\r?\n/);
  const scanned: ScannedLine[] = [];
  let inFence = false;
  for (const text of lines) {
    if (FENCE_LINE.test(text)) {
      // The fence delimiter line itself is part of the code-block boundary.
      scanned.push({
        text,
        code: true,
        headingLevel: null,
        headingText: null,
        marker: false,
      });
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      scanned.push({
        text,
        code: true,
        headingLevel: null,
        headingText: null,
        marker: false,
      });
      continue;
    }
    const heading = HEADING_LINE.exec(text);
    scanned.push({
      text,
      code: false,
      headingLevel: heading ? heading[1].length : null,
      headingText: heading ? heading[2] : null,
      marker: MARKER_LINE.test(text),
    });
  }
  return scanned;
}

/**
 * The text used for ordered-list and reference detection: the raw line text,
 * but blank for fenced-code lines so example lists inside code fences are never
 * treated as structure.
 */
function contentText(line: ScannedLine): string {
  return line.code ? '' : line.text;
}

/** A reference resolved against the repository, before number validation. */
type ReferenceParse =
  | { readonly kind: 'same'; readonly number: number }
  | { readonly kind: 'cross'; readonly found: string };

function parseReferenceMatch(
  match: RegExpExecArray,
  repo: MarkdownRepository,
): ReferenceParse {
  const [, urlOwner, urlRepo, urlNumber, shortOwner, shortRepo, shortNumber] =
    match;
  const bareNumber = match[7];
  if (urlNumber !== undefined) {
    if (!sameRepository(urlOwner, urlRepo, repo)) {
      return { kind: 'cross', found: `${urlOwner}/${urlRepo}` };
    }
    return { kind: 'same', number: Number(urlNumber) };
  }
  if (shortNumber !== undefined) {
    if (!sameRepository(shortOwner, shortRepo, repo)) {
      return { kind: 'cross', found: `${shortOwner}/${shortRepo}` };
    }
    return { kind: 'same', number: Number(shortNumber) };
  }
  return { kind: 'same', number: Number(bareNumber) };
}

/** Every issue reference found in `text`, in first-appearance order. */
function referenceMatches(text: string): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  REFERENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE.exec(text)) !== null) {
    matches.push(match);
  }
  return matches;
}

type BuildNumbersResult =
  | { readonly ok: true; readonly numbers: number[] }
  | { readonly ok: false; readonly result: MarkdownSubIssuesResult };

/**
 * Validate an ordered set of resolved references and produce the final numbers.
 * Centralized so marker, configured-heading, and structural modes fail closed
 * on identical rules: cross-repository, self-reference, and duplicates.
 */
function buildNumbers(
  references: readonly ReferenceParse[],
  repo: MarkdownRepository,
  epicNumber: number | undefined,
): BuildNumbersResult {
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const reference of references) {
    if (reference.kind === 'cross') {
      return { ok: false, result: crossRepository(reference.found, repo) };
    }
    const number = reference.number;
    if (epicNumber !== undefined && number === epicNumber) {
      return { ok: false, result: selfReferential(number) };
    }
    if (seen.has(number)) {
      return { ok: false, result: duplicateReference(number) };
    }
    seen.add(number);
    numbers.push(number);
  }
  return { ok: true, numbers };
}

/**
 * Extract the ordered references from a section's content lines when, and only
 * when, the content forms a qualifying ordered issue list: a consecutive
 * ordered list (`1.`, `1)`, ...) in which every item carries exactly one issue
 * reference. Returns `null` when the content is not such a list (for example a
 * bullet/checklist or an ordered list of prose), so generic dependency or
 * acceptance-criteria sections are never selected.
 */
function orderedListReferences(
  lines: readonly string[],
  repo: MarkdownRepository,
): ReferenceParse[] | null {
  const runs: string[][] = [];
  let run: string[] = [];
  for (const line of lines) {
    const item = ORDERED_ITEM.exec(line);
    if (item) {
      run.push(item[1]);
      continue;
    }
    if (line.trim() === '') {
      // Blank lines do not break a loose ordered list.
      continue;
    }
    if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 0) {
    runs.push(run);
  }

  for (const candidate of runs) {
    const references: ReferenceParse[] = [];
    let qualifies = true;
    for (const itemText of candidate) {
      const matches = referenceMatches(itemText);
      if (matches.length !== 1) {
        // An ordered item with no reference (prose) or multiple references is
        // not a clean one-issue-per-item list.
        qualifies = false;
        break;
      }
      references.push(parseReferenceMatch(matches[0], repo));
    }
    if (qualifies && references.length > 0) {
      return references;
    }
  }
  return null;
}

/** A discovered section eligible as an ordered-issue candidate. */
interface SectionCandidate {
  readonly heading: string;
  readonly headingLevel: number;
  /** 1-based line number of the heading. */
  readonly startLine: number;
  readonly references: readonly ReferenceParse[];
}

/**
 * Parse the ordered sub-issue numbers from the epic `body`.
 *
 * Numbers are returned in first-appearance order. Discovery precedence is
 * marker, then the exact configured `heading`, then a single structural
 * candidate. Ambiguous markers or structural candidates fail closed, as do
 * cross-repository, duplicate, and self-referential references. A body with no
 * candidate section yields an empty list (`discovery: 'none'`).
 */
export function parseMarkdownSubIssues(
  body: string | null | undefined,
  heading: string,
  repo: MarkdownRepository,
  epicNumber?: number,
): MarkdownSubIssuesResult {
  if (!body) {
    return { ok: true, numbers: [], discovery: 'none' };
  }
  const scanned = scanLines(body);

  // 1. Machine-readable marker takes precedence over everything else.
  const markerIndices: number[] = [];
  for (let i = 0; i < scanned.length; i += 1) {
    if (scanned[i].marker) {
      markerIndices.push(i);
    }
  }
  if (markerIndices.length > 1) {
    return multipleMarkers();
  }
  if (markerIndices.length === 1) {
    return discoverFromMarker(scanned, markerIndices[0], repo, epicNumber);
  }

  // 2. Exact configured heading (backward compatible, lenient extraction).
  const configured = extractConfiguredSection(scanned, heading);
  if (configured !== null) {
    const references = referenceMatches(configured).map((match) =>
      parseReferenceMatch(match, repo),
    );
    const built = buildNumbers(references, repo, epicNumber);
    if (!built.ok) {
      return built.result;
    }
    return {
      ok: true,
      numbers: built.numbers,
      discovery: 'configured-heading',
    };
  }

  // 3. Structural fallback: exactly one heading followed by an ordered list.
  return discoverStructural(scanned, repo, epicNumber);
}

/**
 * Extract the text of the section introduced by the configured `heading`. The
 * section starts after the first matching heading and ends at the next heading
 * of any level, or end of body. Returns `null` when no matching heading exists.
 */
function extractConfiguredSection(
  scanned: readonly ScannedLine[],
  heading: string,
): string | null {
  const target = normalizeHeading(heading);
  let start = -1;
  for (let i = 0; i < scanned.length; i += 1) {
    const line = scanned[i];
    if (
      line.headingText !== null &&
      normalizeHeading(line.headingText) === target
    ) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    return null;
  }
  const collected: string[] = [];
  for (let i = start; i < scanned.length; i += 1) {
    if (scanned[i].headingLevel !== null) {
      break;
    }
    collected.push(contentText(scanned[i]));
  }
  return collected.join('\n');
}

/**
 * Resolve the ordered-issue list selected by the single active marker. The
 * marker selects the following section: parsing the heading that follows it (or
 * a list immediately after it) and stopping at the next heading of the same or
 * higher level, another marker, or end of body.
 */
function discoverFromMarker(
  scanned: readonly ScannedLine[],
  markerIndex: number,
  repo: MarkdownRepository,
  epicNumber: number | undefined,
): MarkdownSubIssuesResult {
  let cursor = markerIndex + 1;
  // Skip blank lines between the marker and the section it introduces.
  while (cursor < scanned.length && scanned[cursor].text.trim() === '') {
    cursor += 1;
  }

  let anchorLevel: number | null = null;
  let contentStart = cursor;
  if (cursor < scanned.length && scanned[cursor].headingLevel !== null) {
    anchorLevel = scanned[cursor].headingLevel;
    contentStart = cursor + 1;
  }

  const contentLines: string[] = [];
  for (let i = contentStart; i < scanned.length; i += 1) {
    const line = scanned[i];
    if (line.marker) {
      break;
    }
    if (line.headingLevel !== null) {
      if (anchorLevel === null || line.headingLevel <= anchorLevel) {
        break;
      }
    }
    contentLines.push(contentText(line));
  }

  const references = orderedListReferences(contentLines, repo);
  if (references === null || references.length === 0) {
    return markerEmpty();
  }
  const built = buildNumbers(references, repo, epicNumber);
  if (!built.ok) {
    return built.result;
  }
  return { ok: true, numbers: built.numbers, discovery: 'marker' };
}

/**
 * Enumerate every heading section that structurally looks like an ordered issue
 * list and select the single candidate. Zero candidates yields an empty list;
 * more than one fails closed as ambiguous, naming the candidate headings and
 * their line numbers.
 */
function discoverStructural(
  scanned: readonly ScannedLine[],
  repo: MarkdownRepository,
  epicNumber: number | undefined,
): MarkdownSubIssuesResult {
  const candidates: SectionCandidate[] = [];
  for (let i = 0; i < scanned.length; i += 1) {
    const line = scanned[i];
    if (line.headingLevel === null || line.headingText === null) {
      continue;
    }
    const contentLines: string[] = [];
    for (let j = i + 1; j < scanned.length; j += 1) {
      if (scanned[j].headingLevel !== null) {
        break;
      }
      contentLines.push(contentText(scanned[j]));
    }
    const references = orderedListReferences(contentLines, repo);
    if (references !== null && references.length > 0) {
      candidates.push({
        heading: line.headingText.trim(),
        headingLevel: line.headingLevel,
        startLine: i + 1,
        references,
      });
    }
  }

  if (candidates.length === 0) {
    return { ok: true, numbers: [], discovery: 'none' };
  }
  if (candidates.length > 1) {
    return ambiguousSections(candidates);
  }
  const built = buildNumbers(candidates[0].references, repo, epicNumber);
  if (!built.ok) {
    return built.result;
  }
  return { ok: true, numbers: built.numbers, discovery: 'structural' };
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

function duplicateReference(number: number): MarkdownSubIssuesResult {
  return {
    ok: false,
    reason: 'duplicate-ordered-issue-reference',
    message:
      `Ordered issue #${number} is referenced more than once. ` +
      'Each issue may appear at most once in the ordered list.',
  };
}

function selfReferential(number: number): MarkdownSubIssuesResult {
  return {
    ok: false,
    reason: 'self-referential-ordered-issue',
    message:
      `The ordered issue list references the epic itself (#${number}). ` +
      'An epic cannot be one of its own ordered sub-issues.',
  };
}

function markerEmpty(): MarkdownSubIssuesResult {
  return {
    ok: false,
    reason: 'ordered-issues-marker-empty',
    message:
      'The <!-- feature-loop:ordered-issues --> marker is not followed by an ordered ' +
      'list of issue references. Add a numbered list of same-repository issues after the marker.',
  };
}

function multipleMarkers(): MarkdownSubIssuesResult {
  return {
    ok: false,
    reason: 'multiple-ordered-issues-markers',
    message:
      'The epic body contains more than one <!-- feature-loop:ordered-issues --> marker. ' +
      'Keep exactly one marker before the authoritative ordered issue section.',
  };
}

function ambiguousSections(
  candidates: readonly SectionCandidate[],
): MarkdownSubIssuesResult {
  const list = candidates
    .map(
      (candidate) => `- "${candidate.heading}" at line ${candidate.startLine}`,
    )
    .join('\n');
  return {
    ok: false,
    reason: 'ambiguous-ordered-issue-sections',
    message:
      'The epic contains multiple possible ordered issue sections:\n' +
      `${list}\n` +
      'Add <!-- feature-loop:ordered-issues --> before the authoritative section.',
  };
}
