import { execFile } from 'node:child_process';
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { APP, pageUrl } from './app.ts';
import { appFolder, defaultDeps, install, readRelease, replaceContents, TASK_NAME, type InstallDeps } from './kit/install.ts';
import { ping } from './kit/service.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';

/**
 * The Steward's install, behind a fail-safe. The rounds merge the Steward's own PRs and release them (stages/selfmerge.ts,
 * stages/self.ts), and Manor installs each release, so a broken change could take the Steward down with no one to put
 * it back. So an update of the installed copy:
 * 1. keeps the version it replaces whole beside it (app.prev), before anything changes;
 * 2. is installed as every agent installs (the kit's install.ts);
 * 3. is on probation for a while: its page must answer as the new version and keep answering (a look or two missed on
 *    a busy PC is forgiven), its home page too;
 * 4. failing any of that (the install itself failing once the new copy was in place included), is rolled back: the
 *    new copy set aside as app.unsafe-<version> for a look, the version before put back and started again, and the
 *    version flagged in unsafe-updates.json.
 * A flagged version is refused at once, nothing changed, by every install after (so Manor's automatic updates stop
 * after their few tries, and leave it for you), until you allow it again: Dismiss on its alarm, or
 * `node src\cli.ts allow-update <version>`. A newer version isn't flagged, and installs as usual.
 * An install that changed nothing (the old page wouldn't stop, the copy couldn't be made) flags nothing: it is
 * tried again. A first install has no version before it to go back to.
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
const LOOK_EVERY_MS = 5_000;
/**
 * How many looks in a row a page may miss before it has stopped answering. One ping can miss on a busy PC (each has
 * 2 s): 0.9.2 missed one, 83 s in, and was rolled back for it, though its page went on answering for hours.
 */
export const MISSES_ALLOWED = 3;

export interface SafeDeps extends InstallDeps {
  /** The kit's install of the release, as every agent's. */
  install(opts: { noStart?: boolean }): Promise<number>;
  /** The page's own answer to its ping: its version, or null when it doesn't answer. */
  pingVersion(): Promise<string | null>;
  /** The status of the page's home page, or null when it doesn't answer. */
  homePage(): Promise<number | null>;
  probationMs: number;
  /**
   * Ends the installed copy's page, whether or not it answers: the kit's shutdown, then its process, by server.json's
   * pid, when it's still there. True once it has gone. A page that has stopped answering may still hold the port.
   */
  endPage(): Promise<boolean>;
  copy(from: string, to: string): void;
  now(): number;
  record(u: Unsafe): void;
  flagged(): Record<string, Unsafe>;
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
 * Whether the new version holds up: its page answers as `version` for the whole probation, and its home page renders.
 * The reason when it doesn't.
 */
export async function probation(version: string, d: SafeDeps): Promise<string | null> {
  const start = d.now();
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
      if (status !== 200) return `its home page ${status === null ? "didn't answer" : `answered ${status}`}`;
      homeSeen = true;
    }
    if (d.now() - start >= d.probationMs) return null;
    await d.sleep(LOOK_EVERY_MS);
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
  let v: string | null = null;
  for (let waited = 0; waited < 20_000; waited += 500) {
    v = await d.pingVersion();
    if (v !== null && v === was) return v;
    await d.sleep(500);
  }
  return v;
}

export async function safeInstall(opts: { noStart?: boolean; dryRun?: boolean } = {}, d: SafeDeps = safeDeps()): Promise<number> {
  const { out } = d;
  const release = d.dev ? null : readRelease(d.root);
  // A checkout, not a release, or a dry run: the kit's install says what it says, and changes nothing.
  if (!release || opts.dryRun) return install(opts, d);
  const bad = d.flagged()[release.version];
  if (bad) {
    out(`${APP.name} ${release.version} was rolled back on ${bad.at.slice(0, 10)} (${bad.why}), so it isn't installed again until you allow it: Dismiss its alarm on the Steward's page, or node src\\cli.ts allow-update ${release.version}. Nothing was changed.`);
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
  const why = code !== 0 ? `its install failed (exit ${code}) once it was in place` : await probation(release.version, d);
  if (!why) {
    out(`${APP.name} ${release.version} held up for ${Math.round(d.probationMs / 1000)} s. ${before!.version} stays in ${prev}, to go back to by hand.`);
    return 0;
  }
  out(`${APP.name} ${release.version} failed: ${why}. Going back to ${before!.version}.`);
  const kept = `${app}.unsafe-${release.version}`;
  const answers = await rollBack(app, prev, kept, d);
  d.record({ version: release.version, from: before!.version, why, at: new Date(d.now()).toISOString(), kept: existsSync(kept) ? kept : null });
  const start = `start it with node ${path.win32.join(app, 'src', 'cli.ts')} open`;
  out(
    answers === before!.version
      ? `${APP.name} ${before!.version} is back, and its page is up: ${d.pageUrl}`
      : answers
        ? `${APP.name} ${before!.version} is back in ${app}, but its page answers as ${answers}: end that one (node ${path.win32.join(app, 'src', 'cli.ts')} shutdown), then ${start}`
        : `${APP.name} ${before!.version} is back in ${app}, but its page didn't answer: ${start}`,
  );
  out(`${release.version} is flagged as unsafe, and won't be installed again until you allow it.${existsSync(kept) ? ` Its copy is kept in ${kept} for a look.` : ''}`);
  return 1;
}

/** The real things: the kit's install and its deps, the page's ping, the clock and the flags in the data folder. */
export function safeDeps(): SafeDeps {
  const d = defaultDeps();
  return {
    ...d,
    install: (opts) => install(opts, d),
    pingVersion: async () => {
      const p = await ping();
      return p ? String(p.version ?? '') : null;
    },
    homePage: async () => {
      try {
        return (await fetch(pageUrl, { signal: AbortSignal.timeout(10_000) })).status;
      } catch {
        return null;
      }
    },
    probationMs: Number(process.env.STEWARD_PROBATION_MS) || PROBATION_MS,
    endPage: async () => {
      await d.shutdown();
      const pid = readJson<{ pid?: number } | null>(dataFile('server.json'), null)?.pid;
      if (typeof pid !== 'number' || pid === process.pid || !alive(pid)) return true;
      // server.json's pid may be stale, and Windows reuses pids: only a Node is ended.
      if (!(await isNode(pid))) return true;
      try {
        process.kill(pid);
      } catch {
        // Gone meanwhile, or not ours to end: alive() says which.
      }
      for (let i = 0; i < 40 && alive(pid); i++) await d.sleep(250);
      return !alive(pid);
    },
    copy: (from, to) => cpSync(from, to, { recursive: true }),
    now: () => Date.now(),
    record: (u) => writeJson(unsafeFile(), { ...loadUnsafe(), [u.version]: u }),
    flagged: loadUnsafe,
  };
}

/** install from the command line, behind the fail-safe; uninstall as the kit's. An unknown option is refused. */
export async function safeInstallCli(args: string[]): Promise<number> {
  const known = ['--no-start', '--dry-run'];
  const unknown = args.filter((a) => !known.includes(a));
  if (unknown.length) {
    console.error(`install: unknown ${unknown.join(' ')} (it takes ${known.join(' ')})`);
    return 2;
  }
  return safeInstall({ noStart: args.includes('--no-start'), dryRun: args.includes('--dry-run') });
}
