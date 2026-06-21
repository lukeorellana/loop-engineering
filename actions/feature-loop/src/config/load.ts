/**
 * Configuration loading, default resolution, and validation.
 *
 * The loader is pure: it turns YAML text (or an already-parsed value) into a
 * fully resolved {@link FeatureLoopConfig} or throws a {@link ConfigurationError}
 * with actionable messages. It performs no I/O and never reaches GitHub.
 *
 * Fail-closed rules:
 * - Missing configuration resolves to documented defaults.
 * - Unknown configuration versions fail closed.
 * - Invalid values produce actionable errors and never a partial config.
 */

import { parse as parseYaml, YAMLParseError } from 'yaml';

import { ConfigurationError } from './errors.js';
import {
  CanonicalStateLabels,
  DEFAULT_CANONICAL_STATE_LABELS,
  defaultConfig,
  FeatureLoopConfig,
  ISSUE_SOURCES,
  IssueSource,
  SUPPORTED_CONFIG_VERSION,
} from './schema.js';
import { CANONICAL_ISSUE_STATES, IssueState } from '../domain/state.js';

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse `.github/feature-loop.yml` text into a resolved configuration.
 *
 * @throws {ConfigurationError} when the YAML is malformed, the version is
 *   unsupported, or any value is invalid.
 */
export function parseConfig(yamlText: string): FeatureLoopConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    const detail =
      error instanceof YAMLParseError ? error.message : String(error);
    throw new ConfigurationError([
      `Configuration is not valid YAML: ${detail}`,
    ]);
  }
  return resolveConfig(raw);
}

/**
 * Resolve an already-parsed configuration value into a complete configuration.
 *
 * A `null`/`undefined` or empty value resolves to the documented defaults.
 *
 * @throws {ConfigurationError} when the version is unsupported or any value is
 *   invalid.
 */
export function resolveConfig(raw: unknown): FeatureLoopConfig {
  if (raw === null || raw === undefined) {
    return defaultConfig();
  }
  if (!isPlainObject(raw)) {
    throw new ConfigurationError([
      'Configuration must be a mapping of keys to values at the top level.',
    ]);
  }
  if (Object.keys(raw).length === 0) {
    return defaultConfig();
  }

  const errors: string[] = [];
  const defaults = defaultConfig();

  validateVersion(raw.version, errors);

  const issues = resolveIssues(raw.issues, defaults, errors);
  const agent = resolveAgent(raw.agent, defaults, errors);
  const base = resolveBase(raw.base, defaults, errors);
  const merge = resolveMerge(raw.merge, defaults, errors);
  const concurrency = resolveConcurrency(raw.concurrency, defaults, errors);
  const labels = resolveLabels(raw.labels, errors);

  if (errors.length > 0) {
    throw new ConfigurationError(errors);
  }

  return {
    version: SUPPORTED_CONFIG_VERSION,
    issues,
    agent,
    base,
    merge,
    concurrency,
    labels,
  };
}

function validateVersion(value: unknown, errors: string[]): void {
  if (value === undefined) {
    errors.push(
      `Configuration is missing required "version". Set "version: ${SUPPORTED_CONFIG_VERSION}".`,
    );
    return;
  }
  if (value !== SUPPORTED_CONFIG_VERSION) {
    errors.push(
      `Unsupported configuration version ${JSON.stringify(value)}. This build supports version ${SUPPORTED_CONFIG_VERSION}.`,
    );
  }
}

function resolveIssues(
  value: unknown,
  defaults: FeatureLoopConfig,
  errors: string[],
): FeatureLoopConfig['issues'] {
  if (value === undefined) {
    return defaults.issues;
  }
  if (!isPlainObject(value)) {
    errors.push('"issues" must be a mapping.');
    return defaults.issues;
  }

  let source: IssueSource = defaults.issues.source;
  if (value.source !== undefined) {
    if (
      typeof value.source !== 'string' ||
      !(ISSUE_SOURCES as readonly string[]).includes(value.source)
    ) {
      errors.push(
        `"issues.source" must be one of ${ISSUE_SOURCES.join(', ')}; received ${JSON.stringify(
          value.source,
        )}.`,
      );
    } else {
      source = value.source as IssueSource;
    }
  }

  let heading = defaults.issues.markdown.heading;
  if (value.markdown !== undefined) {
    if (!isPlainObject(value.markdown)) {
      errors.push('"issues.markdown" must be a mapping.');
    } else if (value.markdown.heading !== undefined) {
      if (
        typeof value.markdown.heading !== 'string' ||
        value.markdown.heading.trim() === ''
      ) {
        errors.push('"issues.markdown.heading" must be a non-empty string.');
      } else {
        heading = value.markdown.heading;
      }
    }
  }

  return { source, markdown: { heading } };
}

