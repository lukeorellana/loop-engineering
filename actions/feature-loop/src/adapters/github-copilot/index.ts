/**
 * GitHub Copilot agent provider public surface.
 *
 * The provider implements {@link AgentProviderPort} against the narrow
 * {@link CopilotAgentApi} GraphQL boundary. A concrete transport (for example an
 * Octokit-backed implementation built with the dedicated agent-assignment
 * credential) is supplied by the composition layer; the provider and the loop
 * core never depend on Octokit directly, which keeps the core replaceable with
 * an in-memory fake in tests.
 */
export * from './api.js';
export * from './actors.js';
export * from './errors.js';
export * from './provider.js';
