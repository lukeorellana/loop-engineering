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
  readonly errors: string[] = [];
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

  info(message: string): void {
    this.infos.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }
}
