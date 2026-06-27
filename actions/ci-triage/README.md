# CI Triage

A GitHub Action that triages a failed CI workflow run and hands it to the
Copilot Agent Tasks API, opening or reusing a fix pull request. The action keeps
a human in the loop: a person reviews and merges every fix pull request.

> **Status:** This is the initial package. It defines the stable public
> contract — every v1 input, output, outcome, and reason code — and validates
> inputs end to end. Workflow-run and pull-request resolution, prompt
> generation, and Agent Tasks calls are intentionally **not implemented yet**.
> With valid inputs the action reports the `operational-error` outcome with the
> `orchestration-not-implemented` reason code; a dry run reports a successful
> `dry-run` preview without performing any Agent Tasks writes. The reusable
> contract lives under `src/domain/` (outcomes, pull-request modes, and reason
> codes) and is re-exported from `src/contracts.ts`; the input/output mapping and
> composition root live under `src/action/`, and the entry point is `src/main.ts`.

The action is packaged with the same Node 20 TypeScript model as
[`feature-loop`](../feature-loop): TypeScript sources under `src/`, bundled with
[`@vercel/ncc`](https://github.com/vercel/ncc) into a committed `dist/index.js`.

## Inputs

| Input                 | Required | Default               | Description                                                                                          |
| --------------------- | -------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| `github-token`        | yes      | `${{ github.token }}` | Token for repository, workflow-run, branch, commit, and pull-request reads.                          |
| `agent-token`         | yes      | _none_                | Credential for Agent Tasks reads and writes. The workflow token cannot start Agent Tasks.            |
| `model`               | no       | _empty_               | Model identifier passed unchanged to the Agent Tasks API. Empty means no override; no allowlist.     |
| `pull-request-mode`   | no       | `auto`                | Fix pull-request resolution: `auto`, `existing`, or `new`. Any other value is a configuration error. |
| `prompt-instructions` | no       | _empty_               | Trusted repository-owner instructions appended to the triage prompt.                                 |
| `additional-context`  | no       | _empty_               | Bounded operational evidence. Treated as untrusted data, never as instructions.                      |
| `include-history`     | no       | `true`                | Include prior attempts and related history when building the prompt. Strict boolean.                 |
| `dry-run`             | no       | `false`               | Evaluate and report without any Agent Tasks writes or pull-request mutations. Strict boolean.        |

Boolean inputs accept only `true` or `false` (case-insensitive); any other value
is rejected as a configuration error.

## Outputs

Every normal result path sets all outputs; values that do not apply are emitted
as empty strings.

| Output                 | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `outcome`              | The coarse-grained result (see below).                             |
| `reason`               | A stable, machine-readable reason code.                            |
| `task-id`              | The Agent Tasks task id, when a task was started or reused.        |
| `task-url`             | The Agent Tasks task URL, when a task was started or reused.       |
| `workflow-run-id`      | The failed workflow run id, when resolved.                         |
| `workflow-run-attempt` | The failed workflow run attempt, when resolved.                    |
| `resolved-mode`        | The pull-request mode actually applied: `auto`, `existing`, `new`. |
| `target-base-ref`      | The base ref the fix pull request targets, when resolved.          |
| `target-head-ref`      | The head ref of the fix pull request, when resolved.               |
| `existing-pr-number`   | The reused existing fix pull-request number, when one applied.     |

### Outcomes

`started`, `duplicate`, `ignored`, `needs-human`, `dry-run`,
`configuration-error`, `operational-error`.

### Reason codes

The stable reason-code vocabulary is defined in
[`src/domain/contract.ts`](src/domain/contract.ts). Only a subset is emitted by
this version (`invalid-input`, `orchestration-not-implemented`,
`dry-run-preview`); the remainder reserve stable codes for later versions.

## Development

Run every command from this directory (`actions/ci-triage`):

```bash
npm ci
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format:check  # prettier --check
npm run test          # vitest run
npm run build         # ncc bundle to dist/index.js
npm run all           # all of the above, in order
```

After changing anything under `src/`, run `npm run build` and commit the updated
`dist/`. Repository CI fails if the committed bundle is stale.

## Release model

CI Triage and Feature Loop are released together from this repository. See the
[repository README](../../README.md#release-and-versioning) for the
monorepo release and versioning policy.
