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
