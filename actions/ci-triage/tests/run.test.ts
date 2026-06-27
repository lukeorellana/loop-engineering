import { describe, expect, it } from 'vitest';

import {
  executeAction,
  finalize,
  type ActionEnvironment,
} from '../src/action/index.js';
import { ACTION_OUTPUT_NAMES } from '../src/action/outputs.js';
import type { TriageResult } from '../src/action/result.js';
import { TRIAGE_OUTCOMES, TRIAGE_REASON_CODES } from '../src/domain/index.js';
import { FakeActionCore } from './helpers/fake-action-core.js';

const VALID_INPUTS: Record<string, string> = {
  'github-token': 'gh-secret-token',
  'agent-token': 'agent-secret-token',
};

async function run(
  inputs: Record<string, string> = {},
): Promise<{ core: FakeActionCore; result: TriageResult }> {
  const core = new FakeActionCore({ ...VALID_INPUTS, ...inputs });
  const env: ActionEnvironment = { core };
  const result = await executeAction(env);
  return { core, result };
}

describe('executeAction — outputs contract', () => {
  it('sets all ten outputs on every normal exit path', async () => {
    const cases: Record<string, string>[] = [
      {}, // not-implemented
      { 'dry-run': 'true' }, // dry-run
      { 'agent-token': '' }, // configuration-error
    ];
    for (const inputs of cases) {
      const { core } = await run(inputs);
      for (const name of ACTION_OUTPUT_NAMES) {
        expect(core.outputs).toHaveProperty(name);
      }
    }
  });

  it('emits empty strings for outputs that do not apply', async () => {
    const { core } = await run({ 'dry-run': 'true' });
    expect(core.outputs['task-id']).toBe('');
    expect(core.outputs['task-url']).toBe('');
    expect(core.outputs['workflow-run-id']).toBe('');
    expect(core.outputs['workflow-run-attempt']).toBe('');
    expect(core.outputs['resolved-mode']).toBe('');
    expect(core.outputs['target-base-ref']).toBe('');
    expect(core.outputs['target-head-ref']).toBe('');
    expect(core.outputs['existing-pr-number']).toBe('');
  });

  it('always reports a contract outcome and reason code', async () => {
    const { result } = await run();
    expect(TRIAGE_OUTCOMES).toContain(result.outcome);
    expect(TRIAGE_REASON_CODES).toContain(result.reasonCode);
  });
});

describe('executeAction — valid inputs', () => {
  it('reports orchestration is not implemented yet and fails the step', async () => {
    const { core, result } = await run();
    expect(result.outcome).toBe('operational-error');
    expect(result.reasonCode).toBe('orchestration-not-implemented');
    expect(core.failed).not.toBeNull();
    expect(core.outputs['outcome']).toBe('operational-error');
  });
});

describe('executeAction — dry run', () => {
  it('reports a successful dry-run preview with no writes', async () => {
    const { core, result } = await run({ 'dry-run': 'true' });
    expect(result.outcome).toBe('dry-run');
    expect(result.reasonCode).toBe('dry-run-preview');
    expect(result.dryRun).toBe(true);
    expect(core.failed).toBeNull();
  });
});

describe('executeAction — invalid inputs', () => {
  it('fails closed with a configuration error', async () => {
    const { core, result } = await run({ 'pull-request-mode': 'bogus' });
    expect(result.outcome).toBe('configuration-error');
    expect(result.reasonCode).toBe('invalid-input');
    expect(core.failed).not.toBeNull();
  });

  it('never starts work for an invalid run', async () => {
    const { core } = await run({ 'agent-token': '' });
    expect(core.outputs['outcome']).toBe('configuration-error');
    expect(core.outputs['task-id']).toBe('');
  });
});

describe('executeAction — secrets', () => {
  it('masks both tokens and never logs them', async () => {
    const { core } = await run();
    expect(core.secrets).toContain('gh-secret-token');
    expect(core.secrets).toContain('agent-secret-token');
    for (const line of core.allLogs()) {
      expect(line).not.toContain('gh-secret-token');
      expect(line).not.toContain('agent-secret-token');
    }
  });
});

describe('finalize — step summary resilience', () => {
  it('does not mask the outcome when the summary write fails', async () => {
    const core = new FakeActionCore(VALID_INPUTS);
    core.summary.write = async () => {
      throw new Error('summary boom');
    };
    const result: TriageResult = {
      outcome: 'dry-run',
      reasonCode: 'dry-run-preview',
      dryRun: true,
      details: [],
    };
    await expect(finalize(core, result)).resolves.toBe(result);
    expect(core.failed).toBeNull();
  });
});
