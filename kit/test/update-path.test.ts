import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { freePort } from './free-port.ts';

// An update's whole path: the kit's own install behind its fail-safe (safeinstall.ts), over real folders. The new
// version on probation, the one before put back when it fails, and the layouts an older kit leaves beside app. Task
// Scheduler and the page stand in, and the clock moves only as the install waits: no test sleeps.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'update-path-test-'));
process.env.FIXTURE_HOME = path.join(tmp, 'own-home');
process.env.FIXTURE_PORT = String(await freePort());
// Where the agent keeps unsafe-updates.json (store.ts dataFile).
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

const { APP } = await import('./fixture/src/app.ts');
const { appFolder, install, uninstall } = await import('./fixture/src/kit/install.ts');
const { loadUnsafe, safeInstall, unsafeFile, watchProbation } = await import('./fixture/src/kit/safeinstall.ts');
type SafeDeps = import('./fixture/src/kit/safeinstall.ts').SafeDeps;

const KIT = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
/** A kit whose install kept the version before in app.prev until the next update (2.51.0 to 2.96.1). */
const KEPT_PREV = '2.95.0';
/** A kit from before the fail-safe: its install only swapped (app, app.new, app.old). */
const SWAP_ONLY = '2.50.0';

/** A copy of the agent at `version`, built with `kit`: its release.json, and a cli that says which it is. */
function copyOf(dir: string, version: string, kit: string) {
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ id: APP.id, name: APP.name, version, commit: 'abc1234', dirty: false, built: '2026-10-22T00:00:00.000Z', kit }));
  writeFileSync(path.join(dir, 'src', 'cli.ts'), `// ${version}\n`);
}
const versionIn = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8')).version;

beforeEach(() => rmSync(unsafeFile(), { force: true }));

let n = 0;
/**
 * An installed copy of `installed`, built with an older `kit`, its page up, and a release of `next` built with this kit
 * to update it to. The new version's page stops answering `failsAt` ms after its task starts it (none: it holds up).
 * As on Windows, the task's /Run starts nothing while a page runs.
 */
function updating(o: { installed: string; kit: string; next: string; failsAt?: number; onDuty?: boolean }) {
  const dir = path.join(tmp, `case-${++n}`);
  const data = path.join(dir, `.${APP.id}`);
  const app = appFolder(data);
  const root = path.join(dir, 'unpacked');
  copyOf(app, o.installed, o.kit);
  copyOf(root, o.next, KIT);
  const dutyFile = path.join(data, 'duty.json');
  writeFileSync(dutyFile, JSON.stringify({ onDuty: o.onDuty ?? true, since: '2026-10-01T00:00:00.000Z' }));
  let t = 0;
  let ranAt = 0;
  /** The version whose page runs; '' for none. */
  let running = o.installed;
  const lines: string[] = [];
  const dutySets: boolean[] = [];
  const watched: string[][] = [];
  const d: SafeDeps = {
    root,
    dev: false,
    dataDir: data,
    node: 'C:\\Program Files\\nodejs\\node.exe',
    user: 'PC\\pat',
    userSid: async () => 'S-1-5-21-1111-2222-3333-1001',
    pageUrl: `http://${APP.id}.localhost:1/`,
    home: dir,
    schtasks: async (args) => {
      if (args[0] === '/Query') return { code: 1, out: 'ERROR: The system cannot find the file specified.' };
      if (args[0] === '/Run' && !running && existsSync(app)) {
        running = versionIn(app);
        ranAt = t;
      }
      return { code: 0, out: 'SUCCESS' };
    },
    ping: async () => (await d.pingVersion()) !== null,
    shutdown: async () => {
      running = '';
      return 0;
    },
    onDuty: () => JSON.parse(readFileSync(dutyFile, 'utf8')).onDuty !== false,
    setDuty: (on) => {
      dutySets.push(on);
      writeFileSync(dutyFile, JSON.stringify({ onDuty: on, since: '2026-10-22T00:00:00.000Z' }));
    },
    sleep: async (ms) => {
      t += ms;
    },
    out: (line) => lines.push(line),
    pagesStarting: async () => [],
    install: (opts) => install(opts, d),
    pingVersion: async () => (!running || (running === o.next && o.failsAt !== undefined && t - ranAt >= o.failsAt) ? null : running),
    homePage: async () => (running ? 200 : null),
    probationMs: 30_000,
    endPage: async () => {
      running = '';
      return true;
    },
    copy: (from, to) => cpSync(from, to, { recursive: true }),
    now: () => t,
    record: (u) => writeFileSync(unsafeFile(), JSON.stringify({ ...loadUnsafe(), [u.version]: u })),
    flagged: loadUnsafe,
  };
  return { d, data, app, root, lines, dutySets, watched, running: () => running, said: () => lines.join('\n') };
}

