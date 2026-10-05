import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Installing from a release (Manor's docs/INSTALLING.md). Nothing here touches Task Scheduler, a
// running page or the real home folder: every install runs in a temporary folder, with stand-ins.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'install-test-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
const ENV = String(pkg.name).toUpperCase().replace(/-/g, '_');
process.env[`${ENV}_HOME`] = path.join(tmp, 'own-home');
process.env[`${ENV}_PORT`] = String(40000 + Math.floor(Math.random() * 9000));
after(() => rmSync(tmp, { recursive: true, force: true }));

const { APP, appRoot, devCheckout, isDevCheckout, placeFor } = await import('./fixture/src/app.ts');
const { DEV_CHECKOUT, TASK_NAME, appFolder, homePageTaskXml, install, installCli, taskArguments, taskXmlFile, uninstall, utf16 } = await import('./fixture/src/kit/install.ts');
const { ANNOUNCEMENT, announcementOf, checkAnnouncement, kitOf, pickReleaseFiles, releaseVersion, repoFiles, repoFromUrl, sumsText } = await import('./fixture/src/kit/release.ts');
type Deps = import('./fixture/src/kit/install.ts').InstallDeps;

let n = 0;
/** A fresh temporary home: a release to install from, and the data folder it installs into. */
function place() {
  const dir = path.join(tmp, `case-${++n}`);
  const release = path.join(dir, 'unpacked');
  mkdirSync(path.join(release, 'src'), { recursive: true });
  mkdirSync(path.join(release, 'art'), { recursive: true });
  writeFileSync(path.join(release, 'src', 'cli.ts'), '// the new cli\n');
  writeFileSync(path.join(release, 'art', 'icon.svg'), '<svg/>');
  writeFileSync(path.join(release, 'package.json'), '{}');
  writeFileSync(path.join(release, 'release.json'), JSON.stringify({ id: APP.id, name: APP.name, version: '9.9.9', commit: 'abc1234', dirty: false, built: '2026-10-02T12:00:00.000Z' }));
  return { dir, release, data: path.join(dir, `.${APP.id}`) };
}

/** Stand-ins for Task Scheduler and the page: the task's /Run brings the page up, shutdown ends it. */
function fakes(o: { root: string; data: string; dev?: boolean; up?: boolean }) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const state = { up: o.up ?? false, shutdowns: 0, dutySets: [] as boolean[], tasks: new Set<string>() };
  const dutyFile = path.join(o.data, 'duty.json');
  const deps: Deps = {
    root: o.root,
    dev: o.dev ?? false,
    dataDir: o.data,
    node: 'C:\\Program Files\\nodejs\\node.exe',
    user: 'PC\\pat',
    pageUrl: `http://${APP.id}.localhost:1/`,
    home: path.dirname(o.data),
    schtasks: async (args) => {
      calls.push(args);
      const [verb, , name] = args;
      if (verb === '/Create') state.tasks.add(name);
      if (verb === '/Delete') state.tasks.delete(name);
      if (verb === '/Query') return state.tasks.has(name) ? { code: 0, out: name } : { code: 1, out: 'ERROR: The system cannot find the file specified.' };
      if (verb === '/Run') state.up = true;
      return { code: 0, out: 'SUCCESS' };
    },
    ping: async () => state.up,
    shutdown: async () => {
      state.shutdowns++;
      state.up = false;
      return 0;
    },
    onDuty: () => !existsSync(dutyFile) || JSON.parse(readFileSync(dutyFile, 'utf8')).onDuty !== false,
    setDuty: (on) => {
      state.dutySets.push(on);
      mkdirSync(o.data, { recursive: true });
      writeFileSync(dutyFile, JSON.stringify({ onDuty: on, since: new Date().toISOString() }));
    },
    sleep: async () => {},
    out: (line) => lines.push(line),
  };
  return { deps, calls, lines, state, dutyFile };
}

const verbs = (calls: string[][]) => calls.map((c) => c[0]);

// ---------------------------------------------------------------- installed copies and checkouts

test('a copy is a development checkout when its root holds .git, a folder or a worktree file', () => {
  const root = 'C:\\Projects\\Agent';
  assert.equal(isDevCheckout(root, (p) => p === path.join(root, '.git')), true);
  assert.equal(isDevCheckout(root, () => false), false);
  assert.equal(devCheckout, existsSync(path.join(appRoot, '.git')), 'this copy is judged by its own root');
  assert.ok(existsSync(path.join(appRoot, 'src', 'cli.ts')), 'appRoot is the folder above src');
});

