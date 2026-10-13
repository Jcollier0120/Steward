import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { manorHome } from './kit/manor.ts';
import type { Condition, GetJson } from './alarms.ts';
import type { Runner } from './run.ts';
import type { EmployeeResult } from './stages/common.ts';
import { pageToken, request, tokenHeaders } from './upkeep.ts';

/**
 * Agent updates that stopped for a cause that has passed, settled without the person (Steward 0.35.62).
 *
 * A false rollback first. Every agent's install puts a new version on probation (the kit's safeinstall.ts): its page
 * must answer, its home page too, or the version before is put back and the new one flagged in the agent's
 * unsafe-updates.json, after which every install refuses it (exit 3) until a person allows it, and Manor counts a
 * failed update each time until it gives up. When the PC's network blinked during an update pass, every agent updated
 * then was rolled back together with "its home page didn't answer", though the releases were sound (2026-10-13: six
 * agents, 14:16–14:18Z, Manor's log saying the PC offline at 14:18Z and the Exchequer away until 14:24Z).
 *
 * So in each round, an agent whose newest release (Manor's item: available, latest) is flagged is weighed
 * (rollbackCause): flagged because its page or home page gave no answer at all, and either Manor's log shows the PC
 * offline or the Exchequer unreachable within WINDOW_MS of it, or other agents were rolled back the same way within
 * WINDOW_MS. If so, once the PC has been quiet a while (QUIET_MS since the rollback, no update running, Manor online
 * and answering), the Steward allows that version again, as the agent's own `install --allow-unsafe` does (its flag
 * taken out of unsafe-updates.json), and presses Update for it on Manor's page: one agent a round, GAP_MS apart, once
 * for each (agent, version) ever, kept in unstick.json. The install is the usual one, probation and all: a release that
 * truly fails is rolled back again, and is then an alarm. One whose cause doesn't look like the PC's is an alarm at
 * once, with the flag's own why and when.
 *
 * Then, an update Manor gave up on otherwise (GIVEN_UP failures, its item still offering that version): its install is
 * run as a dry run (one a round, RECHECK_MS apart while nothing changes); if it would install that version now (the
 * release wasn't everywhere yet when Manor tried), Update is pressed for it, once for each version; if not, it is an
 * alarm in the dry run's words. Nothing is done while an update runs, or while Manor's page doesn't answer.
 */

/** Manor's MAX_TRIES (its src/updates.ts): a failure counted this many times is left for the person. */
export const GIVEN_UP = 3;
/** While nothing changes, a dry run this often at most: Manor's own RETRY_MS. */
export const RECHECK_MS = 30 * 60_000;
/** How near a rollback the PC's being offline, or another agent's rollback, must be to count as its cause. */
export const WINDOW_MS = 10 * 60_000;
/** A rolled-back version is allowed again only this long after its rollback: past the blip. */
export const QUIET_MS = 30 * 60_000;
/** Between two versions allowed again, at least this long: one agent's install and probation at a time. */
export const GAP_MS = 10 * 60_000;
/** Manor's dry run asks the Exchequer or GitHub for each agent's latest release: a little time for each. */
const DRY_RUN_MS = 120_000;
/** Manor's install POST waits for its task to start. */
const PRESS_MS = 30_000;
const KEEP_SETTLED = 20;
/** How much of the end of Manor's serve.log is read for when the PC was offline. */
const LOG_TAIL = 2_000_000;

/** A probation that failed for want of any answer (the kit's probation()): what a network blip makes. Not "answered 500". */
export const NO_ANSWER = /^its home page didn't answer$|^its page stopped answering /;

/** Manor's updates.json, as far as this needs it. */
export interface ManorUpdates {
  offline?: string | null;
  exchequerDown?: string | null;
  items?: { id: string; name?: string; installed?: string | null; latest?: string | null; available?: boolean }[];
  run?: { finishedAt?: string | null } | null;
  failures?: Record<string, { version: string; at: string; count: number }>;
}

