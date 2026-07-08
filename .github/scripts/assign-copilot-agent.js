// @ts-check
'use strict';

/**
 * Assign the GitHub Copilot coding agent to an issue that has opted into
 * agentic implementation via the `agent: implement` label.
 *
 * This module is deliberately dependency-free so it can run under
 * `actions/github-script` (which supplies an authenticated `github` Octokit,
 * the workflow `context`, and `core`) and be unit tested with mocked
 * collaborators and Node's built-in test runner. It performs no logging of
 * tokens or raw API responses and fails closed: any unexpected condition marks
 * the issue as failed with a concise, sanitized comment rather than silently
 * doing nothing.
 *
 * The design mirrors the repository's existing Copilot provider: discover the
 * assignable Copilot actor from `suggestedActors`, read the issue node id and
 * current assignees, then assign via the `replaceActorsForAssignable` GraphQL
 * mutation while preserving existing human assignees.
 */

/** Known Copilot coding-agent logins, current first, matched case-insensitively. */
const DEFAULT_COPILOT_LOGINS = ['copilot-swe-agent', 'copilot'];

/** Hidden markers used to keep the failure/instruction comments idempotent. */
const FAILURE_MARKER = '<!-- copilot-agent-assign:failed -->';
const INSTRUCTIONS_MARKER = '<!-- copilot-agent-assign:instructions -->';

/** The default custom-instruction block posted for the agent to follow. */
const DEFAULT_CUSTOM_INSTRUCTIONS = [
  'Implement the issue with the smallest safe change.',
  '',
  'Project priorities:',
  '- reliability and maintainability over speed',
  '- accessibility matters',
  '- keep operating cost low',
  '- avoid scope creep',
  '- include or update tests where practical',
  '- do not introduce paid services or new infrastructure unless the issue explicitly requests it',
  '- open a focused pull request and reference this issue',
].join('\n');

/**
 * Parse a boolean-ish environment value. Defaults to `false` for anything that
 * is not an explicit truthy token.
 *
 * @param {string | undefined} value
 * @returns {boolean}
 */
