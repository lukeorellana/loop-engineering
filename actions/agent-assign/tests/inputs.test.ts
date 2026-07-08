import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SUPPRESS_LABELS,
  readActionInputs,
} from '../src/action/inputs.js';
import { FakeActionCore } from './helpers/fake-action-core.js';

function read(inputs: Record<string, string>) {
  const core = new FakeActionCore({ 'github-token': 'gh-token', ...inputs });
  return { core, result: readActionInputs(core) };
}

describe('readActionInputs', () => {
  it('uses github-token as agent-token fallback and masks both', () => {
    const { core, result } = read({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.inputs.agentToken).toBe('gh-token');
    expect(core.secrets).toContain('gh-token');
  });

  it('treats empty suppress-labels as default suppression list', () => {
    const { result } = read({ 'suppress-labels': '' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.inputs.suppressLabels).toEqual([...DEFAULT_SUPPRESS_LABELS]);
  });

  it('defaults post-instructions to true even when empty', () => {
    const { result } = read({ 'post-instructions': '' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.inputs.postInstructions).toBe(true);
  });

  it('validates boolean inputs', () => {
    const { result } = read({ 'dry-run': 'yes' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.messages).toContain(
      'Input "dry-run" must be "true" or "false".',
    );
  });
});
