import { describe, expect, it } from 'vitest';

import { resolveEvent } from '../src/orchestrator/event.js';
import type { MergedPullRequest } from '../src/domain/merged-pr.js';

const pr: MergedPullRequest = {
  number: 20,
  merged: true,
  baseRef: 'main',
  headRef: 'feat',
  body: 'Closes #11',
  closingIssueReferences: [11],
};

describe('resolveEvent', () => {
  it('classifies a closed pull request as a merged-PR continuation', () => {
    const result = resolveEvent({
      name: 'pull_request',
      action: 'closed',
      pullRequest: pr,
    });
    expect(result.kind).toBe('merged-pr');
    if (result.kind === 'merged-pr') {
      expect(result.event.pullRequest.number).toBe(20);
    }
  });

  it('classifies a positive epic number as a manual start', () => {
    const result = resolveEvent({ name: 'workflow_dispatch', epicNumber: 7 });
    expect(result).toEqual({ kind: 'manual', epicNumber: 7 });
  });

  it('classifies an opened pull request as a pull-request link candidate', () => {
    const result = resolveEvent({
      name: 'pull_request',
      action: 'opened',
      pullRequest: pr,
    });
    expect(result.kind).toBe('pr-opened');
    if (result.kind === 'pr-opened') {
      expect(result.pullRequestNumber).toBe(20);
    }
  });

  it('classifies a reopened pull request as a pull-request link candidate', () => {
    const result = resolveEvent({
      name: 'pull_request',
      action: 'reopened',
      pullRequest: pr,
    });
    expect(result.kind).toBe('pr-opened');
  });

  it('treats an unrelated pull-request action as unrelated', () => {
    const result = resolveEvent({
      name: 'pull_request',
      action: 'synchronize',
      pullRequest: pr,
    });
    expect(result.kind).toBe('unrelated');
  });

  it('treats a missing or non-positive epic number as unrelated', () => {
    expect(resolveEvent({ name: 'issues' }).kind).toBe('unrelated');
    expect(
      resolveEvent({ name: 'workflow_dispatch', epicNumber: 0 }).kind,
    ).toBe('unrelated');
    expect(
      resolveEvent({ name: 'workflow_dispatch', epicNumber: -3 }).kind,
    ).toBe('unrelated');
  });

  it('prefers the merged-PR context over a manual epic number', () => {
    const result = resolveEvent({
      name: 'pull_request',
      action: 'closed',
      epicNumber: 7,
      pullRequest: pr,
    });
    expect(result.kind).toBe('merged-pr');
  });
});
