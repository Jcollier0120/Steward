import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { remoteUrl } from './kit/git-auth.ts';
import { manorHome } from './kit/manor.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { githubApi } from './glance.ts';
import type { GitHubApi } from './kit/github.ts';
import { fileAt, lsRemote, readRef, writeRef, type RemoteRepo } from './remote-ref.ts';
import type { Runner } from './run.ts';
import type { Employee, Settings } from './settings.ts';
import { checkoutOf, mapLimit, result, workRootOf, type EmployeeResult } from './stages/common.ts';

/**
 * One release PC per repository, elected by the PCs themselves (docs/MULTI-PC.md). Every PC may run a Steward signed in
 * to the same GitHub account; without turns, two of them release the same versions, and stamp and roll the kit out to
 * the same repositories. (Since Steward 0.36.124 no Steward merges anyone else's PRs.)
 *
 * The meeting place is a ref in the repository's own remote, on any host: `refs/manor/release-pc`, a tiny orphan commit
 * holding release-pc.json, `{ pc, name, until, since, pinned, checkout }`, read and written with plain git
 * (remote-ref.ts), by compare-and-swap. No licence, no Exchequer, nothing of GitHub's: it works for anyone.
 *
 * - Before a stage publishes (releases, the Release button, a stamp, refresh and kit rollout pushes, and the merges
 *   of its own stamp and kit PRs), it reads the ref of each repository it would publish to: a round, only of those
 *   its plan looks at (stages/changes.ts), as it publishes nothing to the rest. Free, or run out: it takes it, for three rounds; for half a day while no other
 *   PC has been seen in a turn record for a month (LONG_TTL_S), as a PC alone has no one to hand it over to. Its own:
 *   renewed once half of that is gone. Another PC's: left alone, and the page says so, with Do it here.
 * - On GitHub, the refs are read from the Steward's own process through GitHub's API (githubTurnRefs), not git
 *   ls-remote, which starts git, its HTTPS helper and Git Credential Manager for each repository.
 * - Pinned (Keep it on this PC): another PC never takes it while it is renewed; a pin silent for over 24 hours may be
 *   taken, and the page says that PC has gone quiet. A PC with a checkout takes the turn from one without.
 * - Before each publishing act, one ls-remote: it acts only while the ref is still its own.
 * - The remote out of reach: the stage goes on as before for that repository (it can't publish there anyway), and the
 *   page says releasing waits until this PC can reach it. A host that refuses the ref: this PC works alone there, said
 *   once on the page. Nothing local ever waits for a turn: builds, tests, tastings, bumps, commits and claims.
 *
 * What each repository's ref last said is kept in turns.json, for the guard and the page.
 */

export const RELEASE_PC_REF = 'refs/manor/release-pc';
export const RELEASE_PC_FILE = 'release-pc.json';
/** The ref, in each repository's own remote, that holds the version claims of every PC looking after it (claims.ts). */
export const CLAIMS_REF = 'refs/manor/claims';
export const CLAIMS_FILE = 'claims.json';
/** A turn lasts three rounds, never less than 15 minutes; renewed once half of it is gone. */
const MIN_TTL_S = 15 * 60;
const MAX_TTL_S = 24 * 3600;
/** Clocks differ: a turn is taken over only this long after it ran out, and trusted by its holder until this long before. */
const SKEW_MS = 2 * 60_000;
/** A pinned turn renewed by no one for this long may be taken. */
export const QUIET_PIN_MS = 24 * 3600_000;
/**
 * A turn's length while no other PC has been seen: half a day, renewed once half of it is gone. A PC that joins later
 * finds it taken, and takes it once it runs out (or at once, with Do it here); from then on both use three rounds.
 */
export const LONG_TTL_S = 12 * 3600;
/** Another PC seen in a turn record within this long: this PC isn't alone. */
export const ALONE_AFTER_MS = 30 * 24 * 3600_000;

export interface TurnRecord {
  /** The PC's id: Manor's device.json, else the Steward's own. */
  pc: string;
  name: string;
  until: string;
  since: string;
  pinned: boolean;
  /** Whether that PC has a checkout of the repository: one that has takes the turn from one that hasn't. */
  checkout?: boolean;
}

export interface Device {
  id: string;
  name: string;
}

