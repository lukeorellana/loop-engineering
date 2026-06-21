# Feature Loop

A reusable GitHub Action that advances a feature epic through an ordered set of
sub-issues, assigning exactly one issue at a time to the GitHub Copilot coding
agent. The loop remains human-gated: a human reviews and merges every pull
request before the next issue starts.

> **Status:** Adapter and preflight implemented; controller orchestration and
> the Octokit transport are not yet wired in. The action entry point currently
> reports that Feature Loop is not yet implemented and exits successfully. The
> reusable contracts (configuration, domain types, state model, and ports) are
> defined under `src/` and exported from `src/contracts.ts`; the GitHub
> repository adapter and preflight live under `src/adapters/github/` and
> `src/preflight/`. See
> [`docs/adr/0001-feature-loop-contracts.md`](docs/adr/0001-feature-loop-contracts.md)
> and
> [`docs/adr/0002-github-repository-adapter-and-preflight.md`](docs/adr/0002-github-repository-adapter-and-preflight.md).

## Configuration

Feature Loop reads a versioned `.github/feature-loop.yml` from the repository
default branch. Every key is optional and resolves to documented, secure
defaults; missing configuration uses the defaults and unsupported versions fail
closed. See [`examples/feature-loop.yml`](examples/feature-loop.yml) for an
annotated example and the ADR above for the full contract.

## Usage

```yaml
- uses: lukeorellana/loop-engineering/actions/feature-loop@v1
```

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