function resolveAgent(
  value: unknown,
  defaults: FeatureLoopConfig,
  errors: string[],
): FeatureLoopConfig['agent'] {
  if (value === undefined) {
    return defaults.agent;
  }
  if (!isPlainObject(value)) {
    errors.push('"agent" must be a mapping.');
    return defaults.agent;
  }

  let provider = defaults.agent.provider;
  if (value.provider !== undefined) {
    if (typeof value.provider !== 'string' || value.provider.trim() === '') {
      errors.push('"agent.provider" must be a non-empty string.');
    } else {
      provider = value.provider;
    }
  }

  let model = defaults.agent.model;
  if (value.model !== undefined) {
    if (value.model === null) {
      model = null;
    } else if (typeof value.model !== 'string' || value.model.trim() === '') {
      errors.push(
        '"agent.model" must be a non-empty string or null for automatic selection.',
      );
    } else {
      model = value.model;
    }
  }

  return { provider, model };
}

function resolveBase(
  value: unknown,
  defaults: FeatureLoopConfig,
  errors: string[],
): FeatureLoopConfig['base'] {
  if (value === undefined) {
    return defaults.base;
  }
  if (!isPlainObject(value)) {
    errors.push('"base" must be a mapping.');
    return defaults.base;
  }

  let branch = defaults.base.branch;
  if (value.branch !== undefined) {
    if (value.branch === null) {
      branch = null;
    } else if (typeof value.branch !== 'string' || value.branch.trim() === '') {
      errors.push(
        '"base.branch" must be a non-empty string or null for the default branch.',
      );
    } else {
      branch = value.branch;
    }
  }

  return { branch };
}

function resolveMerge(
  value: unknown,
  defaults: FeatureLoopConfig,
  errors: string[],
): FeatureLoopConfig['merge'] {
  if (value === undefined) {
    return defaults.merge;
  }
  if (!isPlainObject(value)) {
    errors.push('"merge" must be a mapping.');
    return defaults.merge;
  }

  const requireHuman = resolveBoolean(
    value.requireHuman,
    defaults.merge.requireHuman,
    'merge.requireHuman',
    errors,
  );
  const autoMerge = resolveBoolean(
    value.autoMerge,
    defaults.merge.autoMerge,
    'merge.autoMerge',
    errors,
  );

  if (requireHuman === false) {
    errors.push(
      '"merge.requireHuman" cannot be false: a human merge is always required.',
    );
  }
  if (autoMerge === true) {
    errors.push(
      '"merge.autoMerge" cannot be true: automatic merge is not supported.',
    );
  }

  return { requireHuman, autoMerge };
}

function resolveConcurrency(
  value: unknown,
  defaults: FeatureLoopConfig,
  errors: string[],
): FeatureLoopConfig['concurrency'] {
  if (value === undefined) {
    return defaults.concurrency;
  }
  if (!isPlainObject(value)) {
    errors.push('"concurrency" must be a mapping.');
    return defaults.concurrency;
  }

  let activeIssuesPerEpic = defaults.concurrency.activeIssuesPerEpic;
  if (value.activeIssuesPerEpic !== undefined) {
    if (value.activeIssuesPerEpic !== 1) {
      errors.push(
        '"concurrency.activeIssuesPerEpic" must be 1: exactly one active issue per epic.',
      );
    } else {
      activeIssuesPerEpic = 1;
    }
  }

  return { activeIssuesPerEpic };
}

function resolveLabels(value: unknown, errors: string[]): CanonicalStateLabels {
  const labels: Record<IssueState, string> = {
    ...DEFAULT_CANONICAL_STATE_LABELS,
  };
  if (value === undefined) {
    return labels;
  }
  if (!isPlainObject(value)) {
    errors.push(
      '"labels" must be a mapping of canonical states to label names.',
    );
    return labels;
  }

  const known = new Set<string>(CANONICAL_ISSUE_STATES);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      errors.push(
        `"labels.${key}" is not a canonical state. Valid states: ${CANONICAL_ISSUE_STATES.join(', ')}.`,
      );
      continue;
    }
    const labelValue = value[key];
    if (typeof labelValue !== 'string' || labelValue.trim() === '') {
      errors.push(`"labels.${key}" must be a non-empty string.`);
      continue;
    }
    labels[key as IssueState] = labelValue;
  }

  // Preserve "one canonical state": distinct states must map to distinct labels.
  const seen = new Map<string, IssueState>();
  for (const state of CANONICAL_ISSUE_STATES) {
    const label = labels[state];
    const existing = seen.get(label);
    if (existing !== undefined) {
      errors.push(
        `"labels.${state}" duplicates "labels.${existing}" ("${label}"). Each canonical state needs a distinct label.`,
      );
    } else {
      seen.set(label, state);
    }
  }

  return labels;
}

function resolveBoolean(
  value: unknown,
  fallback: boolean,
  path: string,
  errors: string[],
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    errors.push(`"${path}" must be a boolean.`);
    return fallback;
  }
  return value;
}
