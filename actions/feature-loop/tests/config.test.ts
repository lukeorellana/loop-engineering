import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  defaultConfig,
  parseConfig,
  resolveConfig,
  SUPPORTED_CONFIG_VERSION,
} from '../src/config/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, '..', 'examples');

function readExample(name: string): string {
  return readFileSync(join(examplesDir, name), 'utf8');
}

describe('configuration defaults', () => {
  it('resolves missing configuration to documented defaults', () => {
    expect(resolveConfig(null)).toEqual(defaultConfig());
    expect(resolveConfig(undefined)).toEqual(defaultConfig());
    expect(parseConfig('')).toEqual(defaultConfig());
    expect(resolveConfig({})).toEqual(defaultConfig());
  });

  it('uses secure defaults', () => {
    const config = defaultConfig();
    expect(config.agent.provider).toBe('github-copilot');
    expect(config.agent.model).toBeNull();
    expect(config.base.branch).toBeNull();
    expect(config.merge.requireHuman).toBe(true);
    expect(config.merge.autoMerge).toBe(false);
    expect(config.concurrency.activeIssuesPerEpic).toBe(1);
    expect(config.issues.source).toBe('auto');
  });

  it('does not hardcode operational values in defaults', () => {
    const serialized = JSON.stringify(defaultConfig());
    expect(serialized).not.toContain('main');
    expect(serialized).not.toContain('LingoQuest');
  });
});

describe('configuration overrides', () => {
  it('applies overrides from the annotated example file', () => {
    const config = parseConfig(readExample('feature-loop.yml'));
    expect(config).toEqual(defaultConfig());
  });

  it('customizes labels while preserving one canonical state', () => {
    const config = parseConfig(readExample('feature-loop.custom-labels.yml'));
    expect(config.labels.names['in-progress']).toBe('fl/active');
    expect(config.labels.names.done).toBe('fl/done');
    const labelNames = Object.values(config.labels.names);
    expect(new Set(labelNames).size).toBe(labelNames.length);
  });

  it('accepts explicit overrides for provider, model, base, and source', () => {
    const config = parseConfig(
      [
        'version: 1',
        'issues:',
        '  source: native',
        'agent:',
        '  provider: custom-provider',
        '  model: some-model',
        'base:',
        '  branch: release',
      ].join('\n'),
    );
    expect(config.issues.source).toBe('native');
    expect(config.agent.provider).toBe('custom-provider');
    expect(config.agent.model).toBe('some-model');
    expect(config.base.branch).toBe('release');
  });
});

describe('configuration failure modes', () => {
  it('fails closed on malformed YAML', () => {
    expect(() => parseConfig('version: [1')).toThrow(ConfigurationError);
    expect(() => parseConfig('version: [1')).toThrow(/not valid YAML/);
  });

  it('fails closed on unsupported versions', () => {
    expect(() => resolveConfig({ version: 2 })).toThrow(
      /Unsupported configuration version/,
    );
  });

  it('fails closed when a present file omits the version', () => {
    expect(() => resolveConfig({ issues: { source: 'native' } })).toThrow(
      /missing required "version"/,
    );
  });

  it('rejects an unknown issue source', () => {
    expect(() =>
      resolveConfig({
        version: SUPPORTED_CONFIG_VERSION,
        issues: { source: 'nope' },
      }),
    ).toThrow(/issues.source/);
  });

  it('rejects disabling the human merge requirement', () => {
    expect(() =>
      resolveConfig({
        version: SUPPORTED_CONFIG_VERSION,
        merge: { requireHuman: false },
      }),
    ).toThrow(/human merge is always required/);
  });

  it('rejects enabling automatic merge', () => {
    expect(() =>
      resolveConfig({
        version: SUPPORTED_CONFIG_VERSION,
        merge: { autoMerge: true },
      }),
    ).toThrow(/automatic merge is not supported/);
  });

  it('rejects more than one active issue per epic', () => {
    expect(() =>
      resolveConfig({
        version: SUPPORTED_CONFIG_VERSION,
        concurrency: { activeIssuesPerEpic: 2 },
      }),
    ).toThrow(/exactly one active issue per epic/);
  });

  it('rejects an unknown canonical state label key', () => {
    expect(() =>
      resolveConfig({
        version: SUPPORTED_CONFIG_VERSION,
        labels: { unknown: 'x' },
      }),
    ).toThrow(/is not a canonical state/);
  });

  it('rejects duplicate canonical state labels (invalid state combination)', () => {
    expect(() =>
      resolveConfig({
        version: SUPPORTED_CONFIG_VERSION,
        labels: { todo: 'same', done: 'same' },
      }),
    ).toThrow(/distinct label/);
  });

  it('defaults labels.auto-create to false', () => {
    expect(defaultConfig().labels.autoCreate).toBe(false);
    expect(
      resolveConfig({
        version: SUPPORTED_CONFIG_VERSION,
        labels: { todo: 'fl/todo' },
      }).labels.autoCreate,
    ).toBe(false);
  });

  it('honors labels.auto-create alongside label names', () => {
    const config = resolveConfig({
      version: SUPPORTED_CONFIG_VERSION,
      labels: { 'auto-create': true, todo: 'fl/todo' },
    });
    expect(config.labels.autoCreate).toBe(true);
    expect(config.labels.names.todo).toBe('fl/todo');
  });

  it('rejects a non-boolean labels.auto-create', () => {
    expect(() =>
      resolveConfig({
        version: SUPPORTED_CONFIG_VERSION,
        labels: { 'auto-create': 'yes' },
      }),
    ).toThrow(/"labels.auto-create" must be a boolean/);
  });

  it('collects multiple actionable errors', () => {
    try {
      resolveConfig({ version: 9, issues: { source: 'bogus' } });
      throw new Error('expected ConfigurationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(
        (error as ConfigurationError).messages.length,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('rejects a non-mapping top-level value', () => {
    expect(() => resolveConfig([1, 2, 3])).toThrow(/mapping of keys/);
  });
});
