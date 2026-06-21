/**
 * Action composition public surface.
 *
 * The composition layer turns validated inputs, the triggering event, and the
 * host-supplied Octokit transports into one idempotent Feature Loop iteration,
 * then publishes the action outputs and step summary and decides the step exit
 * status. It depends only on the {@link ActionEnvironment} seam so it can be
 * exercised end-to-end with in-memory doubles.
 */
export * from './core.js';
export * from './inputs.js';
export * from './outputs.js';
export * from './summary.js';
export * from './run.js';
