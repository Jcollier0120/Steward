import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, port } from '../app.ts';
import { flushTree } from './flush.ts';
import { appFolder, defaultDeps, install, readRelease, replaceContents, TASK_NAME, waitForPage, type InstallDeps } from './install.ts';
import { endProcesses, pagesFrom } from './native.ts';
import { compareVersions } from './update-hold.ts';
import { ping } from './service.ts';
import { dataFile, readJson, writeJson } from './store.ts';

/**
 * Every agent's install, behind a fail-safe (kit 2.51.0; the Steward's own since its 0.9). Manor installs each release
 * by itself, so a broken change could take an agent down with no one to put it back. So an update of the installed copy:
 * 1. keeps the version it replaces whole beside it (app.prev), before anything changes;
 * 2. is installed as every agent installs (the kit's install.ts);
 * 3. is on probation for a while: its page must answer as the new version and keep answering (a look or two missed on
 *    a busy PC is forgiven), its home page too;
 * 4. failing any of that (the install itself failing once the new copy was in place included), is rolled back: the
 *    new copy set aside as app.unsafe-<version> for a look, the version before put back and started again, and the
 *    version flagged in unsafe-updates.json.
 * A flagged version is refused at once, nothing changed, by every install after (so Manor's automatic updates stop
 * after their few tries), until it is allowed again: `install --allow-unsafe` from the release, or the agent's own way
 * (the Steward's: Dismiss on its alarm). A newer version isn't flagged, and installs as usual; once it holds up, the
 * flags of the versions before it are dropped (kit 2.75.2).
 * An install that changed nothing (the old page wouldn't stop, the copy couldn't be made) flags nothing: it is
 * tried again. A first install has no version before it to go back to.
 *
 * The install waits only for the probation's start (kit 2.52.0): the new page up, answering as the new version and its
 * home page rendering, for SETTLE_MS. The rest is watched by a process of its own (`install --watch-probation`, no
 * window), which goes back and flags just the same if the page stops answering. So Manor's update pass, which installs
 * one agent after another, waits seconds for each, not the whole probation. `--wait` (or a watcher that can't start)
 * waits for all of it here, as before.
 */

export const unsafeFile = () => dataFile('unsafe-updates.json');

export interface Unsafe {
  version: string;
  /** The version it was rolled back to. */
  from: string | null;
  why: string;
  at: string;
  /** Where the failed copy is kept for a look. */
  kept: string | null;
}

export const loadUnsafe = (): Record<string, Unsafe> => readJson<Record<string, Unsafe>>(unsafeFile(), {});

/** Allows a flagged version to be installed again; false when it wasn't flagged. */
export function allowUpdate(version: string): boolean {
  const all = loadUnsafe();
  if (!(version in all)) return false;
  delete all[version];
  writeJson(unsafeFile(), all);
  return true;
}

/** The alarm's id for a flagged version; dismissing it allows the version again (agent.ts). */
export const unsafeAlarmId = (version: string) => `unsafe:${version}`;

/** How long a new version must keep answering before the update counts as done. */
export const PROBATION_MS = 90_000;
/** How much of it the install itself waits for (kit 2.52.0): the rest is watched in the background. */
export const SETTLE_MS = 15_000;
const LOOK_EVERY_MS = 5_000;
/**
 * How many looks in a row a page may miss before it has stopped answering. One ping can miss on a busy PC (each has
 * 2 s): 0.9.2 missed one, 83 s in, and was rolled back for it, though its page went on answering for hours.
 */
export const MISSES_ALLOWED = 3;

export interface SafeDeps extends InstallDeps {
  /** How a flagged version is allowed again, said when one is refused. */
  allowHint?: (version: string) => string;
  /** The kit's install of the release, as every agent's. */
  install(opts: { noStart?: boolean }): Promise<number>;
  /** The page's own answer to its ping: its version, or null when it doesn't answer. */
  pingVersion(): Promise<string | null>;
  /** The status of the page's home page, or null when it doesn't answer. */
  homePage(): Promise<number | null>;
  probationMs: number;
  /**
   * Ends the installed copy's page, whether or not it answers: the kit's shutdown, then its process, by server.json's
   * pid, when it's still there, and any page process still starting from app (kit 2.75.2). True once they have gone.
   * A page that has stopped answering may still hold the port.
   */
  endPage(): Promise<boolean>;
  copy(from: string, to: string): void;
  now(): number;
  record(u: Unsafe): void;
  flagged(): Record<string, Unsafe>;
  /**
   * Starts the rest of the probation in a process of its own (`install` with these arguments, from the new copy), so
   * the install can return: true once it says it is watching (watchingFile), false when it didn't. Without it, the
   * install waits for the whole probation.
   */
  watch?(args: string[]): Promise<boolean>;
}

