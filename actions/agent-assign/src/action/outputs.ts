import type { ActionCore } from './core.js';
import type { AssignResult } from './result.js';

export function setActionOutputs(core: ActionCore, result: AssignResult): void {
  core.setOutput('outcome', result.outcome);
  core.setOutput('reason', result.reasonCode);
  core.setOutput(
    'issue-number',
    result.issueNumber === undefined ? '' : String(result.issueNumber),
  );
}