test('an older kit updating to this one: the new version holds up, and nothing of the old layout is left beside app', async () => {
  // What older kits left: the version before the last update, kept until the next (2.51.0 to 2.96.1), a rolled-back
  // version's copy and flag, and an app.old a swap-only kit couldn't remove (a file in it was still open).
  const u = updating({ installed: '1.4.0', kit: KEPT_PREV, next: '1.5.0' });
  copyOf(`${u.app}.prev`, '1.3.0', KEPT_PREV);
  copyOf(`${u.app}.old`, '1.2.0', SWAP_ONLY);
  copyOf(`${u.app}.unsafe-1.3.5`, '1.3.5', KEPT_PREV);
  writeFileSync(unsafeFile(), JSON.stringify({ '1.3.5': { version: '1.3.5', from: '1.3.0', why: 'its home page answered 500', at: '2026-10-10T12:00:00.000Z', kept: `${u.app}.unsafe-1.3.5` } }));
  let prevOnProbation: string | null = null;
  const home = u.d.homePage;
  u.d.homePage = async () => ((prevOnProbation ??= versionIn(`${u.app}.prev`)), home());

  assert.equal(await safeInstall({}, u.d), 0, u.said());
  assert.equal(versionIn(u.app), '1.5.0');
  assert.equal(u.running(), '1.5.0');
  assert.equal(prevOnProbation, '1.4.0', 'on probation, the version it replaced is the one kept to go back to');
  for (const left of ['prev', 'old', 'new']) assert.ok(!existsSync(`${u.app}.${left}`), `app.${left} is gone`);
  assert.deepEqual(u.dutySets, [], 'duty as it was');
  assert.deepEqual(loadUnsafe(), {}, "the older version's flag is dropped once a newer one holds up (kit 2.75.2)");
  assert.equal(versionIn(`${u.app}.unsafe-1.3.5`), '1.3.5', 'its copy stays for a look, until uninstall');
  assert.match(u.said(), /1\.5\.0 held up for 30 s, so 1\.4\.0, kept in .*app\.prev to go back to, is removed\./);
});