/** A probation watcher's word that it is watching: its version and pid, while it does (removed once it's done). */
export const watchingFile = () => dataFile('probation.json');
interface Watching {
  version: string;
  pid: number;
  since: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Whether the process is a Node (tasklist's image name), so a pid Windows has given to another program is left alone. */
async function isNode(pid: number): Promise<boolean> {
  const out = await new Promise<string>((resolve) =>
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10_000 }, (_e, stdout) => resolve(String(stdout ?? ''))),
  );
  return /^"node(\.exe)?",/im.test(out.trim());
}

/** Whether a process is still there (signal 0 only checks), as the kit's service.ts asks. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function moveWithRetries(from: string, to: string, d: SafeDeps): Promise<void> {
  const rename = d.rename ?? renameSync;
  for (let tries = 1; ; tries++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      if (tries >= 30 || !['EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await d.sleep(500);
    }
  }
}

/**
 * Whether the new version holds up: its page answers as `version` until `ms` after `since` (now, and the whole
 * probation, unless said), and its home page renders. The reason when it doesn't, timed from `since`.
 *
 * A home page that answers with an error fails at once. One that doesn't answer at all is asked again at each look
 * (kit 2.69.1), and fails only when it hasn't rendered by the end: its ping answers, so its process is up, and a first
 * render can wait on something slow. `homeLater`: the end isn't this one's to judge, as the install's own settling
 * hands the rest to a watcher, which asks again.
 */
export async function probation(version: string, d: SafeDeps, o: { ms?: number; since?: number; homeLater?: boolean } = {}): Promise<string | null> {
  const start = o.since ?? d.now();
  const ms = o.ms ?? d.probationMs;
  let homeSeen = false;
  let missedAt: number | null = null;
  let misses = 0;
  for (;;) {
    const v = await d.pingVersion();
    if (v === null) {
      missedAt ??= d.now();
      if (++misses >= MISSES_ALLOWED) return `its page stopped answering ${Math.round((missedAt - start) / 1000)} s into its probation`;
      await d.sleep(LOOK_EVERY_MS);
      continue;
    }
    missedAt = null;
    misses = 0;
    if (v !== version) return `its page answers as ${v}, not ${version}`;
    if (!homeSeen) {
      const status = await d.homePage();
      if (status !== null && status !== 200) return `its home page answered ${status}`;
      homeSeen = status === 200;
    }
    // The same words as before 2.69.1, which the Steward's retry of such rollbacks reads.
    if (d.now() - start >= ms) return homeSeen || o.homeLater ? null : "its home page didn't answer";
    await d.sleep(LOOK_EVERY_MS);
  }
}

/**
 * Where the probation asks for the home page (kit 2.69.1): 127.0.0.1, as the ping does, never the page's
 * <agent>.localhost name. Windows doesn't name *.localhost itself: it asks the network's DNS server (a home router
 * answers 127.0.0.1), so while the network is down the name doesn't resolve, and a page that was up was rolled back
 * (2026-10-13: seven agents, in the minute the router stopped answering). The page's server takes 127.0.0.1 as its host.
 */
export const homePageUrl = (at: number = port) => `http://127.0.0.1:${at}/`;

/** The status of the page's home page, or null when it doesn't answer within `ms`. */
export async function homePageStatus(url = homePageUrl(), ms = 10_000): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
}

/**
 * The version before, put back in app and started: what its page answers as then (null for nothing). The new page is
 * ended first whether it answers or not: one that has stopped answering may still be running and hold the port, and
 * the old one, started beside it, would find a page up and leave it be (0.9.2 went on running from 0.9.1's files).
 */
