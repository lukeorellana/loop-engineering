/**
 * GitHub Copilot coding-agent provider.
 *
 * Implements {@link AgentProviderPort} on top of the narrow
 * {@link CopilotAgentApi} GraphQL boundary. The provider owns Copilot actor
 * discovery (including documented legacy logins), already-assigned detection,
 * model omission for automatic selection, error sanitization, and safe
 * reconciliation of uncertain assignment mutations. It never exposes Octokit
 * types or raw GraphQL responses, and never logs or posts credentials, tokens,
 * or response bodies.
 *
 * The transport is constructed by the composition layer with the dedicated
 * agent-assignment credential, kept separate from the ordinary repository token
 * used by the repository adapter.
 */
import type {
  AgentPreflightRequest,
  AgentPreflightResult,
  AgentStartRequest,
  AgentStartResult,
} from '../../domain/agent.js';
import type { AgentProviderPort } from '../../ports/agent-provider.js';
import type { Clock } from '../../ports/clock.js';
import {
  type AssignActorRequest,
  type AssignableActor,
  type AssignableIssue,
  type CopilotAgentApi,
} from './api.js';
import {
  COPILOT_ACTOR_LOGINS,
  findCopilotActor,
  isCopilotLogin,
} from './actors.js';
import { CopilotProviderError, sanitizeCopilotError } from './errors.js';

/** The stable provider identifier. */
export const GITHUB_COPILOT_PROVIDER_ID = 'github-copilot';

/**
 * Construction options for {@link GitHubCopilotProvider}.
 */
export interface GitHubCopilotProviderOptions {
  /** The GraphQL transport boundary, built with the agent-assignment token. */
  readonly api: CopilotAgentApi;
  /** Clock used to stamp the assignment time. */
  readonly clock: Clock;
}

export class GitHubCopilotProvider implements AgentProviderPort {
  readonly id = GITHUB_COPILOT_PROVIDER_ID;

  /** Known Copilot coding-agent author logins, current first. */
  readonly authorLogins = COPILOT_ACTOR_LOGINS;

  private readonly api: CopilotAgentApi;
  private readonly clock: Clock;

  constructor(options: GitHubCopilotProviderOptions) {
    this.api = options.api;
    this.clock = options.clock;
  }

  async preflight(
    request: AgentPreflightRequest,
  ): Promise<AgentPreflightResult> {
    void request;
    let actors: readonly AssignableActor[];
    try {
      actors = await this.api.getAssignableActors();
    } catch (error) {
      const sanitized = sanitizeCopilotError('discover Copilot actor', error);
      return {
        ok: false,
        reason: sanitized.reason,
        messages: [sanitized.message],
      };
    }
    if (findCopilotActor(actors) === null) {
      const sanitized = new CopilotProviderError(
        'discover Copilot actor',
        'actor-not-found',
      );
      return {
        ok: false,
        reason: 'actor-not-found',
        messages: [sanitized.message],
      };
    }
    return { ok: true };
  }

  async isAlreadyStarted(request: AgentStartRequest): Promise<boolean> {
    const issue = await this.run('check Copilot assignment', () =>
      this.api.getAssignableIssue(request.issue.number),
    );
    return issue !== null && this.copilotIsAssigned(issue);
  }

  async startAgent(request: AgentStartRequest): Promise<AgentStartResult> {
    const issueNumber = request.issue.number;

    // Dry-run is strictly read-only: never mutate, report only what is known.
    if (request.dryRun) {
      const issue = await this.run('check Copilot assignment', () =>
        this.api.getAssignableIssue(issueNumber),
      );
      if (issue !== null && this.copilotIsAssigned(issue)) {
        return { status: 'already-running', issueNumber };
      }
      return {
        status: 'uncertain',
        issueNumber,
        detail:
          'Dry run: Copilot would be assigned to the issue; no mutation was performed.',
      };
    }

    let actor: AssignableActor | null;
    let issue: AssignableIssue | null;
    try {
      const actors = await this.api.getAssignableActors();
      actor = findCopilotActor(actors);
      if (actor === null) {
        return this.failed(
          issueNumber,
          new CopilotProviderError('discover Copilot actor', 'actor-not-found'),
        );
      }
      issue = await this.api.getAssignableIssue(issueNumber);
    } catch (error) {
      return this.failed(
        issueNumber,
        sanitizeCopilotError('prepare Copilot assignment', error),
      );
    }

    if (issue === null) {
      return this.failed(
        issueNumber,
        new CopilotProviderError('locate sub-issue', 'unknown'),
      );
    }
    if (this.copilotIsAssigned(issue)) {
      return { status: 'already-running', issueNumber };
    }

    const assignment: AssignActorRequest = {
      assignableId: issue.id,
      actorId: actor.id,
      baseRef: request.baseBranch,
      // The model field is included only when explicitly configured; it is
      // omitted entirely to request automatic model selection.
      ...(request.model.kind === 'explicit'
        ? { model: request.model.name }
        : {}),
    };

    try {
      const result = await this.api.assignActor(assignment);
      if (result.assigneeLogins.some((login) => isCopilotLogin(login))) {
        return this.started(issueNumber);
      }
      // The mutation returned without confirming the assignment. Do not retry;
      // reconcile against the real issue state instead.
      return this.reconcile(issueNumber, null);
    } catch (error) {
      // The mutation may or may not have taken effect. Re-fetch the issue before
      // doing anything; never blindly retry a possibly-successful mutation.
      return this.reconcile(
        issueNumber,
        sanitizeCopilotError('assign Copilot', error),
      );
    }
  }

  /**
   * Reconcile an uncertain assignment by re-reading the issue. If Copilot is now
   * assigned, the operation succeeded; otherwise return a sanitized failure. If
   * the re-read itself fails, the outcome stays uncertain so the orchestrator
   * reconciles later rather than rolling back or retrying.
   */
  private async reconcile(
    issueNumber: number,
    originalError: CopilotProviderError | null,
  ): Promise<AgentStartResult> {
    let issue: AssignableIssue | null;
    try {
      issue = await this.api.getAssignableIssue(issueNumber);
    } catch {
      return {
        status: 'uncertain',
        issueNumber,
        detail:
          'The assignment result is unknown and could not be confirmed; the loop will reconcile the issue state before retrying.',
      };
    }
    if (issue !== null && this.copilotIsAssigned(issue)) {
      return this.started(issueNumber);
    }
    return this.failed(
      issueNumber,
      originalError ?? new CopilotProviderError('assign Copilot', 'unknown'),
    );
  }

  private copilotIsAssigned(issue: AssignableIssue): boolean {
    return issue.assigneeLogins.some((login) => isCopilotLogin(login));
  }

  private started(issueNumber: number): AgentStartResult {
    return {
      status: 'started',
      issueNumber,
      assignedAt: this.clock.now().toISOString(),
    };
  }

  private failed(
    issueNumber: number,
    error: CopilotProviderError,
  ): AgentStartResult {
    return {
      status: 'failed',
      issueNumber,
      error: error.message,
      reason: error.reason,
    };
  }

  private async run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw sanitizeCopilotError(operation, error);
    }
  }
}
