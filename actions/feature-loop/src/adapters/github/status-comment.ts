/**
 * Hidden machine-readable markers for status comments.
 *
 * Status comments embed an HTML comment marker that is invisible in rendered
 * Markdown but lets the loop find and update its own previous comment instead of
 * posting duplicates. These helpers are pure.
 */

/**
 * Build the hidden marker token for a given logical marker name.
 */
export function statusMarkerToken(marker: string): string {
  return `<!-- feature-loop:status:${marker} -->`;
}

/**
 * Build a status comment body that begins with the hidden marker token.
 */
export function buildStatusCommentBody(marker: string, body: string): string {
  return `${statusMarkerToken(marker)}\n${body}`;
}

/**
 * Whether a comment body carries the hidden marker token for `marker`.
 */
export function hasStatusMarker(commentBody: string, marker: string): boolean {
  return commentBody.includes(statusMarkerToken(marker));
}
