import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { manorHome } from './kit/manor.ts';
import type { Condition, GetJson } from './alarms.ts';
import type { Runner } from './run.ts';
import type { EmployeeResult } from './stages/common.ts';
import { pageToken, request, tokenHeaders } from './upkeep.ts';

/**
 * An agent update Manor gave up on, settled once its cause has passed (Steward 0.35.62). Manor's own updates count an
 * install that leaves the agent on its old version as failed, try again after half an hour, and after GIVEN_UP tries
 * leave it for the person's Update (Manor's updates.json, `failures`). Most often the cause was passing: the install
 * downloaded the older release while Manor's look had found the new one (the release day's hold, the Exchequer away a
 * few minutes), and a little later the same install would have taken it.
 *
 * So in each round, while one is stuck that way (its item still offers failure.version, and no update is running) and
 * Manor's page answers, Manor's install is run as a dry run for those agents (one run a round at most, and one every
 * RECHECK_MS while nothing changes). For each whose dry run would install that very version, the Steward presses Update
 * for it as Manor's page does (POST /api/updates/install), at most once for each version, kept in unstick.json, so it
 * can never loop. One whose dry run would still take an older release, or fails, is an alarm (unstickConditions) in the
 * dry run's own words, until it is on that version, or Manor no longer holds it given up. So is one whose own install
 * rolled that version back once (its page didn't answer after it: the kit's safeinstall.ts): its installer refuses it
 * until a person allows it, which the Steward leaves to them; no dry run or Update is spent on it.
 */

/** Manor's MAX_TRIES (its src/updates.ts): a failure counted this many times is left for the person. */
export const GIVEN_UP = 3;
/** While nothing changes, a dry run this often at most: Manor's own RETRY_MS. */
export const RECHECK_MS = 30 * 60_000;
/** Manor's dry run asks the Exchequer or GitHub for each agent's latest release: a little time for each. */
const DRY_RUN_MS = 120_000;
/** Manor's install POST waits for its task to start. */
const PRESS_MS = 30_000;
const KEEP_SETTLED = 20;

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

/** Why one stuck update can't be settled now. */
export interface Blocked {
  name: string;
  version: string;
  installed: string | null;
  /** When the Steward first found it couldn't settle it. */
  since: string;
  /**
   * older: the dry run would install an older release; failed: the dry run named no release; pressed: the Steward
   * pressed Update for this version once already, and Manor gave up again; refused: Manor didn't take the Update;
   * rolledBack: the agent's own install rolled this version back once, and refuses it until a person allows it.
   */
  why: 'older' | 'failed' | 'pressed' | 'refused' | 'rolledBack';
  /** The dry run's words for it, or Manor's answer. */
  said: string;
  /** When the Steward pressed Update for this version, for 'pressed'. */
  pressedAt?: string;
}

export interface UnstickState {
  at: string | null;
  /** Each update the Steward pressed Update for, as "<id>@<version>", and when: once each, ever. */
  pressed: Record<string, string>;
  /** The stuck updates the Steward couldn't settle, by agent: its alarms. */
  blocked: Record<string, Blocked>;
  /** The last dry run: when, and the updates it was for ("<id>@<version>"). */
  lastDryRun: { at: string; for: string[] } | null;
  /** The last updates settled, newest first. */
  settled: { id: string; name: string; version: string; at: string }[];
}

export const unstickFile = () => dataFile('unstick.json');
export const loadUnstick = (): UnstickState => ({ at: null, pressed: {}, blocked: {}, lastDryRun: null, settled: [], ...readJson<Partial<UnstickState>>(unstickFile(), {}) });
const manorUpdatesFile = () => path.join(manorHome(), 'updates.json');
const keyOf = (s: { id: string; version: string }) => `${s.id}@${s.version}`;