test("a new version that stops answering on probation goes back to the older kit's copy, is recorded, and isn't tried again; a newer one is", async () => {
  const u = updating({ installed: '1.4.0', kit: KEPT_PREV, next: '1.5.0', failsAt: 10_000 });
  assert.equal(await safeInstall({}, u.d), 1);
  assert.equal(versionIn(u.app), '1.4.0', 'the version before, back in app');
  assert.equal(readFileSync(path.join(u.app, 'src', 'cli.ts'), 'utf8'), '// 1.4.0\n');
  assert.equal(u.running(), '1.4.0', 'and started again');
  assert.equal(versionIn(`${u.app}.unsafe-1.5.0`), '1.5.0', 'the failed copy kept for a look');
  assert.ok(!existsSync(`${u.app}.prev`));
  // The record Manor and the Steward show: in the agent's home, what failed, when, why, and what it went back to.
  assert.equal(path.dirname(unsafeFile()), process.env.FIXTURE_HOME);
  const flag = loadUnsafe()['1.5.0'];
  assert.equal(flag.from, '1.4.0');
  assert.match(flag.why, /^its page stopped answering 10 s into its probation/);
  assert.ok(!Number.isNaN(Date.parse(flag.at)));
  assert.equal(flag.kept, `${u.app}.unsafe-1.5.0`);
  assert.match(u.said(), /1\.4\.0 is back, and its page is up/);

  // The same release again (Manor's next try): refused at once, nothing touched, its page left running.
  u.lines.length = 0;
  assert.equal(await safeInstall({}, u.d), 3);
  assert.equal(versionIn(u.app), '1.4.0');
  assert.equal(u.running(), '1.4.0');
  assert.match(u.said(), /1\.5\.0 was rolled back on \d{4}-\d\d-\d\d \(its page stopped answering.*A newer version installs as usual\. Nothing was changed\./);

  // A newer release installs as usual, and holding up, allows the one it replaced again.
  copyOf(u.root, '1.5.1', KIT);
  assert.equal(await safeInstall({}, u.d), 0, u.said());
  assert.equal(versionIn(u.app), '1.5.1');
  assert.deepEqual(loadUnsafe(), {});
  assert.ok(!existsSync(`${u.app}.prev`));
});

test("a new version whose page never answers after the swap is rolled back too, in the words the Steward's retry reads", async () => {
  const u = updating({ installed: '1.4.0', kit: SWAP_ONLY, next: '1.5.0', failsAt: 0 });
  assert.equal(await safeInstall({}, u.d), 1);
  assert.equal(versionIn(u.app), '1.4.0');
  assert.equal(u.running(), '1.4.0');
  assert.equal(loadUnsafe()['1.5.0'].why, 'its install failed (exit 1) once it was in place');
});

test("an unfinished swap an older kit left (app missing, the installed copy in app.old) is put back, and updated as the update it is", async () => {
  // The PC went off between moving app aside and moving the release in: the page is down, the agent off duty.
  const u = updating({ installed: '1.4.0', kit: SWAP_ONLY, next: '1.5.0', onDuty: false });
  renameSync(u.app, `${u.app}.old`);
  mkdirSync(`${u.app}.new`);
  writeFileSync(path.join(`${u.app}.new`, 'half.ts'), '');
  await u.d.endPage();

  // A dry run says so, and changes nothing.
  assert.equal(await safeInstall({ dryRun: true }, u.d), 0);
  assert.match(u.said(), /would update the installed copy \(1\.4\.0\)[\s\S]*0\. Put 1\.4\.0 back in .*app from .*app\.old/);
  assert.ok(!existsSync(u.app) && existsSync(`${u.app}.old`));

  u.lines.length = 0;
  let prevOnProbation: string | null = null;
  const home = u.d.homePage;
  u.d.homePage = async () => ((prevOnProbation ??= versionIn(`${u.app}.prev`)), home());
  assert.equal(await safeInstall({}, u.d), 0, u.said());
  assert.match(u.lines[0], /app was missing: an earlier install never finished its swap\. 1\.4\.0, which it had moved aside to .*app\.old, is back in /);
  assert.equal(versionIn(u.app), '1.5.0');
  assert.equal(prevOnProbation, '1.4.0', 'guarded as any update: the version before kept until the new one held up');
  for (const left of ['prev', 'old', 'new']) assert.ok(!existsSync(`${u.app}.${left}`), `app.${left} is gone`);
  assert.deepEqual(u.dutySets, [], 'not taken for a first install, which would have put it on duty');
  assert.equal(u.d.onDuty(), false);
  assert.match(u.said(), /updated from 1\.4\.0/);

  // Refused as flagged, it is put back all the same: the agent can start again.
  const r = updating({ installed: '1.4.0', kit: SWAP_ONLY, next: '1.5.0' });
  renameSync(r.app, `${r.app}.old`);
  writeFileSync(unsafeFile(), JSON.stringify({ '1.5.0': { version: '1.5.0', from: '1.4.0', why: 'its home page answered 500', at: '2026-10-21T12:00:00.000Z', kept: null } }));
  assert.equal(await safeInstall({}, r.d), 3);
  assert.equal(versionIn(r.app), '1.4.0');
  assert.ok(!existsSync(`${r.app}.old`));

  // The kit's install on its own does the same.
  const k = updating({ installed: '1.4.0', kit: SWAP_ONLY, next: '1.5.0', onDuty: false });
  renameSync(k.app, `${k.app}.old`);
  assert.equal(await install({}, k.d), 0, k.said());
  assert.equal(versionIn(k.app), '1.5.0');
  assert.deepEqual(k.dutySets, []);
});

test('the watcher of a probation removes app.prev once the new version holds up, and goes back with it when it fails', async () => {
  const u = updating({ installed: '1.4.0', kit: KEPT_PREV, next: '1.5.0' });
  u.d.watch = async (args) => (u.watched.push(args), true);
  assert.equal(await safeInstall({}, u.d), 0, u.said());
  assert.equal(versionIn(`${u.app}.prev`), '1.4.0', 'kept while the watcher watches');
  const [, version, , from, , since] = u.watched[0];
  assert.equal(await watchProbation(version, from, Number(since), u.d), 0);
  assert.ok(!existsSync(`${u.app}.prev`));

  const f = updating({ installed: '1.4.0', kit: KEPT_PREV, next: '1.5.0', failsAt: 20_000 });
  f.d.watch = async (args) => (f.watched.push(args), true);
  assert.equal(await safeInstall({}, f.d), 0, 'settled before it fails');
  const [, v, , fr, , s] = f.watched[0];
  assert.equal(await watchProbation(v, fr, Number(s), f.d), 1);
  assert.equal(versionIn(f.app), '1.4.0');
  assert.equal(f.running(), '1.4.0');
  assert.match(loadUnsafe()['1.5.0'].why, /its page stopped answering 20 s into its probation/);
});

test('uninstall removes the copies updates kept beside app (app.prev, app.unsafe-<version>), and keeps the data', async () => {
  const u = updating({ installed: '1.4.0', kit: KEPT_PREV, next: '1.5.0' });
  copyOf(`${u.app}.prev`, '1.3.0', KEPT_PREV);
  copyOf(`${u.app}.unsafe-1.3.5`, '1.3.5', KEPT_PREV);
  writeFileSync(path.join(u.data, 'state.json'), '{}');

  assert.equal(await uninstall({ dryRun: true }, u.d), 0);
  assert.match(u.said(), /and the copies its updates kept beside it \(app\.prev, app\.unsafe-1\.3\.5\)/);
  assert.ok(existsSync(`${u.app}.prev`), 'a dry run removes nothing');

  u.lines.length = 0;
  assert.equal(await uninstall({}, u.d), 0, u.said());
  for (const gone of [u.app, `${u.app}.prev`, `${u.app}.unsafe-1.3.5`]) assert.ok(!existsSync(gone), gone);
  assert.ok(existsSync(path.join(u.data, 'state.json')), 'the data stays');
  assert.match(u.said(), /Removed the copies its updates kept beside it: app\.prev, app\.unsafe-1\.3\.5\./);
});
