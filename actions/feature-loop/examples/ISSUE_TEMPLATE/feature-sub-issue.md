---
name: Feature sub-issue
about: A single unit of work the Feature Loop assigns to the coding agent.
title: ''
labels: ['feature-loop:todo']
---

<!--
Feature Loop sub-issue.

This issue is one step of an epic. The loop starts it only when it is the
first not-yet-completed sub-issue of its epic and carries the `todo` canonical
state (no canonical-state label resolves to `todo`; the default label is
`feature-loop:todo`).

Canonical state is tracked by exactly one canonical-state label at a time. The
loop manages these labels — do not apply more than one by hand, or the issue
resolves to `invalid` and the epic pauses for a human.

To complete this sub-issue, the merged pull request MUST formally close it with
a closing keyword scoped to this repository, for example:

  Closes #<this-issue-number>

Before requesting review, the coding agent MUST follow the repository's
`.github/skills/self-review/SKILL.md`, fix valid findings, rerun affected
validation, and record review evidence in the pull-request summary.

A human reviews and merges the pull request; the action never merges and never
executes pull-request code.
-->

## Goal

<!-- The single, well-scoped outcome this sub-issue delivers. -->

## Acceptance criteria

<!-- Checklist the coding agent and reviewer use to confirm completion. -->

- [ ]
- [ ]

## Context

<!-- Links, constraints, and pointers the coding agent needs. -->

## Completion requirements

- [ ] Implement every applicable acceptance criterion without unrelated scope expansion.
- [ ] Run the repository's applicable build, test, lint, type-check, and formatting validation.
- [ ] Follow `.github/skills/self-review/SKILL.md` against the complete diff and this issue.
- [ ] Fix valid self-review findings and rerun affected validation.
- [ ] Record self-review findings, fixes, validation evidence, and remaining human checks in the pull-request summary.