/** The updates Manor gave up on whose item still offers that version: what this settles. */
export function stuckUpdates(u: ManorUpdates): Stuck[] {
  const items = Array.isArray(u.items) ? u.items : [];
  return Object.entries(u.failures && typeof u.failures === 'object' ? u.failures : {}).flatMap(([id, f]) => {
    const item = items.find((i) => i?.id === id);
    if (!f || typeof f.version !== 'string' || !(f.count >= GIVEN_UP) || !item?.available || item.latest !== f.version) return [];
    return [{ id, name: typeof item.name === 'string' ? item.name : id, version: f.version, installed: item.installed ?? null }];
  });
}

/** A version an agent's own install rolled back (the kit's safeinstall.ts, its unsafe-updates.json), by version. */
export type RolledBack = Record<string, { version: string; why: string; at: string }>;

/**
 * An agent's rolled-back versions, from its data folder (%USERPROFILE%\.<id>, as every agent's); {} when there are none.
 * Never under node --test: a test must not read this PC's agents.
 */
export const readRolledBack = (id: string): RolledBack =>
  !process.env.NODE_TEST_CONTEXT && /^[a-z0-9-]+$/.test(id) ? readJson<RolledBack>(path.join(os.homedir(), `.${id}`, 'unsafe-updates.json'), {}) : {};

/** Whether Manor is installing now: its run started and not finished. */
export const updateRunning = (u: ManorUpdates) => !!u.run && !u.run.finishedAt;

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

