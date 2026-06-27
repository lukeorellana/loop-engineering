# CI Triage

A GitHub Action that triages a failed CI workflow run and hands it to the
Copilot Agent Tasks API, opening or reusing a fix pull request. The action keeps
a human in the loop: a person reviews and merges every fix pull request.

> **Status:** This package defines the stable public contract — every v1 input,
> output, outcome, and reason code — validates inputs end to end, resolves the
> failed run's delivery target, builds the hardened Copilot investigation prompt,
> and composes them into the executable action: it starts (or, in a dry run,
> previews) a GitHub Copilot Agent Tasks task through a dedicated provider
> boundary. The reusable contract lives under `src/domain/` (outcomes,
> pull-request modes, reason codes, the pure target-resolution decisions, and the
> pure triage-prompt builder) and is re-exported from `src/contracts.ts`; the
> failed-run and pull-request target resolver (`resolveTriageTarget`) lives under
> `src/adapters/github/` over a narrow, mockable GitHub API boundary; the Agent
> Tasks provider (`GitHubAgentTasksProvider`) lives under
> `src/adapters/agent-tasks/` over a narrow, mockable transport boundary that
> isolates the preview endpoint path and the pinned API version; the
> input/output mapping and composition root live under `src/action/`, and the
> entry point is `src/main.ts`.