async function rollBack(app: string, prev: string, kept: string, d: SafeDeps): Promise<string | null> {
  if (!(await d.endPage())) d.out("The new version's page wouldn't end: going back all the same.");
  rmSync(kept, { recursive: true, force: true });
  try {
    if (existsSync(app)) await moveWithRetries(app, kept, d);
    await moveWithRetries(prev, app, d);
  } catch {
    // Something holds app open (a shell in it): its contents are put back instead, and the failed copy is lost.
    replaceContents(prev, app);
  }
  const ran = await d.schtasks(['/Run', '/TN', TASK_NAME]);
  if (ran.code !== 0) return null;
  const was = readRelease(app)?.version;
  // Waited for as an install waits for its page (kit 2.75.2): a busy PC's slow start isn't taken for none.
  let v = null as string | null;
  await waitForPage(async () => (v = await d.pingVersion()) !== null, app, d);
  // A page answering as another version a moment after the swap is given the 20 s it always was to become this one.
  for (let waited = 0; v !== null && v !== was && waited < 20_000; waited += 500) {
    await d.sleep(500);
    v = await d.pingVersion();
  }
  return v;
}

const defaultAllowHint = () => 'install it again with --allow-unsafe (node src\\cli.ts install --allow-unsafe, in the release)';

/**
 * A version that failed its probation: the one before put back and started, the failed copy kept, the version flagged,
 * and what happened said. Exit 1.
 */
async function goBack(version: string, from: string, why: string, d: SafeDeps): Promise<number> {
  const { out } = d;
  const app = appFolder(d.dataDir);
  out(`${APP.name} ${version} failed: ${why}. Going back to ${from}.`);
  const kept = `${app}.unsafe-${version}`;
  const answers = await rollBack(app, `${app}.prev`, kept, d);
  d.record({ version, from, why, at: new Date(d.now()).toISOString(), kept: existsSync(kept) ? kept : null });
  const start = `start it with node ${path.win32.join(app, 'src', 'cli.ts')} open`;
  out(
    answers === from
      ? `${APP.name} ${from} is back, and its page is up: ${d.pageUrl}`
      : answers
        ? `${APP.name} ${from} is back in ${app}, but its page answers as ${answers}: end that one (node ${path.win32.join(app, 'src', 'cli.ts')} shutdown), then ${start}`
        : `${APP.name} ${from} is back in ${app}, but its page didn't answer: ${start}`,
  );
  out(`${version} is flagged as unsafe, and won't be installed again until you allow it.${existsSync(kept) ? ` Its copy is kept in ${kept} for a look.` : ''}`);
  return 1;
}

/**
 * The rest of an update's probation, in a process of its own (`install --watch-probation <version> --from <before>
 * --since <ms>`, kit 2.52.0): the page watched until the probation's end, counted from `since`, and the version before
 * put back if it stops holding up. Only the update it was started for: once another version is in app, or the one
 * before isn't the one in app.prev any more (a later install, or one by hand), it's left alone.
 */
export async function watchProbation(version: string, from: string, since: number, d: SafeDeps): Promise<number> {
  const app = appFolder(d.dataDir);
  const why = d.now() - since < d.probationMs ? await probation(version, d, { since }) : null;
  if (!why) {
    dropOlderFlags(version, d);
    d.out(`${APP.name} ${version} held up for ${Math.round(d.probationMs / 1000)} s. ${from} stays in ${app}.prev, to go back to by hand.`);
    return 0;
  }
  if (readRelease(app)?.version !== version || readRelease(`${app}.prev`)?.version !== from) {
    d.out(`${APP.name} ${version} ${why}, but another install has changed ${app} since: it is left as it is.`);
    return 0;
  }
  return goBack(version, from, why, d);
}

/**
 * Once a version has held up for its probation, the versions before it that were flagged are allowed again (kit
 * 2.75.2): Manor never installs an older one, and an agent's alarm for one (the Steward's) would stay up for nothing.
 * Their kept copies (app.unsafe-<version>) stay for a look.
 */
function dropOlderFlags(version: string, d: SafeDeps): void {
  for (const v of Object.keys(d.flagged())) {
    if (compareVersions(v, version) < 0 && allowUpdate(v)) d.out(`${v} was flagged as unsafe: no longer, since ${version}, newer, holds up.`);
  }
}