/** One update Manor gave up on, whose item still offers that version. */
export interface Stuck {
  id: string;
  name: string;
  version: string;
  installed: string | null;
}

/** Why one update can't be settled now. */
export interface Blocked {
  name: string;
  version: string;
  installed: string | null;
  /** When the Steward first found it couldn't settle it. */
  since: string;
  /**
   * older: the dry run would install an older release; failed: the dry run named no release; pressed: the Steward
   * pressed Update for this version once already, and Manor gave up again; refused: Manor didn't take the Update;
   * rolledBack: its own install rolled this version back, and nothing points at the PC; rolledBackAgain: the Steward
   * allowed it again once, and it was rolled back again.
   */
  why: 'older' | 'failed' | 'pressed' | 'refused' | 'rolledBack' | 'rolledBackAgain';
  /** The dry run's words for it, Manor's answer, or the rollback's why and when. */
  said: string;
  /** When the Steward pressed Update for it, or allowed it again. */
  pressedAt?: string;
}

export interface UnstickState {
  at: string | null;
  /** Each update the Steward pressed Update for, as "<id>@<version>", and when: once each, ever. */
  pressed: Record<string, string>;
  /** Each rolled-back version the Steward allowed again ("<id>@<version>"): when, and the rollback it allowed. */
  allowed: Record<string, { at: string; rolledBackAt: string; why: string; cause: string }>;
  /** The updates the Steward couldn't settle, by agent: its alarms. */
  blocked: Record<string, Blocked>;
  /** The last dry run: when, and the updates it was for ("<id>@<version>"). */
  lastDryRun: { at: string; for: string[] } | null;
  /** The last updates settled, newest first. */
  settled: { id: string; name: string; version: string; at: string; how?: 'pressed' | 'allowed' }[];
}

export const unstickFile = () => dataFile('unstick.json');
export const loadUnstick = (): UnstickState => ({ at: null, pressed: {}, allowed: {}, blocked: {}, lastDryRun: null, settled: [], ...readJson<Partial<UnstickState>>(unstickFile(), {}) });
const manorUpdatesFile = () => path.join(manorHome(), 'updates.json');
const keyOf = (s: { id: string; version: string }) => `${s.id}@${s.version}`;
const minute = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')}Z`;

/** The updates Manor gave up on whose item still offers that version. */
export function stuckUpdates(u: ManorUpdates): Stuck[] {
  const items = Array.isArray(u.items) ? u.items : [];
  return Object.entries(u.failures && typeof u.failures === 'object' ? u.failures : {}).flatMap(([id, f]) => {
    const item = items.find((i) => i?.id === id);
    if (!f || typeof f.version !== 'string' || !(f.count >= GIVEN_UP) || !item?.available || item.latest !== f.version) return [];
    return [{ id, name: typeof item.name === 'string' ? item.name : id, version: f.version, installed: item.installed ?? null }];
  });
}

/** Whether Manor is installing now: its run started and not finished. */
export const updateRunning = (u: ManorUpdates) => !!u.run && !u.run.finishedAt;

/** A version an agent's own install rolled back (the kit's safeinstall.ts, its unsafe-updates.json), by version. */
export type RolledBack = Record<string, { version: string; from?: string | null; why: string; at: string; kept?: string | null }>;

const agentId = /^[a-z0-9-]+$/;
const unsafeFileOf = (id: string) => path.join(os.homedir(), `.${id}`, 'unsafe-updates.json');

/**
 * An agent's rolled-back versions, from its data folder (%USERPROFILE%\.<id>, as every agent's); {} when there are none.
 * Never under node --test: a test must not read this PC's agents.
 */
export const readRolledBack = (id: string): RolledBack => (!process.env.NODE_TEST_CONTEXT && agentId.test(id) ? readJson<RolledBack>(unsafeFileOf(id), {}) : {});

export type AllowAgain = (id: string, version: string) => boolean;

