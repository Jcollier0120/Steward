import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { manorHome } from './kit/manor.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { fileAt, lsRemote, readRef, writeRef, type RemoteRepo } from './remote-ref.ts';
import type { Runner } from './run.ts';
import type { Employee, Settings } from './settings.ts';
import { checkoutOf, mapLimit, result, workRootOf, type EmployeeResult } from './stages/common.ts';

/**
 * One release PC per repository, elected by the PCs themselves (docs/MULTI-PC.md). Every PC may run a Steward signed in
 * to the same GitHub account; without turns, two of them merge and release the same PRs.
 *
 * The meeting place is a ref in the repository's own remote, on any host: `refs/manor/release-pc`, a tiny orphan commit
 * holding release-pc.json, `{ pc, name, until, since, pinned, checkout }`, read and written with plain git
 * (remote-ref.ts), by compare-and-swap. No licence, no Exchequer, nothing of GitHub's: it works for anyone.
 *
 * - Before a stage publishes (merges, releases, refresh, kit rollout and catch-up pushes, the Release button), it reads
 *   the ref of each repository it would publish to. Free, or run out: it takes it, for three rounds. Its own: renewed
 *   once half of that is gone. Another PC's: left alone, and the page says so, with Do it here.
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
}

/** Stands in for this PC, the clock and the remotes (tests). */
export interface TurnsDeps {
  device?: Device;
  now?: () => number;
  remote?: (e: Employee) => Promise<RemoteRepo | null>;
}

export const turnsFile = () => dataFile('turns.json');
export const loadTurns = (): TurnsState => ({ at: null, device: null, repos: {}, ...readJson<Partial<TurnsState>>(turnsFile(), {}) });
const key = (repo: string) => repo.toLowerCase();

/** A turn's length for Settings' rounds: three of them, at least 15 minutes. */
export const ttlFor = (s: Pick<Settings, 'roundMinutes'>) => Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, Math.round(3 * (s.roundMinutes || 10) * 60)));

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
    const r = await run('git', ['config', '--get', 'remote.origin.url'], { cwd: checkout, timeoutMs: 30_000 });
    const url = r.code === 0 ? r.out.trim() : '';
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
export async function turnOne(run: Runner, r: RemoteRepo, e: Pick<Employee, 'name' | 'repo'>, o: { me: Device; checkout: boolean; now: number; ttlMs: number }): Promise<RepoTurn> {
  const at = new Date(o.now).toISOString();
  // Both refs in one look: the claims ref's commit is kept for claims.ts.
  const ls = await lsRemote(run, r, [RELEASE_PC_REF, CLAIMS_REF]);
  if (!ls.ok) return { repo: e.repo, status: 'unreachable', note: unreachableNote(e), at };
  const claimsSha = ls.refs[CLAIMS_REF] ?? null;
  const sha = ls.refs[RELEASE_PC_REF] ?? null;
  const rec = sha ? readRecord(await fileAt(run, r, RELEASE_PC_REF, sha, RELEASE_PC_FILE)) : null;
  const d = decide(rec, { pc: o.me.id, checkout: o.checkout }, o.now, o.ttlMs);
  if (d === 'keep') return { repo: e.repo, status: 'here', sha: sha!, record: rec!, claimsSha, at };
  if (d === 'elsewhere') return { repo: e.repo, status: 'elsewhere', sha: sha!, record: rec!, claimsSha, at };
  // Taken from another PC (run out, or a pin gone quiet): not pinned here.
  const pinned = rec && rec.pc !== o.me.id ? false : undefined;
  return { ...(await claimTurn(run, r, e, recordFor(o.me, o.checkout, o.now, o.ttlMs, rec, pinned), sha, o.me, o.now)), claimsSha };
}

/** The words for a repository another PC publishes. */
export const doneBy = (e: Pick<Employee, 'name'>, holder: string) => `merging and releasing for ${e.name}: done by ${holder || 'another PC'}`;

/** Before each publishing act: whether this PC may still publish to an employee's repository. */
export interface LeaseGuard {
  ok(e: Pick<Employee, 'id' | 'repo'>): Promise<boolean>;
  /** The employees another PC publishes for, this stage. */
  skip: Set<string>;
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
  const ttlMs = ttlFor(o.settings) * 1000;
  const remote = deps.remote ?? ((e: Employee) => remoteFor(o.run, o.settings, e));
  const unique = employees.filter((e, i) => employees.findIndex((x) => x.id === e.id) === i);
  // 0.24's file, from the turns through the Exchequer: gone.
  rmSync(dataFile('leases.json'), { force: true });
  const remotes = new Map<string, RemoteRepo>();
  const checkouts = new Map<string, boolean>();
  const turns = await mapLimit(unique, 4, async (e): Promise<RepoTurn | null> => {
    if (!publishes(e)) return null;
    try {
      const r = await remote(e);
      if (!r) return null;
      remotes.set(e.id, r);
      const checkout = !!e.checkout && existsSync(checkoutOf(e));
      checkouts.set(e.id, checkout);
      return await turnOne(o.run, r, e, { me, checkout, now: nowOf(), ttlMs });
    } catch (err) {
      log(`[${e.id}] turn: ${(err as Error).message}`);
      return { repo: e.repo, status: 'unreachable', note: unreachableNote(e), at: new Date(nowOf()).toISOString() };
    }
  });
  const repos = { ...loadTurns().repos };
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
  writeJson(turnsFile(), { at: new Date(nowOf()).toISOString(), device: me, repos } satisfies TurnsState);

  const skip = new Set(elsewhere.map((r) => r.id));
  const given = new Set(acting.map((e) => e.id));
  const guard: LeaseGuard = {
    skip,
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
      writeJson(turnsFile(), { ...cur, repos: { ...cur.repos, [k]: next } } satisfies TurnsState);
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
  const ttlMs = ttlFor(o.settings) * 1000;
  const r = await (deps.remote ?? ((x: Employee) => remoteFor(o.run, o.settings, x)))(e);
  if (!r) return { ok: false, message: `${e.name} has no remote to take its turn in.` };
  const checkout = !!e.checkout && existsSync(checkoutOf(e));
  for (let i = 0; i < 3; i++) {
    const now = deps.now?.() ?? Date.now();
    const read = await readRef(o.run, r, RELEASE_PC_REF, RELEASE_PC_FILE);
    if (read.kind === 'unreachable') return { ok: false, message: `Not now: this PC can't reach ${e.name}'s remote (${read.why}). Try again once it can.` };
    const had = read.kind === 'found' ? readRecord(read.text) : null;
    const rec = recordFor(me, checkout, now, ttlMs, had, o.pin ?? (had?.pc === me.id ? had.pinned : false));
    const t = await claimTurn(o.run, r, e, rec, read.kind === 'found' ? read.sha : null, me, now);
    if (t.status === 'alone') return { ok: false, message: `${t.note}.` };
    if (t.status === 'unreachable') return { ok: false, message: `Not now: ${t.note}.` };
    if (t.status === 'here' && t.sha && t.record?.until === rec.until) {
      const cur = loadTurns();
      writeJson(turnsFile(), { ...cur, device: me, repos: { ...cur.repos, [key(e.repo)]: t } } satisfies TurnsState);
      const from = had && had.pc !== me.id && had.name ? ` from ${had.name}` : '';
      const words =
        o.pin === true
          ? `This PC keeps ${e.name}${from}: other PCs leave it alone while this PC is around.`
          : o.pin === false
            ? `${e.name} isn't kept on this PC any more: it stays here until another PC's turn comes.`
            : `This PC merges and releases ${e.name} now${from}.`;
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
