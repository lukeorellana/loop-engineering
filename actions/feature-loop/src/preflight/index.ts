/**
 * Repository preflight.
 *
 * Preflight runs the read-only (and, when `labels.auto-create` is enabled,
 * minimally write-enabled) checks that must pass before the loop may act on an
 * epic. It loads configuration from the repository default branch, verifies the
 * epic and its ordered sub-issues, resolves the controlling sub-issue source,
 * confirms the base branch and required labels, checks token access where it can
 * be determined, and delegates provider-specific checks to the caller.
 *
 * Preflight fails closed: any problem is reported as a structured failure with
 * actionable messages, never a partial success.
 */

import {
  ConfigurationError,
  defaultConfig,
  parseConfig,
  type FeatureLoopConfig,
} from '../config/index.js';
import { resolveIssueSource, type Epic } from '../domain/index.js';
import type { MarkdownDiscoverySource } from '../domain/markdown.js';
import {
  CrossRepositoryReferenceError,
  MarkdownDiscoveryError,
} from '../adapters/github/errors.js';
import type { GitHubRepositoryPort } from '../ports/github-repository.js';

/** The default location of the configuration file on the default branch. */
export const DEFAULT_CONFIG_PATH = '.github/feature-loop.yml';

/**
 * The result of a provider-specific preflight check (for example verifying that
 * the coding-agent provider is available and authorized).
 */
export type PreflightProviderResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly messages: readonly string[] };

/**
 * A provider-specific preflight check, delegated to the provider port.
 */
export type PreflightProviderCheck = () => Promise<PreflightProviderResult>;

/**
 * Inputs to {@link preflight}.
 */
export interface PreflightInput {
  /** The repository port (read, plus label creation when auto-create is on). */
  readonly repository: GitHubRepositoryPort;
  /** The epic issue number to validate. */
  readonly epicNumber: number;
  /** Configuration path on the default branch; defaults to the standard path. */
  readonly configPath?: string;
  /** Optional provider-specific check, delegated to the provider port. */
  readonly providerCheck?: PreflightProviderCheck;
  /**
   * The frozen execution plan's ordered issues for a continuation run. When
   * provided, preflight uses these issues directly as the controlling order and
   * does not reread Markdown or the native sub-issue hierarchy — the frozen plan
   * is the sole execution-order source after initialization.
   */
  readonly plannedIssues?: readonly number[];
}

/**
 * A successful preflight: the loop may proceed using these resolved values.
 */
export interface PreflightSuccess {
  readonly ok: true;
  readonly config: FeatureLoopConfig;
  readonly epic: Epic;
  readonly source: 'native' | 'markdown';
  readonly issues: readonly number[];
  /**
   * How the Markdown ordered-issue list was discovered, when the controlling
   * source is `markdown`. Reported in dry-run output so authors can see whether
   * discovery came from the marker, the configured heading, or the structural
   * fallback.
   */
  readonly markdownDiscovery?: MarkdownDiscoverySource | 'none';
  readonly baseBranch: string;
  /** Labels created during preflight because `labels.auto-create` was enabled. */
  readonly createdLabels: readonly string[];
}

/**
 * A failed preflight.
 *
 * - `configuration-error`: a setup or configuration problem that fails closed.
 * - `operational-error`: an unexpected transport failure (already sanitized).
 */
export interface PreflightFailure {
  readonly ok: false;
  readonly kind: 'configuration-error' | 'operational-error';
  readonly messages: readonly string[];
}

export type PreflightResult = PreflightSuccess | PreflightFailure;

function operationalError(error: unknown): PreflightFailure {
  return {
    ok: false,
    kind: 'operational-error',
    messages: [
      error instanceof Error ? error.message : 'An unexpected error occurred.',
    ],
  };
}

/**
 * Run repository preflight for an epic.
 */
