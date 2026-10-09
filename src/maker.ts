import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeveloper } from './kit/developer.ts';
import { publisherKey } from './kit/exchequer.ts';
import { manorHome } from './kit/manor.ts';
import { readJson } from './kit/store.ts';

/**
 * The maker's laptop, and everyone else's PC.
 *
 * The Steward is sold to developers, as the hire in the Steward's office: it looks after the repositories of their own
 * that they pick, claims versions up front, merges their ready pull requests and releases, each only where they say
 * yes. On the PC Castellan is made on it is also Castellan's own release machinery: it holds and rolls out the kit,
 * releases itself, publishes every agent's release to the releases repository and the Exchequer, hands out the ports of
 * new agents, and looks after Manor, the site, the Exchequer and every agent.
 *
 * Which of the two this is, is the maker's laptop itself: its firmware's (SMBIOS) UUID, which a reinstall of Windows
 * keeps and no file or setting can give another PC, hashed with a salt, the same check as Manor's customer view
 * (Manor's src/customer-view.ts, copied here so the Steward depends on nothing of Manor's). The Steward holds only the
 * hash, never the UUID. On that laptop everything is as it always was. Everywhere else:
 * - "Releases Castellan itself" is off and not offered, whatever settings.json says (settings.ts), so the kit, the
 *   Steward's own releases and PRs and the releases repository are out of reach, and the page shows none of them;
 * - none of the maker's own repositories is looked after, claimed, merged or released (makersOwn): anything whose origin
 *   is the maker's account on GitHub (Manor, the site, the Exchequer, the releases repository, every agent), or that
 *   takes the id of one of Manor's agents (its shipped staff.json) or of the manor's own repositories;
 * - the maker-only commands (claim-port, release-port, ports, mine) answer that they are the maker's only;
 * - it acts only while Developer options are on (stewardActs): it is a developer's hire, so with them off its rounds
 *   don't run, its buttons and commands say why, and its page has one plain line.
 */

/** The maker's laptop: SHA-256 of MAKERS_SALT and its firmware UUID (upper case, no braces). Manor's, the same. */
const MAKERS_PC = 'e0a67cec8c84f4f7fedd7e4ed4c24b89082f23354687f7b1e0c32f444bb6ccca';
const MAKERS_SALT = 'castellan-makers-pc:';
const REG = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');