/** What a repository's turn came to. */
export interface RepoTurn {
  repo: string;
  /** here: this PC's; elsewhere: another's; unreachable: the remote couldn't be asked; alone: the host refuses the ref. */
  status: 'here' | 'elsewhere' | 'unreachable' | 'alone';
  /** The ref's commit, as last read or written. */
  sha?: string;
  /** The claims ref's commit, as the same look saw it (null: none there): claims.ts's shareClaims reads it when it moved. */
  claimsSha?: string | null;
  record?: TurnRecord;
  note?: string;
  at: string;
}

export interface TurnsState {
  at: string | null;
  device: Device | null;
  repos: Record<string, RepoTurn>;
  /** The other PCs seen in a turn record, by id: their name, and when last seen. */
  others?: Record<string, { name: string; at: string }>;
}

/** A remote's commits of some refs, by ref (one it hasn't is left out), or why it couldn't be asked: lsRemote's answer. */
export type TurnRefs = (r: RemoteRepo, refs: string[]) => Promise<{ ok: true; refs: Record<string, string> } | { ok: false; why: string }>;

/** Stands in for this PC, the clock and the remotes (tests). */
export interface TurnsDeps {
  device?: Device;
  now?: () => number;
  remote?: (e: Employee) => Promise<RemoteRepo | null>;
  /** How a remote's turn refs are read: githubTurnRefs for the Steward's own stages; left out, git ls-remote. */
  refs?: TurnRefs;
}

export const turnsFile = () => dataFile('turns.json');
export const loadTurns = (): TurnsState => ({ at: null, device: null, repos: {}, ...readJson<Partial<TurnsState>>(turnsFile(), {}) });
const key = (repo: string) => repo.toLowerCase();

/** A turn's length for Settings' rounds: three of them, at least 15 minutes. */
export const ttlFor = (s: Pick<Settings, 'roundMinutes'>) => Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, Math.round(3 * (s.roundMinutes || 10) * 60)));

/** The other PCs `s` has seen: those it noted (others), and the holders of the turn records it keeps, as of when read. */
function othersIn(s: TurnsState, me: Device): Record<string, { name: string; at: string }> {
  const out = { ...(s.others ?? {}) };
  for (const t of Object.values(s.repos)) {
    const r = t.record;
    if (r && r.pc !== me.id && !(Date.parse(out[r.pc]?.at ?? '') >= Date.parse(t.at))) out[r.pc] = { name: r.name, at: t.at };
  }
  delete out[me.id];
  return out;
}

/** `s` with `repos`, and the other PCs seen kept: a repository whose turn this PC took over forgets its holder, but this PC doesn't. */
const withRepos = (s: TurnsState, me: Device, repos: Record<string, RepoTurn>): TurnsState => ({ ...s, repos, others: othersIn({ ...s, others: othersIn(s, me), repos }, me) });

/** Whether no other PC has been seen in a turn record for ALONE_AFTER_MS. Pure. */
export const aloneHere = (s: TurnsState, me: Device, now: number) => !Object.values(othersIn(s, me)).some((o) => now - Date.parse(o.at) < ALONE_AFTER_MS);

/** A turn's length now, in ms: LONG_TTL_S while this PC is alone (aloneHere), else three rounds (ttlFor). */
export const turnMs = (settings: Pick<Settings, 'roundMinutes'>, s: TurnsState, me: Device, now: number) => (aloneHere(s, me, now) ? Math.max(LONG_TTL_S, ttlFor(settings)) : ttlFor(settings)) * 1000;