test('an installed copy keeps its data in .<id> and its own port; a checkout uses .<id>-dev and port + 10000', () => {
  const home = 'C:\\Users\\pat';
  assert.deepEqual(placeFor({ id: 'porter', port: 18686, dev: false, home, env: {} }), { dataDir: path.join(home, '.porter'), port: 18686 });
  assert.deepEqual(placeFor({ id: 'porter', port: 18686, dev: true, home, env: {} }), { dataDir: path.join(home, '.porter-dev'), port: 28686 });
});

test('<ID>_HOME and <ID>_PORT override both kinds of copy', () => {
  const env = { PORTER_HOME: 'D:\\scratch', PORTER_PORT: '41234' };
  for (const dev of [false, true]) {
    assert.deepEqual(placeFor({ id: 'porter', port: 18686, dev, home: 'C:\\Users\\pat', env }), { dataDir: 'D:\\scratch', port: 41234 });
  }
  assert.deepEqual(placeFor({ id: 'some-agent', port: 18000, dev: true, home: 'C:\\Users\\pat', env: { SOME_AGENT_HOME: 'E:\\x' } }), { dataDir: 'E:\\x', port: 28000 });
});

// ---------------------------------------------------------------- the sign-in task

test('the sign-in task runs open from app at sign-in, hidden, with no time limit', () => {
  const app = 'C:\\Users\\pat\\.agent\\app';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const args = taskArguments(node, app);
  assert.equal(args, `--headless "${node}" "${app}\\src\\cli.ts" open`);
  assert.equal(TASK_NAME, `\\${APP.name}\\Home page`);
  const xml = homePageTaskXml({ node, app, user: 'PC\\pat', pageUrl: 'http://agent.localhost:1/' });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>'));
  assert.ok(xml.includes(`<URI>${TASK_NAME}</URI>`));
  assert.ok(xml.includes('<Command>C:\\Windows\\System32\\conhost.exe</Command>'));
  assert.ok(xml.includes(`<Arguments>${args.replace(/"/g, '&quot;')}</Arguments>`));
  assert.ok(xml.includes(`<WorkingDirectory>${app}</WorkingDirectory>`));
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>PC\\pat<\/UserId>\s*<\/LogonTrigger>/);
  for (const part of ['<LogonType>InteractiveToken</LogonType>', '<RunLevel>LeastPrivilege</RunLevel>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<Hidden>true</Hidden>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>', '<Priority>7</Priority>']) {
    assert.ok(xml.includes(part), part);
  }
  assert.ok(xml.includes('http://agent.localhost:1/'));
  assert.ok(xml.includes(`Remove with: node ${app}\\src\\cli.ts uninstall`));
  const bytes = utf16(xml);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], 'UTF-16 LE with a byte-order mark');
  assert.equal(bytes.subarray(2).toString('utf16le'), xml);
});

// ---------------------------------------------------------------- install

test('a fresh install copies the release to app, goes on duty, registers the task and runs it', async () => {
  const p = place();
  writeFileSync(path.join(p.dir, 'stray.txt'), 'not part of the release');
  const f = fakes({ root: p.release, data: p.data });
  assert.equal(await install({}, f.deps), 0, f.lines.join('\n'));
  const app = appFolder(p.data);
  assert.equal(readFileSync(path.join(app, 'src', 'cli.ts'), 'utf8'), '// the new cli\n');
  assert.ok(existsSync(path.join(app, 'art', 'icon.svg')) && existsSync(path.join(app, 'release.json')));
  assert.ok(!existsSync(`${app}.new`) && !existsSync(`${app}.old`));
  assert.deepEqual(f.state.dutySets, [true]);
  assert.deepEqual(verbs(f.calls), ['/Create', '/Run']);
  assert.deepEqual(f.calls[0], ['/Create', '/TN', TASK_NAME, '/XML', taskXmlFile(p.data), '/F']);
  assert.deepEqual(f.calls[1], ['/Run', '/TN', TASK_NAME]);
  const xml = readFileSync(taskXmlFile(p.data));
  assert.deepEqual([...xml.subarray(0, 2)], [0xff, 0xfe]);
  assert.ok(xml.subarray(2).toString('utf16le').includes(`${app}\\src\\cli.ts`));
  assert.equal(f.state.shutdowns, 0, 'nothing was running');
  const said = f.lines.join('\n');
  assert.match(said, /9\.9\.9 installed/);
  for (const s of [app, p.data, TASK_NAME, f.deps.pageUrl, 'on duty']) assert.ok(said.includes(s), s);
});