export async function safeInstall(opts: { noStart?: boolean; dryRun?: boolean; allowUnsafe?: boolean; wait?: boolean } = {}, d: SafeDeps = safeDeps()): Promise<number> {
  const { out } = d;
  const release = d.dev ? null : readRelease(d.root);
  // A checkout, not a release, or a dry run: the kit's install says what it says, and changes nothing.
  if (!release || opts.dryRun) return install(opts, d);
  if (opts.allowUnsafe && allowUpdate(release.version)) out(`${APP.name} ${release.version} is allowed again, as asked.`);
  const bad = d.flagged()[release.version];
  if (bad) {
    out(`${APP.name} ${release.version} was rolled back on ${bad.at.slice(0, 10)} (${bad.why}), so it isn't installed again until it is allowed: ${(d.allowHint ?? defaultAllowHint)(release.version)}. A newer version installs as usual. Nothing was changed.`);
    return 3;
  }
  const app = appFolder(d.dataDir);
  const before = existsSync(app) ? readRelease(app) : null;
  const prev = `${app}.prev`;
  // The version it replaces, kept whole first: no copy, no update.
  const guarded = !!before && before.version !== release.version && !opts.noStart;
  if (guarded) {
    try {
      rmSync(prev, { recursive: true, force: true });
      d.copy(app, prev);
    } catch (e) {
      rmSync(prev, { recursive: true, force: true });
      out(`Couldn't keep ${before!.version} in ${prev} to go back to (${message(e)}), so nothing was changed.`);
      return 1;
    }
  }
  const code = await d.install(opts);
  if (!guarded) return code;

  const now = readRelease(app);
  if (code !== 0 && now && now.version !== release.version) {
    // The kit's install left the installed copy as it was: nothing to go back from, and nothing to flag.
    rmSync(prev, { recursive: true, force: true });
    return code;
  }
  const from = before!.version;
  // Its page answering as the new version by now, though the install gave up waiting for it (a busy PC's slow start),
  // is no failed install: its probation judges it, as any other's (kit 2.75.2). The Steward's 0.36.46 was rolled back
  // and flagged for answering late, and went on running over 0.36.42's files.
  if (code !== 0 && (await d.pingVersion()) === release.version) out(`${APP.name} ${release.version}'s page answered late, after the install had stopped waiting for it (the PC is busy): its probation goes on.`);
  else if (code !== 0) return goBack(release.version, from, `its install failed (exit ${code}) once it was in place`, d);
  // Its start waited for here; the rest, in the background, when a watcher can take it (kit 2.52.0).
  const since = d.now();
  const background = !opts.wait && !!d.watch && d.probationMs > SETTLE_MS;
  const why = await probation(release.version, d, { since, ms: background ? SETTLE_MS : d.probationMs, homeLater: background });
  if (why) return goBack(release.version, from, why, d);
  if (background) {
    if (await d.watch!(['--watch-probation', release.version, '--from', from, '--since', String(since)])) {
      out(`${APP.name} ${release.version} is up and answering. The rest of its ${Math.round(d.probationMs / 1000)} s probation is watched in the background: if it stops answering, ${from} is put back.`);
      return 0;
    }
    // No watcher: the rest is waited for here, as before 2.52.0.
    const late = await probation(release.version, d, { since });
    if (late) return goBack(release.version, from, late, d);
  }
  dropOlderFlags(release.version, d);
  out(`${APP.name} ${release.version} held up for ${Math.round(d.probationMs / 1000)} s. ${from} stays in ${prev}, to go back to by hand.`);
  return 0;
}

/**
 * Ends the page processes still starting from `app` (kit 2.75.2), and the `open` starting them, as the real endPage
 * does after the kit's shutdown and server.json's pid: a page still starting has no server.json of its own yet, and
 * would come up over the version a rollback puts back in app. The Steward's 0.36.46 did, and ran over 0.36.42's files.
 * This process is never one of them. True once none is left.
 */
export async function endStartingPages(
  app: string,
  d: { pagesStarting(app: string): Promise<number[]>; endPrograms(ids: number[]): Promise<void>; sleep(ms: number): Promise<void> },
): Promise<boolean> {
  const starting = async () => (await d.pagesStarting(app)).filter((id) => id !== process.pid);
  let left = await starting();
  if (!left.length) return true;
  await d.endPrograms(left);
  for (let i = 0; i < 10 && left.length; i++) {
    await d.sleep(1000);
    left = await starting();
  }
  return !left.length;
}

