# loop-engineering

A monorepo of reusable GitHub Actions that keep human-gated automation loops
running on top of GitHub and the Copilot agents.

## Actions

- [`actions/feature-loop`](actions/feature-loop) — advances a feature epic
  through ordered sub-issues, assigning one issue at a time to the GitHub
  Copilot coding agent.
- [`actions/ci-triage`](actions/ci-triage) — triages a failed CI workflow run
  and hands it to the Copilot Agent Tasks API, opening or reusing a fix pull
  request.

Each action is a self-contained Node 20 TypeScript action: TypeScript sources
under `src/`, tests under `tests/`, and a committed `dist/index.js` bundle built
with [`@vercel/ncc`](https://github.com/vercel/ncc).

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) validates every action
independently with a matrix build. For each action directory it runs, from a
clean checkout:

1. `npm ci`
2. Type checking (`npm run typecheck`)
3. Linting (`npm run lint`)
4. Formatting checks (`npm run format:check`)
5. Tests (`npm run test`)
6. Bundle generation (`npm run build`)
7. Committed-bundle drift verification (fails if `dist/` is stale)

A separate smoke-test job runs each packaged action locally. The CI Triage smoke
test runs in dry-run mode and performs no external Agent Tasks writes; normal CI
never starts a real Copilot Agent Task.

## Release and versioning

This repository uses a single, repository-wide release model:

- **Git refs version the whole repository, not one action directory.** A tag such
  as `v1` (and immutable tags such as `v1.2.3`) versions everything under
  `loop-engineering`, including both `actions/feature-loop` and
  `actions/ci-triage`. Consumers reference an action and a repository ref
  together, for example `lukeorellana/loop-engineering/actions/ci-triage@v1`.
- **Every action must pass before a release is cut.** An immutable release tag is
  created — and the floating `v1` tag is moved to it — only after CI is green for
  **both** action directories (install, type-check, lint, format, test, bundle,
  committed-bundle drift, and smoke test). A failure in either action blocks the
  release for both.
- **Releases never start real Copilot Agent Tasks.** Normal CI and the release
  process exercise the actions only in modes that perform no Agent Tasks writes
  (for example, the CI Triage dry-run smoke test).

## License

See [`LICENSE`](LICENSE).