function parseBoolean(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Split a comma/newline separated list into trimmed, non-empty entries.
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
function parseList(value) {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve the effective configuration from the process environment, applying
 * documented defaults. Exposed for testing.
 *
 * @param {Record<string, string | undefined>} env
 */
function resolveConfig(env) {
  const copilotLogins = parseList(env.COPILOT_LOGINS);
  return {
    implementLabel: (env.IMPLEMENT_LABEL || 'agent: implement').trim(),
    queuedLabel: (env.QUEUED_LABEL || 'agent: queued').trim(),
    assignedLabel: (env.ASSIGNED_LABEL || 'agent: assigned').trim(),
    failedLabel: (env.FAILED_LABEL || 'agent: failed').trim(),
    suppressLabels: parseList(
      env.SUPPRESS_LABELS === undefined
        ? 'agent: manual, agent: blocked'
        : env.SUPPRESS_LABELS,
    ),
    copilotLogins:
      copilotLogins.length > 0 ? copilotLogins : DEFAULT_COPILOT_LOGINS,
    dryRun: parseBoolean(env.DRY_RUN),
    replaceAssignees: parseBoolean(env.REPLACE_ASSIGNEES),
    postInstructions:
      env.POST_INSTRUCTIONS === undefined
        ? true
        : parseBoolean(env.POST_INSTRUCTIONS),
    customInstructions:
      typeof env.CUSTOM_INSTRUCTIONS === 'string' &&
      env.CUSTOM_INSTRUCTIONS.trim().length > 0
        ? env.CUSTOM_INSTRUCTIONS
        : DEFAULT_CUSTOM_INSTRUCTIONS,
    baseRef:
      typeof env.BASE_REF === 'string' && env.BASE_REF.trim().length > 0
        ? env.BASE_REF.trim()
        : null,
    hasToken:
      typeof env.COPILOT_ASSIGN_TOKEN === 'string' &&
      env.COPILOT_ASSIGN_TOKEN.trim().length > 0,
  };
}

/**
 * Case-insensitive membership test for a login against the known set.
 *
 * @param {string} login
 * @param {readonly string[]} copilotLogins
 */
function isCopilotLogin(login, copilotLogins) {
  const normalized = login.toLowerCase();
  return copilotLogins.some((known) => known.toLowerCase() === normalized);
}

/**
 * The Copilot actor among assignable actors, preferring the current login over
 * documented legacy logins. Returns `null` when none match.
 *
 * @param {ReadonlyArray<{ id: string; login: string }>} actors
 * @param {readonly string[]} copilotLogins
 */
function findCopilotActor(actors, copilotLogins) {
  for (const login of copilotLogins) {
    const match = actors.find(
      (actor) => actor.login.toLowerCase() === login.toLowerCase(),
    );
    if (match) {
      return match;
    }
  }
  return null;
}

/**
 * Pure eligibility decision. Kept side-effect free so it can be exhaustively
 * unit tested.
 *
 * @param {{
 *   state: string;
 *   labels: readonly string[];
 *   assigneeLogins: readonly string[];
 * }} issue
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {{ eligible: boolean; reason: string }}
 */
function evaluateEligibility(issue, config) {
  const labels = issue.labels.map((label) => label.toLowerCase());
  if (issue.state !== 'open') {
    return { eligible: false, reason: 'issue is not open' };
  }
  if (!labels.includes(config.implementLabel.toLowerCase())) {
    return {
      eligible: false,
      reason: `issue is not labeled "${config.implementLabel}"`,
    };
  }
  const suppressing = config.suppressLabels.find((label) =>
    labels.includes(label.toLowerCase()),
  );
  if (suppressing) {
    return {
      eligible: false,
      reason: `issue has suppression label "${suppressing}"`,
    };
  }
  if (
    issue.assigneeLogins.some((login) =>
      isCopilotLogin(login, config.copilotLogins),
    )
  ) {
    return { eligible: false, reason: 'Copilot is already assigned' };
  }
  return { eligible: true, reason: 'eligible' };
}

/**
 * Reduce an arbitrary thrown value to a short, sanitized reason string. Never
 * includes tokens or raw response bodies; GraphQL error messages are truncated.
 *
 * @param {unknown} error
 * @returns {string}
 */
function sanitizeError(error) {
  let message = 'an unexpected error occurred';
  if (error && typeof error === 'object' && 'message' in error) {
    const raw = /** @type {{ message?: unknown }} */ (error).message;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      message = raw.trim();
    }
  } else if (typeof error === 'string' && error.trim().length > 0) {
    message = error.trim();
  }
  // Defensively strip anything that looks like a bearer/token value and cap the
  // length so we never emit an oversized or credential-bearing comment.
  message = message.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]');
  message = message.replace(/bearer\s+\S+/gi, 'bearer [redacted]');
  if (message.length > 500) {
    message = `${message.slice(0, 500)}…`;
  }
  return message;
}

/**
 * Normalize a REST issue payload into the minimal shape the decision uses.
 *
 * @param {{
 *   state: string;
 *   labels: Array<string | { name?: string }>;
 *   assignees: Array<{ login: string }>;
 * }} issue
 */
function normalizeIssue(issue) {
  const labels = (issue.labels || []).map((label) =>
    typeof label === 'string' ? label : (label.name ?? ''),
  );
  return {
    state: issue.state,
    labels: labels.filter((name) => name.length > 0),
    assigneeLogins: (issue.assignees || []).map((assignee) => assignee.login),
  };
}

/**
 * Main entry point. Invoked by the workflow via `actions/github-script`.
 *
 * @param {{
 *   github: any;
 *   context: any;
 *   core: any;
 *   env?: Record<string, string | undefined>;
 * }} deps
 */
