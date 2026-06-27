/**
 * The narrow, API-specific Agent Tasks transport boundary.
 *
 * The provider depends only on {@link AgentTasksTransport}; the concrete
 * implementation (built by the composition layer with the dedicated
 * `agent-token`) is the only place that knows about HTTP, Octokit, the preview
 * path, or the pinned API version. Keeping the wire shapes here means the
 * preview API's request and response types never leak into the core triage
 * orchestration, which speaks only the clean provider port in
 * {@link ./provider.ts}.
 */

import { extractTaskFingerprint } from '../../domain/index.js';

/**
 * The exact JSON request body sent to the Agent Tasks create endpoint.
 *
 * Field presence is significant and is asserted by contract tests:
 * - `head_ref` is present only in existing-PR mode.
 * - `create_pull_request` is present (and `true`) only in new-PR mode.
 * - `model` is present only when a non-empty model override was supplied; it is
 *   omitted entirely (never sent empty) to let the API select its default.
 */
export interface AgentTaskRequestBody {
  /** The full triage prompt. Sensitive — never logged or echoed. */
  readonly problem_statement: string;
  /** The base ref the task targets. */
  readonly base_ref: string;
  /** The existing PR head ref (existing mode only). */
  readonly head_ref?: string;
  /** Whether the API should open a new pull request (new mode only). */
  readonly create_pull_request?: boolean;
  /** The exact model override, sent unchanged; omitted entirely when empty. */
  readonly model?: string;
}

/**
 * The minimal task resource the provider maps a successful response into. The
 * transport returns the raw response payload; the provider validates and reduces
 * it to this shape (or classifies an `agent-unexpected-response`).
 */
export interface AgentTaskResource {
  readonly id: string;
  readonly htmlUrl: string;
}

/**
 * The transport-level Agent Tasks operation the provider consumes.
 *
 * Implementations translate this into a single create-task HTTP request that
 * pins the documented API version header and targets the isolated preview path.
 * On any HTTP or network failure the implementation throws (carrying a numeric
 * `status` when available); the provider sanitizes the failure and never logs or
 * surfaces raw bodies, headers, or credentials.
 */
export interface AgentTasksTransport {
  /**
   * Start an Agent Tasks task. Returns the raw, unparsed response payload on a
   * successful (2xx) response; throws on any HTTP or network failure.
   */
  createTask(body: AgentTaskRequestBody): Promise<unknown>;

  /**
   * List recent Agent Tasks for the repository. Returns the raw, unparsed
   * response payload on a successful (2xx) response; throws on any HTTP or
   * network failure. Used both for best-effort fingerprint deduplication and for
   * collecting bounded previous-attempt history.
   */
  listTasks(): Promise<unknown>;

  /**
   * Retrieve a single candidate task's details (including the prompt body that
   * carries the fingerprint marker), or `null` when it no longer exists. Only
   * called when a list item lacks the data needed to match a fingerprint.
   */
  getTask(taskId: string): Promise<unknown>;
}

/**
 * The maximum number of characters retained for a previous-attempt approach
 * summary. The complete prior prompt is never carried across this boundary; only
 * a short, bounded summary field is exposed.
 */
export const PREVIOUS_APPROACH_SUMMARY_MAX = 280;

/** A pull request the Agent Tasks API associated with a previous attempt. */
export interface AgentTaskPullRequestRef {
  readonly number: number;
  readonly state: string;
  readonly url: string;
}

/**
 * A reduced, bounded view of one Agent Task as returned by the list endpoint.
 * It deliberately carries only diagnosis-useful fields and never the complete
 * prior prompt: {@link AgentTaskListItem.fingerprint} is parsed from the hidden
 * marker, and {@link AgentTaskListItem.summary} is a short, truncated approach
 * summary only.
 */
export interface AgentTaskListItem {
  readonly id: string;
  readonly htmlUrl: string;
  /** The task lifecycle state, when reported (for example `completed`). */
  readonly state: string | null;
  /** The CI Triage fingerprint parsed from the prompt marker, or `null`. */
  readonly fingerprint: string | null;
  /** A short, truncated approach summary, never the full prompt, when known. */
  readonly summary: string | null;
  /** The associated pull request, when the API exposes one. */
  readonly pullRequest: AgentTaskPullRequestRef | null;
}

