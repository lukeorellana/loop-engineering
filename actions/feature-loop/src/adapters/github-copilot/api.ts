/**
 * Narrow GitHub GraphQL boundary used by the Copilot agent provider.
 *
 * The provider depends only on this interface, never on Octokit types or raw
 * GraphQL response bodies. This keeps the loop decoupled from the transport and
 * lets tests drive the provider with mocked GraphQL responses (assignable
 * actors, issue assignees, and assignment mutations) through a simple in-memory
 * fake.
 *
 * A concrete implementation is supplied by the composition layer and is
 * constructed with the dedicated agent-assignment credential, which is kept
 * separate from the ordinary repository token used by the repository adapter.
 */

/**
 * A single actor the repository reports as assignable to issues, reduced to the
 * minimal provider-independent shape. `typename` is the GraphQL `__typename`
 * (for example `Bot` or `User`) so the provider can prefer the bot actor.
 */
export interface AssignableActor {
  /** The actor's GraphQL node id, used as the mutation `actorIds` value. */
  readonly id: string;
  /** The actor login, matched against known Copilot actor logins. */
  readonly login: string;
  /** The GraphQL `__typename`, for example `Bot`. */
  readonly typename: string;
}

/**
 * The minimal assignable-issue shape the provider needs: its GraphQL node id and
 * the logins currently assigned to it (used to detect an existing assignment).
 */
export interface AssignableIssue {
  /** The issue's GraphQL node id, used as the mutation `assignableId`. */
  readonly id: string;
  /** Logins currently assigned to the issue. */
  readonly assigneeLogins: readonly string[];
}

/**
 * Inputs to an assignment mutation. The model field is present only when the
 * user explicitly configured a model; it is omitted entirely to request
 * automatic model selection.
 */
export interface AssignActorRequest {
  /** The issue node id to assign. */
  readonly assignableId: string;
  /** The Copilot actor node id to assign. */
  readonly actorId: string;
  /** The base branch the resulting pull request must target. */
  readonly baseRef: string;
  /** Explicit model name; omitted entirely for automatic selection. */
  readonly model?: string;
}

/**
 * The result of an assignment mutation: the logins assigned to the issue after
 * the mutation, so the provider can confirm the assignment took effect.
 */
export interface AssignActorResult {
  readonly assigneeLogins: readonly string[];
}

/**
 * The transport-level GraphQL operations the Copilot provider consumes.
 * Implementations translate these to GitHub GraphQL queries and mutations.
 * Methods may throw transport errors; the provider sanitizes them before they
 * reach callers and never logs or posts raw responses.
 */
export interface CopilotAgentApi {
  /**
   * The actors the repository reports as assignable (GraphQL
   * `suggestedActors(capabilities: [CAN_BE_ASSIGNED])`). Used to discover the
   * Copilot actor and to confirm the provider is available to the repository.
   */
  getAssignableActors(): Promise<readonly AssignableActor[]>;

  /**
   * The assignable issue, or `null` when it does not exist. Carries the current
   * assignee logins so the provider can detect an already-assigned issue and
   * reconcile after an uncertain mutation.
   */
  getAssignableIssue(issueNumber: number): Promise<AssignableIssue | null>;

  /**
   * Assign the Copilot actor to the issue. This is the only mutating operation
   * and must never be blindly retried by the provider; reconciliation is driven
   * by re-reading {@link getAssignableIssue}.
   */
  assignActor(request: AssignActorRequest): Promise<AssignActorResult>;
}
