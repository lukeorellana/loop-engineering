/**
 * Logger port.
 *
 * A minimal structured logging surface. Adapters map these calls onto the host
 * logging facility (for example GitHub Actions core logging). Fields are
 * optional structured context and must never contain secrets.
 */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warning(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