test('an update ends the running page, replaces app and keeps the duty it had', async () => {
  const p = place();
  const app = appFolder(p.data);
  mkdirSync(path.join(app, 'src'), { recursive: true });
  writeFileSync(path.join(app, 'src', 'cli.ts'), '// the old cli\n');
  writeFileSync(path.join(app, 'src', 'gone.ts'), '// only in the old release\n');
  writeFileSync(path.join(app, 'release.json'), JSON.stringify({ version: '1.0.0' }));
  mkdirSync(`${app}.new`, { recursive: true }); // a stale one from an install that failed
  writeFileSync(path.join(p.data, 'duty.json'), JSON.stringify({ onDuty: false, since: '2026-10-01T00:00:00.000Z' }));
  const f = fakes({ root: p.release, data: p.data, up: true });
  assert.equal(await install({}, f.deps), 0, f.lines.join('\n'));
  assert.equal(f.state.shutdowns, 1);
  assert.equal(readFileSync(path.join(app, 'src', 'cli.ts'), 'utf8'), '// the new cli\n');
  assert.ok(!existsSync(path.join(app, 'src', 'gone.ts')));
  assert.ok(!existsSync(`${app}.new`) && !existsSync(`${app}.old`));
  assert.deepEqual(f.state.dutySets, [], 'duty is left as it was');
  assert.equal(JSON.parse(readFileSync(f.dutyFile, 'utf8')).onDuty, false);
  assert.deepEqual(verbs(f.calls), ['/Create', '/Run']);
  assert.match(f.lines.join('\n'), /updated from 1\.0\.0[\s\S]*off duty/);
});

/** An installed copy to update: its old cli, on duty, its page up. */
function installed() {
  const p = place();
  const app = appFolder(p.data);
  mkdirSync(path.join(app, 'src'), { recursive: true });
  writeFileSync(path.join(app, 'src', 'cli.ts'), '// the old cli\n');
  writeFileSync(path.join(app, 'release.json'), JSON.stringify({ version: '1.0.0' }));
  return { ...p, app, f: fakes({ root: p.release, data: p.data, up: true }) };
}

const busy = () => Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });

test('a folder Windows says is busy (a process that has just ended still holds it) is tried again', async () => {
  const { app, f } = installed();
  let refusals = 2;
  f.deps.rename = (from, to) => {
    if (from === app && refusals-- > 0) throw busy();
    renameSync(from, to);
  };
  assert.equal(await install({}, f.deps), 0, f.lines.join('\n'));
  assert.equal(readFileSync(path.join(app, 'src', 'cli.ts'), 'utf8'), '// the new cli\n');
  assert.equal(refusals, -1, 'it waited, and tried again');
});

test('when app can\'t be moved at all (a shell is in it), the release is copied into it, and what it no longer has removed', async () => {
  const { app, f } = installed();
  writeFileSync(path.join(app, 'src', 'gone.ts'), '// only in the old release\n');
  mkdirSync(path.join(app, 'old-folder'));
  f.deps.rename = (from, to) => {
    if (from === app) throw busy();
    renameSync(from, to);
  };
  assert.equal(await install({}, f.deps), 0, f.lines.join('\n'));
  assert.equal(readFileSync(path.join(app, 'src', 'cli.ts'), 'utf8'), '// the new cli\n');
  assert.ok(existsSync(path.join(app, 'art', 'icon.svg')));
  assert.ok(!existsSync(path.join(app, 'src', 'gone.ts')) && !existsSync(path.join(app, 'old-folder')), 'nothing of the old release is left');
  assert.ok(!existsSync(`${app}.new`) && !existsSync(`${app}.old`));
  assert.deepEqual(verbs(f.calls), ['/Create', '/Run']);
  assert.match(f.lines.join('\n'), /held open \(a shell or another program is in it\), so the release was copied into it/);
});

