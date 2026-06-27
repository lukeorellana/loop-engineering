/**
 * The Copilot Agent Tasks provider — the clean boundary the triage
 * orchestration calls.
 *
 * The orchestration speaks only {@link AgentTasksProvider}: it asks to start a
 * task with a resolved delivery target, a model decision, and a prompt, and gets
 * back either a started task or a stable {@link AgentTasksFailureReason}. None of
 * the preview API's request or response types cross this boundary; the provider
 * builds the wire payload (see {@link buildAgentTaskRequestBody}), calls the
 * narrow {@link AgentTasksTransport}, classifies failures, and maps the response.
 *
 * Request construction follows the two delivery modes exactly:
 * - Existing PR mode: `base_ref` and `head_ref` are both sent; no new PR is
 *   requested.
 * - New PR mode: only `base_ref` is sent (no `head_ref`) and
 *   `create_pull_request: true` is requested.
 *
 * The model is sent unchanged when supplied and omitted entirely when empty;
 * there is no local allowlist and no retry without the requested model.
 */

import {
  mapTaskList,
  mapTaskListItem,
  mapTaskResource,
  type AgentTaskListItem,
  type AgentTaskPullRequestRef,
  type AgentTaskRequestBody,
  type AgentTasksTransport,
} from './api.js';
import {
  AgentTasksError,
  sanitizeAgentTasksError,
  type AgentTasksFailureReason,
} from './errors.js';

/**
 * The clean, API-independent request the orchestration hands the provider.
 */
export interface StartTaskInput {
  /** The base ref the task targets. */
  readonly baseRef: string;
  /**
   * The existing PR head ref, present only for existing-PR mode. When present,
   * the provider reuses the existing pull request and requests no new one; when
   * absent, the provider requests a new pull request.
   */
  readonly headRef?: string;
  /** The exact model override, or `undefined` to let the API choose. */
  readonly model?: string;
  /** The full triage prompt. Sensitive — never logged. */
  readonly prompt: string;
}

/** A successfully started Agent Tasks task. */
export interface StartedTask {
  readonly taskId: string;
  readonly taskUrl: string;
}

/**
 * An existing Agent Task discovered by fingerprint or listed as prior history.
 * It carries only bounded, diagnosis-useful fields — never the full prior
 * prompt.
 */
export interface ExistingTask {
  readonly taskId: string;
  readonly taskUrl: string;
  /** The task lifecycle state, when reported. */
  readonly state?: string;
  /** A short, truncated approach summary, when known. */
  readonly summary?: string;
  /** The CI Triage fingerprint parsed from the task, when present. */
  readonly fingerprint?: string;
  /** The associated pull request, when the API exposes one. */
  readonly pullRequest?: AgentTaskPullRequestRef;
}

/** The result of attempting to start a task. */
export type StartTaskResult =
  | { readonly ok: true; readonly task: StartedTask }
  | {
      readonly ok: false;
      readonly reason: AgentTasksFailureReason;
      /** A sanitized, secret-free message safe to surface anywhere. */
      readonly message: string;
    };

/**
 * The result of searching recent Agent Tasks for an exact fingerprint match.
 *
 * `ok: true` with `task: null` means the search ran but found no match (a new
 * task may be started). `ok: false` means the search itself could not be
 * performed reliably, so deduplication cannot be guaranteed and the caller must
 * fail closed rather than risk a duplicate.
 */
export type FindTaskResult =
  | { readonly ok: true; readonly task: ExistingTask | null }
  | {
      readonly ok: false;
      readonly reason: AgentTasksFailureReason;
      readonly message: string;
    };

/** The result of listing recent Agent Tasks for bounded history. */
export type RecentTasksResult =
  | { readonly ok: true; readonly tasks: readonly ExistingTask[] }
  | {
      readonly ok: false;
      readonly reason: AgentTasksFailureReason;
      readonly message: string;
    };

/**
 * The clean provider port the triage orchestration depends on.
 */
export interface AgentTasksProvider {
  startTask(input: StartTaskInput): Promise<StartTaskResult>;
  /**
   * Best-effort search of recent Agent Tasks for a task whose embedded
   * fingerprint marker matches `fingerprint`.
   */
  findTaskByFingerprint(fingerprint: string): Promise<FindTaskResult>;
  /** List recent Agent Tasks, reduced to bounded fields, for history. */
  listRecentTasks(): Promise<RecentTasksResult>;
}

/**
 * Build the exact create-task request body from a clean {@link StartTaskInput}.
 *
 * Pure and deterministic so contract tests can assert the precise field set for
 * every mode and model combination:
 * - `head_ref` is included only when an existing head ref is supplied.
 * - `create_pull_request: true` is included only when no head ref is supplied
 *   (new-PR mode).
 * - `model` is included only when a non-empty override is supplied; a
 *   whitespace-only or empty value is omitted entirely.
 */