/** The firmware UUID in `reg query HKLM\SYSTEM\HardwareConfig /v LastConfig`'s answer ("{4C4C4544-…}"), upper case; null when there's none. */
export function uuidIn(regOutput: string): string | null {
  const m = /\{?([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\}?/i.exec(regOutput);
  return m ? m[1].toUpperCase() : null;
}

let firmware: string | null = null;
let failedAt = 0;
/** After a read that failed, the next try waits this long. */
const RETRY_MS = 60_000;
/**
 * This PC's firmware UUID, which Windows keeps as HardwareConfig's LastConfig: read once (about 20 ms) and kept; null
 * when it can't be read. A read that failed (reg.exe slow under load, say) isn't kept: it is tried again a minute later,
 * so the maker's laptop is never taken for a customer's for longer than that.
 */
export function firmwareUuid(now = Date.now()): string | null {
  if (firmware) return firmware;
  if (failedAt && now - failedAt < RETRY_MS) return null;
  try {
    firmware = uuidIn(execFileSync(REG, ['query', 'HKLM\\SYSTEM\\HardwareConfig', '/v', 'LastConfig'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    firmware = null;
  }
  failedAt = firmware ? 0 : now;
  return firmware;
}

/** Whether a firmware UUID is the maker's laptop's: its salted hash is MAKERS_PC (`expected`, for tests). */
export function isMakersUuid(uuid: string | null, expected = MAKERS_PC): boolean {
  return !!uuid && createHash('sha256').update(MAKERS_SALT + uuid).digest('hex') === expected;
}

let given: (() => boolean) | null = null;

/**
 * Stands in for the firmware in a test: `() => true`, the maker's laptop; `() => false`, a customer's PC; null, this
 * PC's own firmware again. Only code in the same process can call it: no file, setting or environment variable makes a
 * PC the maker's.
 */
export function makersPcForTests(f: (() => boolean) | null): void {
  given = f;
}

/**
 * Whether this is the maker's laptop. STEWARD_CUSTOMER=1 makes even the maker's laptop answer no (to see the Steward as
 * a customer has it, and for a test's child process); nothing makes another PC answer yes.
 */
export function makersPc(): boolean {
  if (process.env.STEWARD_CUSTOMER === '1') return false;
  if (given) return given();
  const uuid = firmwareUuid();
  // Only when the firmware can't be read at all (never on a working Windows; for a moment, under load): the PC holding
  // the Exchequer's publisher key, as the Steward told the maker's PC before (migrate.ts), so a slow read never turns the
  // release machinery off. A customer has no such key.
  return uuid ? isMakersUuid(uuid) : 'key' in publisherKey();
}

/** The maker's account on GitHub: every repository under it is Castellan's own (Manor, the site, the Exchequer, the agents). */
export const MAKERS_ACCOUNT = 'jcollier0120';

/** The ids of the manor's own repositories that aren't agents in Manor's staff.json: Manor, the Steward's kit, the site, the Exchequer, the releases. */
export const MAKERS_IDS = ['manor', 'castellan', 'kit', 'steward', 'castellansite', 'exchequer', 'manor-releases'];

/** Whether a repository's name (owner/name, or host/path from its origin) is under the maker's account on GitHub. */
export function makersRepo(repo: string): boolean {
  const r = repo.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.git$/, '');
  return r.startsWith(`${MAKERS_ACCOUNT}/`) || r.startsWith(`github.com/${MAKERS_ACCOUNT}/`) || r.startsWith(`www.github.com/${MAKERS_ACCOUNT}/`);
}

/** The ids in Manor's shipped staff.json: the agents Castellan ships (employ.ts' manorStaff, read here without it). */
function shippedStaff(home = manorHome()): Set<string> {
  const agents = readJson<{ agents?: { id?: unknown }[] } | null>(path.join(home, 'app', 'staff.json'), null)?.agents;
  return new Set((Array.isArray(agents) ? agents : []).map((a) => a?.id).filter((x): x is string => typeof x === 'string'));
}

/** The ids no customer's repository may take: Manor's agents (its shipped staff.json) and the manor's own repositories. */
export function makersIds(staff: () => Set<string> = shippedStaff): Set<string> {
  let agents = new Set<string>();
  try {
    agents = staff();
  } catch {
    // No Manor here, or its staff.json unreadable: the manor's own ids still count.
  }
  return new Set([...MAKERS_IDS, ...[...agents].map((id) => id.toLowerCase())]);
}

/** What a refusal says it is: one of the maker's repositories, the site, the Exchequer. */
const what = (e: { name?: string; repo: string }) => e.name?.trim() || e.repo;

/**
 * Why the Steward won't look after this repository here, or null when it may: on any PC but the maker's laptop, one
 * whose origin is the maker's account (by repository) or that takes the id of one of Manor's agents or the manor's own
 * repositories (by id, when `byId`; a name made up for a version claim doesn't count). In plain words, for the page and
 * the commands.
 */
export function makersOwn(e: { id?: string; name?: string; repo: string }, o: { makers?: boolean; ids?: Set<string>; byId?: boolean } = {}): string | null {
  if (o.makers ?? makersPc()) return null;
  if (makersRepo(e.repo)) return `${what(e)} is one of Castellan's own repositories, which only its makers look after: the Steward here looks after yours.`;
  const id = e.id?.toLowerCase();
  if ((o.byId ?? true) && id && (o.ids ?? makersIds()).has(id))
    return `${e.id} is the name of one of Castellan's own agents or repositories, which only its makers look after: give yours another id in Settings.`;
  return null;
}

/** What a maker-only command answers anywhere else. */
export const makersOnly = (what: string) => `${what} is for the people who make Castellan, on their own PC: the Steward here looks after your repositories.`;

/**
 * Whether the Steward may act now: always on the maker's laptop, where it is the release machinery and no switch holds
 * it; elsewhere only while Developer options are on (the kit's developer.ts, read now), as a developer's hire.
 */
export function stewardActs(o: { makers?: boolean; developer?: boolean } = {}): boolean {
  return (o.makers ?? makersPc()) || (o.developer ?? isDeveloper());
}

/** What it says, with Developer options off, in place of its page, its buttons and its commands. */
export const DEVELOPER_ONLY = "The Steward is for people who write software: it looks after their code once Developer options is on in Manor's Settings.";
/** Its role in plain words then. */
export const PLAIN_ROLE = 'For people who write software';