/**
 * Allows a rolled-back version to be installed again, as the agent's own `install --allow-unsafe` does (the kit's
 * allowUpdate): its flag taken out of the agent's unsafe-updates.json. False when it wasn't flagged. Never under node --test.
 */
export const allowAgain: AllowAgain = (id, version) => {
  if (process.env.NODE_TEST_CONTEXT || !agentId.test(id)) return false;
  const all = readJson<RolledBack>(unsafeFileOf(id), {});
  if (!(version in all)) return false;
  delete all[version];
  writeJson(unsafeFileOf(id), all);
  return true;
};

/** The end of Manor's serve.log (and the one before it, when kept), for when the PC was offline. Never under node --test. */
export function readManorLog(home = manorHome()): string {
  if (process.env.NODE_TEST_CONTEXT) return '';
  return ['serve.old.log', 'serve.log']
    .map((name) => {
      const file = path.join(home, name);
      try {
        const size = statSync(file).size;
        const len = Math.min(size, LOG_TAIL);
        const buf = Buffer.alloc(len);
        const fd = openSync(file, 'r');
        try {
          readSync(fd, buf, 0, len, size - len);
        } finally {
          closeSync(fd);
        }
        return buf.toString('utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

/** Manor's log lines that say the PC or the Exchequer couldn't be reached. */
const OFFLINE_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (This PC is offline|This PC is back online|The Exchequer can't answer now|The Exchequer answers again)/;

/**
 * Whether a rollback looks like the PC's doing rather than the release's: it failed for want of any answer (NO_ANSWER),
 * and Manor's log shows the PC offline or the Exchequer unreachable within WINDOW_MS, or other agents were rolled back
 * the same way within WINDOW_MS (one update pass, all at once). Its words say what was found either way. Pure.
 */
export function rollbackCause(
  r: { why: string; at: string },
  others: { name: string; why: string; at: string }[],
  manorLog: string,
): { environmental: boolean; words: string } {
  const at = Date.parse(r.at);
  if (!NO_ANSWER.test(r.why)) return { environmental: false, words: `"${r.why}" is the release's own answer, not a page that gave none` };
  const near = (t: number) => Math.abs(t - at) <= WINDOW_MS;
  const offline = manorLog
    .split(/\r?\n/)
    .map((l) => OFFLINE_LINE.exec(l))
    .filter((m): m is RegExpExecArray => !!m && near(Date.parse(m[1])))
    .map((m) => `${m[2].replace(/^This PC is /, 'the PC ').replace(/^The Exchequer /, 'the Exchequer ')} at ${minute(m[1])}`);
  const together = others.filter((o) => NO_ANSWER.test(o.why) && near(Date.parse(o.at))).map((o) => o.name);
  const found: string[] = [];
  // Said by its going away (offline, can't answer); its coming back only when that is all there is near it.
  const away = offline.filter((w) => !/back online|answers again/.test(w));
  if (offline.length) found.push(`Manor's log says ${[...new Set(away.length ? away : offline)].slice(0, 2).join(', and ')}`);
  if (together.length) found.push(`${together.join(', ')} ${together.length === 1 ? 'was' : 'were'} rolled back the same way within ${WINDOW_MS / 60_000} minutes`);
  if (found.length) return { environmental: true, words: found.join('; and ') };
  return { environmental: false, words: `Manor's log shows the PC online then, and no other agent was rolled back near it` };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What Manor's install dry run says of one agent: the version it would install (the "<id>-v<version>" its line names,
 * after "; from "), with the line's words, or only the words when it names none (its release couldn't be found).
 */
export function dryRunFinds(out: string, a: { id: string; name: string }): { version: string | null; said: string } {
  const lines = out.split(/\r?\n/);
  const tag = new RegExp(`(?:^|[^\\w-])${escape(a.id)}-v(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)\\b`, 'i');
  const from = (l: string) => l.slice(l.indexOf('; from ') + '; from '.length).trim();
  const tagged = lines.find((l) => l.includes('; from ') && tag.test(from(l)));
  if (tagged) return { version: tag.exec(from(tagged))![1], said: from(tagged) };
  // Its line by its name, as the dry run pads it ("  Lamplighter  …"): no tag, so the reason the release can't be had.
  const named = lines.find((l) => new RegExp(`^\\s+${escape(a.name)}\\s{2,}`).test(l) && l.includes('; from '));
  if (named) return { version: null, said: from(named) };
  const last = lines.map((l) => l.trim()).filter(Boolean).slice(-2).join(' ');
  return { version: null, said: last || 'it printed nothing' };
}

export type DryRun = (ids: string[]) => Promise<{ code: number; out: string }>;

/** Manor's install, as a dry run, for these agents: the installed Manor's own cli.ts, its window hidden, with a deadline. */
export function manorDryRun(run: Runner, home = manorHome()): DryRun {
  return async (ids) => {
    const cli = path.join(home, 'app', 'src', 'cli.ts');
    if (!existsSync(cli)) return { code: -1, out: `Manor isn't installed at ${path.dirname(path.dirname(cli))}` };
    const r = await run('node', [cli, 'install', ...ids, '--dry-run', '--no-browser'], { timeoutMs: DRY_RUN_MS });
    return { code: r.code, out: `${r.out}\n${r.err}` };
  };
}

export type PressUpdate = (ids: string[]) => Promise<{ ok: boolean; said: string }>;

/** Presses Update on Manor's page for these agents, as the page does: its token from the page, then the POST, no Origin. */
export function pressUpdate(manorUrl: string): PressUpdate {
  return async (ids) => {
    const origin = new URL(manorUrl);
    const t = await pageToken(origin, { timeoutMs: 5000 });
    if ('error' in t) return { ok: false, said: `Manor's page didn't answer: ${t.error}` };
    if (!('token' in t)) return { ok: false, said: `Manor's page (HTTP ${t.status}) carries no token` };
    const r = await request(new URL('/api/updates/install', origin), { method: 'POST', headers: tokenHeaders(t.token), body: JSON.stringify({ ids }), timeoutMs: PRESS_MS });
    if ('error' in r) return { ok: false, said: r.error };
    let error: string | null = null;
    try {
      error = (JSON.parse(r.body) as { error?: string | null })?.error ?? null;
    } catch {
      // Not JSON: the status says it.
    }
    return r.status >= 200 && r.status < 300 && !error ? { ok: true, said: `HTTP ${r.status}` } : { ok: false, said: error ?? `HTTP ${r.status}` };
  };
}

/** Whether a page answered: getJson's lone { error } is no answer. */
const answered = (v: unknown) => !!v && typeof v === 'object' && !(Object.keys(v as object).length === 1 && 'error' in (v as object));

/** An agent whose newest release its own install rolled back. */
interface Flagged {
  id: string;
  name: string;
  version: string;
  installed: string | null;
  flag: RolledBack[string];
}

/**
 * One look at the updates that stopped: a false rollback allowed again and its Update pressed, or an update Manor gave
 * up on pressed once its install would take it, one action a round at most; the rest kept as alarms. A line for the
 * round for each one settled; none when nothing stopped.
 */
export async function unstick(o: {
  manorUrl: string;
  getJson: GetJson;
  dryRun: DryRun;
  press?: PressUpdate;
  /** Manor's updates.json; null when it can't be read. */
  readUpdates?: () => ManorUpdates | null;
  /** An agent's rolled-back versions (readRolledBack). */
  rolledBack?: (id: string) => RolledBack;
  /** Takes a version's flag out (allowAgain). */
  allow?: AllowAgain;
  /** The end of Manor's serve.log (readManorLog). */
  manorLog?: () => string;
  now?: () => Date;
  log: (line: string) => void;
}): Promise<EmployeeResult[]> {
  const now = o.now ?? (() => new Date());
  const at = now().toISOString();
  const was = loadUnstick();
  const u = (o.readUpdates ?? (() => readJson<ManorUpdates | null>(manorUpdatesFile(), null)))();
  if (!u || typeof u !== 'object') return [];
  const items = Array.isArray(u.items) ? u.items : [];
  const stillOffered = (id: string, version: string) => items.some((i) => i?.id === id && i.latest === version && i.installed !== version);
  const state: UnstickState = { ...was, at, blocked: {}, pressed: {}, allowed: {} };
  // What was done once is remembered while that version is still offered and the agent isn't on it.
  for (const [key, when] of Object.entries(was.pressed)) if (stillOffered(key.split('@')[0], key.split('@')[1])) state.pressed[key] = when;
  for (const [key, a] of Object.entries(was.allowed ?? {})) if (stillOffered(key.split('@')[0], key.split('@')[1])) state.allowed[key] = a;
  const save = () => writeJson(unstickFile(), state);
  const block = (s: { id: string; name: string; version: string; installed: string | null }, why: Blocked['why'], said: string, pressedAt?: string) => {
    const before = state.blocked[s.id];
    if (!before || before.why !== why) o.log(`[${s.id}] ${s.name} can't be updated to ${s.version}, and the Steward can't settle it: ${said}`);
    state.blocked[s.id] = { name: s.name, version: s.version, installed: s.installed, since: before?.since ?? at, why, said, ...(pressedAt ? { pressedAt } : {}) };
  };

  // The agents whose newest release their own install rolled back, weighed together: a blip rolls back several at once.
  const rolledBack = o.rolledBack ?? readRolledBack;
  const flags = new Map<string, RolledBack>();
  for (const i of items) if (i?.id && i.available) flags.set(i.id, rolledBack(i.id));
  const flagged: Flagged[] = items.flatMap((i) => {
    const flag = i?.available && i.latest ? flags.get(i.id)?.[i.latest] : undefined;
    return flag && typeof flag === 'object' && typeof flag.at === 'string' ? [{ id: i.id, name: i.name ?? i.id, version: i.latest!, installed: i.installed ?? null, flag: { ...flag, why: String(flag.why ?? '') } }] : [];
  });
  // Every agent's flags, superseded ones too (a blip's other rollbacks), only once one is to be weighed.
  if (flagged.length) for (const i of items) if (i?.id && !flags.has(i.id)) flags.set(i.id, rolledBack(i.id));
  const everyFlag = items.flatMap((i) => Object.values(flags.get(i?.id) ?? {}).map((f) => ({ id: i.id, name: i.name ?? i.id, why: String(f?.why ?? ''), at: String(f?.at ?? '') })));
  const log = flagged.length ? (o.manorLog ?? readManorLog)() : '';
  const toAllow: (Flagged & { cause: string })[] = [];
  for (const f of flagged) {
    const allowed = state.allowed[keyOf(f)];
    if (allowed) {
      // Allowed once already, and flagged again since: the release's own doing after all, and never allowed twice.
      block(f, 'rolledBackAgain', `it was rolled back again at ${minute(f.flag.at)}: ${f.flag.why}`, allowed.at);
      continue;
    }
    const cause = rollbackCause(f.flag, everyFlag.filter((x) => x.id !== f.id), log);
    if (!cause.environmental) block(f, 'rolledBack', `${f.name} ${f.version} was rolled back to ${f.flag.from ?? 'the version before'} at ${minute(f.flag.at)}: ${f.flag.why}. ${cause.words[0].toUpperCase()}${cause.words.slice(1)}`);
    else toAllow.push({ ...f, cause: cause.words });
  }
  const flaggedIds = new Set(flagged.map((f) => f.id));

  // Updates Manor gave up on for anything else.
  for (const [id, b] of Object.entries(was.blocked)) {
    if (state.blocked[id] || b.why === 'rolledBack' || b.why === 'rolledBackAgain') continue;
    if (stuckUpdates(u).some((s) => s.id === id && s.version === b.version) && !flaggedIds.has(id)) state.blocked[id] = b;
  }
  for (const [id, b] of Object.entries(was.blocked)) {
    if (!state.blocked[id] && items.find((i) => i?.id === id)?.installed === b.version) o.log(`[${id}] ${b.name} is on ${b.version} now: its update is done`);
  }
  const stuck = stuckUpdates(u).filter((s) => !flaggedIds.has(s.id));
  for (const s of stuck) if (state.pressed[keyOf(s)]) block(s, 'pressed', `${s.name} stayed on ${s.installed ?? 'its old version'}`, state.pressed[keyOf(s)]);
  const left = stuck.filter((s) => !state.pressed[keyOf(s)]);

  // Only on a quiet PC: no update running, Manor online and reaching the Exchequer, its page answering.
  if ((!toAllow.length && !left.length) || updateRunning(u) || u.offline || u.exchequerDown) {
    save();
    return [];
  }
  if (!answered(await o.getJson(new URL('/api/state', o.manorUrl).href))) {
    save();
    return [];
  }
  const press = o.press ?? pressUpdate(o.manorUrl);
  const results: EmployeeResult[] = [];

  // A false rollback: one agent a round, GAP_MS after the last, QUIET_MS after its rollback.
  const lastAllowed = Math.max(0, ...Object.values(was.allowed ?? {}).map((a) => Date.parse(a.at)));
  const due = toAllow.filter((f) => now().getTime() - Date.parse(f.flag.at) >= QUIET_MS).sort((a, b) => Date.parse(a.flag.at) - Date.parse(b.flag.at));
  if (due.length && now().getTime() - lastAllowed >= GAP_MS) {
    const f = due[0];
    if (!(o.allow ?? allowAgain)(f.id, f.version)) {
      block(f, 'rolledBack', `${f.name} ${f.version} was rolled back at ${minute(f.flag.at)} (${f.flag.why}), and the Steward couldn't take its flag out of ${f.id}'s unsafe-updates.json`);
      save();
      return [];
    }
    state.allowed[keyOf(f)] = { at, rolledBackAt: f.flag.at, why: f.flag.why, cause: f.cause };
    const r = await press([f.id]).catch((e: Error) => ({ ok: false, said: e.message }));
    const what = `${f.version} was rolled back at ${minute(f.flag.at)} (${f.flag.why}), when ${f.cause}`;
    if (!r.ok) {
      // Allowed all the same: Manor's own next update installs it.
      o.log(`[${f.id}] ${what}: the Steward allowed it again, but Manor didn't take its Update (${r.said}); Manor's next update installs it`);
      save();
      return [];
    }
    state.settled = [{ id: f.id, name: f.name, version: f.version, at, how: 'allowed' as const }, ...state.settled].slice(0, KEEP_SETTLED);
    o.log(`[${f.id}] ${what}: the Steward allowed it again and pressed Update for it, once`);
    save();
    return [{ id: f.id, name: f.name, outcome: 'done', message: `unstick: ${what}, so the Steward allowed it again and pressed Update for it, once`, version: f.version }];
  }
  if (!left.length || toAllow.length) {
    // A false rollback waits its turn first: one action at a time.
    save();
    return results;
  }

  // One dry run while nothing changes, then one every RECHECK_MS: it asks the Exchequer or GitHub for each.
  const keys = left.map(keyOf).sort();
  const same = was.lastDryRun && was.lastDryRun.for.join() === keys.join();
  if (same && now().getTime() - Date.parse(was.lastDryRun!.at) < RECHECK_MS) {
    save();
    return [];
  }
  const dry = await o.dryRun(left.map((s) => s.id)).catch((e: Error) => ({ code: -1, out: e.message }));
  state.lastDryRun = { at, for: keys };
  const ready: Stuck[] = [];
  for (const s of left) {
    const f = dryRunFinds(dry.out, s);
    if (f.version === null) block(s, 'failed', f.said);
    else if (f.version !== s.version) block(s, 'older', f.said);
    else ready.push(s);
  }
  if (ready.length) {
    const r = await press(ready.map((s) => s.id)).catch((e: Error) => ({ ok: false, said: e.message }));
    for (const s of ready) {
      if (!r.ok) {
        block(s, 'refused', r.said);
        continue;
      }
      state.pressed[keyOf(s)] = at;
      delete state.blocked[s.id];
      state.settled = [{ id: s.id, name: s.name, version: s.version, at, how: 'pressed' as const }, ...state.settled].slice(0, KEEP_SETTLED);
      o.log(`[${s.id}] Manor had given up updating ${s.name} to ${s.version}; its install would take it now, so the Steward pressed Update for it`);
      results.push({ id: s.id, name: s.name, outcome: 'done', message: `unstick: Manor had given up updating it to ${s.version}; its install would take it now, so the Steward pressed Update for it`, version: s.version });
    }
  }
  save();
  return results;
}

const ALLOW_BY_HAND = (id: string) => `unpack its release (Manor keeps the zip in %USERPROFILE%\\.manor\\downloads\\${id}) and run node src\\cli.ts install --allow-unsafe in it`;

/** The alarms of the updates the Steward couldn't settle, in their own words. At once: Manor has tried already. */
export function unstickConditions(state: UnstickState): Condition[] {
  return Object.entries(state.blocked).map(([id, b]) => {
    const on = b.installed ? `${b.name} stays on ${b.installed}` : `${b.name} isn't updated`;
    const again = `${on}. The Steward runs the install's dry run again every half hour, and presses Update for it once it would take ${b.version}. Or press Update on Manor's page yourself.`;
    const byWhy: Record<Blocked['why'], { title: string; detail: string[] }> = {
      older: { title: `Manor gave up updating ${b.name} to ${b.version}`, detail: [`Manor's look found ${b.version}, but its install would still take an older release: ${b.said}.`, again] },
      failed: { title: `Manor gave up updating ${b.name} to ${b.version}`, detail: [`Manor's install couldn't name a release for it: ${b.said}`, again] },
      refused: { title: `Manor gave up updating ${b.name} to ${b.version}`, detail: [`Manor didn't take the Steward's Update for it: ${b.said}`, `${on}. The Steward tries again in half an hour. Or press Update on Manor's page yourself.`] },
      pressed: {
        title: `Manor gave up updating ${b.name} to ${b.version}`,
        detail: [`The Steward pressed Update for it${b.pressedAt ? ` at ${minute(b.pressedAt)}` : ''}, when Manor's install would take ${b.version}, and Manor gave up on it again: ${b.said}.`, `The Steward presses Update only once for each version, so this one is yours: look at Manor's install log for why, then press Update on Manor's page.`],
      },
      rolledBack: {
        title: `${b.name} ${b.version} was rolled back, so Manor can't update it`,
        detail: [`${b.said}.`, `Its installer refuses ${b.version} until it is allowed, so ${on}. Its next version installs as usual. To try ${b.version} again now, ${ALLOW_BY_HAND(id)}.`],
      },
      rolledBackAgain: {
        title: `${b.name} ${b.version} was rolled back again, after the Steward allowed it once`,
        detail: [`The Steward allowed ${b.version} again${b.pressedAt ? ` at ${minute(b.pressedAt)}` : ''}, as its first rollback looked like the PC's doing, and ${b.said}. So it looks like the release's own.`, `${on}, and the Steward won't allow it again. Its next version installs as usual; to try ${b.version} once more, ${ALLOW_BY_HAND(id)}.`],
      },
    };
    const w = byWhy[b.why] ?? byWhy.failed;
    return { id: `unstick:${id}`, who: id, title: w.title, detail: w.detail, since: b.since, afterMs: 0 };
  });
}
