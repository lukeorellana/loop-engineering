import { describe, expect, it } from 'vitest';

import {
  buildStatusComment,
  decodeStatusData,
  encodeStatusData,
  epicStatusMarker,
  epicStatusMarkerToken,
  type LoopStatusData,
} from '../src/orchestrator/status.js';
import { hasStatusMarker } from '../src/adapters/github/status-comment.js';

const data: LoopStatusData = {
  epic: 1,
  issue: 11,
  provider: 'github-copilot',
  state: 'running',
  reason: 'started',
  startedAt: '2024-01-01T00:00:00.000Z',
};

describe('status payloads', () => {
  it('round-trips the machine-readable payload', () => {
    expect(decodeStatusData(encodeStatusData(data))).toEqual(data);
  });

  it('embeds the dedupe marker and the payload in the comment body', () => {
    const { marker, body } = buildStatusComment(data, 'Human readable text.');
    expect(marker).toBe(epicStatusMarker(1));
    expect(hasStatusMarker(body, marker)).toBe(true);
    expect(body).toContain(epicStatusMarkerToken(1));
    expect(body).toContain('Human readable text.');
    expect(decodeStatusData(body)).toEqual(data);
  });

  it('returns null for missing or malformed payloads', () => {
    expect(decodeStatusData(null)).toBeNull();
    expect(decodeStatusData('no marker here')).toBeNull();
    expect(decodeStatusData('<!-- feature-loop:data:not-json -->')).toBeNull();
  });
});
