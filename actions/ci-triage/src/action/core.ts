/**
 * The minimal host-runner surface the action composition depends on.
 *
 * Modeling the GitHub Actions toolkit (`@actions/core`) behind this interface
 * keeps the action's orchestration testable: the entry point binds the real
 * toolkit, while tests drive the same orchestration through an in-memory double.
 * Only the operations the action actually uses are exposed.
 */

/** The append-and-write subset of the Actions job-summary surface. */
export interface ActionSummary {
  addRaw(text: string, addEOL?: boolean): ActionSummary;
  write(): Promise<unknown>;
}

/**
 * The host-runner operations the action composition consumes. Mirrors the subset
 * of `@actions/core` used here, with a {@link ActionSummary} for the step summary.
 */
export interface ActionCore {
  /** Read a raw string input; returns `''` when the input is unset. */
  getInput(name: string): string;
  /** Register a value to be masked in logs. */
  setSecret(secret: string): void;
  /** Set a string action output. */
  setOutput(name: string, value: string): void;
  /** Mark the step as failed with a message. */
  setFailed(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  /** The job step summary surface. */
  readonly summary: ActionSummary;
}
