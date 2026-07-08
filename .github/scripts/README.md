# Assign Copilot Agent

A small, repo-as-code GitHub Action that assigns the **GitHub Copilot coding
agent** to an issue as soon as the issue is tagged with `agent: implement`.

It supports a human-gated workflow: triage issues manually, then opt specific
issues into agentic implementation by applying a single label. It is
deterministic and easy to remove later if GitHub ships a native "label added"
Copilot automation trigger.

- Workflow: [`.github/workflows/agent-assign.yml`](../workflows/agent-assign.yml)
- Script: [`assign-copilot-agent.js`](assign-copilot-agent.js)
- Tests: [`assign-copilot-agent.test.js`](assign-copilot-agent.test.js)
  (run with `node --test .github/scripts/assign-copilot-agent.test.js`)

## Behavior

The workflow triggers on `issues.opened`, `issues.reopened`, and
`issues.labeled`. On each event the script re-reads the issue's current state
(it does not trust the webhook payload) and continues **only** when all of the
following hold:

- the issue is open,
- the issue has the `agent: implement` label,
- the issue does **not** have a suppression label (`agent: manual` or
  `agent: blocked`),
- the Copilot coding agent (`copilot-swe-agent`) is not already assigned, and
- the `COPILOT_ASSIGN_TOKEN` secret is present.

When eligible it:

1. Adds the `agent: queued` label.
2. Posts a one-time custom-instructions comment for the agent (idempotent via a
   hidden marker; can be disabled).
3. Resolves the GraphQL node ids for the Copilot actor (from the repository's
   suggested assignable actors) and the issue.
4. Assigns the issue to Copilot with the `replaceActorsForAssignable` mutation,
   **preserving existing human assignees**.
5. Adds `agent: assigned` on success and removes `agent: failed` if present.
6. On failure, adds `agent: failed` and posts a concise, sanitized comment
   (idempotent via a hidden marker) so re-runs do not spam the issue.

Re-running is idempotent: once Copilot is assigned the script exits early
without re-assigning or re-commenting.

## Setup

1. Create a repository secret named `COPILOT_ASSIGN_TOKEN`.

   The Copilot assignment API requires a **user token** or a **GitHub App
   user-to-server token** that can assign the Copilot coding agent. A plain
   `GITHUB_TOKEN` or a GitHub App **installation** token is **not** sufficient.

   Expected token permissions:

   | Scope          | Access       |
   | -------------- | ------------ |
   | metadata       | read         |
   | issues         | read / write |
   | contents       | read / write |
   | pull requests  | read / write |
   | actions        | read / write |

2. (Recommended) Pre-create the labels below so they get intentional colors and
   descriptions. The action adds labels with GitHub's default color if they do
   not already exist.

3. Apply `agent: implement` to an open issue. The workflow assigns Copilot.

If the secret is missing, the workflow fails fast with a clear error and never
prints the secret value.

## Labels

| Label             | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `agent: implement`| Opt an issue into agentic implementation (the trigger label).  |
| `agent: queued`   | The assignment workflow has started for this issue.            |
| `agent: assigned` | Copilot assignment succeeded.                                  |
| `agent: failed`   | Assignment failed; see the issue comment for the reason.       |
| `agent: manual`   | Suppress automatic assignment (handle manually).               |
| `agent: blocked`  | Suppress automatic assignment because the issue is not ready.  |

## Configuration

All configuration is optional and read from environment variables, wired in the
workflow from repository **variables** (`vars.*`) so you can override defaults
without editing the workflow:

| Env var               | Default                                   | Purpose                                                   |
| --------------------- | ----------------------------------------- | --------------------------------------------------------- |
| `COPILOT_ASSIGN_TOKEN`| _(required)_                              | Credential that can assign Copilot.                       |
| `DRY_RUN`             | `false`                                   | Evaluate eligibility and log intent, but make no changes. |
| `IMPLEMENT_LABEL`     | `agent: implement`                        | The opt-in trigger label.                                 |
| `QUEUED_LABEL`        | `agent: queued`                           | Label added when the workflow starts.                     |
| `ASSIGNED_LABEL`      | `agent: assigned`                         | Label added on success.                                   |
| `FAILED_LABEL`        | `agent: failed`                           | Label added on failure.                                   |
| `SUPPRESS_LABELS`     | `agent: manual, agent: blocked`           | Comma/newline-separated labels that suppress assignment.  |
| `COPILOT_LOGINS`      | `copilot-swe-agent, copilot`              | Known Copilot actor logins (current first).               |
| `POST_INSTRUCTIONS`   | `true`                                    | Post the custom-instruction comment for the agent.        |
| `CUSTOM_INSTRUCTIONS` | _(built-in default block)_                | Override the custom-instruction text.                     |
| `REPLACE_ASSIGNEES`   | `false`                                   | When `true`, replace human assignees instead of keeping.  |

The built-in custom instructions ask the agent to make the smallest safe
change, prioritize reliability, maintainability, accessibility and low cost,
avoid scope creep, include tests where practical, avoid introducing paid
services or new infrastructure, and open a focused pull request referencing the
issue.

## Testing without assigning Copilot

- Set the `AGENT_ASSIGN_DRY_RUN` repository variable to `true` (or `DRY_RUN`
  env) to exercise the full trigger and eligibility path without assigning
  Copilot or mutating the issue.
- The script is unit tested against a mocked GitHub client:

  ```sh
  node --test .github/scripts/assign-copilot-agent.test.js
  ```

## Limitations

- The action does not merge pull requests and does not replace human triage.
- It introduces no paid services or external infrastructure.
- The Copilot assignment API requires a user/user-to-server token; a normal
  `GITHUB_TOKEN` cannot assign the Copilot coding agent.
- If GitHub adds a native label-added Copilot automation trigger, this action
  can be removed without affecting anything else in the repository.
