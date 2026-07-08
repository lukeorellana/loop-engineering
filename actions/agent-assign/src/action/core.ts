export interface ActionSummary {
  addRaw(text: string): ActionSummary;
  write(): Promise<unknown>;
}

export interface ActionCore {
  getInput(name: string): string;
  setSecret(secret: string): void;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  info(message: string): void;
  error(message: string): void;
  summary: ActionSummary;
}
