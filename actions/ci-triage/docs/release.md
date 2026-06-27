# CI Triage release & versioning

CI Triage does not version independently. This repository uses a single,
**repository-wide** release model that covers **both** committed action bundles —
[Feature Loop](../../feature-loop) and CI Triage — together.

For the authoritative policy, see the
[repository README → Release and versioning](../../../README.md#release-and-versioning).
The points below restate how that policy applies to CI Triage specifically.

## Git refs version the whole repository

A tag such as the floating `v1` (and immutable tags such as `v1.2.3`) versions
**everything** under `loop-engineering`, including both `actions/feature-loop`
and `actions/ci-triage`. Consumers reference an action and a repository ref
together:

```yaml
uses: lukeorellana/loop-engineering/actions/ci-triage@v1
```

There is no separate `ci-triage@…` tag. Pinning CI Triage to `v1` also pins
Feature Loop to the same `v1`, and vice versa.

## Every action must pass before a release is cut

An immutable release tag is created — and the floating `v1` tag is moved to it —
only after CI is green for **both** action directories:

- install (`npm ci`),
- type-check, lint, format check, tests,
- bundle generation (`npm run build`),
- committed-bundle drift verification (the committed `dist/` must not be stale),
- and the smoke test.

A failure in **either** action blocks the release for **both**. After changing
anything under `actions/ci-triage/src/`, run `npm run build` and commit the
updated `dist/`, or repository CI will fail on bundle drift.

## Releases never start real Copilot Agent Tasks

Normal CI and the release process exercise CI Triage only in modes that perform
no Agent Tasks writes — specifically the **dry-run** smoke test. No real Copilot
Agent Task is ever started by CI or by cutting a release.

## Do not move `v1` until everything passes

Do **not** publish or move the repository-wide `v1` tag until:

- both actions pass the full CI suite (above), and
- the CI Triage [integration scenarios](integration-validation.md) have
  succeeded (or corrected the implementation where the public-preview API
  differed from assumptions).

Because the tag is shared, moving `v1` prematurely would also re-point every
Feature Loop consumer. Treat the release as a single repository-wide event.
