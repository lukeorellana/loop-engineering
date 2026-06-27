# CI Triage operational behavior & public-preview limits

This document explains how CI Triage behaves in production, the guarantees it
makes, and the limits imposed by the **public-preview** Agent Tasks API. Read it
alongside the [Security model](security.md) and the
[Troubleshooting & recovery runbook](troubleshooting.md).

## Operational behavior

### The triage workflow never checks out or executes failed-branch code

CI Triage operates entirely on GitHub API metadata for the failed run, its
branches, its commits, and its candidate pull request. The reference workflows
have **no `actions/checkout` step**, and you must not add one. See
[Security model](security.md#the-triage-workflow-never-checks-out-or-executes-failed-branch-code).

### Copilot investigates the exact run directly; CI Triage does not parse logs

CI Triage resolves one exact failed **run id** and **run attempt** and instructs
Copilot to inspect that run directly. The action never downloads or parses logs;
log interpretation is entirely Copilot's job. This keeps untrusted log content
out of the action's control flow.

### A pinned model may be rejected

The `model` input is passed **unchanged** to the Agent Tasks API. The action
keeps no allowlist and performs **no silent fallback** to a default model. GitHub
or your organization policy may reject a pinned, misspelled, or unavailable
model. When that happens the action fails closed as `configuration-error` with
`agent-invalid-request` rather than quietly downgrading the model. Leave `model`
empty to let the API select its own default.

### New-mode PR creation is asynchronous

When the action requests a **new** pull request, the Agent Tasks API creates that
pull request asynchronously, after the task starts. The action therefore cannot
immediately know the future pull-request number and does **not** output it; the
`existing-pr-number` output is set only when an **existing** pull request is
reused. v1 deliberately does **not** poll for the asynchronously created pull
request (a non-goal). Find the resulting pull request from the task itself via
the `task-url`.

### A human may need to approve CI

Depending on your repository settings (for example "Require approval for all
outside collaborators" or first-time-contributor CI approval), CI may not run
automatically on the changes Copilot pushes. A human may need to **approve CI**
before the fix pull request's checks run. CI Triage does not and cannot approve
CI runs, approve pull requests, or merge them — the loop stays human-gated.

### Best-effort idempotency, not exactly-once

CI Triage deduplicates work **per failed run attempt** on a best-effort basis.
Every generated prompt carries a hidden, machine-readable fingerprint marker
(`<!-- ci-triage-fingerprint: … -->`) derived only from non-secret identity
metadata: the CI Triage prompt/version marker, the repository, the workflow run
id, the run attempt, and the resolved target head ref. The same run attempt
always yields the same fingerprint; a **new** run attempt yields a different one.

- **Deduplication.** Before creating a task (outside a dry run), the action lists
  recent Agent Tasks with `agent-token`, retrieves candidate task details as
  needed, and matches the exact fingerprint. A match returns `duplicate` /
  `agent-task-already-exists` with the existing task id and URL, starting no new
  task. If the deduplication search itself cannot be performed reliably, the
  action fails closed rather than risk a duplicate.
- **Reconciliation.** After an uncertain create result (a network timeout or an
  undecodable response), the action searches again for the fingerprint. When the
  task is found it returns `started` / `agent-task-create-reconciled`; only when
  no task can be confirmed does it report `operational-error` /
  `agent-task-reconciliation-failed`.
- **No attempt cap.** v1 implements no automatic maximum-remediation-attempt cap
  or circuit breaker. Each **new failed run attempt** may legitimately start
  another task; reprocessing the **same exact** run attempt reconciles to the one
  task.

> Because the public-preview API exposes **no atomic idempotency key**,
> exactly-once creation cannot be guaranteed across truly concurrent callers.
> Serialize duplicate executions with the recommended `concurrency` group keyed
> by repository, run id, and run attempt so duplicate deliveries queue rather
> than race (see [Setup → Recommended concurrency](setup.md#5-recommended-concurrency)).

### Each new failed attempt may start a new task

Re-running a failed workflow produces a new **run attempt**, which yields a new
fingerprint and may start a new task. This is intentional: a genuinely new
attempt represents new work. Only the **same** run attempt reconciles to a single
task.

### Previous-attempt history is best effort

When `include-history` is `true`, the action collects bounded, redacted
previous-attempt context (recent commits with author **name** only — never email;
recent matching CI Triage tasks with a truncated approach summary — never the
full prior prompt; and legacy `copilot/*` pull requests only as a fallback) and
feeds it into the prompt. History collection never blocks a new task: a source
that cannot be retrieved is recorded safely as `agent-task-history-unavailable`.

## Public-preview API limitations

Agent Tasks is in **public preview**. CI Triage isolates the preview path and the
pinned API version in
[`src/adapters/agent-tasks/endpoint.ts`](../src/adapters/agent-tasks/endpoint.ts)
so the action can be repointed in one place if the preview API evolves. Known
limitations that shape the contract:

- **No atomic idempotency key.** Deduplication is best effort (see above).
- **Asynchronous pull-request creation.** New-mode PR numbers are not available
  synchronously, so they are not output.
- **Availability depends on plan and policy.** The credential type, plan, or
  preview enablement may make Agent Tasks unavailable, surfacing as
  `configuration-error` / `agent-unsupported`.
- **Model acceptance is decided by the API.** A pinned model may be rejected
  (`agent-invalid-request`); the action does not second-guess or fall back.

If the preview API's real behavior is found to differ from these assumptions
during [integration validation](integration-validation.md), update the provider,
its tests, the contract, and these docs **before** relying on the behavior —
never document unsupported behavior as working.