/** The real things: the kit's install and its deps, the page's ping, the clock and the flags in the data folder. */
export function safeDeps(): SafeDeps {
  const d = defaultDeps();
  const pagesStarting = d.pagesStarting ?? (async (app: string) => pagesFrom(app));
  return {
    ...d,
    install: (opts) => install(opts, d),
    pingVersion: async () => {
      const p = await ping();
      return p ? String(p.version ?? '') : null;
    },
    homePage: () => homePageStatus(),
    probationMs: Number(process.env.KIT_PROBATION_MS || process.env.STEWARD_PROBATION_MS) || PROBATION_MS,
    endPage: async () => {
      await d.shutdown();
      const pid = readJson<{ pid?: number } | null>(dataFile('server.json'), null)?.pid;
      // server.json's pid may be stale, and Windows reuses pids: only a Node is ended.
      if (typeof pid === 'number' && pid !== process.pid && alive(pid) && (await isNode(pid))) {
        try {
          process.kill(pid);
        } catch {
          // Gone meanwhile, or not ours to end: alive() says which.
        }
        for (let i = 0; i < 40 && alive(pid); i++) await d.sleep(250);
        if (alive(pid)) return false;
      }
      return endStartingPages(appFolder(d.dataDir), { pagesStarting, endPrograms: async (ids) => endProcesses(ids), sleep: d.sleep });
    },
    // app.prev on the disk, as the release is before its swap (kit 2.73.3): what a rollback after a crash puts back.
    copy: (from, to) => {
      cpSync(from, to, { recursive: true });
      flushTree(to);
    },
    now: () => Date.now(),
    record: (u) => writeJson(unsafeFile(), { ...loadUnsafe(), [u.version]: u }),
    flagged: loadUnsafe,
    // From the new copy, working in the user's folder (never in app, which a rollback moves, nor the data folder), with
    // no window and nothing tying it to the install that started it: Manor's update pass goes on to the next agent.
    watch: async (args) => {
      let pid: number | undefined;
      try {
        const child = spawn(process.execPath, [path.join(appFolder(d.dataDir), 'src', 'cli.ts'), 'install', ...args], { cwd: os.homedir(), detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => {});
        child.unref();
        pid = child.pid;
      } catch {
        return false;
      }
      if (typeof pid !== 'number') return false;
      // Started is not watching: a copy that can't run its watcher would leave the rest unwatched, so it must say so.
      for (let waited = 0; waited < 10_000; waited += 250) {
        const w = readJson<Watching | null>(watchingFile(), null);
        if (w?.pid === pid && w.version === args[1]) return true;
        if (!alive(pid)) return false;
        await d.sleep(250);
      }
      return false;
    },
  };
}

/** Where a probation watcher, which has no console, says what it did: the last lines kept, never more. */
export const watchLogFile = () => dataFile('probation.log');
const WATCH_LOG_LINES = 200;

function watchLog(line: string): void {
  const file = watchLogFile();
  try {
    const old = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
    writeFileSync(file, [...old, `${new Date().toISOString()} ${line}`].slice(-WATCH_LOG_LINES).join('\n') + '\n');
  } catch {
    // A log that can't be written changes nothing of the watch.
  }
}

/** install from the command line, behind the fail-safe. An unknown option is refused, so a mistyped --dry-run never installs. */
export async function safeInstallCli(args: string[], d?: Partial<SafeDeps>): Promise<number> {
  // The rest of an update's probation, started by the install itself (kit 2.52.0): not one for people to type.
  if (args[0] === '--watch-probation') {
    const [, version, fromFlag, from, sinceFlag, since] = args;
    if (args.length !== 6 || !version || fromFlag !== '--from' || !from || sinceFlag !== '--since' || !Number.isFinite(Number(since))) {
      console.error('install --watch-probation <version> --from <version before> --since <ms>');
      return 2;
    }
    writeJson(watchingFile(), { version, pid: process.pid, since: Number(since) } satisfies Watching);
    try {
      return await watchProbation(version, from, Number(since), { ...safeDeps(), out: watchLog, ...d });
    } finally {
      if (readJson<Watching | null>(watchingFile(), null)?.pid === process.pid) rmSync(watchingFile(), { force: true });
    }
  }
  const known = ['--no-start', '--dry-run', '--allow-unsafe', '--wait'];
  const unknown = args.filter((a) => !known.includes(a));
  if (unknown.length) {
    console.error(`install: unknown ${unknown.join(' ')} (it takes ${known.join(' ')})`);
    return 2;
  }
  return safeInstall(
    { noStart: args.includes('--no-start'), dryRun: args.includes('--dry-run'), allowUnsafe: args.includes('--allow-unsafe'), wait: args.includes('--wait') },
    { ...safeDeps(), ...d },
  );
}