test('when the swap fails for another reason, nothing changes, and the page that was ended comes back', async () => {
  const { app, f } = installed();
  f.deps.rename = (from, to) => {
    if (from === app) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    renameSync(from, to);
  };
  assert.equal(await install({}, f.deps), 1);
  assert.equal(readFileSync(path.join(app, 'src', 'cli.ts'), 'utf8'), '// the old cli\n', 'the installed copy is as it was');
  assert.ok(!existsSync(`${app}.new`), 'the release copied beside it is cleared away');
  assert.equal(f.state.shutdowns, 1);
  assert.deepEqual(verbs(f.calls), ['/Run'], 'no task registered for a release that isn\'t there; the old page started again');
  assert.equal(f.state.up, true);
  assert.match(f.lines.join('\n'), /EXDEV[^\n]*Nothing was changed\.\nIts page is up again/);

  const other = installed();
  other.f.state.up = false;
  other.f.deps.rename = (from) => {
    if (from === other.app) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
  };
  assert.equal(await install({}, other.f.deps), 1);
  assert.deepEqual(verbs(other.f.calls), [], 'a page that wasn\'t up isn\'t started');
});

test('--no-start installs and registers the task, but neither starts it nor changes duty', async () => {
  const p = place();
  const f = fakes({ root: p.release, data: p.data });
  assert.equal(await install({ noStart: true }, f.deps), 0);
  assert.ok(existsSync(path.join(appFolder(p.data), 'src', 'cli.ts')));
  assert.deepEqual(verbs(f.calls), ['/Create']);
  assert.deepEqual(f.state.dutySets, []);
});

test('install refuses in a development checkout', async () => {
  const p = place();
  const f = fakes({ root: p.release, data: p.data, dev: true });
  assert.equal(await install({}, f.deps), 2);
  assert.deepEqual(f.lines, [DEV_CHECKOUT]);
  assert.equal(DEV_CHECKOUT, 'This is a development checkout. Build a release and install that: npm run release -- --install');
  assert.deepEqual(f.calls, []);
  assert.ok(!existsSync(p.data));
});

test('install refuses a copy without release.json, and the installed copy itself', async () => {
  const p = place();
  rmSync(path.join(p.release, 'release.json'));
  const f = fakes({ root: p.release, data: p.data });
  assert.equal(await install({}, f.deps), 2);
  assert.match(f.lines.join('\n'), /no release\.json/);
  assert.deepEqual(f.calls, []);
  assert.ok(!existsSync(p.data));

  const q = place();
  const app = appFolder(q.data);
  mkdirSync(path.dirname(app), { recursive: true });
  const g0 = fakes({ root: q.release, data: q.data, up: false });
  assert.equal(await install({ noStart: true }, g0.deps), 0);
  const g = fakes({ root: app, data: q.data });
  assert.equal(await install({}, g.deps), 2);
  assert.match(g.lines.join('\n'), /This is the installed copy/);
  assert.deepEqual(g.calls, []);
  assert.ok(existsSync(path.join(app, 'src', 'cli.ts')));
});

test('a dry run says what it would do and changes nothing', async () => {
  const p = place();
  const f = fakes({ root: p.release, data: p.data, up: true });
  assert.equal(await install({ dryRun: true }, f.deps), 0);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.shutdowns, 0);
  assert.ok(!existsSync(p.data), 'not even the data folder');
  const said = f.lines.join('\n');
  for (const s of [appFolder(p.data), TASK_NAME, '--dry-run: nothing changed']) assert.ok(said.includes(s), s);

  const u = fakes({ root: p.release, data: p.data, up: true });
  assert.equal(await uninstall({ dryRun: true, purge: true }, u.deps), 0);
  assert.deepEqual(u.calls, []);
  assert.equal(u.state.shutdowns, 0);
});

// ---------------------------------------------------------------- uninstall

test('uninstall ends the page, deletes the task and removes app, and keeps the data unless --purge', async () => {
  const p = place();
  const f = fakes({ root: p.release, data: p.data });
  assert.equal(await install({}, f.deps), 0);
  writeFileSync(path.join(p.data, 'state.json'), '{}');
  f.calls.length = 0;
  assert.equal(await uninstall({}, f.deps), 0, f.lines.join('\n'));
  assert.deepEqual(verbs(f.calls), ['/Query', '/End', '/Delete']);
  assert.deepEqual(f.calls[2], ['/Delete', '/TN', TASK_NAME, '/F']);
  assert.equal(f.state.shutdowns, 1);
  assert.ok(!existsSync(appFolder(p.data)));
  assert.ok(!existsSync(taskXmlFile(p.data)));
  assert.ok(existsSync(path.join(p.data, 'state.json')), 'the data stays');

  f.calls.length = 0;
  assert.equal(await uninstall({ purge: true }, f.deps), 0, 'a task that is already gone is fine');
  assert.deepEqual(verbs(f.calls), ['/Query']);
  assert.ok(!existsSync(p.data));
});

