---
name: self-review
description: Review a completed implementation against its issue, acceptance criteria, full diff, and validation evidence before handing the pull request to a human.
---

# Self-review

Use this skill after implementation and initial validation are complete, but before requesting human review or declaring the assigned issue finished.

The goal is not to restate what was implemented. The goal is to find and correct defects that the implementation pass may have missed.

## Required inputs

- The assigned issue and all acceptance criteria.
- The repository's base branch.
- The complete working-tree and branch diff against that base branch.
- The repository's build, test, lint, type-check, and formatting guidance.

## Procedure

1. **Re-read the contract.** Compare the implementation with the issue goal, every acceptance criterion, linked context, and repository instructions. Identify anything omitted, only partially implemented, or implemented differently from the requested behavior.
2. **Inspect the actual result.** Review the complete diff against the base branch, including tests, configuration, generated files, documentation, deletions, and uncommitted changes. Do not review only the files you remember changing.
3. **Challenge the implementation.** Actively look for:
   - incorrect assumptions and missed edge cases
   - error-handling and recovery failures
   - race conditions, retries, duplicate execution, and idempotency problems
   - security, authorization, secret-handling, and trust-boundary issues
   - regressions, incompatible contracts, and unintended behavior changes
   - weak, misleading, missing, or over-mocked tests
   - duplicated logic, unnecessary abstractions, and avoidable complexity
   - unrelated changes or scope expansion
4. **Run applicable validation.** Run the relevant formatter, lint, type-check, unit tests, integration tests, build, and any focused reproduction needed for the changed behavior. Do not treat existing green checks as proof that the implementation is correct.
5. **Fix valid findings.** Correct issues found during self-review. Do not merely list defects that can be safely fixed within the assigned issue. Do not weaken tests, checks, types, or validation to make the result pass.
6. **Re-review after fixes.** Inspect the resulting diff again and rerun the affected validation. Repeat until no additional concrete issue is found or a real human decision is required.
7. **Produce handoff evidence.** Update the pull-request summary with:
   - findings discovered during self-review
   - fixes made because of those findings
   - exact validation commands and outcomes
   - remaining risks, assumptions, or human-required checks

## Stop conditions

Stop and request human guidance when completing the review requires a product decision, unavailable credential or environment, destructive action, production access, or scope beyond the assigned issue. State the blocker precisely rather than guessing.

A self-review is not complete when it only says "looks good," repeats the implementation summary, or reports tests without inspecting the full diff.