async function run({ github, context, core, env = process.env }) {
  const config = resolveConfig(env);
  const { owner, repo } = context.repo;
  const issueNumber = context.payload.issue && context.payload.issue.number;

  if (!issueNumber) {
    core.info('No issue in the event payload; nothing to do.');
    return { status: 'skipped', reason: 'no issue in payload' };
  }

  const logPrefix = `#${issueNumber}`;

  // Fail clearly, and without leaking anything, when the credential is absent.
  if (!config.hasToken) {
    const message =
      'COPILOT_ASSIGN_TOKEN is not configured. Set the repository secret to a ' +
      'user or GitHub App user-to-server token that can assign the Copilot ' +
      'coding agent.';
    core.setFailed(message);
    return { status: 'failed', reason: 'missing token' };
  }

  // Always read fresh state rather than trusting the (possibly stale) webhook
  // payload. This keeps opened/reopened/labeled events consistent.
  const fresh = await github.rest.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });
  const issue = normalizeIssue(fresh.data);

  const eligibility = evaluateEligibility(issue, config);
  if (!eligibility.eligible) {
    core.info(`${logPrefix} skipped: ${eligibility.reason}.`);
    return { status: 'skipped', reason: eligibility.reason };
  }

  core.info(`${logPrefix} eligible for Copilot assignment.`);

  if (config.dryRun) {
    core.info(
      `${logPrefix} dry run: would ensure "${config.queuedLabel}", assign ` +
        `Copilot, and add "${config.assignedLabel}". No changes made.`,
    );
    return { status: 'dry-run', reason: 'dry run' };
  }

  await ensureLabels(github, { owner, repo, issueNumber }, [config.queuedLabel]);

  try {
    if (config.postInstructions) {
      await ensureInstructionsComment(
        github,
        { owner, repo, issueNumber },
        config.customInstructions,
      );
    }

    const assignedLogins = await assignCopilot(
      github,
      { owner, repo, issueNumber },
      config,
    );

    if (
      !assignedLogins.some((login) => isCopilotLogin(login, config.copilotLogins))
    ) {
      throw new Error(
        'the assignment mutation completed but Copilot was not assigned to the issue',
      );
    }

    await ensureLabels(github, { owner, repo, issueNumber }, [
      config.assignedLabel,
    ]);
    await removeLabelIfPresent(
      github,
      { owner, repo, issueNumber },
      config.failedLabel,
    );
    core.info(`${logPrefix} Copilot assignment succeeded.`);
    return { status: 'assigned', reason: 'assigned' };
  } catch (error) {
    const reason = sanitizeError(error);
    core.error(`${logPrefix} Copilot assignment failed: ${reason}`);
    await ensureLabels(github, { owner, repo, issueNumber }, [
      config.failedLabel,
    ]);
    await ensureFailureComment(github, { owner, repo, issueNumber }, reason);
    core.setFailed(`Copilot assignment failed: ${reason}`);
    return { status: 'failed', reason };
  }
}

/**
 * Add labels to the issue if not already present. `addLabels` is additive and
 * auto-creates unknown labels, so this is safe to call repeatedly.
 *
 * @param {any} github
 * @param {{ owner: string; repo: string; issueNumber: number }} ref
 * @param {readonly string[]} labels
 */
async function ensureLabels(github, ref, labels) {
  const wanted = labels.filter((label) => label && label.length > 0);
  if (wanted.length === 0) {
    return;
  }
  await github.rest.issues.addLabels({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.issueNumber,
    labels: wanted,
  });
}

/**
 * Remove a label from the issue, ignoring the case where it is not present.
 *
 * @param {any} github
 * @param {{ owner: string; repo: string; issueNumber: number }} ref
 * @param {string} label
 */
async function removeLabelIfPresent(github, ref, label) {
  if (!label) {
    return;
  }
  try {
    await github.rest.issues.removeLabel({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.issueNumber,
      name: label,
    });
  } catch (error) {
    // A 404 simply means the label was not applied. Any error here is
    // swallowed because label cleanup is best-effort and must never turn a
    // successful assignment into a failure.
    void error;
  }
}

/**
 * Assign Copilot to the issue via GraphQL, preserving existing human assignees
 * unless replacement is explicitly configured. Returns the resulting assignee
 * logins so the caller can verify the assignment took effect.
 *
 * @param {any} github
 * @param {{ owner: string; repo: string; issueNumber: number }} ref
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {Promise<string[]>}
 */
