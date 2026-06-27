import { describe, expect, it } from 'vitest';

import { buildStepSummary } from '../src/action/summary.js';
import type { TriageResult } from '../src/action/result.js';

describe('buildStepSummary', () => {
  it('renders outcome and reason code in every summary', () => {
    const result: TriageResult = {
      outcome: 'configuration-error',
      reasonCode: 'invalid-input',
      dryRun: false,
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('`configuration-error`');
    expect(summary).toContain('`invalid-input`');
  });

  it('uses the human-readable title for known outcomes', () => {
    const result: TriageResult = {
      outcome: 'dry-run',
      reasonCode: 'dry-run-preview',
      dryRun: true,
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('Dry run preview');
    expect(summary).toContain('(dry run)');
    expect(summary).toContain('dry run (no writes)');
  });

  it('falls back to the raw outcome when no title is registered', () => {
    const result: TriageResult = {
      // Cast to bypass TS so we can test the unknown-outcome fallback.
      outcome: 'unknown-future-outcome' as TriageResult['outcome'],
      reasonCode: 'task-started',
      dryRun: false,
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('unknown-future-outcome');
  });

  it('omits optional rows when the fields are undefined', () => {
    const result: TriageResult = {
      outcome: 'operational-error',
      reasonCode: 'task-started',
      dryRun: false,
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).not.toContain('Workflow run');
    expect(summary).not.toContain('Resolved PR mode');
    expect(summary).not.toContain('Existing PR');
    expect(summary).not.toContain('Task');
  });

  it('renders the workflow-run row when workflowRunId is provided', () => {
    const result: TriageResult = {
      outcome: 'started',
      reasonCode: 'task-started',
      dryRun: false,
      workflowRunId: 42,
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('Workflow run');
    expect(summary).toContain('#42');
  });

  it('renders the resolved-mode row when resolvedMode is provided', () => {
    const result: TriageResult = {
      outcome: 'started',
      reasonCode: 'task-started',
      dryRun: false,
      resolvedMode: 'auto',
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('Resolved delivery mode');
    expect(summary).toContain('`auto`');
  });

  it('renders the existing-PR row when existingPrNumber is provided', () => {
    const result: TriageResult = {
      outcome: 'duplicate',
      reasonCode: 'task-already-exists',
      dryRun: false,
      existingPrNumber: 7,
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('Existing PR');
    expect(summary).toContain('#7');
  });

  it('renders the task URL row when taskUrl is provided', () => {
    const result: TriageResult = {
      outcome: 'started',
      reasonCode: 'task-started',
      dryRun: false,
      taskUrl: 'https://github.com/example/repo/issues/99',
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('Task');
    expect(summary).toContain('https://github.com/example/repo/issues/99');
  });

  it('escapes pipe characters in the task URL', () => {
    const result: TriageResult = {
      outcome: 'started',
      reasonCode: 'task-started',
      dryRun: false,
      taskUrl: 'https://example.com/path?a=1|b=2',
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('https://example.com/path?a=1\\|b=2');
  });

  it('renders all optional fields together when all are provided', () => {
    const result: TriageResult = {
      outcome: 'started',
      reasonCode: 'task-started',
      dryRun: false,
      workflowRunId: 100,
      resolvedMode: 'new',
      existingPrNumber: 5,
      taskUrl: 'https://github.com/example/repo/issues/1',
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('#100');
    expect(summary).toContain('`new`');
    expect(summary).toContain('#5');
    expect(summary).toContain('https://github.com/example/repo/issues/1');
  });

  it('renders the details section when details are present', () => {
    const result: TriageResult = {
      outcome: 'configuration-error',
      reasonCode: 'invalid-input',
      dryRun: false,
      details: ['first detail', 'second | detail'],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('### Details');
    expect(summary).toContain('- first detail');
    expect(summary).toContain('- second \\| detail');
  });

  it('omits the details section when details array is empty', () => {
    const result: TriageResult = {
      outcome: 'operational-error',
      reasonCode: 'task-started',
      dryRun: false,
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).not.toContain('### Details');
  });
});

describe('buildStepSummary — safe operational metadata', () => {
  it('links the failed run and the started task', () => {
    const result: TriageResult = {
      outcome: 'started',
      reasonCode: 'task-started',
      dryRun: false,
      workflowName: 'CI',
      workflowRunId: 4242,
      workflowRunUrl: 'https://github.com/acme/app/actions/runs/4242',
      workflowRunAttempt: 2,
      taskId: 'task-9',
      taskUrl: 'https://github.com/acme/app/agents/task-9',
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('Failed workflow');
    expect(summary).toContain('CI');
    expect(summary).toContain(
      '[#4242](https://github.com/acme/app/actions/runs/4242)',
    );
    expect(summary).toContain('Run attempt');
    expect(summary).toContain(
      '[task-9](https://github.com/acme/app/agents/task-9)',
    );
  });

  it('renders the resolved delivery mode and target refs', () => {
    const result: TriageResult = {
      outcome: 'dry-run',
      reasonCode: 'dry-run-preview',
      dryRun: true,
      resolvedMode: 'new',
      targetBaseRef: 'main',
      targetHeadRef: 'ci-triage/main',
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('Resolved delivery mode');
    expect(summary).toContain('`new`');
    expect(summary).toContain('Target base ref');
    expect(summary).toContain('`main`');
    expect(summary).toContain('Target head ref');
    expect(summary).toContain('`ci-triage/main`');
  });

  it('reports model-override and history/context flags without claiming validity', () => {
    const result: TriageResult = {
      outcome: 'started',
      reasonCode: 'task-started',
      dryRun: false,
      modelOverrideProvided: true,
      historyIncluded: true,
      additionalContextIncluded: false,
      promptTruncated: true,
      details: [],
    };
    const summary = buildStepSummary(result);
    expect(summary).toContain('Model override supplied');
    expect(summary).toMatch(/Model override supplied \| yes/);
    expect(summary).toMatch(/History included \| yes/);
    expect(summary).toMatch(/Additional context included \| no/);
    expect(summary).toMatch(/Prompt truncated \| yes/);
    // It never asserts the model itself is valid.
    expect(summary).not.toContain('valid');
  });
});