function asId(raw: unknown): string | null {
  if (typeof raw === 'string' && raw !== '') {
    return raw;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(raw);
  }
  return null;
}

function asString(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

function truncateSummary(raw: unknown): string | null {
  const text = asString(raw);
  if (text === null) {
    return null;
  }
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine === '') {
    return null;
  }
  return firstLine.length <= PREVIOUS_APPROACH_SUMMARY_MAX
    ? firstLine
    : `${firstLine.slice(0, PREVIOUS_APPROACH_SUMMARY_MAX)}…`;
}

function mapPullRequestRef(raw: unknown): AgentTaskPullRequestRef | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const number = record.number;
  const url = asString(record.html_url ?? record.url);
  if (typeof number !== 'number' || !Number.isFinite(number) || url === null) {
    return null;
  }
  return {
    number,
    state: asString(record.state) ?? 'unknown',
    url,
  };
}

/**
 * The candidate fields a task body may live under across preview API shapes. The
 * fingerprint marker is searched in each so a format change on the server side
 * does not silently break deduplication.
 */
function bodyTextOf(record: Record<string, unknown>): string | null {
  const session =
    typeof record.session === 'object' && record.session !== null
      ? (record.session as Record<string, unknown>)
      : undefined;
  return (
    asString(record.problem_statement) ??
    asString(record.prompt) ??
    asString(record.body) ??
    (session !== undefined
      ? (asString(session.problem_statement) ?? asString(session.prompt))
      : null)
  );
}

/**
 * Reduce one raw task record to a bounded {@link AgentTaskListItem}, or `null`
 * when it lacks the minimal identity (id and URL).
 */
export function mapTaskListItem(data: unknown): AgentTaskListItem | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const id = asId(record.id);
  const htmlUrl = asString(record.html_url ?? record.url);
  if (id === null || htmlUrl === null) {
    return null;
  }
  const body = bodyTextOf(record);
  const fingerprint = body === null ? null : extractTaskFingerprint(body);
  const session =
    typeof record.session === 'object' && record.session !== null
      ? (record.session as Record<string, unknown>)
      : undefined;
  const summary = truncateSummary(
    record.summary ?? record.title ?? session?.summary,
  );
  return {
    id,
    htmlUrl,
    state: asString(record.state),
    fingerprint,
    summary,
    pullRequest: mapPullRequestRef(record.pull_request),
  };
}

/**
 * Reduce a raw list-tasks payload to bounded {@link AgentTaskListItem}s.
 *
 * Defensive across preview shapes: it accepts a bare array or an envelope
 * carrying `agent_tasks`, `tasks`, or `items`, and silently drops any element
 * that lacks the minimal identity rather than throwing.
 */
export function mapTaskList(data: unknown): readonly AgentTaskListItem[] {
  let items: readonly unknown[];
  if (Array.isArray(data)) {
    items = data;
  } else if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>;
    const candidate =
      record.agent_tasks ?? record.tasks ?? record.items ?? null;
    items = Array.isArray(candidate) ? candidate : [];
  } else {
    items = [];
  }
  return items
    .map((item) => mapTaskListItem(item))
    .filter((item): item is AgentTaskListItem => item !== null);
}

/**
 * Reduce a raw create-task response payload to the minimal {@link
 * AgentTaskResource}, or `null` when the shape is not recognized.
 *
 * Pure and defensive: it accepts a string or numeric `id` and either `html_url`
 * or `url`, and reports `null` (rather than throwing) for anything else so the
 * provider can classify a malformed response as `agent-unexpected-response`.
 */
export function mapTaskResource(data: unknown): AgentTaskResource | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const rawId = record.id;
  const id =
    typeof rawId === 'string'
      ? rawId
      : typeof rawId === 'number' && Number.isFinite(rawId)
        ? String(rawId)
        : null;
  const rawUrl = record.html_url ?? record.url;
  const htmlUrl = typeof rawUrl === 'string' && rawUrl !== '' ? rawUrl : null;
  if (id === null || id === '' || htmlUrl === null) {
    return null;
  }
  return { id, htmlUrl };
}