/** owner/name of a remote on github.com (https or ssh), or null for any other. */
export function githubRepoOf(url: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The turn refs of a repository on GitHub, read from the Steward's own process through GitHub's API: one GET of
 * git/matching-refs/manor, kept by its ETag, so an unchanged answer is a 304 that costs nothing of the hourly limit.
 * git ls-remote started git, its HTTPS helper and Git Credential Manager for each repository, every round. (GitHub's
 * GraphQL, the glance, doesn't see refs outside refs/heads and refs/tags: it answers null for refs/manor/….) Any other
 * remote, or GitHub not answering, is asked with git, as before.
 */
export const githubTurnRefs =
  (run: Runner, api: () => Pick<GitHubApi, 'rest'> = githubApi): TurnRefs =>
  async (r, refs) => {
    const repo = githubRepoOf(r.url);
    if (repo && refs.every((x) => x.startsWith('refs/manor/'))) {
      try {
        const list = await api().rest<unknown>('GET', `repos/${repo}/git/matching-refs/manor`);
        if (Array.isArray(list)) {
          const out: Record<string, string> = {};
          for (const x of list) if (refs.includes(x?.ref) && typeof x?.object?.sha === 'string') out[x.ref] = x.object.sha;
          return { ok: true, refs: out };
        }
      } catch {
        // Asked with git.
      }
    }
    return lsRemote(run, r, refs);
  };

/** This PC: Manor's device id when Manor has made one, else the Steward's own (made once); its name. */
export function deviceHere(): Device {
  const name = (process.env.COMPUTERNAME || os.hostname() || 'this PC').slice(0, 100);
  for (const file of [path.join(manorHome(), 'device.json'), dataFile('device.json')]) {
    try {
      const id = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')).id;
      if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) return { id: id.toLowerCase(), name };
    } catch {
      // none there
    }
  }
  const id = randomUUID();
  writeJson(dataFile('device.json'), { id });
  return { id, name };
}

/** A repository's remote: its checkout's origin, else its GitHub address; the scratch repository in the work folder. */
export async function remoteFor(run: Runner, settings: Settings, e: Pick<Employee, 'repo' | 'checkout'>): Promise<RemoteRepo | null> {
  if (!e.repo) return null;
  const scratch = path.join(workRootOf(settings), '_turns.git');
  const checkout = e.checkout ? checkoutOf(e as Employee) : '';
  if (checkout && existsSync(checkout)) {
    // Read from the clone's config file; git asked only when it can't be (a URL kept in an included file, say).
    let url = remoteUrl(checkout, 'origin') ?? '';
    if (!url) {
      const r = await run('git', ['config', '--get', 'remote.origin.url'], { cwd: checkout, timeoutMs: 30_000 });
      url = r.code === 0 ? r.out.trim() : '';
    }
    if (url) return { key: key(e.repo), url, scratch };
  }
  return { key: key(e.repo), url: `https://github.com/${e.repo}.git`, scratch };
}

export function readRecord(text: string | null | undefined): TurnRecord | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (typeof j?.pc !== 'string' || typeof j?.until !== 'string' || Number.isNaN(Date.parse(j.until))) return null;
    return { pc: j.pc, name: String(j.name ?? ''), until: j.until, since: String(j.since ?? j.until), pinned: j.pinned === true, ...(typeof j.checkout === 'boolean' ? { checkout: j.checkout } : {}) };
  } catch {
    return null;
  }
}

/** What to do with a repository's turn, from its record. Pure. */
export function decide(rec: TurnRecord | null, me: { pc: string; checkout: boolean }, now: number, ttlMs: number): 'take' | 'renew' | 'keep' | 'elsewhere' {
  if (!rec) return 'take';
  const until = Date.parse(rec.until);
  if (rec.pc === me.pc) return until - now < ttlMs / 2 ? 'renew' : 'keep';
  if (rec.pinned) return now > until + QUIET_PIN_MS ? 'take' : 'elsewhere';
  if (now > until + SKEW_MS) return 'take';
  if (me.checkout && rec.checkout === false) return 'take';
  return 'elsewhere';
}

/** Whether the Steward would publish anything to an employee's repository: else it takes no turn there. */
const publishes = (e: Employee) => e.merges || !!e.release || !!e.refresh || e.usesKit;

function recordFor(me: Device, checkout: boolean, now: number, ttlMs: number, had: TurnRecord | null, pinned?: boolean): TurnRecord {
  const mine = had?.pc === me.id;
  return { pc: me.id, name: me.name, until: new Date(now + ttlMs).toISOString(), since: mine ? had!.since : new Date(now).toISOString(), pinned: pinned ?? (mine ? had!.pinned : false), checkout };
}

const unreachableNote = (e: Pick<Employee, 'name'>) => `releasing ${e.name} waits until this PC can reach its remote`;
const aloneNote = (e: Pick<Employee, 'name'>, why: string) => `${e.name}'s remote doesn't take the Steward's turn ref (${why}), so this PC works alone there`;

