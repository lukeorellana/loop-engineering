/**
 * Copilot coding-agent actor identity.
 *
 * The assignable Copilot actor is discovered by login from the repository's
 * suggested actors. GitHub has used more than one login for the coding agent
 * over time, so the provider matches the current login as well as documented
 * legacy logins, case-insensitively, rather than hardcoding a single name.
 */
import type { AssignableActor } from './api.js';

/**
 * Known Copilot coding-agent actor logins, current first.
 *
 * - `copilot-swe-agent`: the current assignable Copilot coding-agent login.
 * - `copilot`: a documented legacy login.
 *
 * Matching is case-insensitive so capitalization differences (for example
 * `Copilot`) still resolve.
 */
export const COPILOT_ACTOR_LOGINS: readonly string[] = [
  'copilot-swe-agent',
  'copilot',
];

const NORMALIZED_LOGINS = new Set(
  COPILOT_ACTOR_LOGINS.map((login) => login.toLowerCase()),
);

/**
 * Whether a login is a known Copilot coding-agent login (case-insensitive).
 */
export function isCopilotLogin(login: string): boolean {
  return NORMALIZED_LOGINS.has(login.toLowerCase());
}

/**
 * The Copilot actor among a set of assignable actors, or `null` when none of
 * them is a known Copilot actor. When multiple known logins are present, the
 * current login is preferred over legacy logins.
 */
export function findCopilotActor(
  actors: readonly AssignableActor[],
): AssignableActor | null {
  for (const login of COPILOT_ACTOR_LOGINS) {
    const match = actors.find(
      (actor) => actor.login.toLowerCase() === login.toLowerCase(),
    );
    if (match !== undefined) {
      return match;
    }
  }
  return null;
}
