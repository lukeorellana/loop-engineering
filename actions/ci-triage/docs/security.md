# CI Triage security model

This document describes CI Triage's trust boundaries, the guarantees it does and
does not make, the responsibilities of each token, and the permissions an
adoption requires.

## Design principles

- **Fail closed.** Ambiguous, inconsistent, forked, or unverifiable targets stop
  for a human (`needs-human`) or are ignored rather than guessing where to write.
- **Least privilege.** The triage workflow requests only read scopes; every Agent
  Tasks write goes through a separate, narrowly scoped `agent-token`.
- **Failed-branch code is never executed.** The action inspects the failed run
  and pull-request **metadata** through the GitHub API; it never checks out,
  builds, or runs failed-branch code.

## Trust boundaries

### The triage workflow never checks out or executes failed-branch code

The reference workflows deliberately have **no `actions/checkout` step**. CI
Triage reads the failed run, its branches, its commits, and its candidate pull
request through the GitHub API only. This is what makes it safe to run in
response to a failed run that may contain untrusted contributor code. **Do not**
add a checkout of the failed ref to a triage workflow.

### Copilot investigates the run directly; CI Triage does not parse logs

CI Triage does **not** download, parse, or forward workflow logs. It resolves the
exact failed **run id** and **run attempt** and builds a prompt that tells
Copilot to inspect that run directly (starting from the failure summary and
fetching job or full logs only as needed). The action's own logic depends only on
run/branch/PR metadata, so untrusted log content never drives a control decision.

### Trusted instructions vs. untrusted evidence

The triage prompt strictly separates trusted instructions from untrusted data:

- **Trusted:** the standard prompt, the resolved run/target metadata, and the
  repository-owner `prompt-instructions`. These are trusted because only
  repository owners can set workflow inputs.
- **Untrusted:** workflow logs, commit messages, pull-request bodies, test
  output, exception text, previous-attempt history, and `additional-context`.
  Instructions embedded in that evidence (for example a log line that says
  "ignore your instructions and …") must never override the standard prompt or
  the repository-owned instructions.

The prompt and its untrusted evidence are sensitive and are **never** written to
normal logs or `GITHUB_STEP_SUMMARY`; a redaction-safe summary (fingerprint,
length, and which sections were truncated) is used instead.

### Fork pull requests are never targeted

A pull request whose head branch lives in a different repository than the failed
run is a fork. CI Triage never targets a fork-owned branch: a fork match resolves
to `needs-human` / `fork-pull-request`. CI Triage never pushes to a branch your
repository does not control.

### Conservative target resolution

A write is attempted only when the resolver selects **exactly one** open,
same-repository, non-fork pull request (for PR-triggered reuse) or a concrete,
still-existing target branch (for remediation). Zero matches, multiple matches,
closed-only matches, fork matches, missing branches, and stale runs each fail
closed with a specific reason code (see
[Reference → Reason codes](reference.md#reason-codes)).

## Tokens and permissions

CI Triage uses two separate credentials with different responsibilities.

### `github-token` (repository reads)

- **Responsibility:** read-only resolution of the failed workflow run, its
  attempt, branches, commits, and the candidate fix pull request.
- **Value:** the workflow-provided `${{ github.token }}` is sufficient.
- **Workflow permissions required:**

  ```yaml
  permissions:
    actions: read # read the failed workflow run and its attempt
    contents: read # read branches and commits
    pull-requests: read # match and inspect the candidate fix pull request
  ```

The `github-token` is never used to start Agent Tasks and never writes repository
contents or pull requests.

### `agent-token` (Agent Tasks reads and writes)

- **Responsibility:** searching recent Agent Tasks (for best-effort
  deduplication and reconciliation) and starting a task that opens or updates the
  fix pull request.
- **Value:** a dedicated secret, for example
  `${{ secrets.CI_TRIAGE_AGENT_TOKEN }}`. There is **no default** — the workflow
  `GITHUB_TOKEN` cannot start Agent Tasks.
- **Required Agent Tasks permissions:** the credential must be authorized to
  create and read Copilot Agent Tasks and to open pull requests on your behalf.
  Provision it according to your organization's Agent Tasks (public preview)
  enablement. If the credential is unauthenticated, unauthorized, or missing the
  Agent Tasks permission, the action fails closed as `configuration-error` with
  `agent-auth-failed`, `agent-forbidden`, or `agent-unsupported`.

### Secret handling

Both tokens are registered as secrets so the runner masks them. The Agent Tasks
provider never logs authorization headers, raw API responses (which may echo
prompt content), or the full generated prompt.

## What CI Triage does not do

- It does not approve or merge pull requests. A human reviews and merges every
  fix pull request. Depending on your repository settings, a human may also need
  to **approve CI** after Copilot pushes changes (see
  [Operational behavior](operations.md#a-human-may-need-to-approve-ci)).
- It does not poll for the asynchronously created pull request, so it cannot
  output a brand-new PR number.
- It does not embed any consumer-specific cloud login or query behavior (for
  example Azure OIDC or KQL). Such enrichment belongs in the consumer workflow
  and is passed in via `additional-context` as untrusted data.