/** Writes the record over `old` (null: none); on a lost race, whatever the ref says now stands. */
async function claimTurn(run: Runner, r: RemoteRepo, e: Pick<Employee, 'name' | 'repo'>, rec: TurnRecord, old: string | null, me: Device, now: number): Promise<RepoTurn> {
  const at = new Date(now).toISOString();
  const w = await writeRef(run, r, RELEASE_PC_REF, RELEASE_PC_FILE, `${JSON.stringify(rec, null, 2)}\n`, old, `${e.name}: released from ${rec.name} until ${rec.until}`);
  if (w.kind === 'ok') return { repo: e.repo, status: 'here', sha: w.sha, record: rec, at };
  if (w.kind === 'refused') return { repo: e.repo, status: 'alone', note: aloneNote(e, w.why), at };
  if (w.kind === 'unreachable') return { repo: e.repo, status: 'unreachable', note: unreachableNote(e), at };
  const again = await readRef(run, r, RELEASE_PC_REF, RELEASE_PC_FILE);
  if (again.kind === 'unreachable') return { repo: e.repo, status: 'unreachable', note: unreachableNote(e), at };
  if (again.kind === 'absent') return { repo: e.repo, status: 'elsewhere', at };
  const now2 = readRecord(again.text);
  return { repo: e.repo, status: now2?.pc === me.id ? 'here' : 'elsewhere', sha: again.sha, ...(now2 ? { record: now2 } : {}), at };
}

/** One repository's turn: read, and taken or renewed as decide() says. */
export async function turnOne(run: Runner, r: RemoteRepo, e: Pick<Employee, 'name' | 'repo'>, o: { me: Device; checkout: boolean; now: number; ttlMs: number; kept?: RepoTurn; refs?: TurnRefs }): Promise<RepoTurn> {
  const at = new Date(o.now).toISOString();
  // Both refs in one look: the claims ref's commit is kept for claims.ts.
  const ls = await (o.refs ?? ((x: RemoteRepo, refs: string[]) => lsRemote(run, x, refs)))(r, [RELEASE_PC_REF, CLAIMS_REF]);
  if (!ls.ok) return { repo: e.repo, status: 'unreachable', note: unreachableNote(e), at };
  const claimsSha = ls.refs[CLAIMS_REF] ?? null;
  const sha = ls.refs[RELEASE_PC_REF] ?? null;
  // The record at a commit read before is the one kept with it: a commit's file never changes, so git isn't asked again.
  const rec = !sha ? null : sha === o.kept?.sha && o.kept.record ? o.kept.record : readRecord(await fileAt(run, r, RELEASE_PC_REF, sha, RELEASE_PC_FILE));
  const d = decide(rec, { pc: o.me.id, checkout: o.checkout }, o.now, o.ttlMs);
  if (d === 'keep') return { repo: e.repo, status: 'here', sha: sha!, record: rec!, claimsSha, at };
  if (d === 'elsewhere') return { repo: e.repo, status: 'elsewhere', sha: sha!, record: rec!, claimsSha, at };
  // Taken from another PC (run out, or a pin gone quiet): not pinned here.
  const pinned = rec && rec.pc !== o.me.id ? false : undefined;
  return { ...(await claimTurn(run, r, e, recordFor(o.me, o.checkout, o.now, o.ttlMs, rec, pinned), sha, o.me, o.now)), claimsSha };
}

/** The words for a repository another PC publishes. */
export const doneBy = (e: Pick<Employee, 'name'>, holder: string) => `releasing for ${e.name}: done by ${holder || 'another PC'}`;

/** Before each publishing act: whether this PC may still publish to an employee's repository. */
export interface LeaseGuard {
  ok(e: Pick<Employee, 'id' | 'repo'>): Promise<boolean>;
  /** The employees another PC publishes for, this stage. */
  skip: Set<string>;
  /** Whether this guard's turns were taken for the employee (by id). */
  has(id: string): boolean;
}

/**
 * Two stages' worth of turns as one guard: a round takes the Steward's own and the refreshed repositories' first, and
 * the rest once its plan says which it looks at (steward.ts). An employee is asked of the guard that took its turn,
 * the later first.
 */
export function joinGuards(a: LeaseGuard | null | undefined, b: LeaseGuard | null | undefined): LeaseGuard | null {
  if (!a || !b) return a ?? b ?? null;
  const skip = new Set([...a.skip, ...b.skip]);
  return {
    get skip() {
      for (const id of [...a.skip, ...b.skip]) skip.add(id);
      return skip;
    },
    has: (id) => b.has(id) || a.has(id),
    ok: (e) => (b.has(e.id) || !a.has(e.id) ? b.ok(e) : a.ok(e)),
  };
}

export interface TurnsOptions {
  run: Runner;
  settings: Settings;
  log?: (line: string) => void;
  /** Null: no turns at all (the tests, unless they give their own). */
  deps: TurnsDeps | null;
}

