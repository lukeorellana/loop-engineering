/**
 * The minimal host-runner surface the action composition depends on.
 *
 * Modeling the GitHub Actions toolkit (`@actions/core`) behind this interface
 * keeps the action's orchestration testable: the entry point binds the real
 * toolkit, while tests drive the same orchestration through an in-memory double.
 * Only the operations the action actually uses are exposed.
 */

import type { Logger, LogFields } from '../ports/logger.js';

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

/** Render sanitized structured fields as a compact, secret-free suffix. */
function renderFields(fields: LogFields | undefined): string {
  if (fields === undefined) {
    return '';
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) {
    return '';
  }
  return ` ${JSON.stringify(fields)}`;
}

/**
 * A {@link Logger} that writes to the host runner through {@link ActionCore}.
 *
 * Structured fields are appended as compact JSON; the loop guarantees these
 * fields and messages are already sanitized and never carry secrets, and the
 * runner additionally masks any registered secret values.
 */
export class CoreLogger implements Logger {
  constructor(private readonly core: ActionCore) {}

  debug(message: string, fields?: LogFields): void {
    this.core.debug(`${message}${renderFields(fields)}`);
  }

  info(message: string, fields?: LogFields): void {
    this.core.info(`${message}${renderFields(fields)}`);
  }

  warning(message: string, fields?: LogFields): void {
    this.core.warning(`${message}${renderFields(fields)}`);
  }

  error(message: string, fields?: LogFields): void {
    this.core.error(`${message}${renderFields(fields)}`);
  }
}
