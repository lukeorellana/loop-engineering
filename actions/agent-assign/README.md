# Agent Assign action

Assigns the GitHub Copilot coding agent to issues that opt in with the
`agent: implement` label.

## Behavior

- Re-reads the live issue state before mutating anything.
- Assigns Copilot only when the issue is open, has the implement label, and does
  not have a suppression label (`agent: manual`, `agent: blocked` by default).
- Preserves existing human assignees by default.
- Supports idempotent reruns (marker-based comments, safe repeated label calls).
- Supports a strict `dry-run` mode.

## Key inputs

- `github-token` (required, defaults to `${{ github.token }}`)
- `agent-token` (optional; falls back to `github-token`)
- `dry-run`
- Label controls: `implement-label`, `queued-label`, `assigned-label`,
  `failed-label`, `suppress-labels`
- Instructions controls: `post-instructions`, `custom-instructions`, `base-ref`,
  `model`
- `copilot-logins`, `replace-assignees`

## Outputs

- `outcome`
- `reason`
- `issue-number`

## Example consumer workflow

```yaml
name: Assign Copilot agent

on:
  issues:
    types: [opened, reopened, labeled]

permissions:
  contents: read
  issues: write

jobs:
  assign:
    runs-on: ubuntu-latest
    steps:
      - name: Assign Copilot when issue is labeled for implementation
        uses: lukeorellana/loop-engineering/actions/agent-assign@v1
        with:
          github-token: ${{ github.token }}
          agent-token: ${{ secrets.COPILOT_ASSIGN_TOKEN }}
          implement-label: agent: implement
          suppress-labels: |
            agent: manual
            agent: blocked
```

See [`examples/assign-on-label.yml`](examples/assign-on-label.yml) for a full
workflow including concurrency and optional instruction settings.