test('uninstall refuses in a development checkout, and --purge refuses a home folder', async () => {
  const p = place();
  const f = fakes({ root: p.release, data: p.data, dev: true });
  assert.equal(await uninstall({ purge: true }, f.deps), 2);
  assert.match(f.lines.join('\n'), new RegExp(`node %USERPROFILE%\\\\\\.${APP.id}\\\\app\\\\src\\\\cli\\.ts uninstall`));
  assert.deepEqual(f.calls, []);

  const g = fakes({ root: p.release, data: p.dir });
  g.deps.home = p.dir;
  assert.equal(await uninstall({ purge: true }, g.deps), 2);
  assert.deepEqual(g.calls, []);
  assert.ok(existsSync(p.dir));
});

test('a mistyped option is refused before anything is done', async () => {
  assert.equal(await installCli('install', ['--dryrun']), 2);
  assert.equal(await installCli('uninstall', ['--no-start']), 2);
});

// ---------------------------------------------------------------- the release

test('a release carries src (no tests) with the kit in src/kit, art, package.json, README.md, LICENSE, kit.json and tools/kit.ts, and nothing else', () => {
  const picked = pickReleaseFiles([
    'src/cli.ts', 'src\\watch\\index.ts', 'src/ocr.ps1', 'src/thing.test.ts', 'src/kit/npu.ts', 'src/kit/VERSION', 'art/icon.svg', 'package.json', 'README.md', 'LICENSE',
    'test/agent.test.ts', 'tools/kit.ts', 'tools\\convert.ts', 'kit.json', 'tsconfig.json', 'package-lock.json', '.gitignore', 'artifacts/x/X-1.zip', 'node_modules/typescript/package.json', 'docs/x.md',
  ]);
  assert.deepEqual(picked, ['LICENSE', 'README.md', 'art/icon.svg', 'kit.json', 'package.json', 'src/cli.ts', 'src/kit/VERSION', 'src/kit/npu.ts', 'src/ocr.ps1', 'src/watch/index.ts', 'tools/kit.ts']);

  const own = pickReleaseFiles(repoFiles(appRoot));
  for (const f of ['src/cli.ts', 'src/app.ts', 'src/kit/install.ts', 'src/kit/release.ts', 'art/icon.svg', 'package.json', 'README.md']) assert.ok(own.includes(f), f);
  assert.ok(own.every((f) => f.startsWith('src/') || f.startsWith('art/') || ['package.json', 'README.md', 'LICENSE', 'kit.json', 'tools/kit.ts'].includes(f)));
});

test('repoFiles looks into tools\\ for tools/kit.ts, and the release picks only that from it', () => {
  const dir = path.join(tmp, 'repo-tools');
  for (const f of ['tools/kit.ts', 'tools/convert.ts', 'docs/x.md', 'src/a.ts', 'kit.json']) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), '');
  }
  assert.deepEqual(pickReleaseFiles(repoFiles(dir)), ['kit.json', 'src/a.ts', 'tools/kit.ts']);
});

