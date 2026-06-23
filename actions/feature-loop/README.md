# Feature Loop

A reusable GitHub Action that advances a feature epic through an ordered set of
sub-issues, assigning exactly one issue at a time to the GitHub Copilot coding
agent. The loop remains human-gated: a human reviews and merges every pull
request before the next issue starts.

> **Status:** The action is packaged end to end. The repository adapter,
> preflight, trusted merged-PR resolution, the GitHub Copilot agent provider, and
> the transactional controller are wired to Octokit transports through the
> composition layer in `src/action/` and the entry point in `src/main.ts`. The
> reusable contracts (configuration, domain types, state model, and ports) are
> defined under `src/` and exported from `src/contracts.ts`; the GitHub repository
> adapter and preflight live under `src/adapters/github/` and `src/preflight/`,
> and the controller lives under `src/orchestrator/`. See
> [`docs/adr/0001-feature-loop-contracts.md`](docs/adr/0001-feature-loop-contracts.md),
> [`docs/adr/0002-github-repository-adapter-and-preflight.md`](docs/adr/0002-github-repository-adapter-and-preflight.md),
> [`docs/adr/0003-trusted-merged-pr-resolution.md`](docs/adr/0003-trusted-merged-pr-resolution.md),
> [`docs/adr/0004-github-copilot-agent-provider.md`](docs/adr/0004-github-copilot-agent-provider.md),
> and
> [`docs/adr/0005-transactional-orchestration-and-reconciliation.md`](docs/adr/0005-transactional-orchestration-and-reconciliation.md).

## Documentation

Adopt and operate Feature Loop without reading its source:

- [Setup guide](docs/setup.md) — clean-room adoption, step by step.
- [Configuration reference](docs/configuration.md) — every input, output,
  configuration field, outcome, and reason code.
- [Security model](docs/security.md) — trust boundaries, permissions, tokens,
  pinning, and what this version does and does not guarantee.
- [Troubleshooting & recovery runbook](docs/troubleshooting.md) — recover from
  every pause and failure.
- [LingoQuest migration guide](docs/migration-lingoquest.md) — a reversible
  rollout from an existing custom controller.

Copy-ready templates and examples live under [`examples/`](examples):

- [`feature-loop.yml`](examples/feature-loop.yml) — annotated configuration.
- [`feature-loop.custom-labels.yml`](examples/feature-loop.custom-labels.yml) —
  customized canonical-state labels.
- [`feature-loop.workflow.yml`](examples/feature-loop.workflow.yml) — reference
  consumer workflow.
- [`ISSUE_TEMPLATE/feature-epic.md`](examples/ISSUE_TEMPLATE/feature-epic.md) and
  [`ISSUE_TEMPLATE/feature-sub-issue.md`](examples/ISSUE_TEMPLATE/feature-sub-issue.md)
  — epic and sub-issue templates.
- [`copilot-instructions.md`](examples/copilot-instructions.md) — agent
  instruction template.

## Configuration

Feature Loop reads a versioned `.github/feature-loop.yml` from the repository
default branch. Every key is optional and resolves to documented, secure
defaults; missing configuration uses the defaults and unsupported versions fail
closed. See [`examples/feature-loop.yml`](examples/feature-loop.yml) for an
annotated example and the ADR above for the full contract.

## Usage

Invoke the action from a workflow with `uses:`. Consumers do not install Node,
run a repository script, or check out their code; the action never executes
pull-request code.

```yaml
- uses: lukeorellana/loop-engineering/actions/feature-loop@v1
  with:
    epic-issue: ${{ github.event.inputs.epic-issue }}
```

A complete, ready-to-copy consumer workflow — with the `workflow_dispatch` and
`pull_request` (`closed`, `opened`, `reopened`) triggers, the merged-PR guard,
minimal permissions, and repository-wide serialization — is provided in
[`examples/feature-loop.workflow.yml`](examples/feature-loop.workflow.yml).

### Inputs

| Input          | Required | Default                    | Description                                                                                                                   |
| -------------- | -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `github-token` | yes      | `${{ github.token }}`      | Token for repository reads and writes (issues, labels, comments).                                                             |
| `agent-token`  | no       | `github-token`             | Token for assigning the Copilot coding agent. Defaults to `github-token`; supply a broader-scoped one if assignment needs it. |
| `epic-issue`   | no       | —                          | Epic issue number for a manual start. Required for `workflow_dispatch`; ignored for merged-PR runs.                           |
| `dry-run`      | no       | `false`                    | When `true`, evaluate only and perform no writes.                                                                             |
| `config-path`  | no       | `.github/feature-loop.yml` | Configuration path on the default branch.                                                                                     |

Inputs are validated and fail closed; credentials are registered as secrets so
they are masked in logs and never printed.

### Outputs

Every normal exit path sets all five outputs. Numeric outputs are empty when
they do not apply.

| Output            | Description                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `outcome`         | `started`, `already-running`, `complete`, `needs-human`, `dry-run`, `no-op`, `configuration-error`, or `operational-error`. |
| `epic-issue`      | The epic issue number the loop acted on, when resolved.                                                                     |
| `active-issue`    | The sub-issue the loop is driving (started, running, or paused).                                                            |
| `completed-issue` | The sub-issue completed from a trusted merged pull request during this run.                                                 |
| `reason`          | A stable, machine-readable reason code for the outcome.                                                                     |

A Markdown summary of the result (including dry-run previews) is written to
`GITHUB_STEP_SUMMARY`.

### Exit behavior

- Expected pauses (`needs-human`) and no-op outcomes complete successfully with
  outputs populated, so the workflow does not fail when the repository simply
  needs a human or the event does not apply.
- Invalid configuration and unrecoverable operational errors fail the step.

### Permissions

The action needs minimal, documented permissions:

```yaml
permissions:
  contents: read # read the configuration file from the default branch
  issues: write # labels, status comments, agent assignment, and closing sub-issues
  pull-requests: write # inspect pull requests and record the Closes #<issue> link
```

Coding-agent assignment may require a credential with broader scope than the
default `GITHUB_TOKEN`; provide it through `agent-token`.

### Serialization

Run the controller serially per repository so concurrent events queue instead of
racing. The action is idempotent, so a queued run that observes already-applied
state is safe. The reference workflow uses:

```yaml
concurrency:
  group: feature-loop-${{ github.repository }}
  cancel-in-progress: false
```

which queues controller runs (it never cancels a running controller), equivalent
to a `queue: max` contract.

## Development

All commands run from `actions/feature-loop/`.

| Command                | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `npm ci`               | Install dependencies from the committed lock file. |
| `npm run typecheck`    | Type-check the TypeScript sources.                 |
| `npm run lint`         | Run ESLint.                                        |
| `npm run format:check` | Verify formatting with Prettier.                   |
| `npm run test`         | Run the test suite with Vitest.                    |
| `npm run build`        | Bundle the action into `dist/index.js` with `ncc`. |
| `npm run all`          | Run the full check set used by CI.                 |

### Bundling

The action is bundled with [`@vercel/ncc`](https://github.com/vercel/ncc) into a
single `dist/index.js` file, which is committed to the repository. After
changing any source under `src/`, regenerate and commit the bundle:

```bash
npm run build
```

CI fails if the committed bundle differs from a freshly generated one.
