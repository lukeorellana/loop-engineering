/**
 * In-memory fake of the {@link CopilotAgentApi} GraphQL boundary.
 *
 * Tests configure mocked GraphQL responses — assignable actors, issue assignees,
 * assignment results, and deliberate transport failures — and pass this fake to
 * the provider, exercising actor discovery, already-assigned detection, model
 * omission, error sanitization, and uncertain-mutation reconciliation without
 * any network access.
 */
import type {
  AssignActorRequest,
  AssignActorResult,
  AssignableActor,
  AssignableIssue,
  CopilotAgentApi,
} from '../../src/adapters/github-copilot/api.js';

export interface FakeCopilotConfig {
  actors?: AssignableActor[];
  /** Issue node id and current assignee logins, keyed by issue number. */
  issues?: Record<number, { id: string; assigneeLogins: string[] }>;
  /** Throw on the corresponding call instead of returning. */
  getActorsError?: unknown;
  getIssueError?: unknown;
  assignError?: unknown;
  /**
   * Logins reported as assigned by the assignment mutation. When omitted, the
   * fake assigns the Copilot actor's login from the matched actor.
   */
  assignResultLogins?: string[];
  /**
   * When `true`, the assignment also updates the stored issue assignees so a
   * subsequent reconciliation read observes the assignment.
   */
  assignPersists?: boolean;
}

export interface FakeCopilotCall {
  op: string;
  args: unknown[];
}

export class FakeCopilotAgentApi implements CopilotAgentApi {
  readonly calls: FakeCopilotCall[] = [];
  readonly assignments: AssignActorRequest[] = [];

  constructor(private readonly config: FakeCopilotConfig = {}) {}

  private record(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args });
  }

  async getAssignableActors(): Promise<readonly AssignableActor[]> {
    this.record('getAssignableActors');
    if (this.config.getActorsError !== undefined) {
      throw this.config.getActorsError;
    }
    return this.config.actors ?? [];
  }

  async getAssignableIssue(
    issueNumber: number,
  ): Promise<AssignableIssue | null> {
    this.record('getAssignableIssue', issueNumber);
    if (this.config.getIssueError !== undefined) {
      throw this.config.getIssueError;
    }
    const issue = this.config.issues?.[issueNumber];
    if (issue === undefined) {
      return null;
    }
    return { id: issue.id, assigneeLogins: [...issue.assigneeLogins] };
  }

  async assignActor(request: AssignActorRequest): Promise<AssignActorResult> {
    this.record('assignActor', request);
    this.assignments.push(request);
    if (this.config.assignError !== undefined) {
      throw this.config.assignError;
    }
    const logins =
      this.config.assignResultLogins ??
      this.copilotLoginForActor(request.actorId);
    if (this.config.assignPersists) {
      for (const issue of Object.values(this.config.issues ?? {})) {
        if (issue.id === request.assignableId) {
          issue.assigneeLogins = [...logins];
        }
      }
    }
    return { assigneeLogins: logins };
  }

  private copilotLoginForActor(actorId: string): string[] {
    const actor = (this.config.actors ?? []).find((a) => a.id === actorId);
    return actor ? [actor.login] : [];
  }
}
