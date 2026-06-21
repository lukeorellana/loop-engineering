import { describe, expect, it } from 'vitest';

import { reasonCodeOf, type LoopDecision } from '../src/domain/decisions.js';
import type {
  Epic,
  PullRequestCompletionContext,
  SubIssue,
} from '../src/domain/issues.js';
import type { IssueState } from '../src/domain/state.js';
import {
  decideLoop,
  type LoopEvaluation,
} from '../src/domain/state-machine.js';

const baseEvaluation: LoopEvaluation = {
  provider: 'github-copilot',
  model: { kind: 'auto' },
  baseBranch: 'main',
  dryRun: false,
};

interface SubIssueOverrides {
  readonly number?: number;
  readonly order?: number;
  readonly open?: boolean;
  readonly closedReason?: SubIssue['closedReason'];
  readonly canonicalStateLabels?: readonly string[];
}

function subIssue(
  order: number,
  state: IssueState,
  overrides: SubIssueOverrides = {},
): SubIssue {
  return {
    number: overrides.number ?? 100 + order,
    title: `Issue ${order}`,
    order,
    open: overrides.open ?? (state !== 'done' && state !== 'not-planned'),
    closedReason: overrides.closedReason,
    state,
    canonicalStateLabels: overrides.canonicalStateLabels ?? [],
  };
}

function epicOf(
  subIssues: readonly SubIssue[],
  overrides: Partial<Epic> = {},
): Epic {
  return {
    number: overrides.number ?? 1,
    title: overrides.title ?? 'Epic',
    open: overrides.open ?? true,
    subIssues,
  };
}

describe('decideLoop: head-of-line ordering', () => {
  it('starts the first incomplete ready (todo) issue', () => {
    const epic = epicOf([
      subIssue(0, 'done'),
      subIssue(1, 'todo'),
      subIssue(2, 'todo'),
    ]);

    const decision = decideLoop(epic, baseEvaluation);

    expect(decision.outcome).toBe('started');
    if (decision.outcome !== 'started') {
      throw new Error('expected started');
    }
    expect(decision.issue.order).toBe(1);
    expect(decision.request).toEqual({
      epic,
      issue: decision.issue,
      provider: 'github-copilot',
      model: { kind: 'auto' },
      baseBranch: 'main',
      dryRun: false,
    });
    expect(reasonCodeOf(decision)).toBe('started');
  });

  it('reports an already-running issue and does not start another', () => {
    const epic = epicOf([
      subIssue(0, 'done'),
      subIssue(1, 'in-progress'),
      subIssue(2, 'todo'),
    ]);

    const decision = decideLoop(epic, baseEvaluation);

    expect(decision.outcome).toBe('already-running');
    if (decision.outcome !== 'already-running') {
      throw new Error('expected already-running');
    }
    expect(decision.issue.order).toBe(1);
    expect(reasonCodeOf(decision)).toBe('already-running');
  });

  it('marks the epic complete when every sub-issue is done', () => {
    const epic = epicOf([
      subIssue(0, 'done'),
      subIssue(1, 'done'),
      subIssue(2, 'done'),
    ]);

    const decision = decideLoop(epic, baseEvaluation);

    expect(decision.outcome).toBe('complete');
    expect(reasonCodeOf(decision)).toBe('complete');
  });

  it('skips only completed issues, in order, regardless of input ordering', () => {
    const epic = epicOf([
      subIssue(2, 'todo'),
      subIssue(0, 'done'),
      subIssue(1, 'todo'),
    ]);

    const decision = decideLoop(epic, baseEvaluation);

    expect(decision.outcome).toBe('started');
    if (decision.outcome !== 'started') {
      throw new Error('expected started');
    }
    // The first incomplete by order (1), not by input position.
    expect(decision.issue.order).toBe(1);
  });

  it('a blocked first issue prevents later ready work from starting', () => {
    const epic = epicOf([
      subIssue(0, 'blocked'),
      subIssue(1, 'todo'),
      subIssue(2, 'todo'),
    ]);

    const decision = decideLoop(epic, baseEvaluation);

    expect(decision.outcome).toBe('needs-human');
    if (decision.outcome !== 'needs-human') {
      throw new Error('expected needs-human');
    }
    expect(decision.issue.order).toBe(0);
    expect(decision.reason).toBe('blocked');
  });
});

