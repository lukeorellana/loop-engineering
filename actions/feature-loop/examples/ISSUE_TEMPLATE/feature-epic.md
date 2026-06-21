---
name: Feature epic
about: A Feature Loop epic that advances ordered sub-issues one at a time.
title: '[Epic] '
labels: []
---

<!--
Feature Loop epic.

This epic is the unit the action advances. The loop drives exactly one
sub-issue at a time, in order, assigning each `todo` sub-issue to the GitHub
Copilot coding agent and waiting for a human to merge its pull request before
starting the next one.

Provide the ordered list of sub-issues using ONE of the two supported sources:

  * Native sub-issues — add real GitHub sub-issues to this epic. This is the
    default and preferred source.
  * Markdown — list the sub-issues under the configured heading below. The
    heading text must match `issues.markdown.heading` in
    `.github/feature-loop.yml` (default: "Ordered sub-issues").

With `issues.source: auto` (the default), native sub-issues are used when
present; otherwise the Markdown list below is used. If both are non-empty and
disagree, preflight fails closed so a human can resolve the conflict.
-->

## Objective

<!-- What this epic delivers and why. -->

## Ordered sub-issues

<!--
Used only when sub-issues are sourced from Markdown (or `auto` with no native
sub-issues). List the sub-issues in execution order, one per line. Reference
real issues so the loop can resolve their state.
-->

1. #
2. #
3. #

## Notes

<!-- Optional context for reviewers and the coding agent. -->
