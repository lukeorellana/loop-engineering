// @ts-check
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  run,
  resolveConfig,
  evaluateEligibility,
  findCopilotActor,
  isCopilotLogin,
  sanitizeError,
  normalizeIssue,
  parseBoolean,
  parseList,
  DEFAULT_COPILOT_LOGINS,
  FAILURE_MARKER,
  INSTRUCTIONS_MARKER,
} = require('./assign-copilot-agent.js');

/** A minimal `core` stub that records calls. */
function makeCore() {
  return {
    infos: [],
    errors: [],
    failures: [],
    info(message) {
      this.infos.push(message);
    },
    error(message) {
      this.errors.push(message);
    },
    setFailed(message) {
      this.failures.push(message);
    },
  };
}

/**
 * Build a fake Octokit that records mutations and answers reads from the
 * provided fixtures. GraphQL is dispatched by inspecting the query string.
 */
function makeGithub(options = {}) {
  const state = {
    issue: options.issue || {
      state: 'open',
      labels: [{ name: 'agent: implement' }],
      assignees: [],
    },
    actors: options.actors || [
      { id: 'BOT_copilot', login: 'copilot-swe-agent', __typename: 'Bot' },
    ],
    issueNode: options.issueNode || {
      id: 'ISSUE_NODE',
      assignees: { nodes: [] },
    },
    assignResultLogins:
      options.assignResultLogins !== undefined
        ? options.assignResultLogins
        : ['copilot-swe-agent'],
    comments: options.comments || [],
    graphqlError: options.graphqlError || null,
    addedLabels: [],
    removedLabels: [],
    createdComments: [],
    lastActorIds: null,
  };

  const github = {
    _state: state,
    rest: {
      issues: {
        get: async () => ({ data: state.issue }),
        addLabels: async ({ labels }) => {
          state.addedLabels.push(...labels);
          return {};
        },
        removeLabel: async ({ name }) => {
          if (options.removeLabelStatus === 404) {
            const err = new Error('Label does not exist');
            // @ts-ignore
            err.status = 404;
            throw err;
          }
          state.removedLabels.push(name);
          return {};
        },
        createComment: async ({ body }) => {
          state.createdComments.push(body);
          state.comments.push({ body });
          return {};
        },
        listComments: () => ({}),
      },
    },
    paginate: async () => state.comments,
    graphql: async (query, variables) => {
      if (query.includes('suggestedActors')) {
        return { repository: { suggestedActors: { nodes: state.actors } } };
      }
      if (query.includes('issue(number')) {
        return { repository: { issue: state.issueNode } };
      }
      if (query.includes('replaceActorsForAssignable')) {
        state.lastActorIds = variables.actorIds;
        if (state.graphqlError) {
          throw state.graphqlError;
        }
        return {
          replaceActorsForAssignable: {
            assignable: {
              assignees: {
                nodes: (state.assignResultLogins || []).map((login) => ({
                  login,
                })),
              },
            },
          },
        };
      }
      throw new Error(`unexpected graphql query: ${query}`);
    },
  };
  return github;
}

const context = {
  repo: { owner: 'acme', repo: 'widgets' },
  payload: { issue: { number: 42 } },
};

const tokenEnv = { COPILOT_ASSIGN_TOKEN: 'gho_exampletoken' };

test('parseBoolean recognizes truthy tokens only', () => {
  for (const v of ['1', 'true', 'YES', 'On']) {
    assert.equal(parseBoolean(v), true);
  }
  for (const v of ['0', 'false', '', undefined, 'nope']) {
    assert.equal(parseBoolean(v), false);
  }
});

test('parseList splits on commas and newlines and trims', () => {
  assert.deepEqual(parseList('a, b\nc ,, '), ['a', 'b', 'c']);
  assert.deepEqual(parseList(undefined), []);
});