async function assignCopilot(github, ref, config) {
  const actorsResult = await github.graphql(
    `query($owner:String!,$repo:String!){
      repository(owner:$owner,name:$repo){
        suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:100){
          nodes{
            login
            __typename
            ... on Bot { id }
            ... on User { id }
            ... on Mannequin { id }
            ... on Organization { id }
          }
        }
      }
    }`,
    { owner: ref.owner, repo: ref.repo },
  );
  const actorNodes =
    (actorsResult.repository && actorsResult.repository.suggestedActors.nodes) ||
    [];
  const actors = actorNodes
    .filter((node) => node && typeof node.id === 'string')
    .map((node) => ({ id: node.id, login: node.login }));
  const copilot = findCopilotActor(actors, config.copilotLogins);
  if (!copilot) {
    throw new Error(
      'the Copilot coding agent is not available to this repository (no assignable Copilot actor)',
    );
  }

  const issueResult = await github.graphql(
    `query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){
        issue(number:$number){
          id
          assignees(first:100){ nodes{ id login } }
        }
      }
    }`,
    { owner: ref.owner, repo: ref.repo, number: ref.issueNumber },
  );
  const issueNode = issueResult.repository && issueResult.repository.issue;
  if (!issueNode) {
    throw new Error('the issue could not be resolved to a GraphQL node id');
  }

  const existing = issueNode.assignees.nodes;
  const humanActorIds = config.replaceAssignees
    ? []
    : existing
        .filter((node) => !isCopilotLogin(node.login, config.copilotLogins))
        .map((node) => node.id);
  const actorIds = [...humanActorIds, copilot.id];

  const mutationResult = await github.graphql(
    `mutation($assignableId:ID!,$actorIds:[ID!]!){
      replaceActorsForAssignable(input:{assignableId:$assignableId,actorIds:$actorIds}){
        assignable{
          ... on Issue { assignees(first:100){ nodes{ login } } }
        }
      }
    }`,
    { assignableId: issueNode.id, actorIds },
  );
  const assignable =
    mutationResult.replaceActorsForAssignable &&
    mutationResult.replaceActorsForAssignable.assignable;
  const nodes =
    (assignable && assignable.assignees && assignable.assignees.nodes) || [];
  return nodes.map((node) => node.login);
}

/**
 * Post the custom instructions as a comment exactly once (idempotent via a
 * hidden marker), so the Copilot agent has explicit guidance when it starts.
 *
 * @param {any} github
 * @param {{ owner: string; repo: string; issueNumber: number }} ref
 * @param {string} instructions
 */
async function ensureInstructionsComment(github, ref, instructions) {
  if (await hasCommentWithMarker(github, ref, INSTRUCTIONS_MARKER)) {
    return;
  }
  const body = `${INSTRUCTIONS_MARKER}\n### Copilot implementation guidance\n\n${instructions}`;
  await github.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.issueNumber,
    body,
  });
}

/**
 * Post a concise failure comment exactly once (idempotent via a hidden marker)
 * so re-running the workflow does not spam the issue.
 *
 * @param {any} github
 * @param {{ owner: string; repo: string; issueNumber: number }} ref
 * @param {string} reason
 */
async function ensureFailureComment(github, ref, reason) {
  if (await hasCommentWithMarker(github, ref, FAILURE_MARKER)) {
    return;
  }
  const body =
    `${FAILURE_MARKER}\n**Copilot agent assignment failed.**\n\n` +
    `Reason: ${reason}\n\n` +
    'Check the `COPILOT_ASSIGN_TOKEN` secret and its permissions, then re-apply ' +
    'the `agent: implement` label to retry.';
  await github.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.issueNumber,
    body,
  });
}

/**
 * Whether an issue already has a comment carrying the given hidden marker.
 *
 * @param {any} github
 * @param {{ owner: string; repo: string; issueNumber: number }} ref
 * @param {string} marker
 * @returns {Promise<boolean>}
 */
async function hasCommentWithMarker(github, ref, marker) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.issueNumber,
    per_page: 100,
  });
  return comments.some(
    (comment) =>
      typeof comment.body === 'string' && comment.body.includes(marker),
  );
}

module.exports = {
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
  DEFAULT_CUSTOM_INSTRUCTIONS,
  FAILURE_MARKER,
  INSTRUCTIONS_MARKER,
};
