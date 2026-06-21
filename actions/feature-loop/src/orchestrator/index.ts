/**
 * Feature Loop orchestrator public surface.
 *
 * The orchestrator composes the repository adapter, the trusted merged-PR
 * resolver, the pure state machine, and the coding-agent provider into a single
 * idempotent controller. It depends only on ports, so it can be exercised
 * end-to-end with in-memory fakes and wired to concrete transports by the
 * composition layer.
 */
export * from './event.js';
export * from './status.js';
export * from './read-only-repository.js';
export * from './controller.js';