/**
 * The turns a publishing stage takes: of `employees`, those this PC publishes for (its turn; nothing to publish there; a
 * host that refuses the ref; or a remote out of reach, where it can't publish anyway), and a line for each another PC has.
 */
export async function takeTurns(employees: Employee[], o: TurnsOptions): Promise<{ acting: Employee[]; elsewhere: EmployeeResult[]; guard: LeaseGuard | null }> {
  if (!o.deps) return { acting: employees, elsewhere: [], guard: null };
  const deps = o.deps;
  const log = o.log ?? (() => {});
  const nowOf = () => deps.now?.() ?? Date.now();
  const me = deps.device ?? deviceHere();
  const remote = deps.remote ?? ((e: Employee) => remoteFor(o.run, o.settings, e));
  const unique = employees.filter((e, i) => employees.findIndex((x) => x.id === e.id) === i);
  // 0.24's file, from the turns through the Exchequer: gone.
  rmSync(dataFile('leases.json'), { force: true });
  const remotes = new Map<string, RemoteRepo>();
  const checkouts = new Map<string, boolean>();
  const state = loadTurns();
  const before = state.repos;
  const ttlMs = turnMs(o.settings, state, me, nowOf());
  const turns = await mapLimit(unique, 4, async (e): Promise<RepoTurn | null> => {
    if (!publishes(e)) return null;
    try {
      const r = await remote(e);
      if (!r) return null;
      remotes.set(e.id, r);
      const checkout = !!e.checkout && existsSync(checkoutOf(e));
      checkouts.set(e.id, checkout);
      return await turnOne(o.run, r, e, { me, checkout, now: nowOf(), ttlMs, kept: before[key(e.repo)], refs: deps.refs });
    } catch (err) {
      log(`[${e.id}] turn: ${(err as Error).message}`);
      return { repo: e.repo, status: 'unreachable', note: unreachableNote(e), at: new Date(nowOf()).toISOString() };
    }
  });
  const now = loadTurns();
  const repos = { ...now.repos };
  const acting: Employee[] = [];
  const elsewhere: EmployeeResult[] = [];
  unique.forEach((e, i) => {
    const t = turns[i];
    if (t) repos[key(e.repo)] = t;
    if (t?.status === 'elsewhere') elsewhere.push(result(e, 'skipped', doneBy(e, t.record?.name ?? '')));
    else {
      acting.push(e);
      if (t?.note) log(`[${e.id}] ${t.note}`);
    }
  });
  writeJson(turnsFile(), withRepos({ ...now, at: new Date(nowOf()).toISOString(), device: me }, me, repos));

  const skip = new Set(elsewhere.map((r) => r.id));
  const given = new Set(acting.map((e) => e.id));
  const guard: LeaseGuard = {
    skip,
    has: (id) => given.has(id) || skip.has(id),
    async ok(e) {
      if (skip.has(e.id) || !given.has(e.id)) return false;
      const r = remotes.get(e.id);
      const k = key(e.repo);
      const t = loadTurns().repos[k];
      // No turn to keep (nothing to publish there, a host that refuses the ref, or a remote out of reach): as before.
      if (!r || !t || t.status !== 'here') return true;
      const ls = await lsRemote(o.run, r, [RELEASE_PC_REF]).catch(() => null);
      if (!ls || !ls.ok) return true;
      const sha = ls.refs[RELEASE_PC_REF] ?? null;
      const now = nowOf();
      if (sha && sha === t.sha && t.record && Date.parse(t.record.until) - SKEW_MS > now) return true;
      const full = unique.find((x) => x.id === e.id)!;
      let next: RepoTurn;
      if (sha && sha === t.sha && t.record) {
        // Still its own, near its end: renewed.
        const checkout = checkouts.get(e.id) ?? true;
        next = await claimTurn(o.run, r, full, recordFor(me, checkout, now, ttlMs, t.record), sha, me, now);
      } else {
        // Moved: Do it here on this PC (still its own), or another PC's now.
        const rec = sha ? readRecord(await fileAt(o.run, r, RELEASE_PC_REF, sha, RELEASE_PC_FILE)) : null;
        next = { repo: e.repo, status: rec?.pc === me.id ? 'here' : 'elsewhere', ...(sha ? { sha } : {}), ...(rec ? { record: rec } : {}), at: new Date(now).toISOString() };
      }
      const cur = loadTurns();
      writeJson(turnsFile(), withRepos(cur, me, { ...cur.repos, [k]: next }));
      if (next.status === 'elsewhere') {
        skip.add(e.id);
        return false;
      }
      return true;
    },
  };
  return { acting, elsewhere, guard };
}