export async function preflight(
  input: PreflightInput,
): Promise<PreflightResult> {
  const repository = input.repository;
  const configPath = input.configPath ?? DEFAULT_CONFIG_PATH;

  let info;
  try {
    info = await repository.getRepositoryInfo();
  } catch (error) {
    return operationalError(error);
  }

  let config: FeatureLoopConfig;
  try {
    const text = await repository.getDefaultBranchFile(configPath);
    config = text === null ? defaultConfig() : parseConfig(text);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return {
        ok: false,
        kind: 'configuration-error',
        messages: error.messages,
      };
    }
    return operationalError(error);
  }

  const messages: string[] = [];

  // Epic exists and is open.
  let epic: Epic | null;
  try {
    epic = await repository.getEpic(input.epicNumber);
  } catch (error) {
    return operationalError(error);
  }
  if (epic === null) {
    messages.push(`Epic #${input.epicNumber} was not found.`);
  } else if (!epic.open) {
    messages.push(
      `Epic #${input.epicNumber} is closed. Reopen it before running the loop.`,
    );
  }

  // Ordered sub-issues: resolve the controlling source. A continuation run with
  // a frozen plan supplies its issues directly; the frozen plan is the sole
  // execution-order source, so Markdown and the native sub-issue hierarchy are
  // not reread.
  let source: 'native' | 'markdown' = 'native';
  let issues: readonly number[] = [];
  let markdownDiscovery: MarkdownDiscoverySource | 'none' = 'none';

  if (input.plannedIssues !== undefined) {
    issues = input.plannedIssues;
  } else {
    let native: readonly number[] = [];
    let markdown: readonly number[] = [];
    try {
      native = await repository.getNativeSubIssueNumbers(input.epicNumber);
    } catch (error) {
      return operationalError(error);
    }
    try {
      const discovered = await repository.getMarkdownSubIssueNumbers(
        input.epicNumber,
        config.issues.markdown.heading,
      );
      markdown = discovered.numbers;
      markdownDiscovery = discovered.source;
    } catch (error) {
      if (
        error instanceof CrossRepositoryReferenceError ||
        error instanceof MarkdownDiscoveryError
      ) {
        messages.push(error.message);
      } else {
        return operationalError(error);
      }
    }

    const resolution = resolveIssueSource(
      config.issues.source,
      native,
      markdown,
    );
    if (!resolution.ok) {
      messages.push(resolution.message);
    } else {
      source = resolution.source;
      issues = resolution.issues;
      if (issues.length === 0 && epic !== null) {
        messages.push(
          `Epic #${input.epicNumber} has no ordered sub-issues for source "${config.issues.source}".`,
        );
      }
    }
  }

  // Configured base branch exists.
  const baseBranch = config.base.branch ?? info.defaultBranch;
  try {
    if (!(await repository.branchExists(baseBranch))) {
      messages.push(`Configured base branch "${baseBranch}" does not exist.`);
    }
  } catch (error) {
    return operationalError(error);
  }

  // Required labels exist, or are created when auto-create is enabled.
  const createdLabels: string[] = [];
  try {
    const existing = new Set(await repository.getRepositoryLabelNames());
    const required = Object.values(config.labels.names);
    const missing = required.filter((name) => !existing.has(name));
    if (missing.length > 0) {
      if (config.labels.autoCreate) {
        for (const name of missing) {
          await repository.createLabel(name);
          createdLabels.push(name);
        }
      } else {
        messages.push(
          `Missing required labels: ${missing.join(', ')}. ` +
            'Create them, or enable "labels.auto-create".',
        );
      }
    }
  } catch (error) {
    return operationalError(error);
  }

  // Token access, where it can be determined.
  try {
    const canWrite = await repository.hasWriteAccess();
    if (canWrite === false) {
      messages.push(
        'The configured token does not have write access to the repository.',
      );
    }
  } catch (error) {
    return operationalError(error);
  }

  // Provider-specific checks, delegated to the provider port.
  if (input.providerCheck) {
    let providerResult: PreflightProviderResult;
    try {
      providerResult = await input.providerCheck();
    } catch (error) {
      return operationalError(error);
    }
    if (!providerResult.ok) {
      messages.push(...providerResult.messages);
    }
  }

  if (messages.length > 0 || epic === null) {
    return { ok: false, kind: 'configuration-error', messages };
  }

  return {
    ok: true,
    config,
    epic,
    source,
    issues,
    ...(source === 'markdown' ? { markdownDiscovery } : {}),
    baseBranch,
    createdLabels,
  };
}
