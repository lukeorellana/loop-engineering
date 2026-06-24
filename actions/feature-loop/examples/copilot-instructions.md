# Feature Loop agent instructions (template)

Copy this file into the consuming repository as
`.github/copilot-instructions.md` (or merge it into an existing one) so the
GitHub Copilot coding agent has the context it needs when the Feature Loop
assigns it a sub-issue. Adjust the project-specific sections to match your
repository; the Feature Loop conventions below should be preserved.

Also copy [`skills/self-review/SKILL.md`](skills/self-review/SKILL.md) to
`.github/skills/self-review/SKILL.md`. The completion contract below explicitly
references that path so the agent uses the same structured review process for
every Feature Loop sub-issue.

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

## Self-review before handoff

Before requesting human review or declaring the assigned issue complete:

1. Follow `.github/skills/self-review/SKILL.md`.
2. Re-read the issue and acceptance criteria, then inspect the complete diff
   against the base branch rather than reviewing only the files you remember
   changing.
3. Fix all valid findings that remain within the assigned issue and rerun the
   affected validation.
4. Update the pull-request summary with findings discovered, fixes made, exact
   validation commands and outcomes, and any remaining risk or human-required
   check.

Do not treat passing tests as a substitute for reviewing the implementation.
Do not report a generic "self-review complete" without evidence. If the skill
is missing or the review requires a product decision, unavailable environment,
destructive action, or broader scope, explain the blocker and stop for a human.

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
