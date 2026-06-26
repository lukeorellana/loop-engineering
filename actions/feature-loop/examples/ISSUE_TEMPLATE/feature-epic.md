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
  * Markdown — list the sub-issues under the marked section below. Place the
    machine-readable marker

        <!-- feature-loop:ordered-issues -->

    immediately before the ordered list. The marker is the authoritative parser
    contract: it identifies the ordered-issue section regardless of the heading
    wording that follows it, so the heading stays human-readable. The exact
    configured heading (`issues.markdown.heading`, default "Ordered sub-issues")
    also still works, and — as a backward-compatible fallback — a single heading
    followed by an ordered list of issue references is detected structurally.
    If an epic has more than one possible ordered list, discovery fails closed;
    add the marker before the authoritative section to resolve it.

With `issues.source: auto` (the default), native sub-issues are used when
present; otherwise the Markdown list below is used. If both are non-empty and
disagree, preflight fails closed so a human can resolve the conflict.
-->

## Objective

<!-- What this epic delivers and why. -->

<!-- feature-loop:ordered-issues -->

## Ordered sub-issues

<!--
Used only when sub-issues are sourced from Markdown (or `auto` with no native
sub-issues). List the sub-issues in execution order as an ordered list, one per
line. Reference real same-repository issues so the loop can resolve their state.
The heading text is human-facing; the marker above is what the parser keys on.
-->

1. #
2. #
3. #

## Notes

<!-- Optional context for reviewers and the coding agent. -->
