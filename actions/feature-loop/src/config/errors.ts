/**
 * Configuration error type.
 *
 * Configuration problems fail closed and are surfaced as actionable messages.
 * A {@link ConfigurationError} always carries at least one message and never a
 * partially-resolved configuration, so invalid configuration can never produce
 * a start decision.
 */
export class ConfigurationError extends Error {
  readonly messages: readonly string[];

  constructor(messages: readonly string[]) {
    const list =
      messages.length > 0 ? messages : ['Invalid Feature Loop configuration.'];
    super(list.join('\n'));
    this.name = 'ConfigurationError';
    this.messages = list;
  }
}