test('a release carries the kit kit.json pins, and says so; otherwise it is refused', () => {
  const dir = path.join(tmp, 'kit-of');
  mkdirSync(path.join(dir, 'src', 'kit'), { recursive: true });
  assert.match((kitOf(dir) as { error: string }).error, /kit\.json is missing/);
  writeFileSync(path.join(dir, 'kit.json'), '{ "kit": "1.2.3" }\n');
  assert.match((kitOf(dir) as { error: string }).error, /isn't filled: run npm run kit/);
  writeFileSync(path.join(dir, 'src', 'kit', 'VERSION'), '1.2.2\n');
  assert.match((kitOf(dir) as { error: string }).error, /holds kit 1\.2\.2, but kit\.json pins 1\.2\.3/);
  writeFileSync(path.join(dir, 'src', 'kit', 'VERSION'), '1.2.3\r\n');
  assert.deepEqual(kitOf(dir), { kit: '1.2.3' });
});

test('a release from uncommitted changes is versioned +dev.<commit>; the repo comes from origin', () => {
  assert.equal(releaseVersion('0.1.0', '4d1b8ed', false), '0.1.0');
  assert.equal(releaseVersion('0.1.0', '4d1b8ed', true), '0.1.0+dev.4d1b8ed');
  assert.equal(repoFromUrl('https://github.com/Jcollier0120/Porter.git'), 'Jcollier0120/Porter');
  assert.equal(repoFromUrl('https://github.com/Jcollier0120/Porter'), 'Jcollier0120/Porter');
  assert.equal(repoFromUrl('git@github.com:Jcollier0120/Porter.git'), 'Jcollier0120/Porter');
  assert.equal(repoFromUrl('https://example.com/x/y.git'), null);
});

/** A manor-agent.json Manor would take, for the fixture's agent from Jcollier0120/Fixture. */
const announcement = (agent: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => ({
  agent: {
    id: APP.id, name: APP.name, role: 'Keeps a fixture', fills: ['fixture'],
    paths: { app: [`%USERPROFILE%\\.${APP.id}\\app`] },
    release: { repo: 'Jcollier0120/Fixture', kind: 'node' },
    ...agent,
  },
  ...more,
});

test("a release's manor-agent.json is checked as Manor checks it: this agent, a Node release from origin's repository, installed in .<id>\\app", () => {
  const repo = 'Jcollier0120/Fixture';
  assert.equal(checkAnnouncement(announcement(), APP.id, repo), null);
  assert.equal(checkAnnouncement(announcement({ release: { repo: 'jcollier0120/fixture', kind: 'node' } }), APP.id, repo), null, 'the repository, in any case');
  assert.equal(checkAnnouncement(announcement({}, { roles: [{ id: 'fixture', name: 'Fixture' }] }), APP.id, repo), null, 'with the roles it brings');

  assert.match(checkAnnouncement(announcement({ release: { repo: 'Jcollier0120/Other', kind: 'node' } }), APP.id, repo)!, /names Jcollier0120\/Other as its "release\.repo", but origin is Jcollier0120\/Fixture/);
  assert.match(checkAnnouncement(announcement({ release: { kind: 'node' } }), APP.id, repo)!, /names no repository/);
  assert.match(checkAnnouncement(announcement(), APP.id, null)!, /origin isn't a GitHub repository/);
  assert.match(checkAnnouncement(announcement({ id: 'someone-else' }), APP.id, repo)!, new RegExp(`agent is "someone-else", but this release is "${APP.id}" \\(release\\.json's id\\)`));
  assert.match(checkAnnouncement(announcement({ id: undefined }), APP.id, repo)!, /agent is null/);
  assert.match(checkAnnouncement(announcement({ release: { repo, kind: 'heiward' } }), APP.id, repo)!, /"release\.kind" is "heiward"/);
  assert.match(checkAnnouncement(announcement({ paths: { app: ['C:\\Elsewhere\\app'] } }), APP.id, repo)!, /"paths\.app" should be/);
  assert.match(checkAnnouncement(announcement({ paths: {} }), APP.id, repo)!, /"paths\.app" should be/);
  assert.match(checkAnnouncement(announcement({}, { roles: {} }), APP.id, repo)!, /"roles" should be a list/);
  assert.match(checkAnnouncement(announcement({}, { roles: ['fixture'] }), APP.id, repo)!, /"roles" should be a list/);
  assert.match(checkAnnouncement({ agents: [] }, APP.id, repo)!, /should give its "agent"/);
  assert.match(checkAnnouncement([], APP.id, repo)!, /should be an object/);
});

test("manor-agent.json at a checkout's root is published with the release; none is nothing; a wrong or broken one stops the build", () => {
  const dir = path.join(tmp, 'announces');
  mkdirSync(dir, { recursive: true });
  assert.equal(announcementOf(dir, APP.id, 'Jcollier0120/Fixture'), null, 'no manor-agent.json: the release is as before');

  writeFileSync(path.join(dir, ANNOUNCEMENT), '\uFEFF' + JSON.stringify(announcement(), null, 2));
  assert.deepEqual(announcementOf(dir, APP.id, 'Jcollier0120/Fixture'), { file: path.join(dir, 'manor-agent.json') });
  assert.match((announcementOf(dir, APP.id, 'Jcollier0120/Fork') as { error: string }).error, /but origin is Jcollier0120\/Fork.*Fix it, or remove it, and release again\.$/);
  assert.match((announcementOf(dir, 'other', 'Jcollier0120/Fixture') as { error: string }).error, /but this release is "other"/);

  writeFileSync(path.join(dir, ANNOUNCEMENT), '{ "agent": ');
  assert.match((announcementOf(dir, APP.id, 'Jcollier0120/Fixture') as { error: string }).error, /^manor-agent\.json isn't JSON/);
});

test('SHA256SUMS.txt lists the zip, and manor-agent.json after it, as sha256sum writes them', () => {
  assert.equal(sumsText([{ name: 'Fixture-1.0.0.zip', hash: 'ab'.repeat(32) }]), `${'ab'.repeat(32)}  Fixture-1.0.0.zip\n`);
  assert.equal(
    sumsText([{ name: 'Fixture-1.0.0.zip', hash: 'ab'.repeat(32) }, { name: ANNOUNCEMENT, hash: 'cd'.repeat(32) }]),
    `${'ab'.repeat(32)}  Fixture-1.0.0.zip\n${'cd'.repeat(32)}  manor-agent.json\n`,
  );
});

test('npm run release copies manor-agent.json beside the zip and lists it in SHA256SUMS.txt; a mismatched one builds nothing', { skip: process.platform !== 'win32' && 'needs Windows tar.exe' }, () => {
  // A copy of the fixture as an agent's own repository, from Jcollier0120/Fixture, committed, its kit filled.
  const repo = path.join(tmp, 'fixture-repo');
  cpSync(appRoot, repo, { recursive: true });
  writeFileSync(path.join(repo, 'kit.json'), JSON.stringify({ kit: readFileSync(path.join(appRoot, 'src', 'kit', 'VERSION'), 'utf8').trim() }) + '\n');
  writeFileSync(path.join(repo, '.gitignore'), 'artifacts/\nsrc/kit/\n');
  writeFileSync(path.join(repo, ANNOUNCEMENT), JSON.stringify(announcement(), null, 2) + '\n');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: repo, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/Jcollier0120/Fixture.git');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const release = () => spawnSync(process.execPath, [path.join(repo, 'src', 'kit', 'release.ts')], { cwd: repo, encoding: 'utf8', windowsHide: true });
  const out = path.join(repo, 'artifacts', APP.id);
  const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

  let r = release();
  assert.equal(r.status, 0, r.stderr);
  const zip = `${APP.name}-${pkg.version}.zip`;
  assert.equal(readFileSync(path.join(out, ANNOUNCEMENT), 'utf8'), readFileSync(path.join(repo, ANNOUNCEMENT), 'utf8'), 'the checkout\'s file, as committed');
  assert.equal(readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8'), `${sha(path.join(out, zip))}  ${zip}\n${sha(path.join(out, ANNOUNCEMENT))}  ${ANNOUNCEMENT}\n`);
  assert.match(r.stdout, /manor-agent\.json, announcing/);
  assert.doesNotMatch(r.stdout, /with uncommitted changes/);

  // A change to it makes the release dirty: it is published, so it must be the commit's.
  writeFileSync(path.join(repo, ANNOUNCEMENT), JSON.stringify(announcement({ role: 'Keeps a fixture well' })) + '\n');
  r = release();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /with uncommitted changes/);

  // Another repository's, or another agent's: refused, and the last build's files are left as they were.
  const before = readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8');
  writeFileSync(path.join(repo, ANNOUNCEMENT), JSON.stringify(announcement({ release: { repo: 'Jcollier0120/Other', kind: 'node' } })));
  r = release();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /names Jcollier0120\/Other as its "release\.repo", but origin is Jcollier0120\/Fixture/);
  writeFileSync(path.join(repo, ANNOUNCEMENT), JSON.stringify(announcement({ id: 'other' })));
  r = release();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /agent is "other", but this release is/);
  assert.equal(readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8'), before);

  // None: the zip alone, and an earlier build's manor-agent.json is gone.
  rmSync(path.join(repo, ANNOUNCEMENT));
  git('commit', '-q', '-am', 'no announcement');
  r = release();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(path.join(out, ANNOUNCEMENT)));
  assert.equal(readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8'), `${sha(path.join(out, zip))}  ${zip}\n`);
});
