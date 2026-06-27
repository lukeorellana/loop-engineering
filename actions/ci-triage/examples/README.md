# CI Triage examples

Copy-ready consumer workflows for the CI Triage action. Each file is a complete
`.github/workflows/*.yml` you can copy into a repository and adapt. Read the
[setup guide](../docs/setup.md) and [pipeline targeting](../docs/pipeline-targeting.md)
first.

All examples share the same safety properties: minimal read-only permissions,
the dedicated `agent-token` for Agent Tasks, the recommended `concurrency` group,
and **no `actions/checkout`** of failed-branch code.

| Example                                                                                                | Demonstrates                                                                                |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [`pr-failure-auto.yml`](pr-failure-auto.yml)                                                           | PR failure with `pull-request-mode: auto` — updates the existing fix pull request in place. |
| [`pr-failure-new-stacked.yml`](pr-failure-new-stacked.yml)                                             | PR failure with `pull-request-mode: new` — opens a stacked remediation pull request.        |
| [`push-failure-main.yml`](push-failure-main.yml)                                                       | Push failure on `main` — opens a remediation pull request targeting `main`.                 |
| [`ci-and-infra-targeting.yml`](ci-and-infra-targeting.yml)                                             | One triage workflow watching `ci` and `infra` with different job-level conditions.          |
| [`model-pinning.yml`](model-pinning.yml)                                                               | A hardcoded `model` value and the empty/default model case.                                 |
| [`additional-context-azure.yml`](additional-context-azure.yml)                                         | Optional Azure / Application Insights enrichment passed through `additional-context`.       |
| [`concurrency.yml`](concurrency.yml)                                                                   | Recommended concurrency keyed by repository, run id, and run attempt.                       |
| [`skills/github-actions-failure-debugging/SKILL.md`](skills/github-actions-failure-debugging/SKILL.md) | Optional GitHub Actions failure-debugging skill.                                            |

## Pipeline targeting reminder

Which named source workflows can start triage is set by
`on.workflow_run.workflows`; the source-run **event**, **branch**, **conclusion**,
and any other condition belong in the consumer job-level `if`. The action cannot
change which workflows trigger GitHub before the job starts, and the triage
workflow must exist on the repository's **default branch** for `workflow_run` to
fire. See [Pipeline targeting](../docs/pipeline-targeting.md).

## Dry-run first

Add `dry-run: true` to any example to preview the resolved target, mode, run id,
and attempt without performing any Agent Tasks writes. Switch to `dry-run: false`
once the preview matches your expectation.
