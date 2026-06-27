/**
 * Step-summary rendering.
 *
 * {@link buildStepSummary} turns a triage result into a compact Markdown summary
 * suitable for `GITHUB_STEP_SUMMARY`. It distinguishes dry-run previews from
 * applied results and lists the sanitized detail lines, so a reader can see what
 * happened (or would happen) without opening the run log.
 */

import type { TriageResult } from './result.js';

const OUTCOME_TITLES: Record<string, string> = {
  started: 'Started a triage task',
  duplicate: 'A triage task already exists',
  ignored: 'No triage needed',
  'needs-human': 'Paused for human attention',
  'dry-run': 'Dry run preview',
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
 * Render a Markdown step summary for a triage result.
 */
export function buildStepSummary(result: TriageResult): string {
  const title = OUTCOME_TITLES[result.outcome] ?? result.outcome;
  const mode = result.dryRun ? ' (dry run)' : '';

  let summary = `## CI Triage — ${title}${mode}\n\n`;

  summary += '| Field | Value |\n| --- | --- |\n';
  summary += row('Outcome', `\`${result.outcome}\``);
  summary += row('Reason', `\`${result.reasonCode}\``);
  summary += row('Mode', result.dryRun ? 'dry run (no writes)' : 'normal');
  if (result.workflowRunId !== undefined) {
    summary += row('Workflow run', `#${result.workflowRunId}`);
  }
  if (result.resolvedMode !== undefined) {
    summary += row('Resolved PR mode', `\`${result.resolvedMode}\``);
  }
  if (result.existingPrNumber !== undefined) {
    summary += row('Existing PR', `#${result.existingPrNumber}`);
  }
  if (result.taskUrl !== undefined) {
    summary += row('Task', escapeCell(result.taskUrl));
  }

  if (result.details.length > 0) {
    summary += '\n### Details\n\n';
    for (const detail of result.details) {
      summary += `- ${escapeCell(detail)}\n`;
    }
  }

  return summary;
}
