# Feature Loop agent instructions (template)

Copy this file into the consuming repository as
`.github/copilot-instructions.md` (or merge it into an existing one) so the
GitHub Copilot coding agent has the context it needs when the Feature Loop
assigns it a sub-issue. Adjust the project-specific sections to match your
repository; the Feature Loop conventions below should be preserved.

## How this repository drives work

This repository uses **Feature Loop** to advance a feature epic through an
ordered set of sub-issues. You are assigned exactly one sub-issue at a time.
Work only the issue you are assigned; do not start, reorder, or close other
sub-issues.

## Completing your assigned sub-issue

- Open exactly one pull request for the sub-issue you are assigned. Inconsistent
  multiple-pull-request state is detected and pauses the loop for a human, so do
  not open more than one.
- The pull request must **formally close** the sub-issue using a closing keyword
  scoped to this repository, for example `Closes #123`. Generic mentions or
  cross-references are not treated as completion.
- Target the repository's base branch (the default branch unless the workflow
  configures `base.branch`).
- A human reviews and merges every pull request. Do not attempt to merge your
  own pull request; the loop never auto-merges.

## Canonical state labels

The Feature Loop manages canonical-state labels on issues (for example
`feature-loop:todo`, `feature-loop:in-progress`, `feature-loop:done`). Do not
add, remove, or change these labels yourself — exactly one canonical-state label
may exist on an issue at a time, and editing them by hand can pause the epic.

## If you cannot complete the work

If the sub-issue is blocked, ambiguous, or needs a human decision, explain the
situation in a comment and stop. Do not work ahead to a later sub-issue; the
loop intentionally never skips blocked head-of-line work.

## Project-specific guidance

<!-- Replace with your repository's build, test, and style conventions. -->

- Build:
- Test:
- Lint/format:
- Coding conventions:
