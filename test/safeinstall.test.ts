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
function setup(o: { installCode?: number; page?: (t: number) => string | null; homeStatus?: number | null | ((t: number) => number | null); installLeaves?: 'new' | 'old' } = {}) {
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
    homePage: async () => (o.homeStatus === undefined ? 200 : typeof o.homeStatus === 'function' ? o.homeStatus(t) : o.homeStatus),
    probationMs: 30_000,
    copy: (from, to) => cpSync(from, to, { recursive: true }),
    now: () => t,
    record: (u) => writeFileSync(unsafeFile(), JSON.stringify({ ...loadUnsafe(), [u.version]: u })),
    flagged: loadUnsafe,
    // No page process is looked for on this PC: a page that doesn't answer has ended, as far as a rollback's wait goes.
    pagesStarting: async () => [],
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
  assert.match(again.said[0], /isn't installed again until it is allowed: Dismiss its alarm/);
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
    // Its page never answering as it: one that answers late goes on to its probation (below).
    [{ installCode: 1, page: () => null }, /its install failed \(exit 1\) once it was in place/],
  ] as const) {
    rmSync(unsafeFile(), { force: true });
    const s = setup(o);
    assert.equal(await safeInstall({}, s.d), 1);
    assert.equal(versionIn(s.app), '0.8.13');
    assert.match(loadUnsafe()['0.8.14'].why, why);
  }
});

test("an install that stopped waiting for a slow page, which then answers as the new version, goes on to its probation: not rolled back, not flagged (0.36.46's case)", async () => {
  rmSync(unsafeFile(), { force: true });
  // The kit's install gave up on the page (exit 1), but by now it answers as 0.8.14, and keeps answering.
  const s = setup({ installCode: 1 });
  assert.equal(await safeInstall({}, s.d), 0, s.said.join('\n'));
  assert.equal(versionIn(s.app), '0.8.14');
  assert.equal(s.running(), '0.8.14');
  assert.deepEqual(s.ended, [], 'nothing ended');
  assert.deepEqual(loadUnsafe(), {});
  assert.ok(s.said.some((l) => /0\.8\.14's page answered late, after the install had stopped waiting for it/.test(l)), s.said.join('\n'));

  // One that answers late and then stops is judged by its probation, as any other.
  const t = setup({ installCode: 1, page: (at) => (at < 10_000 ? '0.8.14' : null) });
  assert.equal(await safeInstall({}, t.d), 1);
  assert.equal(versionIn(t.app), '0.8.13');
  assert.match(loadUnsafe()['0.8.14'].why, /its page stopped answering/);
});

test('a version that holds up drops the flags of the versions before it (their alarms are the flags); a newer one flagged stays (kit 2.75.2)', async () => {
  rmSync(unsafeFile(), { force: true });
  const flag = (version: string) => ({ version, from: '0.8.11', why: 'its install failed (exit 1) once it was in place', at: '2026-10-15T18:00:00.000Z', kept: null });
  writeFileSync(unsafeFile(), JSON.stringify({ '0.8.12': flag('0.8.12'), '0.8.20': flag('0.8.20') }));
  const s = setup();
  assert.equal(await safeInstall({}, s.d), 0, s.said.join('\n'));
  assert.deepEqual(Object.keys(loadUnsafe()), ['0.8.20']);
  assert.ok(s.said.some((l) => /0\.8\.12 was flagged as unsafe: no longer, since 0\.8\.14, newer, holds up/.test(l)), s.said.join('\n'));
  rmSync(unsafeFile(), { force: true });
});

test('a rollback ends a page still starting from app, and the open starting it, before the version before goes back in (kit 2.75.2)', async () => {
  const { endStartingPages } = await import('../src/kit/safeinstall.ts');
  const app = path.join(home, 'starting', 'app');
  let running = [4242, 4243, process.pid];
  const asked: string[] = [];
  const endedIds: number[][] = [];
  const deps = {
    pagesStarting: async (dir: string) => {
      asked.push(dir);
      return running;
    },
    endPrograms: async (ids: number[]) => {
      endedIds.push(ids);
      running = running.filter((id) => !ids.includes(id));
    },
    sleep: async () => {},
  };
  assert.equal(await endStartingPages(app, deps), true);
  assert.deepEqual(endedIds, [[4242, 4243]], 'both, never the install itself');
  assert.ok(asked.every((d) => d === app));

  // None there: nothing ended. One that won't end: false, after a while.
  endedIds.length = 0;
  running = [];
  assert.equal(await endStartingPages(app, deps), true);
  assert.deepEqual(endedIds, []);
  assert.equal(await endStartingPages(app, { ...deps, pagesStarting: async () => [7], endPrograms: async () => {} }), false);
});

test("a home page that doesn't answer at first is asked again, not rolled back: a network blip at the update (2026-10-13)", async () => {
  // Its ping answers as 0.8.14 all along; the home page is silent for its first 20 s.
  const late = (t: number) => (t < 20_000 ? null : 200);
  rmSync(unsafeFile(), { force: true });
  const s = setup({ homeStatus: late });
  assert.equal(await safeInstall({ wait: true }, s.d), 0, s.said.join('\n'));
  assert.equal(versionIn(s.app), '0.8.14');
  assert.deepEqual(loadUnsafe(), {});

  // Silent through the install's settling: handed to the watcher, which asks again and finds it.
  const kit = await import('../src/kit/safeinstall.ts');
  const b = setup({ homeStatus: late });
  b.d.watch = async () => true;
  assert.equal(await safeInstall({}, b.d), 0, b.said.join('\n'));
  assert.equal(await kit.watchProbation('0.8.14', '0.8.13', 0, b.d), 0);
  assert.equal(versionIn(b.app), '0.8.14');
  assert.deepEqual(loadUnsafe(), {});

  // No watcher: the install asks on itself until the probation's end.
  const c = setup({ homeStatus: late });
  c.d.watch = async () => false;
  assert.equal(await safeInstall({}, c.d), 0, c.said.join('\n'));
  assert.deepEqual(loadUnsafe(), {});
});

test("a home page that never renders in the whole probation is still rolled back, in the words the Steward's retry reads", async () => {
  rmSync(unsafeFile(), { force: true });
  const s = setup({ homeStatus: null });
  assert.equal(await safeInstall({ wait: true }, s.d), 1);
  assert.equal(versionIn(s.app), '0.8.13');
  assert.equal(loadUnsafe()['0.8.14'].why, "its home page didn't answer");

  const kit = await import('../src/kit/safeinstall.ts');
  rmSync(unsafeFile(), { force: true });
  const w = setup({ homeStatus: null });
  w.d.watch = async () => true;
  assert.equal(await safeInstall({}, w.d), 0, 'settled: the home page is the watcher\'s to judge');
  assert.equal(await kit.watchProbation('0.8.14', '0.8.13', 0, w.d), 1);
  assert.equal(versionIn(w.app), '0.8.13');
  assert.equal(loadUnsafe()['0.8.14'].why, "its home page didn't answer");

  // An answer that is an error is no blip: rolled back at once, long before the probation's end.
  rmSync(unsafeFile(), { force: true });
  const e = setup({ homeStatus: (t) => (t < 5_000 ? null : 503) });
  assert.equal(await safeInstall({ wait: true }, e.d), 1);
  assert.equal(loadUnsafe()['0.8.14'].why, 'its home page answered 503');
  assert.ok(e.d.now() < 30_000, `rolled back at ${e.d.now()} ms`);
});

test('the real home page check asks 127.0.0.1, which the page takes as its host, never its .localhost name', async () => {
  const kit = await import('../src/kit/safeinstall.ts');
  const { allowedHosts, hostAllowed } = await import('../src/kit/server.ts');
  const { port } = await import('../src/app.ts');
  assert.equal(kit.homePageUrl(), `http://127.0.0.1:${port}/`);
  // A page with the kit's host check, on a port of its own.
  const http = await import('node:http');
  let hosts = new Set<string>();
  const server = http.createServer((req, res) => res.writeHead(hostAllowed(hosts, req.headers.host) ? 200 : 421).end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = (server.address() as import('node:net').AddressInfo).port;
    hosts = allowedHosts(at);
    assert.equal(await kit.homePageStatus(kit.homePageUrl(at)), 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
  // Nothing listening: no answer, not an error status.
  const gone = http.createServer();
  await new Promise<void>((resolve) => gone.listen(0, '127.0.0.1', resolve));
  const free = (gone.address() as import('node:net').AddressInfo).port;
  await new Promise((r) => gone.close(r));
  assert.equal(await kit.homePageStatus(kit.homePageUrl(free), 5_000), null);
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

test("the kit's own safe install, as every agent's: a flagged version says how to allow it, and --allow-unsafe allows it", async () => {
  const kit = await import('../src/kit/safeinstall.ts');
  rmSync(unsafeFile(), { force: true });
  writeFileSync(unsafeFile(), JSON.stringify({ '0.8.14': { version: '0.8.14', from: '0.8.13', why: 'its page stopped answering', at: '2026-10-11T12:00:00Z', kept: null } }));
  const refused = setup();
  const { allowHint: _, ...plain } = { ...refused.d, allowHint: undefined };
  assert.equal(await kit.safeInstall({}, plain), 3);
  assert.match(refused.said[0], /until it is allowed: install it again with --allow-unsafe .*A newer version installs as usual/);
  const allowed = setup();
  assert.equal(await kit.safeInstall({ allowUnsafe: true }, allowed.d), 0, allowed.said.join('\n'));
  assert.match(allowed.said[0], /0\.8\.14 is allowed again, as asked/);
  assert.equal(versionIn(allowed.app), '0.8.14');
  assert.deepEqual(loadUnsafe(), {});
});

test('the install waits only for the probation to settle; the rest is handed to a watcher of its own (kit 2.52.0)', async () => {
  const kit = await import('../src/kit/safeinstall.ts');
  rmSync(unsafeFile(), { force: true });
  const s = setup();
  const asked: string[][] = [];
  s.d.watch = async (args) => (asked.push(args), true);
  let t0 = -1;
  const now = s.d.now;
  s.d.now = () => (t0 < 0 ? (t0 = now()) : now());
  assert.equal(await safeInstall({}, s.d), 0, s.said.join('\n'));
  assert.ok(s.d.now() >= kit.SETTLE_MS && s.d.now() < 30_000, `waited ${s.d.now()} ms, not the whole probation`);
  assert.deepEqual(asked, [['--watch-probation', '0.8.14', '--from', '0.8.13', '--since', '0']]);
  assert.match(s.said.at(-1)!, /0\.8\.14 is up and answering\. The rest of its 30 s probation is watched in the background: if it stops answering, 0\.8\.13 is put back/);

  // --wait waits for all of it, as before.
  const w = setup();
  w.d.watch = async () => assert.fail('no watcher with --wait');
  assert.equal(await safeInstall({ wait: true }, w.d), 0);
  assert.match(w.said.at(-1)!, /held up for 30 s/);
});

test('a watcher that fails to start leaves the rest to the install, which goes back as before', async () => {
  rmSync(unsafeFile(), { force: true });
  const s = setup({ page: (t) => (t < 20_000 ? '0.8.14' : null) });
  s.d.watch = async () => false;
  assert.equal(await safeInstall({}, s.d), 1);
  assert.equal(versionIn(s.app), '0.8.13');
  assert.match(loadUnsafe()['0.8.14'].why, /its page stopped answering 20 s into its probation/);
});

test('the watcher goes back and flags a version that stops answering, timed from the update; a later install it leaves alone', async () => {
  const kit = await import('../src/kit/safeinstall.ts');
  rmSync(unsafeFile(), { force: true });
  const s = setup({ page: (t) => (t < 20_000 ? '0.8.14' : null) });
  s.d.watch = async () => true;
  assert.equal(await safeInstall({}, s.d), 0, 'handed on, settled');
  assert.equal(await kit.watchProbation('0.8.14', '0.8.13', 0, s.d), 1);
  assert.equal(versionIn(s.app), '0.8.13', 'the version before, back');
  assert.equal(s.running(), '0.8.13');
  assert.match(loadUnsafe()['0.8.14'].why, /its page stopped answering 20 s into its probation/);

  rmSync(unsafeFile(), { force: true });
  const ok = setup();
  ok.d.watch = async () => true;
  assert.equal(await safeInstall({}, ok.d), 0);
  assert.equal(await kit.watchProbation('0.8.14', '0.8.13', 0, ok.d), 0);
  assert.match(ok.said.at(-1)!, /0\.8\.14 held up for 30 s/);
  assert.equal(versionIn(ok.app), '0.8.14');

  // Another version installed meanwhile: the watcher of the one before it leaves app as it is.
  const later = setup({ page: (t) => (t < 20_000 ? '0.8.14' : null) });
  later.d.watch = async () => true;
  assert.equal(await safeInstall({}, later.d), 0);
  writeFileSync(path.join(later.app, 'release.json'), JSON.stringify({ id: 'steward', name: 'Steward', version: '0.8.15' }));
  assert.equal(await kit.watchProbation('0.8.14', '0.8.13', 0, later.d), 0);
  assert.equal(versionIn(later.app), '0.8.15');
  assert.deepEqual(loadUnsafe(), {});
});

test('install --watch-probation takes exactly its arguments, and says it is watching while it does', async () => {
  const kit = await import('../src/kit/safeinstall.ts');
  assert.equal(await kit.safeInstallCli(['--watch-probation', '0.8.14']), 2);
  assert.equal(await kit.safeInstallCli(['--watch-probation', '0.8.14', '--from', '0.8.13', '--since', 'soon']), 2);
  const s = setup();
  let seen: unknown = null;
  s.d.pingVersion = async () => ((seen ??= JSON.parse(readFileSync(kit.watchingFile(), 'utf8'))), '0.8.14');
  assert.equal(await kit.safeInstallCli(['--watch-probation', '0.8.14', '--from', '0.8.13', '--since', '0'], { ...s.d, out: s.d.out }), 0);
  assert.deepEqual(seen, { version: '0.8.14', pid: process.pid, since: 0 });
  assert.ok(!existsSync(kit.watchingFile()), 'gone once it is done');
});

test("the real watcher is a process of its own, counted only once it says it is watching", async () => {
  const kit = await import('../src/kit/safeinstall.ts');
  const { appFolder, defaultDeps } = await import('../src/kit/install.ts');
  const cli = path.join(appFolder(defaultDeps().dataDir), 'src', 'cli.ts');
  const real = appFolder(defaultDeps().dataDir);
  const had = existsSync(real);
  if (had) cpSync(real, `${real}.test-keep`, { recursive: true });
  try {
    mkdirSync(path.dirname(cli), { recursive: true });
    // A copy whose watcher says so (and ends, so the test's folder can go).
    writeFileSync(cli, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(kit.watchingFile())}, JSON.stringify({ version: process.argv[4], pid: process.pid, since: 0 }));\n`);
    assert.equal(await kit.safeDeps().watch!(['--watch-probation', '9.9.9', '--from', '9.9.8', '--since', '0']), true);
    // One that can't watch (it ends at once, saying nothing): not counted, so the install waits for the rest itself.
    rmSync(kit.watchingFile(), { force: true });
    writeFileSync(cli, 'process.exit(2);\n');
    assert.equal(await kit.safeDeps().watch!(['--watch-probation', '9.9.9', '--from', '9.9.8', '--since', '0']), false);
  } finally {
    rmSync(kit.watchingFile(), { force: true });
    rmSync(real, { recursive: true, force: true });
    if (had) {
      cpSync(`${real}.test-keep`, real, { recursive: true });
      rmSync(`${real}.test-keep`, { recursive: true, force: true });
    }
  }
});
