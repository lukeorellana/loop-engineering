/**
 * Step-summary rendering.
 *
 * {@link buildStepSummary} turns a loop result into a compact Markdown summary
 * suitable for `GITHUB_STEP_SUMMARY`. It distinguishes dry-run previews from
 * applied results and lists the sanitized notice and detail lines the loop
 * produced, so a reader can see what happened (or would happen) without opening
 * the run log.
 */

import type { OrchestratorResult } from '../orchestrator/index.js';

const OUTCOME_TITLES: Record<string, string> = {
  started: 'Started the next sub-issue',
  'already-running': 'A sub-issue is already running',
  complete: 'Epic complete',
  'needs-human': 'Paused for human attention',
  'dry-run': 'Dry run preview',
  'no-op': 'No action taken',
  'configuration-error': 'Configuration error',
  'operational-error': 'Operational error',
};

function row(label: string, value: string): string {
  return `| ${label} | ${value} |\n`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/**
 * Render a Markdown step summary for a loop result.
 */
export function buildStepSummary(result: OrchestratorResult): string {
  const title = OUTCOME_TITLES[result.outcome] ?? result.outcome;
  const mode = result.dryRun ? ' (dry run)' : '';

  let summary = `## Feature Loop — ${title}${mode}\n\n`;

  summary += '| Field | Value |\n| --- | --- |\n';
  summary += row('Outcome', `\`${result.outcome}\``);
  summary += row('Reason', `\`${result.reasonCode}\``);
  summary += row('Mode', result.dryRun ? 'dry run (no writes)' : 'normal');
  if (result.epicNumber !== undefined) {
    summary += row('Epic', `#${result.epicNumber}`);
  }
  if (result.issueNumber !== undefined) {
    summary += row('Active issue', `#${result.issueNumber}`);
  }
  if (result.completedIssueNumber !== undefined) {
    summary += row('Completed issue', `#${result.completedIssueNumber}`);
  }

  if ((result.notices?.length ?? 0) > 0) {
    summary += '\n### Notices\n\n';
    for (const notice of result.notices ?? []) {
      summary += `- ${escapeCell(notice)}\n`;
    }
  }

  if (result.details.length > 0) {
    summary += '\n### Details\n\n';
    for (const detail of result.details) {
      summary += `- ${escapeCell(detail)}\n`;
    }
  }

  return summary;
}
