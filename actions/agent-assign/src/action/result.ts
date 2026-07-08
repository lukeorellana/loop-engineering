export type AssignOutcome =
  | 'assigned'
  | 'skipped'
  | 'dry-run'
  | 'configuration-error'
  | 'operational-error';

export interface AssignResult {
  readonly outcome: AssignOutcome;
  readonly reasonCode: string;
  readonly issueNumber?: number;
  readonly details: readonly string[];
}
