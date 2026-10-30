import { githubOwner } from './kit/manor.ts';

/**
 * The team: Settings' own when they name one, else the GitHub account gh is signed in as on this PC (the kit's
 * githubOwner(), kept once known). Claude Code opens its PRs with that account, so the person and their sessions are
 * the team without anyone typing a name. Under node --test gh is never asked unless a test says what it answers.
 * Off GitHub, the accounts glab, az, tea or the Bitbucket token are signed in as are the team there too (steward.ts's
 * withHostTeams asks each host's whoAmI): the page names them with gh's (hostLogins).
 */
export type Owner = () => string | null;

export const realOwner: Owner = () => (process.env.NODE_TEST_CONTEXT ? null : githubOwner());

/** Said wherever the team is used and there is none. */
export const NO_TEAM = "Team is empty in Settings and gh isn't signed in (gh auth login), nor any other host's CLI, so there is no team: no one's vouch is trusted, and no work is filed for the Wright";

export interface Team {
  team: string[];
  /** Where it came from: Settings, the account gh is signed in as (with any other host's), another host's alone, or nowhere. */
  from: 'settings' | 'gh' | 'hosts' | 'none';
  /** What the page says of it: whose account it is, or why there is none. Null when Settings name it. */
  note: string | null;
}

/**
 * The team as the Steward uses it. gh is asked only when Settings name none. `hosts` are the accounts other hosts' CLIs
 * are signed in as, as last asked (steward.ts's hostLogins: `login on host`), named after gh's.
 */
export function teamOf(settingsTeam: string[], owner: Owner = realOwner, hosts: { login: string; at: string }[] = []): Team {
  if (settingsTeam.length) return { team: settingsTeam, from: 'settings', note: null };
  const login = owner();
  const others = hosts.filter((h, i) => h.login.toLowerCase() !== login?.toLowerCase() && hosts.findIndex((x) => x.login.toLowerCase() === h.login.toLowerCase()) === i);
  const also = others.length ? `, and on ${others.map((h) => `${h.at} ${h.login}`).join(', ')}` : '';
  if (login) return { team: [login, ...others.map((h) => h.login)], from: 'gh', note: `Team is empty in Settings: the account gh is signed in as (${login})${also}.` };
  if (others.length) return { team: others.map((h) => h.login), from: 'hosts', note: `Team is empty in Settings: the accounts signed in on ${others.map((h) => `${h.at} (${h.login})`).join(', ')}.` };
  return { team: [], from: 'none', note: `${NO_TEAM}.` };
}
