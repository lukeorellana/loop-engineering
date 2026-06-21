/**
 * Hidden machine-readable Feature Loop status payloads.
 *
 * Every status comment the orchestrator posts carries a hidden marker (so a prior
 * status comment is updated in place instead of duplicated) and an embedded,
 * machine-readable JSON payload describing at least the epic, the active issue,
 * the provider, and the start timestamp. The payload is hidden inside an HTML
 * comment so it is invisible in rendered Markdown but recoverable on the next
 * run (for example to report the age of stalled active work).
 *
 * These helpers are pure. The human-readable body must already be sanitized by
 * the caller; raw provider errors and transport details never reach a comment.
 */

import {
  buildStatusCommentBody,
  statusMarkerToken,
} from '../adapters/github/status-comment.js';

/** The logical marker name used to scope a per-epic status comment. */
export function epicStatusMarker(epicNumber: number): string {
  return `epic-${epicNumber}`;
}

/**
 * The machine-readable status payload embedded in a status comment.
 */
export interface LoopStatusData {
  /** The epic issue number. */
  readonly epic: number;
  /** The sub-issue the status describes, when one applies. */
  readonly issue?: number;
  /** The coding-agent provider identifier. */
  readonly provider: string;
  /** The canonical loop state (for example `running`, `paused`, `complete`). */
  readonly state: string;
  /** A stable machine-readable reason code. */
  readonly reason: string;
  /** ISO-8601 instant the active issue was started, when one applies. */
  readonly startedAt?: string;
}

// The payload is embedded inside an HTML comment. JSON never contains the `-->`
// sequence, so it is always safe to embed and recover.
const DATA_PREFIX = '<!-- feature-loop:data:';
const DATA_SUFFIX = ' -->';
const DATA_PATTERN = /<!-- feature-loop:data:(.*?) -->/s;

/**
 * Serialize a status payload into a hidden HTML comment token.
 */
export function encodeStatusData(data: LoopStatusData): string {
  return `${DATA_PREFIX}${JSON.stringify(data)}${DATA_SUFFIX}`;
}

/**
 * Recover the machine-readable status payload embedded in a comment body, or
 * `null` when no valid payload is present.
 */
export function decodeStatusData(body: string | null): LoopStatusData | null {
  if (body === null) {
    return null;
  }
  const match = DATA_PATTERN.exec(body);
  if (match === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as LoopStatusData).epic === 'number' &&
      typeof (parsed as LoopStatusData).provider === 'string'
    ) {
      return parsed as LoopStatusData;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Build the full status comment body: the hidden dedupe marker, the embedded
 * machine-readable payload, and the (already sanitized) human-readable text.
 */
export function buildStatusComment(
  data: LoopStatusData,
  humanText: string,
): { readonly marker: string; readonly body: string } {
  const marker = epicStatusMarker(data.epic);
  const body = buildStatusCommentBody(
    marker,
    `${encodeStatusData(data)}\n\n${humanText}`,
  );
  return { marker, body };
}

/** Expose the marker token for tests and callers that need to assert dedupe. */
export function epicStatusMarkerToken(epicNumber: number): string {
  return statusMarkerToken(epicStatusMarker(epicNumber));
}
