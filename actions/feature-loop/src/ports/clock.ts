/**
 * Clock port.
 *
 * The loop never reads the wall clock directly; it depends on this port so that
 * time can be controlled in tests and reasoned about deterministically.
 */
export interface Clock {
  /** The current instant. */
  now(): Date;
}
