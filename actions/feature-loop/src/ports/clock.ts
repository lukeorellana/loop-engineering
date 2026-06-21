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

/**
 * The default {@link Clock} backed by the system wall clock. The composition
 * layer wires this in; the loop core never imports it directly.
 */
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};