/**
 * "Do it here" (pin left out), "Keep it on this PC" (pin: true), or Unpin (pin: false): the turn written to this PC by
 * compare-and-swap, whoever held it. The other PC's next check finds it gone, and leaves the repository alone.
 */
export async function handOver(e: Employee, o: { run: Runner; settings: Settings; deps?: TurnsDeps; pin?: boolean }): Promise<{ ok: boolean; message: string }> {
  const deps = o.deps ?? {};
  const me = deps.device ?? deviceHere();
  const r = await (deps.remote ?? ((x: Employee) => remoteFor(o.run, o.settings, x)))(e);
  if (!r) return { ok: false, message: `${e.name} has no remote to take its turn in.` };
  const checkout = !!e.checkout && existsSync(checkoutOf(e));
  for (let i = 0; i < 3; i++) {
    const now = deps.now?.() ?? Date.now();
    const read = await readRef(o.run, r, RELEASE_PC_REF, RELEASE_PC_FILE);
    if (read.kind === 'unreachable') return { ok: false, message: `Not now: this PC can't reach ${e.name}'s remote (${read.why}). Try again once it can.` };
    const had = read.kind === 'found' ? readRecord(read.text) : null;
    // Taken from another PC: it is seen, so the turn is three rounds long, not half a day.
    const ttlMs = had && had.pc !== me.id ? ttlFor(o.settings) * 1000 : turnMs(o.settings, loadTurns(), me, now);
    const rec = recordFor(me, checkout, now, ttlMs, had, o.pin ?? (had?.pc === me.id ? had.pinned : false));
    const t = await claimTurn(o.run, r, e, rec, read.kind === 'found' ? read.sha : null, me, now);
    if (t.status === 'alone') return { ok: false, message: `${t.note}.` };
    if (t.status === 'unreachable') return { ok: false, message: `Not now: ${t.note}.` };
    if (t.status === 'here' && t.sha && t.record?.until === rec.until) {
      const cur = loadTurns();
      const seen = had && had.pc !== me.id ? { ...(cur.others ?? {}), [had.pc]: { name: had.name, at: new Date(now).toISOString() } } : cur.others;
      writeJson(turnsFile(), withRepos({ ...cur, device: me, ...(seen ? { others: seen } : {}) }, me, { ...cur.repos, [key(e.repo)]: t }));
      const from = had && had.pc !== me.id && had.name ? ` from ${had.name}` : '';
      const words =
        o.pin === true
          ? `This PC keeps ${e.name}${from}: other PCs leave it alone while this PC is around.`
          : o.pin === false
            ? `${e.name} isn't kept on this PC any more: it stays here until another PC's turn comes.`
            : `This PC releases ${e.name} now${from}.`;
      return { ok: true, message: words };
    }
  }
  return { ok: false, message: `Another PC kept changing ${e.name}'s turn: try again in a minute.` };
}

/** One repository's row on the page. */
export interface TurnRow {
  id: string;
  name: string;
  repo: string;
  status: RepoTurn['status'];
  /** "this PC", or the other PC's name. */
  holder: string;
  pinned: boolean;
  /** Pinned to another PC that has stopped renewing it. */
  quiet: boolean;
  until: string | null;
  note: string | null;
}

/** The page's view: who has each repository's turn, pinned or not, and what waits. Null when no turn was taken yet. */
export interface TurnsView {
  at: string | null;
  rows: TurnRow[];
}

export function turnsView(employees: Pick<Employee, 'id' | 'name' | 'repo'>[], now = Date.now()): TurnsView | null {
  const s = loadTurns();
  const rows: TurnRow[] = [];
  for (const e of employees) {
    const t = s.repos[key(e.repo)];
    if (!t) continue;
    const rec = t.record;
    rows.push({
      id: e.id,
      name: e.name,
      repo: e.repo,
      status: t.status,
      holder: t.status === 'here' ? 'this PC' : (rec?.name ?? ''),
      pinned: !!rec?.pinned && (t.status === 'here' || t.status === 'elsewhere'),
      quiet: t.status === 'elsewhere' && !!rec?.pinned && Date.parse(rec.until) < now,
      until: rec?.until ?? null,
      note: t.note ?? null,
    });
  }
  return rows.length ? { at: s.at, rows } : null;
}
