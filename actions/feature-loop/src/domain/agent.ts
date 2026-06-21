/**
 * Agent start requests and results.
 *
 * Feature Loop delegates implementation work to a coding-agent provider. These
 * types describe what the loop asks a provider to do and what the provider
 * reports back. They are provider-independent: the default provider is
 * `github-copilot`, but the loop never hardcodes a provider, model, or skill
 * path.
 */

import type { Epic, SubIssue } from './issues.js';

/**
 * Model selection for an agent run.
 *
 * - `{ kind: 'auto' }`: let the provider choose a model automatically. This is
 *   the secure default when no explicit model is configured.
 * - `{ kind: 'explicit', name }`: use the named model. The name is never
 *   hardcoded; it comes from configuration.
 */
export type AgentModelSelection =
  | { kind: 'auto' }
  | { kind: 'explicit'; name: string };

/**
 * A request to start the coding agent on exactly one sub-issue.
 */
export interface AgentStartRequest {
  /** The epic the issue belongs to. */
  readonly epic: Epic;
  /** The single sub-issue to work on. */
  readonly issue: SubIssue;
  /** Provider identifier, for example `github-copilot`. */
  readonly provider: string;
  /** Model selection; `auto` lets the provider choose. */
  readonly model: AgentModelSelection;
  /** Base branch the resulting pull request must target. */
  readonly baseBranch: string;
  /**
   * When `true`, the request is read-only and the provider must not create or
   * mutate anything. Dry-run is strictly read-only.
   */
  readonly dryRun: boolean;
}

/**
 * A normalized, provider-independent reason code describing why an agent
 * operation could not complete (or completed in a degraded way).
 *
 * Reason codes are derived only from coarse, transport-level classification —
 * never from raw provider response bodies — so they are always safe to surface.
 *
 * - `actor-not-found`: the coding agent is not available to the repository
 *   (for example Copilot is not enabled, or the account lacks a seat).
 * - `unauthenticated`: the agent-assignment credential is missing or invalid.
 * - `unauthorized`: the credential is valid but lacks permission to assign.
 * - `invalid-base-branch`: the configured base branch was rejected.
 * - `unavailable`: a transient provider/transport failure.
 * - `unknown`: an unclassified failure.
 */
export type AgentReasonCode =
  | 'actor-not-found'
  | 'unauthenticated'
  | 'unauthorized'
  | 'invalid-base-branch'
  | 'unavailable'
  | 'unknown';

/**
 * A request to verify that a provider is available and authorized before the
 * loop attempts to start any work. Preflight is strictly read-only.
 */
export interface AgentPreflightRequest {
  /** The epic the loop intends to advance. */
  readonly epic: Epic;
  /** Provider identifier, for example `github-copilot`. */
  readonly provider: string;
  /** Base branch the resulting pull request must target. */
  readonly baseBranch: string;
  /** Model selection; `auto` lets the provider choose. */
  readonly model: AgentModelSelection;
}

/**
 * The result of a provider preflight check.
 *
 * The shape is intentionally compatible with the repository preflight's
 * provider-check contract: a failure always carries actionable, sanitized
 * messages, plus a normalized {@link AgentReasonCode} for programmatic handling.
 */
export type AgentPreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AgentReasonCode;
      readonly messages: readonly string[];
    };

/**
 * The result of attempting to start an agent.
 *
 * - `started`: the agent was assigned and is now the single active issue.
 * - `already-running`: the issue was already assigned; idempotent re-processing.
 * - `uncertain`: the start may or may not have taken effect. The orchestrator
 *   must reconcile the real state before rolling back, never blindly retry a
 *   mutation.
 * - `failed`: the start failed deterministically and can be surfaced as an
 *   operational error.
 */
export type AgentStartResult =
  | {
      readonly status: 'started';
      readonly issueNumber: number;
      readonly assignedAt: string;
    }
  | { readonly status: 'already-running'; readonly issueNumber: number }
  | {
      readonly status: 'uncertain';
      readonly issueNumber: number;
      readonly detail: string;
    }
  | {
      readonly status: 'failed';
      readonly issueNumber: number;
      readonly error: string;
      /** Normalized, sanitized reason for the failure. */
      readonly reason: AgentReasonCode;
    };
