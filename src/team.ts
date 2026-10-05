import { githubOwner } from './kit/manor.ts';

/**
 * The team: Settings' own when they name one, else the GitHub account gh is signed in as on this PC (the kit's
 * githubOwner(), kept once known). Claude Code opens its PRs with that account, so the person and their sessions are
 * the team without anyone typing a name. Under node --test gh is never asked unless a test says what it answers.
 */
export type Owner = () => string | null;

export const realOwner: Owner = () => (process.env.NODE_TEST_CONTEXT ? null : githubOwner());

/** Said wherever the team is used and there is none. */
export const NO_TEAM = "Team is empty in Settings and gh isn't signed in (gh auth login), so there is no team: only the Steward's own PRs are merged";

export interface Team {
  team: string[];
  /** Where it came from: Settings, the account gh is signed in as, or nowhere. */
  from: 'settings' | 'gh' | 'none';
  /** What the page says of it: whose account it is, or why there is none. Null when Settings name it. */
  note: string | null;
}

/** The team as the Steward uses it. gh is asked only when Settings name none. */
export function teamOf(settingsTeam: string[], owner: Owner = realOwner): Team {
  if (settingsTeam.length) return { team: settingsTeam, from: 'settings', note: null };
  const login = owner();
  if (login) return { team: [login], from: 'gh', note: `Team is empty in Settings: the account gh is signed in as (${login}).` };
  return { team: [], from: 'none', note: `${NO_TEAM}.` };
}
