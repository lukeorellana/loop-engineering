# AGENTS.md

Guidance for AI coding agents (including the GitHub Copilot coding agent) working
in `loop-engineering`.

## What this repository is

A monorepo of reusable GitHub Actions that keep human-gated automation loops running
on top of GitHub and the Copilot agents. Each action is a self-contained **Node 20
TypeScript** action with sources in `src/`, tests in `tests/`, and a committed
`dist/index.js` bundle built with [`@vercel/ncc`](https://github.com/vercel/ncc):

- [`actions/feature-loop`](actions/feature-loop) — advances a feature epic through
  ordered sub-issues, assigning one issue at a time to the Copilot coding agent.
- [`actions/ci-triage`](actions/ci-triage) — triages a failed CI workflow run via the
  Copilot Agent Tasks API.
- [`actions/agent-assign`](actions/agent-assign) — assigns the Copilot coding agent to
  labeled issues.

## Working in an action

Every command runs from the specific action directory (`actions/<name>`), not the repo
root. All three actions expose the same scripts:

```bash
cd actions/<name>
npm ci
npm run typecheck     # tsc --noEmit
npm run lint          # eslint .
npm run format:check  # prettier --check .
npm run test          # vitest run
npm run build         # ncc bundle -> dist/index.js
npm run all           # typecheck + lint + format:check + test + build
```

Use `npm run format:write` to fix formatting. Tests use **Vitest** (not Jest).

## CI expectations (must stay green)

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) validates each action
independently in a matrix. For every change to an action you must be able to pass, from
a clean checkout:

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run format:check`
5. `npm run test`
6. `npm run build`
7. **Committed-bundle drift check** — after any `src/` change, run `npm run build` and
   commit the regenerated `dist/`. CI fails if `git status --porcelain dist` is dirty.

Do not change release tags, publish packages, or merge pull requests as part of routine
work; this repo uses a single repository-wide release model where one tag versions every
action (see [`README.md`](README.md)).

## Skills

Repository-scoped Copilot skills live in [`.github/skills/`](.github/skills/) (see its
[README](.github/skills/README.md) for the full index, provenance, and install
mechanism). Reach for them when relevant:

- Authoring or reviewing anything under `.github/workflows/` → `github-actions-hardening`,
  `github-actions-efficiency`, `github-actions-runtime-upgrade-conventions`.
- Security scanning and dependency hygiene → `codeql`, `secret-scanning`, `dependabot`,
  `agent-supply-chain`.
- Planning and quality on the TypeScript actions → `create-implementation-plan`,
  `context-map`, `refactor-plan`, `review-and-refactor`, `javascript-typescript-jest`.
- Commits, releases, and repo context → `conventional-commit`, `github-release`,
  `acquire-codebase-knowledge`, `create-agentsmd`, `github-issues`, `pr-dashboard`.