The action is packaged with the same Node 20 TypeScript model as
[`feature-loop`](../feature-loop): TypeScript sources under `src/`, bundled with
[`@vercel/ncc`](https://github.com/vercel/ncc) into a committed `dist/index.js`.

## Documentation

A new repository can adopt CI Triage from these guides and the
[examples](examples/README.md) without reading the source:

- [Setup guide](docs/setup.md) — prerequisites and a step-by-step adoption path.
- [Reference](docs/reference.md) — every input, output, outcome, and reason code,
  plus the pull-request-mode matrix.
- [Pipeline targeting](docs/pipeline-targeting.md) — which workflows trigger
  triage and where that decision lives (the consumer workflow).
- [Security model](docs/security.md) — trust boundaries, token responsibilities,
  and required permissions.
- [Operational behavior & public-preview limits](docs/operations.md) — what the
  action guarantees and what the preview API does not.
- [Troubleshooting & recovery](docs/troubleshooting.md) — how to act on every
  outcome and reason.
- [Integration validation](docs/integration-validation.md) — the disposable
  end-to-end validation plan.
- [CallAgent migration](docs/migration-callagent.md) — reversible migration from
  an inline Agent Tasks workflow, with rollback.
- [Release & versioning](docs/release.md) — the repository-wide release model
  shared with Feature Loop.

## Inputs

| Input                 | Required | Default               | Description                                                                                          |
| --------------------- | -------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| `github-token`        | yes      | `${{ github.token }}` | Token for repository, workflow-run, branch, commit, and pull-request reads.                          |
| `agent-token`         | yes      | _none_                | Credential for Agent Tasks reads and writes. The workflow token cannot start Agent Tasks.            |
| `model`               | no       | _empty_               | Model identifier passed unchanged to the Agent Tasks API. Empty means no override; no allowlist.     |
| `pull-request-mode`   | no       | `auto`                | Fix pull-request resolution: `auto`, `existing`, or `new`. Any other value is a configuration error. |
| `prompt-instructions` | no       | _empty_               | Trusted repository-owner instructions appended to the triage prompt.                                 |
| `additional-context`  | no       | _empty_               | Bounded operational evidence. Treated as untrusted data, never as instructions.                      |
| `include-history`     | no       | `true`                | Collect bounded, redacted previous-attempt history (best effort) for the prompt. Strict boolean.     |
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
[`src/domain/contract.ts`](src/domain/contract.ts). The action entry point emits
`invalid-input` and `dry-run-preview` from input handling and `task-started`
from a successful start; the target resolver
([`src/adapters/github/resolve-target.ts`](src/adapters/github/resolve-target.ts))
produces the failed-run and pull-request codes (`not-a-workflow-run-event`,
`workflow-run-not-completed`, `workflow-run-not-failed`,
`unsupported-triggering-event`, `pull-request-not-found`,
`pull-request-ambiguous`, `pull-request-closed`, `fork-pull-request`,
`existing-mode-requires-pull-request`, `target-branch-not-found`, and
`stale-workflow-run`); and the Agent Tasks provider
([`src/adapters/agent-tasks/`](src/adapters/agent-tasks/)) classifies every API
failure into one of `agent-auth-failed`, `agent-forbidden`, `agent-unsupported`,
`agent-invalid-request` (including an invalid model, with no silent fallback),
`agent-rate-limited`, `agent-transient`, or `agent-unexpected-response`. The
credential, permission, plan, and request-validation failures fail closed as
`configuration-error`; rate-limit, transient, and malformed-response failures are
`operational-error`.

The idempotency, reconciliation, and history codes
(`agent-task-already-exists`, `agent-task-create-reconciled`,
`agent-task-reconciliation-failed`, and `agent-task-history-unavailable`) are
described under [Idempotency, reconciliation, and history](#idempotency-reconciliation-and-history).

## Idempotency, reconciliation, and history

CI Triage deduplicates work per failed run **attempt** on a best-effort basis.
Every generated prompt carries a hidden, machine-readable fingerprint marker
(`<!-- ci-triage-fingerprint: ... -->`) derived only from non-secret identity
metadata — the CI Triage prompt/version marker, the repository, the workflow run
id, the run attempt, and the resolved target head ref. The same run attempt
always yields the same fingerprint; a **new** run attempt yields a different one.

> **Best effort only.** The public-preview Agent Tasks API exposes no atomic
> idempotency key, so deduplication cannot be guaranteed across truly concurrent
> callers. CI Triage minimizes duplicates by searching recent Agent Tasks for the
> fingerprint before creating, and by reconciling uncertain create results.

- **Deduplication.** Before creating a task (outside of a dry run), the action
  lists recent Agent Tasks with `agent-token`, retrieves candidate task details
  as needed, and matches the exact fingerprint marker. A match returns
  `duplicate` / `agent-task-already-exists` with the existing task id and URL and
  starts no new task. If the deduplication search itself cannot be performed
  reliably, the action fails closed rather than risk a duplicate.
- **Reconciliation.** After an uncertain create result (a network timeout or an
  undecodable response), the action searches again for the fingerprint. When the
  task is found it returns `agent-task-create-reconciled`; only when no task can
  be confirmed does it report `agent-task-reconciliation-failed`
  (`operational-error`).
- **No attempt cap.** v1 deliberately implements no automatic
  maximum-remediation-attempt cap or circuit breaker. Each new **failed workflow
  run attempt** may legitimately start another task, while reprocessing the
  **same exact** run attempt reconciles to the one task.
- **Recommended concurrency.** Because deduplication is best effort, consumers
  should serialize duplicate workflow executions with a workflow `concurrency`
  group keyed by repository, run id, and run attempt so duplicate executions
  queue rather than race, for example:

  ```yaml
  concurrency:
    group: ci-triage-${{ github.repository }}-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}
    cancel-in-progress: false
  ```

### Previous-attempt history

When `include-history` is `true`, the action collects bounded, redacted
previous-attempt context and feeds it into the prompt with explicit instructions
to review previous attempts before changing code, not to repeat a failed change
unchanged, and to explain why a new approach is materially different when earlier
fixes did not work. The collected context is strictly bounded and redacted:

- Recent commits ending at the resolved target (short SHA, author **name**, date,
  and subject). Commit-author **email addresses are never included**.
- Recent matching CI Triage tasks and their state, URL, a **truncated** approach
  summary (never the complete prior prompt), and any associated pull request.
- Legacy `copilot/*` pull requests discovered by branch convention are used
  **only as a fallback** for attempts that predate CI Triage fingerprints; they
  are never treated as authoritative for deduplicating a new task.

History collection is best effort: a source that cannot be retrieved is recorded
safely (`agent-task-history-unavailable`) and never blocks a new task. Failures
never leak credentials or dump API payloads.

## Agent Tasks provider

The Copilot Agent Tasks provider lives under
[`src/adapters/agent-tasks/`](src/adapters/agent-tasks/). It is a provider
boundary around the public-preview Agent Tasks API: the triage orchestration
speaks only the clean `AgentTasksProvider` port (a resolved target, a model
decision, and a prompt in; a started task or a stable failure reason out), so the
preview API's request and response types never leak into the core logic.

- **Credentials.** The repository token (`github-token`) drives the read-only
  workflow-run and pull-request reads; the dedicated `agent-token` drives the
  Agent Tasks provider. Both are registered as secrets so the runner masks them,
  and the provider never logs authorization headers, raw responses (which may
  echo prompt content), or the full generated prompt.
- **Request shape.** In existing-PR mode the request sends both `base_ref` and
  `head_ref` and does not request a new pull request; in new-PR mode it sends
  only `base_ref` and `create_pull_request: true`. A non-empty `model` is sent
  unchanged; an empty model is omitted entirely (no allowlist, no retry without
  the model).
- **Pinned endpoint.** The preview path and the documented
  `X-GitHub-Api-Version` header live only in
  [`src/adapters/agent-tasks/endpoint.ts`](src/adapters/agent-tasks/endpoint.ts),
  so the action can be repointed in one place if the preview API evolves.

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
metadata (the prompt/version marker, repository, run id, run attempt, and target
head ref), for the best-effort deduplication and reconciliation described under
[Idempotency, reconciliation, and history](#idempotency-reconciliation-and-history).

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
