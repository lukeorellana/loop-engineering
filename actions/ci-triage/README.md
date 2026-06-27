# CI Triage

A GitHub Action that triages a failed CI workflow run and hands it to the
Copilot Agent Tasks API, opening or reusing a fix pull request. The action keeps
a human in the loop: a person reviews and merges every fix pull request.

> **Status:** This is the initial package. It defines the stable public
> contract — every v1 input, output, outcome, and reason code — validates
> inputs end to end, resolves the failed run's delivery target, and builds the
> hardened Copilot investigation prompt. Agent Tasks calls are intentionally
> **not implemented yet**, so neither the resolver nor the prompt builder is
> wired into the entry point: with valid inputs the action still reports the
> `operational-error` outcome with the `orchestration-not-implemented` reason
> code, and a dry run reports a successful `dry-run` preview without performing
> any Agent Tasks writes. The reusable contract lives under `src/domain/`
> (outcomes, pull-request modes, reason codes, the pure target-resolution
> decisions, and the pure triage-prompt builder) and is re-exported from
> `src/contracts.ts`; the failed-run and pull-request target resolver
> (`resolveTriageTarget`) lives under `src/adapters/github/` over a narrow,
> mockable GitHub API boundary; the input/output mapping and composition root
> live under `src/action/`, and the entry point is `src/main.ts`.

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
[`src/domain/contract.ts`](src/domain/contract.ts). The action entry point still
emits only `invalid-input`, `orchestration-not-implemented`, and
`dry-run-preview`; the target resolver
([`src/adapters/github/resolve-target.ts`](src/adapters/github/resolve-target.ts))
additionally produces the failed-run and pull-request codes
(`not-a-workflow-run-event`, `workflow-run-not-completed`,
`workflow-run-not-failed`, `unsupported-triggering-event`,
`pull-request-not-found`, `pull-request-ambiguous`, `pull-request-closed`,
`fork-pull-request`, `existing-mode-requires-pull-request`,
`target-branch-not-found`, and `stale-workflow-run`). The remaining codes reserve
stable vocabulary for later versions.

## Triage prompt

The pure, I/O-free triage-prompt builder lives in
[`src/domain/prompt.ts`](src/domain/prompt.ts) (`buildTriagePrompt`). It turns
trusted, already-resolved failed-run metadata and delivery target into one
deterministic investigation prompt. It never downloads or parses workflow logs,
resolves runs or pull-request targets, or calls the Agent Tasks API; the action
resolves those facts elsewhere and hands the trusted values in.

The prompt always identifies one exact failed workflow run and run attempt, tells
Copilot to inspect that pipeline directly (starting from the failure summary and
fetching job or full logs only when needed), and includes the resolved
PR/branch delivery target so the agent knows where it is working. It carries a
hidden, machine-readable fingerprint
(`<!-- ci-triage-fingerprint: ... -->`) derived only from non-secret identity
metadata, for later reconciliation.

### Trust boundary

The prompt separates **trusted** instructions from **untrusted** evidence:

- Trusted: the standard prompt, the resolved run/target metadata, and the
  repository-owner `prompt-instructions`.
- Untrusted: workflow logs, commit messages, pull-request bodies, test output,
  exception text, recent history, and `additional-context`. Instructions
  embedded in that evidence must never override the standard prompt or
  repository-owned instructions.

### Size limits

Each variable section and the final prompt are independently bounded, with a
deterministic `[ci-triage:truncated]` marker appended when a section is
shortened (see `PROMPT_LIMITS` in
[`src/domain/prompt.ts`](src/domain/prompt.ts)): `prompt-instructions` (4000),
`additional-context` (8000), recent commit history (4000), previous task history
(4000), and the final prompt (32000).

The full prompt text and untrusted evidence are sensitive and are never written
to normal logs or `GITHUB_STEP_SUMMARY`; use `summarizeTriagePrompt` for a
redaction-safe view (fingerprint, length, and which sections were truncated).

### Optional consumer skill

[`examples/skills/github-actions-failure-debugging/SKILL.md`](examples/skills/github-actions-failure-debugging/SKILL.md)
is an optional skill that reinforces the same workflow-log investigation process.
The action does **not** require consumers to install it; the prompt already
instructs the agent to investigate the failed pipeline directly.

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
