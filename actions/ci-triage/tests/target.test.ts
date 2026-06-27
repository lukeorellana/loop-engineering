import { describe, expect, it } from 'vitest';

import {
  remediationBranchName,
  selectPullRequest,
  type CandidatePullRequest,
} from '../src/domain/index.js';

const SHA = 'd'.repeat(40);

function pr(
  overrides: Partial<CandidatePullRequest> = {},
): CandidatePullRequest {
  return {
    number: 1,
    state: 'open',
    isFork: false,
    baseRef: 'main',
    headRef: 'feature',
    headSha: SHA,
    ...overrides,
  };
}

describe('selectPullRequest', () => {
  it('matches by head branch', () => {
    const result = selectPullRequest([pr()], 'feature', 'other-sha');
    expect(result).toEqual({ ok: true, pullRequest: pr() });
  });

  it('matches by head SHA when the branch differs', () => {
    const result = selectPullRequest(
      [pr({ headRef: 'renamed' })],
      'feature',
      SHA,
    );
    expect(result.ok).toBe(true);
  });

  it('reports not-found when nothing matches', () => {
    const result = selectPullRequest(
      [pr({ headRef: 'x', headSha: 'y' })],
      'z',
      SHA,
    );
    expect(result).toEqual({ ok: false, reason: 'pull-request-not-found' });
  });

  it('reports ambiguous when two open same-repository pulls match', () => {
    const result = selectPullRequest(
      [pr({ number: 1 }), pr({ number: 2 })],
      'feature',
      SHA,
    );
    expect(result).toEqual({ ok: false, reason: 'pull-request-ambiguous' });
  });

  it('prefers the single open same-repository pull over a matching fork', () => {
    const result = selectPullRequest(
      [pr({ number: 1 }), pr({ number: 2, isFork: true })],
      'feature',
      SHA,
    );
    expect(result).toMatchObject({ ok: true, pullRequest: { number: 1 } });
  });

  it('reports fork when the only match is a fork', () => {
    const result = selectPullRequest([pr({ isFork: true })], 'feature', SHA);
    expect(result).toEqual({ ok: false, reason: 'fork-pull-request' });
  });

  it('reports closed when the only match is closed', () => {
    const result = selectPullRequest([pr({ state: 'closed' })], 'feature', SHA);
    expect(result).toEqual({ ok: false, reason: 'pull-request-closed' });
  });

  it('deduplicates repeated pull-request numbers before counting', () => {
    const result = selectPullRequest([pr(), pr()], 'feature', SHA);
    expect(result).toMatchObject({ ok: true, pullRequest: { number: 1 } });
  });
});

describe('remediationBranchName', () => {
  it('derives a deterministic, stacked branch name', () => {
    expect(remediationBranchName('main')).toBe('ci-triage/main');
    expect(remediationBranchName('feature/x')).toBe('ci-triage/feature/x');
  });
});
