# Copilot agent skills

This directory holds [Agent Skills](https://agentskills.io/specification) that the
GitHub Copilot coding agent loads on demand while working in this repository. Each
skill is a folder containing a `SKILL.md` instruction file, plus optional bundled
`references/`, `assets/`, and `scripts/`.

The skills here are a repo-specific selection from
[`github/awesome-copilot`](https://github.com/github/awesome-copilot), prioritising
GitHub Actions, supply-chain safety, TypeScript action development, release, and
agent-orchestration workflows that match this Node 20 TypeScript Actions monorepo.

## Install mechanism

The supported installation path is the GitHub CLI
([v2.90.0+](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/)):

```bash
gh skills install github/awesome-copilot <skill-name>
```

For GitHub Copilot the CLI resolves the latest tagged release (falling back to the
default branch HEAD) and places skills at project scope. The skills in this repository
were installed from `github/awesome-copilot` pinned to commit
[`44ffa65`](https://github.com/github/awesome-copilot/tree/44ffa65c503feee850fad4186b21ab5c913777a9)
and are vendored verbatim so the coding agent can use them without any registry access.

To refresh a skill to its upstream version, re-run `gh skills install` (or
`gh skill update`) for that skill name and review the diff.

## Installed skills

### Highest priority — GitHub Actions, supply chain, and scanning

| Skill | Use it when |
| ----- | ----------- |
| [`github-actions-hardening`](github-actions-hardening/SKILL.md) | Reviewing, authoring, or hardening any workflow under `.github/workflows/` — script injection, `pull_request_target`/`workflow_run` privilege, SHA-pinning, least-privilege `GITHUB_TOKEN`. |
| [`github-actions-efficiency`](github-actions-efficiency/SKILL.md) | Auditing a workflow for wasted CI minutes/cost — caching, matrix fan-out, redundant triggers, concurrency. |
| [`github-actions-runtime-upgrade-conventions`](github-actions-runtime-upgrade-conventions/SKILL.md) | Upgrading actions to supported runtimes while preserving behaviour and validating the result. |
| [`agent-supply-chain`](agent-supply-chain/SKILL.md) | Verifying integrity/provenance of agent plugins, tools, and pinned dependencies. |
| [`codeql`](codeql/SKILL.md) | Setting up or debugging CodeQL code scanning via Actions or the CodeQL CLI, and triaging alerts/SARIF. |
| [`secret-scanning`](secret-scanning/SKILL.md) | Configuring secret scanning, push protection, custom patterns, or remediating secret alerts. |
| [`dependabot`](dependabot/SKILL.md) | Creating or optimising `dependabot.yml`, grouping updates, and handling Dependabot PRs. |

### TypeScript action development and quality

| Skill | Use it when |
| ----- | ----------- |
| [`javascript-typescript-jest`](javascript-typescript-jest/SKILL.md) | Writing or reviewing JS/TS unit tests (structure, mocking, patterns). Note: this repo uses **Vitest**, not Jest — apply the structural guidance, keep the Vitest runner. |
| [`create-implementation-plan`](create-implementation-plan/SKILL.md) | Producing a written plan before a feature, refactor, or dependency/infra upgrade. |
| [`context-map`](context-map/SKILL.md) | Mapping every file relevant to a task before editing. |
| [`refactor-plan`](refactor-plan/SKILL.md) | Scoping and sequencing a safe multi-file refactor. |
| [`review-and-refactor`](review-and-refactor/SKILL.md) | Reviewing and cleaning up code against defined standards. |
| [`conventional-commit`](conventional-commit/SKILL.md) | Writing standardized Conventional Commit messages. |
| [`github-release`](github-release/SKILL.md) | Cutting a release with SemVer + changelog. Follow this repo's **repository-wide** release model (a single tag versions every action); do not publish packages or move tags as part of unrelated work. |

### Agent workflow and repository context

| Skill | Use it when |
| ----- | ----------- |
| [`acquire-codebase-knowledge`](acquire-codebase-knowledge/SKILL.md) | Mapping, documenting, or onboarding into the codebase at a repository level. |
| [`create-agentsmd`](create-agentsmd/SKILL.md) | Generating or refreshing an `AGENTS.md` for the repo. |
| [`github-issues`](github-issues/SKILL.md) | Creating or managing issues, sub-issues, fields, and templates via MCP tools. |
| [`pr-dashboard`](pr-dashboard/SKILL.md) | Opening a browser dashboard summarising open pull requests. |

## Bundled executable scripts

Most skills are Markdown-only. Two bundle third-party helper scripts that run
locally and are worth an explicit review pass before use:

- `acquire-codebase-knowledge/scripts/scan.py` — read-only project discovery
  (`git log`/`rev-parse` via `subprocess` with argument lists; no shell, no network).
- `pr-dashboard/scripts/pr-dashboard-cli.mjs` and `pr-dashboard/scripts/lib/utils.mjs`
  — call `gh api` via `execFile` and open a local HTML dashboard; no credentials are
  stored.

These are vendored unchanged from the pinned upstream commit above.