export function buildAgentTaskRequestBody(
  input: StartTaskInput,
): AgentTaskRequestBody {
  const usesExistingPullRequest =
    input.headRef !== undefined && input.headRef !== '';
  const model =
    input.model !== undefined && input.model.trim() !== ''
      ? input.model
      : undefined;
  return {
    problem_statement: input.prompt,
    base_ref: input.baseRef,
    ...(usesExistingPullRequest ? { head_ref: input.headRef } : {}),
    ...(usesExistingPullRequest ? {} : { create_pull_request: true }),
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * Construction options for {@link GitHubAgentTasksProvider}.
 */
export interface GitHubAgentTasksProviderOptions {
  /** The transport boundary, built with the dedicated `agent-token`. */
  readonly transport: AgentTasksTransport;
}

/**
 * The maximum number of fingerprint-less candidates whose details are fetched
 * while searching for a fingerprint match. Bounds the extra reads a single
 * deduplication lookup may perform.
 */
export const FINGERPRINT_DETAIL_LOOKUP_CAP = 5;

/** The maximum number of previous attempts surfaced as bounded history. */
export const RECENT_TASKS_HISTORY_CAP = 10;

function toExistingTask(item: AgentTaskListItem): ExistingTask {
  return {
    taskId: item.id,
    taskUrl: item.htmlUrl,
    ...(item.state !== null ? { state: item.state } : {}),
    ...(item.summary !== null ? { summary: item.summary } : {}),
    ...(item.fingerprint !== null ? { fingerprint: item.fingerprint } : {}),
    ...(item.pullRequest !== null ? { pullRequest: item.pullRequest } : {}),
  };
}

/**
 * The default {@link AgentTasksProvider}, built over a {@link AgentTasksTransport}.
 */
export class GitHubAgentTasksProvider implements AgentTasksProvider {
  private readonly transport: AgentTasksTransport;

  constructor(options: GitHubAgentTasksProviderOptions) {
    this.transport = options.transport;
  }

  async startTask(input: StartTaskInput): Promise<StartTaskResult> {
    const body = buildAgentTaskRequestBody(input);

    let data: unknown;
    try {
      data = await this.transport.createTask(body);
    } catch (error) {
      const sanitized = sanitizeAgentTasksError(error);
      return {
        ok: false,
        reason: sanitized.reason,
        message: sanitized.message,
      };
    }

    const resource = mapTaskResource(data);
    if (resource === null) {
      const sanitized = new AgentTasksError('agent-unexpected-response');
      return {
        ok: false,
        reason: sanitized.reason,
        message: sanitized.message,
      };
    }
    return {
      ok: true,
      task: { taskId: resource.id, taskUrl: resource.htmlUrl },
    };
  }

  async findTaskByFingerprint(fingerprint: string): Promise<FindTaskResult> {
    let items: readonly AgentTaskListItem[];
    try {
      items = mapTaskList(await this.transport.listTasks());
    } catch (error) {
      const sanitized = sanitizeAgentTasksError(error);
      return {
        ok: false,
        reason: sanitized.reason,
        message: sanitized.message,
      };
    }

    const direct = items.find((item) => item.fingerprint === fingerprint);
    if (direct !== undefined) {
      return { ok: true, task: toExistingTask(direct) };
    }

    // Some list items may omit the prompt body that carries the marker. Resolve
    // a bounded number of those candidates' details to confirm or rule them out.
    const pending = items
      .filter((item) => item.fingerprint === null)
      .slice(0, FINGERPRINT_DETAIL_LOOKUP_CAP);
    for (const candidate of pending) {
      let detail: unknown;
      try {
        detail = await this.transport.getTask(candidate.id);
      } catch {
        // A single detail read failing does not invalidate the list-based
        // search; skip this candidate and keep looking.
        continue;
      }
      const resolved = mapTaskListItem(detail);
      if (resolved !== null && resolved.fingerprint === fingerprint) {
        return { ok: true, task: toExistingTask(resolved) };
      }
    }

    return { ok: true, task: null };
  }

  async listRecentTasks(): Promise<RecentTasksResult> {
    let items: readonly AgentTaskListItem[];
    try {
      items = mapTaskList(await this.transport.listTasks());
    } catch (error) {
      const sanitized = sanitizeAgentTasksError(error);
      return {
        ok: false,
        reason: sanitized.reason,
        message: sanitized.message,
      };
    }
    return {
      ok: true,
      tasks: items.slice(0, RECENT_TASKS_HISTORY_CAP).map(toExistingTask),
    };
  }
}
