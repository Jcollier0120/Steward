import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Steward's install behind its fail-safe: the version before kept, the new one on probation, and one that
// doesn't hold up rolled back, flagged, and refused until allowed again. Real folders; the kit's install, the page
// and Task Scheduler stand in.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-safeinstall-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { allowUpdate, loadUnsafe, safeInstall, unsafeFile } = await import('../src/safeinstall.ts');
const { roundConditions } = await import('../src/alarms.ts');
type SafeDeps = import('../src/safeinstall.ts').SafeDeps;

const release = (dir: string, version: string) => {
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ id: 'steward', name: 'Steward', version, commit: 'abc1234', dirty: false, built: '2026-10-05T00:00:00Z' }));
  writeFileSync(path.join(dir, 'src', 'cli.ts'), `// ${version}\n`);
};
const versionIn = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8')).version;

let n = 0;
/**
 * An installed 0.8.13 and a release of 0.8.14 to install; `page` says what 0.8.14's page answers as, by moment (null:
 * it doesn't answer, though its process runs on and holds the port). As on Windows, Task Scheduler's /Run starts
 * nothing while a page is running, and a page that doesn't answer stops only when its process is ended.
 */
function setup(o: { installCode?: number; page?: (t: number) => string | null; homeStatus?: number | null; installLeaves?: 'new' | 'old' } = {}) {
  const dir = path.join(home, `case-${++n}`);
  const dataDir = path.join(dir, 'data');
  const app = path.join(dataDir, 'app');
  const root = path.join(dir, 'release');
  release(app, '0.8.13');
  release(root, '0.8.14');
  let t = 0;
  let running = '0.8.13';
  const said: string[] = [];
  const tasks: string[][] = [];
  const ended: string[] = [];
  const d: SafeDeps = {
    root,
    dev: false,
    dataDir,
    node: process.execPath,
    user: 'PC\\me',
    pageUrl: 'http://steward.localhost:19494/',
    home: dir,
    schtasks: async (args) => {
      tasks.push(args);
      if (args[0] === '/Run' && !running) running = versionIn(app);
      return { code: 0, out: '' };
    },
    ping: async () => (await d.pingVersion()) !== null,
    // The kit's shutdown asks the page to stop, so a page that doesn't answer goes on running.
    shutdown: async () => {
      if (await d.ping()) running = '';
      return 0;
    },
    endPage: async () => {
      ended.push(running);
      running = '';
      return true;
    },
    onDuty: () => true,
    setDuty: () => {},
    sleep: async (ms) => {
      t += ms;
    },
    out: (line) => said.push(line),
    install: async () => {
      // The kit's install: the release swapped in for app, and started.
      if (o.installLeaves !== 'old') {
        rmSync(app, { recursive: true, force: true });
        cpSync(root, app, { recursive: true });
        running = '0.8.14';
      }
      return o.installCode ?? 0;
    },
    pingVersion: async () => (running === '0.8.14' && o.page ? o.page(t) : running || null),
    homePage: async () => (o.homeStatus === undefined ? 200 : o.homeStatus),
    probationMs: 30_000,
    copy: (from, to) => cpSync(from, to, { recursive: true }),
    now: () => t,
    record: (u) => writeFileSync(unsafeFile(), JSON.stringify({ ...loadUnsafe(), [u.version]: u })),
    flagged: loadUnsafe,
  };
  return { d, app, said, tasks, ended, running: () => running };
}

test('an update that holds up for its probation is done, and the version before it is kept beside it', async () => {
  rmSync(unsafeFile(), { force: true });
  const s = setup();
  assert.equal(await safeInstall({}, s.d), 0, s.said.join('\n'));
  assert.equal(versionIn(s.app), '0.8.14');
  assert.equal(versionIn(`${s.app}.prev`), '0.8.13');
  assert.match(s.said.at(-1)!, /0\.8\.14 held up for 30 s\. 0\.8\.13 stays in .*app\.prev/);
  assert.deepEqual(loadUnsafe(), {});
});