test('resolveConfig applies documented defaults', () => {
  const config = resolveConfig({});
  assert.equal(config.implementLabel, 'agent: implement');
  assert.equal(config.queuedLabel, 'agent: queued');
  assert.equal(config.assignedLabel, 'agent: assigned');
  assert.equal(config.failedLabel, 'agent: failed');
  assert.deepEqual(config.suppressLabels, ['agent: manual', 'agent: blocked']);
  assert.deepEqual(config.copilotLogins, DEFAULT_COPILOT_LOGINS);
  assert.equal(config.dryRun, false);
  assert.equal(config.replaceAssignees, false);
  assert.equal(config.postInstructions, true);
  assert.equal(config.hasToken, false);
});

test('resolveConfig honors overrides', () => {
  const config = resolveConfig({
    IMPLEMENT_LABEL: 'go',
    SUPPRESS_LABELS: 'hold',
    DRY_RUN: 'true',
    POST_INSTRUCTIONS: 'false',
    COPILOT_ASSIGN_TOKEN: 'x',
  });
  assert.equal(config.implementLabel, 'go');
  assert.deepEqual(config.suppressLabels, ['hold']);
  assert.equal(config.dryRun, true);
  assert.equal(config.postInstructions, false);
  assert.equal(config.hasToken, true);
});

test('isCopilotLogin and findCopilotActor are case-insensitive', () => {
  assert.equal(isCopilotLogin('Copilot-SWE-Agent', DEFAULT_COPILOT_LOGINS), true);
  assert.equal(isCopilotLogin('octocat', DEFAULT_COPILOT_LOGINS), false);
  const actor = findCopilotActor(
    [
      { id: '1', login: 'octocat' },
      { id: '2', login: 'Copilot' },
    ],
    DEFAULT_COPILOT_LOGINS,
  );
  assert.equal(actor.id, '2');
});

test('findCopilotActor prefers the current login over legacy', () => {
  const actor = findCopilotActor(
    [
      { id: 'legacy', login: 'copilot' },
      { id: 'current', login: 'copilot-swe-agent' },
    ],
    DEFAULT_COPILOT_LOGINS,
  );
  assert.equal(actor.id, 'current');
});

test('evaluateEligibility covers each gate', () => {
  const config = resolveConfig({});
  assert.equal(
    evaluateEligibility(
      { state: 'closed', labels: ['agent: implement'], assigneeLogins: [] },
      config,
    ).eligible,
    false,
  );
  assert.equal(
    evaluateEligibility(
      { state: 'open', labels: [], assigneeLogins: [] },
      config,
    ).eligible,
    false,
  );
  assert.equal(
    evaluateEligibility(
      {
        state: 'open',
        labels: ['agent: implement', 'agent: manual'],
        assigneeLogins: [],
      },
      config,
    ).eligible,
    false,
  );
  assert.equal(
    evaluateEligibility(
      {
        state: 'open',
        labels: ['agent: implement'],
        assigneeLogins: ['copilot-swe-agent'],
      },
      config,
    ).eligible,
    false,
  );
  assert.equal(
    evaluateEligibility(
      { state: 'open', labels: ['agent: implement'], assigneeLogins: [] },
      config,
    ).eligible,
    true,
  );
});

test('sanitizeError redacts tokens and truncates', () => {
  assert.match(
    sanitizeError(new Error('boom ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')),
    /\[redacted\]/,
  );
  const bearerInput = ['bearer', 'sensitive-value-123'].join(' ');
  assert.match(sanitizeError(bearerInput), /bearer \[redacted\]/i);
  const long = sanitizeError(new Error('x'.repeat(1000)));
  assert.ok(long.length <= 501);
  assert.equal(sanitizeError(undefined), 'an unexpected error occurred');
});

test('normalizeIssue handles string and object labels', () => {
  const normalized = normalizeIssue({
    state: 'open',
    labels: ['a', { name: 'b' }, { name: '' }],
    assignees: [{ login: 'octocat' }],
  });
  assert.deepEqual(normalized.labels, ['a', 'b']);
  assert.deepEqual(normalized.assigneeLogins, ['octocat']);
});

