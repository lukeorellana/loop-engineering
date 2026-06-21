/**
 * GitHub repository adapter public surface.
 *
 * The adapter implements {@link GitHubRepositoryPort} against the narrow
 * {@link GitHubApi} transport boundary. A concrete transport (for example an
 * Octokit-backed implementation of {@link GitHubApi}) is supplied by the
 * composition layer; the adapter and the loop core never depend on Octokit
 * directly, which keeps the core replaceable with an in-memory fake in tests.
 */
export * from './api.js';
export * from './errors.js';
export * from './status-comment.js';
export * from './repository-adapter.js';
export * from './octokit-api.js';
