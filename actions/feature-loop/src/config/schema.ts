/**
 * Versioned `.github/feature-loop.yml` configuration schema and secure defaults.
 *
 * Configuration is read from the repository default branch. Every value has a
 * documented default so that a repository with no configuration file still
 * resolves to a complete, secure configuration. Nothing operationally specific
 * (branch names, model names, repository names, or skill paths) is hardcoded in
 * the loop; such values come only from configuration.
 */

import type { IssueState } from '../domain/state.js';

/**
 * The only configuration schema version this build understands. Any other
 * version fails closed with a configuration error.
 */
export const SUPPORTED_CONFIG_VERSION = 1 as const;

/**
 * How ordered sub-issues are discovered.
 *
 * - `native`: use only native GitHub sub-issues.
 * - `markdown`: use only the configured Markdown section of the epic body.
 * - `auto`: use native sub-issues when non-empty, otherwise Markdown. If both
 *   are non-empty and differ, preflight fails closed.
 */
export const ISSUE_SOURCES = ['native', 'markdown', 'auto'] as const;

export type IssueSource = (typeof ISSUE_SOURCES)[number];

/**
 * Mapping from each canonical {@link IssueState} to the repository label name
 * that represents it. Labels are fully customizable, but exactly one canonical
 * label may be present on an issue at a time.
 */
export type CanonicalStateLabels = Readonly<Record<IssueState, string>>;

/**
 * Configuration for Markdown-based sub-issue discovery.
 */
export interface MarkdownIssuesConfig {
  /**
   * The heading text whose list section contains the ordered sub-issues. The
   * heading is configurable so it is never hardcoded to a specific wording.
   */
  readonly heading: string;
}

/**
 * Configuration controlling sub-issue discovery.
 */
export interface IssuesConfig {
  readonly source: IssueSource;
  readonly markdown: MarkdownIssuesConfig;
}

/**
 * Configuration controlling the coding-agent provider and model.
 */
export interface AgentConfig {
  /** Provider identifier. Defaults to `github-copilot`. */
  readonly provider: string;
  /**
   * Model name, or `null` to select a model automatically. Automatic selection
   * is the secure default; an explicit model name is never hardcoded.
   */
  readonly model: string | null;
}

/**
 * Configuration controlling the base branch for agent pull requests.
 */
export interface BaseConfig {
  /**
   * Base branch name, or `null` to use the repository default branch. The
   * branch name is never hardcoded.
   */
  readonly branch: string | null;
}

/**
 * Configuration controlling merge policy. The secure defaults require a human
 * merge and never auto-merge.
 */
export interface MergeConfig {
  readonly requireHuman: boolean;
  readonly autoMerge: boolean;
}

/**
 * Configuration controlling per-epic concurrency. The secure default allows
 * exactly one active issue per epic.
 */
export interface ConcurrencyConfig {
  readonly activeIssuesPerEpic: number;
}

/**
 * The fully resolved Feature Loop configuration. Every field is populated; this
 * is the shape the loop consumes after defaults are applied and validation has
 * passed.
 */
export interface FeatureLoopConfig {
  readonly version: typeof SUPPORTED_CONFIG_VERSION;
  readonly issues: IssuesConfig;
  readonly agent: AgentConfig;
  readonly base: BaseConfig;
  readonly merge: MergeConfig;
  readonly concurrency: ConcurrencyConfig;
  readonly labels: CanonicalStateLabels;
}

/**
 * The default canonical-state label names. These can be overridden per
 * repository while preserving exactly one canonical state per issue.
 */
export const DEFAULT_CANONICAL_STATE_LABELS: CanonicalStateLabels = {
  todo: 'feature-loop:todo',
  'in-progress': 'feature-loop:in-progress',
  blocked: 'feature-loop:blocked',
  'needs-human': 'feature-loop:needs-human',
  skipped: 'feature-loop:skipped',
  invalid: 'feature-loop:invalid',
  done: 'feature-loop:done',
  'not-planned': 'feature-loop:not-planned',
};

/**
 * The secure default configuration, used when no configuration file is present.
 */
export function defaultConfig(): FeatureLoopConfig {
  return {
    version: SUPPORTED_CONFIG_VERSION,
    issues: {
      source: 'auto',
      markdown: {
        heading: 'Ordered sub-issues',
      },
    },
    agent: {
      provider: 'github-copilot',
      model: null,
    },
    base: {
      branch: null,
    },
    merge: {
      requireHuman: true,
      autoMerge: false,
    },
    concurrency: {
      activeIssuesPerEpic: 1,
    },
    labels: { ...DEFAULT_CANONICAL_STATE_LABELS },
  };
}