test('run fails clearly when the token is missing without leaking', async () => {
  const github = makeGithub();
  const core = makeCore();
  const result = await run({ github, context, core, env: {} });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'missing token');
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /COPILOT_ASSIGN_TOKEN/);
  assert.equal(github._state.addedLabels.length, 0);
});

test('run skips issues that are not eligible', async () => {
  const github = makeGithub({
    issue: { state: 'open', labels: [{ name: 'bug' }], assignees: [] },
  });
  const core = makeCore();
  const result = await run({ github, context, core, env: tokenEnv });
  assert.equal(result.status, 'skipped');
  assert.equal(github._state.addedLabels.length, 0);
});

test('run in dry-run mode performs no mutations', async () => {
  const github = makeGithub();
  const core = makeCore();
  const result = await run({
    github,
    context,
    core,
    env: { ...tokenEnv, DRY_RUN: 'true' },
  });
  assert.equal(result.status, 'dry-run');
  assert.equal(github._state.addedLabels.length, 0);
  assert.equal(github._state.createdComments.length, 0);
});

test('run assigns Copilot, labels queued+assigned, and posts instructions', async () => {
  const github = makeGithub();
  const core = makeCore();
  const result = await run({ github, context, core, env: tokenEnv });
  assert.equal(result.status, 'assigned');
  assert.ok(github._state.addedLabels.includes('agent: queued'));
  assert.ok(github._state.addedLabels.includes('agent: assigned'));
  assert.ok(
    github._state.createdComments.some((body) =>
      body.includes(INSTRUCTIONS_MARKER),
    ),
  );
});

test('run preserves existing human assignees', async () => {
  const github = makeGithub({
    issueNode: {
      id: 'ISSUE_NODE',
      assignees: { nodes: [{ id: 'USER_octo', login: 'octocat' }] },
    },
  });
  const core = makeCore();
  await run({ github, context, core, env: tokenEnv });
  assert.deepEqual(github._state.lastActorIds, ['USER_octo', 'BOT_copilot']);
});

test('run replaces assignees only when explicitly configured', async () => {
  const github = makeGithub({
    issueNode: {
      id: 'ISSUE_NODE',
      assignees: { nodes: [{ id: 'USER_octo', login: 'octocat' }] },
    },
  });
  const core = makeCore();
  await run({
    github,
    context,
    core,
    env: { ...tokenEnv, REPLACE_ASSIGNEES: 'true' },
  });
  assert.deepEqual(github._state.lastActorIds, ['BOT_copilot']);
});

test('run marks failure and comments when the actor is unavailable', async () => {
  const github = makeGithub({ actors: [] });
  const core = makeCore();
  const result = await run({ github, context, core, env: tokenEnv });
  assert.equal(result.status, 'failed');
  assert.ok(github._state.addedLabels.includes('agent: failed'));
  assert.ok(
    github._state.createdComments.some((body) => body.includes(FAILURE_MARKER)),
  );
  assert.equal(core.failures.length, 1);
});

test('run does not duplicate the failure comment on re-run', async () => {
  const github = makeGithub({
    actors: [],
    comments: [{ body: `${FAILURE_MARKER}\nprevious failure` }],
  });
  const core = makeCore();
  const result = await run({
    github,
    context,
    core,
    env: { ...tokenEnv, POST_INSTRUCTIONS: 'false' },
  });
  assert.equal(result.status, 'failed');
  assert.equal(github._state.createdComments.length, 0);
});

test('run fails when the mutation does not confirm assignment', async () => {
  const github = makeGithub({ assignResultLogins: [] });
  const core = makeCore();
  const result = await run({ github, context, core, env: tokenEnv });
  assert.equal(result.status, 'failed');
  assert.ok(github._state.addedLabels.includes('agent: failed'));
});
