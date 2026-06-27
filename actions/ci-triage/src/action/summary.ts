/**
 * Step-summary rendering.
 *
 * {@link buildStepSummary} turns a triage result into a compact Markdown summary
 * suitable for `GITHUB_STEP_SUMMARY`. It contains only safe operational
 * metadata: the outcome and reason, the failed run identity and link, the
 * resolved delivery mode and target refs, the existing pull request when one
 * applied, the started task and its link, whether a model override was supplied,
 * and whether optional history/context were included or truncated. It never
 * includes secrets, the full prompt text, or any untrusted context.
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

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
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

  if (result.workflowName !== undefined) {
    summary += row('Failed workflow', escapeCell(result.workflowName));
  }
  if (result.workflowRunId !== undefined) {
    const value =
      result.workflowRunUrl !== undefined
        ? `[#${result.workflowRunId}](${escapeCell(result.workflowRunUrl)})`
        : `#${result.workflowRunId}`;
    summary += row('Workflow run', value);
  }
  if (result.workflowRunAttempt !== undefined) {
    summary += row('Run attempt', `#${result.workflowRunAttempt}`);
  }
  if (result.resolvedMode !== undefined) {
    summary += row('Resolved delivery mode', `\`${result.resolvedMode}\``);
  }
  if (result.targetBaseRef !== undefined) {
    summary += row(
      'Target base ref',
      `\`${escapeCell(result.targetBaseRef)}\``,
    );
  }
  if (result.targetHeadRef !== undefined) {
    summary += row(
      'Target head ref',
      `\`${escapeCell(result.targetHeadRef)}\``,
    );
  }
  if (result.existingPrNumber !== undefined) {
    summary += row('Existing PR', `#${result.existingPrNumber}`);
  }
  if (result.taskId !== undefined || result.taskUrl !== undefined) {
    const label = result.taskId ?? result.taskUrl ?? '';
    const value =
      result.taskUrl !== undefined
        ? `[${escapeCell(label)}](${escapeCell(result.taskUrl)})`
        : escapeCell(label);
    summary += row('Task', value);
  }
  if (result.modelOverrideProvided !== undefined) {
    summary += row(
      'Model override supplied',
      yesNo(result.modelOverrideProvided),
    );
  }
  if (result.historyIncluded !== undefined) {
    summary += row('History included', yesNo(result.historyIncluded));
  }
  if (result.historyUnavailable !== undefined) {
    summary += row(
      'Some history unavailable',
      yesNo(result.historyUnavailable),
    );
  }
  if (result.additionalContextIncluded !== undefined) {
    summary += row(
      'Additional context included',
      yesNo(result.additionalContextIncluded),
    );
  }
  if (result.promptTruncated !== undefined) {
    summary += row('Prompt truncated', yesNo(result.promptTruncated));
  }

  if (result.details.length > 0) {
    summary += '\n### Details\n\n';
    for (const detail of result.details) {
      summary += `- ${escapeCell(detail)}\n`;
    }
  }

  return summary;
}
