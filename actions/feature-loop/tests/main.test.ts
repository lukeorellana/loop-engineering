import { describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import { run } from '../src/main.js';

describe('run', () => {
  it('reports that Feature Loop is not yet implemented and resolves', async () => {
    const info = vi.spyOn(core, 'info').mockImplementation(() => {});
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {});

    await expect(run()).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith('Feature Loop is not yet implemented.');
    expect(setFailed).not.toHaveBeenCalled();

    info.mockRestore();
    setFailed.mockRestore();
  });
});
