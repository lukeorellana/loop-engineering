import { describe, expect, it } from 'vitest';

import { readActionInputs } from '../src/action/inputs.js';
import { FakeActionCore } from './helpers/fake-action-core.js';

function read(inputs: Record<string, string>) {
  const core = new FakeActionCore({
    'github-token': 'gh-secret-token',
    'agent-token': 'agent-secret-token',
    ...inputs,
  });
  return { core, result: readActionInputs(core) };
}

function expectOk(inputs: Record<string, string>) {
  const { core, result } = read(inputs);
  if (!result.ok) {
    throw new Error(
      `expected valid inputs, got: ${result.messages.join('; ')}`,
    );
  }
  return { core, inputs: result.inputs };
}

function expectError(inputs: Record<string, string>): readonly string[] {
  const { result } = read(inputs);
  if (result.ok) {
    throw new Error('expected invalid inputs, but parsing succeeded');
  }
  return result.messages;
}

describe('readActionInputs — credentials', () => {
  it('reads and masks both tokens', () => {
    const { core, inputs } = expectOk({});
    expect(inputs.githubToken).toBe('gh-secret-token');
    expect(inputs.agentToken).toBe('agent-secret-token');
    expect(core.secrets).toContain('gh-secret-token');
    expect(core.secrets).toContain('agent-secret-token');
  });

  it('requires github-token', () => {
    const messages = expectError({ 'github-token': '   ' });
    expect(messages).toContain('Input "github-token" is required.');
  });

  it('requires agent-token (no default)', () => {
    const messages = expectError({ 'agent-token': '' });
    expect(messages).toContain('Input "agent-token" is required.');
  });
});

describe('readActionInputs — model', () => {
  it('retains a non-empty model string exactly', () => {
    const { inputs } = expectOk({ model: 'custom/model-9000' });
    expect(inputs.model).toBe('custom/model-9000');
  });

  it('treats an empty model as no override', () => {
    const { inputs } = expectOk({ model: '' });
    expect(inputs.model).toBeUndefined();
  });

  it('treats a whitespace-only model as no override', () => {
    const { inputs } = expectOk({ model: '   ' });
    expect(inputs.model).toBeUndefined();
  });
});

describe('readActionInputs — pull-request-mode', () => {
  it('defaults to auto when empty', () => {
    const { inputs } = expectOk({ 'pull-request-mode': '' });
    expect(inputs.pullRequestMode).toBe('auto');
  });

  it.each(['auto', 'existing', 'new'])('accepts %s', (mode) => {
    const { inputs } = expectOk({ 'pull-request-mode': mode });
    expect(inputs.pullRequestMode).toBe(mode);
  });

  it('rejects any other value', () => {
    const messages = expectError({ 'pull-request-mode': 'reuse' });
    expect(messages.some((m) => m.includes('pull-request-mode'))).toBe(true);
  });

  it('rejects a whitespace-padded valid value', () => {
    const { inputs } = expectOk({ 'pull-request-mode': '  new  ' });
    expect(inputs.pullRequestMode).toBe('new');
  });
});

describe('readActionInputs — booleans', () => {
  it('defaults include-history to true and dry-run to false', () => {
    const { inputs } = expectOk({});
    expect(inputs.includeHistory).toBe(true);
    expect(inputs.dryRun).toBe(false);
  });

  it('parses explicit boolean values', () => {
    const { inputs } = expectOk({
      'include-history': 'false',
      'dry-run': 'TRUE',
    });
    expect(inputs.includeHistory).toBe(false);
    expect(inputs.dryRun).toBe(true);
  });

  it('rejects a non-boolean include-history', () => {
    const messages = expectError({ 'include-history': 'yes' });
    expect(messages).toContain(
      'Input "include-history" must be "true" or "false".',
    );
  });

  it('rejects a non-boolean dry-run', () => {
    const messages = expectError({ 'dry-run': '1' });
    expect(messages).toContain('Input "dry-run" must be "true" or "false".');
  });
});

describe('readActionInputs — optional context', () => {
  it('omits empty and whitespace-only context inputs', () => {
    const { inputs } = expectOk({
      'prompt-instructions': '   ',
      'additional-context': '',
    });
    expect(inputs.promptInstructions).toBeUndefined();
    expect(inputs.additionalContext).toBeUndefined();
  });

  it('preserves provided context verbatim', () => {
    const { inputs } = expectOk({
      'prompt-instructions': 'Prefer minimal diffs.',
      'additional-context': '  build log line  ',
    });
    expect(inputs.promptInstructions).toBe('Prefer minimal diffs.');
    expect(inputs.additionalContext).toBe('  build log line  ');
  });
});

describe('readActionInputs — accumulation', () => {
  it('reports all validation problems at once', () => {
    const messages = expectError({
      'agent-token': '',
      'pull-request-mode': 'bogus',
      'dry-run': 'maybe',
    });
    expect(messages.length).toBeGreaterThanOrEqual(3);
  });
});
