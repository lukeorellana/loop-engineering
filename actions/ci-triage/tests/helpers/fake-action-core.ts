/**
 * In-memory double of the {@link ActionCore} host-runner surface.
 *
 * Tests configure inputs and then assert on the captured outputs, secrets, step
 * summary, and failure message, exercising the action composition end to end
 * without the GitHub Actions toolkit or any network access.
 */
import type { ActionCore, ActionSummary } from '../../src/action/core.js';

class FakeSummary implements ActionSummary {
  buffer = '';

  addRaw(text: string): ActionSummary {
    this.buffer += text;
    return this;
  }

  async write(): Promise<unknown> {
    return undefined;
  }
}

export class FakeActionCore implements ActionCore {
  readonly outputs: Record<string, string> = {};
  readonly secrets: string[] = [];
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly debugs: string[] = [];
  failed: string | null = null;
  readonly summary = new FakeSummary();

  constructor(private readonly inputs: Record<string, string> = {}) {}

  getInput(name: string): string {
    return this.inputs[name] ?? '';
  }

  setSecret(secret: string): void {
    this.secrets.push(secret);
  }

  setOutput(name: string, value: string): void {
    this.outputs[name] = value;
  }

  setFailed(message: string): void {
    this.failed = message;
  }

  debug(message: string): void {
    this.debugs.push(message);
  }

  info(message: string): void {
    this.infos.push(message);
  }

  warning(message: string): void {
    this.warnings.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  /** All logged lines across levels, for secret-leak assertions. */
  allLogs(): string[] {
    return [
      ...this.debugs,
      ...this.infos,
      ...this.warnings,
      ...this.errors,
      this.summary.buffer,
      ...(this.failed === null ? [] : [this.failed]),
    ];
  }
}