/**
 * One look at the updates Manor gave up on: those whose dry run would now install them pressed once through Manor's
 * page, and the rest kept as alarms. A line for the round for each one pressed; none when nothing is stuck.
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
  now?: () => Date;
  log: (line: string) => void;
}): Promise<EmployeeResult[]> {
  const now = o.now ?? (() => new Date());
  const at = now().toISOString();
  const was = loadUnstick();
  const u = (o.readUpdates ?? (() => readJson<ManorUpdates | null>(manorUpdatesFile(), null)))();
  if (!u || typeof u !== 'object') return [];
  const items = Array.isArray(u.items) ? u.items : [];
  const stuck = stuckUpdates(u);
  const state: UnstickState = { ...was, at, blocked: {}, pressed: {} };
  // An update pressed once is remembered while its item still offers that version and the agent isn't on it.
  for (const [key, when] of Object.entries(was.pressed)) {
    const [id, version] = key.split('@');
    const item = items.find((i) => i?.id === id);
    if (item && item.latest === version && item.installed !== version) state.pressed[key] = when;
  }
  // A blocked one stays while Manor still holds that version given up; on it now, it is said, and its alarm clears.
  for (const [id, b] of Object.entries(was.blocked)) {
    if (stuck.some((s) => s.id === id && s.version === b.version)) state.blocked[id] = b;
    else if (items.find((i) => i?.id === id)?.installed === b.version) o.log(`[${id}] ${b.name} is on ${b.version} now: its update Manor had given up on is done`);
  }
  const save = () => writeJson(unstickFile(), state);
  const block = (s: Stuck, why: Blocked['why'], said: string, pressedAt?: string) => {
    const before = state.blocked[s.id];
    if (!before || before.why !== why) o.log(`[${s.id}] Manor gave up updating ${s.name} to ${s.version}, and the Steward can't settle it: ${said}`);
    state.blocked[s.id] = { name: s.name, version: s.version, installed: s.installed, since: before?.since ?? at, why, said, ...(pressedAt ? { pressedAt } : {}) };
  };
  // One the Steward pressed Update for already, given up on again: never pressed twice, so it is the person's.
  const pressedBefore = stuck.filter((s) => state.pressed[keyOf(s)]);
  for (const s of pressedBefore) block(s, 'pressed', `${s.name} stayed on ${s.installed ?? 'its old version'}`, state.pressed[keyOf(s)]);
  // One its own install rolled back (its page didn't answer after it): every install of that version is refused, so
  // pressing Update would fail again. Allowing it again is a person's call.
  const back = new Map<string, string>();
  for (const s of stuck) {
    if (state.pressed[keyOf(s)]) continue;
    const bad = (o.rolledBack ?? readRolledBack)(s.id)[s.version];
    if (bad && typeof bad === 'object') back.set(s.id, `${s.name} ${s.version} was rolled back on ${String(bad.at).slice(0, 10)} (${bad.why ?? 'its install failed'})`);
  }
  for (const s of stuck) if (back.has(s.id)) block(s, 'rolledBack', back.get(s.id)!);
  const left = stuck.filter((s) => !state.pressed[keyOf(s)] && !back.has(s.id));
  if (!left.length || updateRunning(u) || u.offline || u.exchequerDown) {
    save();
    return [];
  }
  // One dry run while nothing changes, then one every RECHECK_MS: it asks the Exchequer or GitHub for each.
  const keys = left.map(keyOf).sort();
  const same = was.lastDryRun && was.lastDryRun.for.join() === keys.join();
  if (same && now().getTime() - Date.parse(was.lastDryRun!.at) < RECHECK_MS) {
    save();
    return [];
  }
  if (!answered(await o.getJson(new URL('/api/state', o.manorUrl).href))) {
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
  const results: EmployeeResult[] = [];
  if (ready.length) {
    const r = await (o.press ?? pressUpdate(o.manorUrl))(ready.map((s) => s.id)).catch((e: Error) => ({ ok: false, said: e.message }));
    for (const s of ready) {
      if (!r.ok) {
        block(s, 'refused', r.said);
        continue;
      }
      state.pressed[keyOf(s)] = at;
      delete state.blocked[s.id];
      state.settled = [{ id: s.id, name: s.name, version: s.version, at }, ...state.settled].slice(0, KEEP_SETTLED);
      o.log(`[${s.id}] Manor had given up updating ${s.name} to ${s.version}; its install would take it now, so the Steward pressed Update for it`);
      results.push({ id: s.id, name: s.name, outcome: 'done', message: `unstick: Manor had given up updating it to ${s.version}; its install would take it now, so the Steward pressed Update for it`, version: s.version });
    }
  }
  save();
  return results;
}

/** The alarms of the updates the Steward couldn't settle, in the dry run's words. At once: Manor has tried three times already. */
export function unstickConditions(state: UnstickState): Condition[] {
  return Object.entries(state.blocked).map(([id, b]) => {
    const on = b.installed ? `${b.name} stays on ${b.installed}` : `${b.name} isn't updated`;
    const detail =
      b.why === 'older'
        ? [`Manor's look found ${b.version}, but its install would still take an older release: ${b.said}.`, `${on}. The Steward runs the install's dry run again every half hour, and presses Update for it once it would take ${b.version}. Or press Update on Manor's page yourself.`]
        : b.why === 'failed'
          ? [`Manor's install couldn't name a release for it: ${b.said}`, `${on}. The Steward runs the install's dry run again every half hour, and presses Update for it once it would take ${b.version}. Or press Update on Manor's page yourself.`]
          : b.why === 'rolledBack'
            ? [`Its own installer refuses ${b.version}: ${b.said}, so it isn't installed again until it is allowed, and Manor's installs end on ${b.installed ?? 'the version before'}.`, `Its next version installs as usual. To have ${b.version} now, unpack its release (Manor keeps the zip in %USERPROFILE%\\.manor\\downloads\\${id}) and run node src\\cli.ts install --allow-unsafe in it. The Steward leaves a version that was rolled back to you.`]
          : b.why === 'refused'
            ? [`Manor didn't take the Steward's Update for it: ${b.said}`, `${on}. The Steward tries again in half an hour. Or press Update on Manor's page yourself.`]
            : [`The Steward pressed Update for it${b.pressedAt ? ` at ${b.pressedAt}` : ''}, when Manor's install would take ${b.version}, and Manor gave up on it again: ${b.said}.`, `The Steward presses Update only once for each version, so this one is yours: look at Manor's install log for why, then press Update on Manor's page.`];
    return { id: `unstick:${id}`, who: id, title: `Manor gave up updating ${b.name} to ${b.version}`, detail, since: b.since, afterMs: 0 };
  });
}