test("a new version whose page stops answering is rolled back: the one before is back and running, and it is flagged", async () => {
  rmSync(unsafeFile(), { force: true });
  const s = setup({ page: (t) => (t < 10_000 ? '0.8.14' : null) });
  assert.equal(await safeInstall({}, s.d), 1);
  assert.equal(versionIn(s.app), '0.8.13', 'the version before, back in app');
  assert.equal(s.running(), '0.8.13', 'and started again');
  assert.equal(versionIn(`${s.app}.unsafe-0.8.14`), '0.8.14', 'the failed copy kept for a look');
  const flag = loadUnsafe()['0.8.14'];
  assert.equal(flag.from, '0.8.13');
  assert.match(flag.why, /its page stopped answering 10 s into its probation/);
  assert.ok(s.said.some((l) => /0\.8\.13 is back, and its page is up/.test(l)), s.said.join('\n'));

  // Refused from then on, nothing changed, until allowed again.
  const again = setup();
  assert.equal(await safeInstall({}, again.d), 3);
  assert.equal(versionIn(again.app), '0.8.13');
  assert.match(again.said[0], /isn't installed again until you allow it: Dismiss its alarm/);
  assert.equal(allowUpdate('0.8.14'), true);
  assert.equal(allowUpdate('0.8.14'), false);
  const allowed = setup();
  assert.equal(await safeInstall({}, allowed.d), 0, allowed.said.join('\n'));
});

test('a look or two missed on a busy PC is forgiven: the update holds up', async () => {
  rmSync(unsafeFile(), { force: true });
  // One ping missed 10 s in, and two in a row 20 s in: never three.
  const s = setup({ page: (t) => (t === 10_000 || t === 20_000 || t === 25_000 ? null : '0.8.14') });
  assert.equal(await safeInstall({}, s.d), 0, s.said.join('\n'));
  assert.equal(versionIn(s.app), '0.8.14');
  assert.equal(s.running(), '0.8.14');
  assert.deepEqual(loadUnsafe(), {});
});

test("a page that stops answering but runs on is ended by the rollback, and the old version is up as itself (0.9.2's case)", async () => {
  rmSync(unsafeFile(), { force: true });
  // Silent from 10 s in, then answering again by the time the rollback looks: its process never stopped.
  const s = setup({ page: (t) => (t >= 10_000 && t < 25_000 ? null : '0.8.14') });
  assert.equal(await safeInstall({}, s.d), 1);
  assert.deepEqual(s.ended, ['0.8.14'], 'the new page ended, though it didn\'t answer');
  assert.equal(versionIn(s.app), '0.8.13');
  assert.equal(s.running(), '0.8.13', '0.8.13 runs, not 0.8.14 from 0.8.13\'s files');
  assert.match(loadUnsafe()['0.8.14'].why, /its page stopped answering 10 s into its probation/);
  assert.ok(s.said.some((l) => /0\.8\.13 is back, and its page is up/.test(l)), s.said.join('\n'));
});

test("a rollback whose page answers as the wrong version says so, rather than that the old one is up", async () => {
  rmSync(unsafeFile(), { force: true });
  const s = setup({ page: (t) => (t >= 10_000 && t < 25_000 ? null : '0.8.14') });
  s.d.endPage = async () => false; // it wouldn't end
  assert.equal(await safeInstall({}, s.d), 1);
  assert.equal(s.running(), '0.8.14');
  assert.ok(s.said.some((l) => /wouldn't end/.test(l)), s.said.join('\n'));
  assert.ok(s.said.some((l) => /0\.8\.13 is back in .*, but its page answers as 0\.8\.14: end that one/.test(l)), s.said.join('\n'));
});

test('the other ways an update fails its probation: the wrong version answers, the home page fails, the install fails once it is in place', async () => {
  for (const [o, why] of [
    [{ page: () => '0.8.13' }, /its page answers as 0\.8\.13, not 0\.8\.14/],
    [{ homeStatus: 500 }, /its home page answered 500/],
    [{ installCode: 1 }, /its install failed \(exit 1\) once it was in place/],
  ] as const) {
    rmSync(unsafeFile(), { force: true });
    const s = setup(o);
    assert.equal(await safeInstall({}, s.d), 1);
    assert.equal(versionIn(s.app), '0.8.13');
    assert.match(loadUnsafe()['0.8.14'].why, why);
  }
});

test("an install that changed nothing flags nothing, and a first install or --no-start has nothing to go back to", async () => {
  rmSync(unsafeFile(), { force: true });
  const s = setup({ installCode: 1, installLeaves: 'old' });
  assert.equal(await safeInstall({}, s.d), 1);
  assert.equal(versionIn(s.app), '0.8.13');
  assert.deepEqual(loadUnsafe(), {}, 'tried again later');
  assert.ok(!existsSync(`${s.app}.prev`));

  const first = setup({ page: () => null });
  rmSync(first.app, { recursive: true, force: true });
  assert.equal(await safeInstall({}, first.d), 0, 'the kit install answered for it');
  assert.deepEqual(loadUnsafe(), {});

  const quiet = setup({ page: () => null });
  assert.equal(await safeInstall({ noStart: true }, quiet.d), 0);
  assert.deepEqual(loadUnsafe(), {});
});

test("a flagged version is an alarm at once, saying how to allow it again", () => {
  const conditions = roundConditions({
    round: { stage: 'round', started: '', finished: '', kit: null, asked: {}, results: [], log: [] },
    held: [],
    failedReleases: {},
    employees: [],
    settings: { alarms: { waitingHours: 24, tastingHours: 6 }, rollout: false, releaseSelf: false, tasteBeforeRelease: false } as any,
    unsafe: { '0.8.14': { version: '0.8.14', from: '0.8.13', why: 'its home page answered 500', at: '2026-10-05T15:00:00Z', kept: 'C:\\x\\app.unsafe-0.8.14' } },
  });
  assert.equal(conditions.length, 1);
  const c = conditions[0];
  assert.equal(c.id, 'unsafe:0.8.14');
  assert.equal(c.afterMs, 0);
  assert.match(c.title, /update to 0\.8\.14 failed and was rolled back to 0\.8\.13/);
  assert.match(c.detail.join(' '), /Dismiss this once you've looked: that allows 0\.8\.14 again/);
});
