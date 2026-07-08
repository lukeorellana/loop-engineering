import type { AssignResult } from './result.js';

export function buildStepSummary(result: AssignResult): string {
  const rows = [
    ['outcome', result.outcome],
    ['reason', result.reasonCode],
    [
      'issue-number',
      result.issueNumber === undefined ? '' : String(result.issueNumber),
    ],
  ];
  const details = result.details.map((line) => `- ${line}`).join('\n');
  return [
    '### Agent assignment',
    '',
    '| field | value |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    details,
    '',
  ].join('\n');
}