describe('decideLoop: pausing states', () => {
  const cases: ReadonlyArray<{
    readonly state: IssueState;
    readonly reason: string;
    readonly labels?: readonly string[];
  }> = [
    { state: 'blocked', reason: 'blocked' },
    { state: 'needs-human', reason: 'needs-human' },
    { state: 'skipped', reason: 'skipped' },
    { state: 'invalid', reason: 'invalid' },
    { state: 'not-planned', reason: 'not-planned' },
  ];

  for (const { state, reason } of cases) {
    it(`pauses for head-of-line ${state} work with reason "${reason}"`, () => {
      const epic = epicOf([subIssue(0, state), subIssue(1, 'todo')]);

      const decision = decideLoop(epic, baseEvaluation);

      expect(decision.outcome).toBe('needs-human');
      if (decision.outcome !== 'needs-human') {
        throw new Error('expected needs-human');
      }
      expect(decision.issue.order).toBe(0);
      expect(decision.reason).toBe(reason);
      expect(reasonCodeOf(decision)).toBe(reason);
    });
  }

  it('refines invalid to multiple-canonical-state-labels when several labels are present', () => {
    const epic = epicOf([
      subIssue(0, 'invalid', {
        canonicalStateLabels: ['feature-loop:todo', 'feature-loop:blocked'],
      }),
    ]);

    const decision = decideLoop(epic, baseEvaluation);

    expect(decision.outcome).toBe('needs-human');
    if (decision.outcome !== 'needs-human') {
      throw new Error('expected needs-human');
    }
    expect(decision.reason).toBe('multiple-canonical-state-labels');
  });

  it('closed-not-planned head-of-line work fails closed (pauses, never advances)', () => {
    const epic = epicOf([
      subIssue(0, 'not-planned', { open: false, closedReason: 'not-planned' }),
      subIssue(1, 'todo'),
    ]);

    const decision = decideLoop(epic, baseEvaluation);

    expect(decision.outcome).toBe('needs-human');
    if (decision.outcome !== 'needs-human') {
      throw new Error('expected needs-human');
    }
    expect(decision.reason).toBe('not-planned');
  });
});

describe('decideLoop: no-op and edge cases', () => {
  it('no-ops when the event does not apply', () => {
    const epic = epicOf([subIssue(0, 'todo')]);

    const decision = decideLoop(epic, {
      ...baseEvaluation,
      eventApplies: false,
    });

    expect(decision.outcome).toBe('no-op');
    expect(reasonCodeOf(decision)).toBe('event-not-applicable');
  });

  it('no-ops on a closed epic', () => {
    const epic = epicOf([subIssue(0, 'todo')], { open: false });

    const decision = decideLoop(epic, baseEvaluation);

    expect(decision.outcome).toBe('no-op');
    expect(reasonCodeOf(decision)).toBe('epic-not-open');
  });

  it('no-ops on an empty epic', () => {
    const epic = epicOf([]);

    const decision = decideLoop(epic, baseEvaluation);

    expect(decision.outcome).toBe('no-op');
    expect(reasonCodeOf(decision)).toBe('epic-empty');
  });
});

describe('decideLoop: completion context and foreign parents', () => {
  function completion(epicNumber: number): PullRequestCompletionContext {
    return {
      pullRequestNumber: 42,
      merged: true,
      mergedBy: 'human',
      baseRef: 'main',
      headRef: 'feature',
      epicNumber,
      closesIssueNumbers: [101],
    };
  }

  it('ignores a completion event whose parent epic is foreign', () => {
    const epic = epicOf([subIssue(0, 'todo')], { number: 1 });

    const decision = decideLoop(epic, {
      ...baseEvaluation,
      completion: completion(999),
    });

    expect(decision.outcome).toBe('no-op');
    expect(reasonCodeOf(decision)).toBe('foreign-parent');
  });

  it('proceeds when the completion event targets this epic', () => {
    const epic = epicOf([subIssue(0, 'todo')], { number: 1 });

    const decision = decideLoop(epic, {
      ...baseEvaluation,
      completion: completion(1),
    });

    expect(decision.outcome).toBe('started');
  });
});

describe('decideLoop: dry-run is strictly read-only', () => {
  it('previews the start request without producing a started decision', () => {
    const epic = epicOf([subIssue(0, 'todo')]);

    const decision = decideLoop(epic, { ...baseEvaluation, dryRun: true });

    expect(decision.outcome).toBe('dry-run');
    if (decision.outcome !== 'dry-run') {
      throw new Error('expected dry-run');
    }
    expect(decision.wouldStart?.dryRun).toBe(true);
    expect(decision.wouldStart?.issue.order).toBe(0);
    expect(reasonCodeOf(decision)).toBe('dry-run');
  });

  it('still reports pauses and completion under dry-run', () => {
    const blockedDecision = decideLoop(epicOf([subIssue(0, 'blocked')]), {
      ...baseEvaluation,
      dryRun: true,
    });
    expect(blockedDecision.outcome).toBe('needs-human');

    const completeDecision = decideLoop(epicOf([subIssue(0, 'done')]), {
      ...baseEvaluation,
      dryRun: true,
    });
    expect(completeDecision.outcome).toBe('complete');
  });
});

describe('decideLoop: determinism and purity', () => {
  it('produces exactly one decision and is referentially stable', () => {
    const epic = epicOf([
      subIssue(0, 'done'),
      subIssue(1, 'todo'),
      subIssue(2, 'blocked'),
    ]);

    const first: LoopDecision = decideLoop(epic, baseEvaluation);
    const second: LoopDecision = decideLoop(epic, baseEvaluation);

    expect(first).toEqual(second);
    expect(first.outcome).toBe('started');
  });

  it('does not mutate the epic sub-issue ordering', () => {
    const subIssues = [
      subIssue(2, 'todo'),
      subIssue(0, 'done'),
      subIssue(1, 'todo'),
    ];
    const epic = epicOf(subIssues);

    decideLoop(epic, baseEvaluation);

    expect(epic.subIssues.map((issue) => issue.order)).toEqual([2, 0, 1]);
  });
});
