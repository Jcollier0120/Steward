import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { freePort } from './free-port.ts';

// Installing from a release (Manor's docs/INSTALLING.md). Nothing here touches Task Scheduler, a
// running page or the real home folder: every install runs in a temporary folder, with stand-ins.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'install-test-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
const ENV = String(pkg.name).toUpperCase().replace(/-/g, '_');
process.env[`${ENV}_HOME`] = path.join(tmp, 'own-home');
process.env[`${ENV}_PORT`] = String(await freePort());
after(() => rmSync(tmp, { recursive: true, force: true }));

const { APP, appRoot, devCheckout, isDevCheckout, placeFor } = await import('./fixture/src/app.ts');
const { DEV_CHECKOUT, MANOR_STARTUP, OLD_TASK_NAME, OLD_WAKE_TASK_NAME, PAGE_START_MS, TASK_NAME, WAKE_TASK_NAME, appFolder, dropOldTask, isOwnTask, runOwnTask, taskAccount, taskName, homePageTaskXml, install, purgeRefusal, signInDelaySeconds, installCli, taskArguments, taskXmlFile, uninstall, utf16 } = await import('./fixture/src/kit/install.ts');
const { ANNOUNCEMENT, announcementOf, checkAnnouncement, kitOf, pickReleaseFiles, releaseVersion, repoFiles, repoFromUrl, sumsText, zipName } = await import('./fixture/src/kit/release.ts');
const { headings: noticeHeadings } = await import('./fixture/src/kit/notices.ts');
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

/** This user's SID, as the stand-in whoami gives it, and another account's. */
const MY_SID = 'S-1-5-21-1111-2222-3333-1001';
const THEIR_SID = 'S-1-5-21-1111-2222-3333-1002';

/** A task's definition as schtasks /Query /XML prints it: its principal, as Task Scheduler keeps it (a SID). */
const queriedXml = (name: string, principal: string, trigger = principal) => `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><URI>${name}</URI></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${trigger}</UserId></LogonTrigger></Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${principal}</UserId>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
</Task>`;

/**
 * Stand-ins for Task Scheduler and the page: the task's /Run brings the page up, shutdown ends it. `state.tasks` maps
 * each task there to the user its principal runs as: this user's SID for the ones the install registers.
 */
function fakes(o: { root: string; data: string; dev?: boolean; up?: boolean }) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const state = { up: o.up ?? false, shutdowns: 0, dutySets: [] as boolean[], tasks: new Map<string, string>() };
  const dutyFile = path.join(o.data, 'duty.json');
  const deps: Deps = {
    root: o.root,
    dev: o.dev ?? false,
    dataDir: o.data,
    node: 'C:\\Program Files\\nodejs\\node.exe',
    user: 'PC\\pat',
    userSid: async () => MY_SID,
    pageUrl: `http://${APP.id}.localhost:1/`,
    home: path.dirname(o.data),
    schtasks: async (args) => {
      calls.push(args);
      const [verb, , name] = args;
      const missing = { code: 1, out: 'ERROR: The system cannot find the file specified.' };
      if (verb === '/Create') state.tasks.set(name, MY_SID);
      if (verb === '/Delete') state.tasks.delete(name);
      if (verb === '/Query') return state.tasks.has(name) ? { code: 0, out: args.includes('/XML') ? queriedXml(name, state.tasks.get(name)!) : name } : missing;
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

/** An install's looks at the tasks' old names (isOwnTask), when neither is there. */
const OLD_LOOKS = ['/Query', '/Query'];

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
  assert.equal(TASK_NAME, `\\${APP.name} (${taskAccount()})\\Home page`);
  const xml = homePageTaskXml({ node, app, user: 'PC\\pat', pageUrl: 'http://agent.localhost:1/' });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>'));
  assert.ok(xml.includes(`<URI>${TASK_NAME}</URI>`));
  assert.ok(xml.includes('<Command>C:\\Windows\\System32\\conhost.exe</Command>'));
  assert.ok(xml.includes(`<Arguments>${args.replace(/"/g, '&quot;')}</Arguments>`));
  assert.ok(xml.includes(`<WorkingDirectory>${app}</WorkingDirectory>`));
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>PC\\pat<\/UserId>\s*<Delay>PT(\d+)S<\/Delay>\s*<\/LogonTrigger>/);
  // Not in the second of sign-in (every agent's start failed there), each agent at its own time, the same each time.
  const delay = Number(/<Delay>PT(\d+)S<\/Delay>/.exec(xml)![1]);
  assert.equal(delay, signInDelaySeconds(APP.id));
  assert.equal(signInDelaySeconds('porter'), signInDelaySeconds('porter'));
  const spread = new Set(['manor', 'steward', 'reeve', 'porter', 'surveyor', 'smith', 'miller', 'herald', 'clerk', 'pinder'].map(signInDelaySeconds));
  assert.ok(spread.size >= 8, 'agents start at different times');
  assert.ok([...spread].every((s) => s >= 30 && s <= 180));
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>5<\/Count>\s*<\/RestartOnFailure>/, 'a start that fails is tried again');
  for (const part of ['<LogonType>InteractiveToken</LogonType>', '<RunLevel>LeastPrivilege</RunLevel>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<Hidden>true</Hidden>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>', '<Priority>7</Priority>']) {
    assert.ok(xml.includes(part), part);
  }
  assert.ok(xml.includes('http://agent.localhost:1/'));
  assert.ok(xml.includes(`Remove with: node ${app}\\src\\cli.ts uninstall`));
  const bytes = utf16(xml);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], 'UTF-16 LE with a byte-order mark');
  assert.equal(bytes.subarray(2).toString('utf16le'), xml);
});

// ---------------------------------------------------------------- a task folder for each account

test("each account's tasks are in a folder of its own, named after the agent and the profile folder", () => {
  assert.equal(taskAccount({ USERPROFILE: 'C:\\Users\\Jcoll', USERNAME: 'jeremy' }), 'Jcoll', "the profile folder's name, which renaming the account doesn't change");
  assert.equal(taskAccount({ USERPROFILE: 'C:\\Users\\Pat Smith\\' }), 'Pat Smith');
  assert.equal(taskAccount({ USERPROFILE: 'C:\\Users\\a:b*c?"d<e>f|g' }), 'a_b_c__d_e_f_g', "what Task Scheduler won't take in a name");
  assert.equal(taskAccount({ USERNAME: 'pat' }), 'pat', "the user's name without a profile folder");
  assert.equal(taskAccount({}), 'user');
  const env = { USERPROFILE: 'C:\\Users\\Jcoll' };
  assert.equal(taskName('Home page', env), `\\${APP.name} (Jcoll)\\Home page`);
  assert.equal(taskName('Wake', env), `\\${APP.name} (Jcoll)\\Wake`);
  assert.equal(taskName('Home page', env, 'Manor'), '\\Manor (Jcoll)\\Home page', "another program's, as Manor names its own");
  assert.equal(WAKE_TASK_NAME, taskName('Wake'));
  assert.equal(OLD_TASK_NAME, `\\${APP.name}\\Home page`, 'the name before kit 2.95.0');
  assert.equal(OLD_WAKE_TASK_NAME, `\\${APP.name}\\Wake`);
  assert.ok(homePageTaskXml({ node: 'C:\\node.exe', app: 'C:\\a', user: 'PC\\pat', pageUrl: 'http://a.localhost:1/' }).includes(`<URI>${TASK_NAME}</URI>`));
});

test("a task is this account's own when its principal is this user: by SID, or by name; not by its logon trigger", async () => {
  const answer = (out: string | null) => ({ schtasks: async () => (out === null ? { code: 1, out: 'ERROR: The system cannot find the file specified.' } : { code: 0, out }), user: 'PC\\pat', userSid: async () => MY_SID });
  assert.equal(await isOwnTask(OLD_TASK_NAME, answer(queriedXml(OLD_TASK_NAME, MY_SID))), true);
  assert.equal(await isOwnTask(OLD_TASK_NAME, answer(queriedXml(OLD_TASK_NAME, MY_SID.toLowerCase()))), true, 'a SID in any case');
  assert.equal(await isOwnTask(OLD_TASK_NAME, answer(queriedXml(OLD_TASK_NAME, THEIR_SID))), false, "another account's");
  assert.equal(await isOwnTask(OLD_TASK_NAME, answer(queriedXml(OLD_TASK_NAME, THEIR_SID, MY_SID))), false, "the principal's user decides, not the logon trigger's");
  assert.equal(await isOwnTask(OLD_TASK_NAME, answer(queriedXml(OLD_TASK_NAME, 'PC\\pat'))), true, 'a name, as Task Scheduler may keep it');
  assert.equal(await isOwnTask(OLD_TASK_NAME, answer(queriedXml(OLD_TASK_NAME, 'pat'))), true, 'the name alone');
  assert.equal(await isOwnTask(OLD_TASK_NAME, answer(queriedXml(OLD_TASK_NAME, 'PC\\sam'))), false);
  assert.equal(await isOwnTask(OLD_TASK_NAME, answer(queriedXml(OLD_TASK_NAME, 'OTHERPC\\pat'))), false, 'another domain\'s user of the same name');
  assert.equal(await isOwnTask(OLD_TASK_NAME, answer(null)), false, 'no such task');
  assert.equal(await isOwnTask(OLD_TASK_NAME, answer('<Task></Task>')), false, 'no principal');
  assert.equal(await isOwnTask(OLD_TASK_NAME, { ...answer(queriedXml(OLD_TASK_NAME, MY_SID)), userSid: async () => null }), false, "this user's SID unknown: never taken for ours");
});

test("an install moves this account's own tasks off their old names, and leaves another account's be", async () => {
  // This account's old tasks: the home page by SID, the wake task by name.
  const p = place();
  const f = fakes({ root: p.release, data: p.data });
  f.state.tasks.set(OLD_TASK_NAME, MY_SID).set(OLD_WAKE_TASK_NAME, 'PC\\pat');
  assert.equal(await install({}, f.deps), 0, f.lines.join('\n'));
  assert.deepEqual(f.calls.map((c) => c.slice(0, 3)), [
    ['/Create', '/TN', TASK_NAME],
    ['/Query', '/TN', OLD_TASK_NAME],
    ['/End', '/TN', OLD_TASK_NAME],
    ['/Delete', '/TN', OLD_TASK_NAME],
    ['/Query', '/TN', OLD_WAKE_TASK_NAME],
    ['/End', '/TN', OLD_WAKE_TASK_NAME],
    ['/Delete', '/TN', OLD_WAKE_TASK_NAME],
    ['/Run', '/TN', TASK_NAME],
  ]);
  assert.deepEqual([...f.state.tasks.keys()], [TASK_NAME]);
  const said = f.lines.join('\n');
  assert.ok(said.includes(`Its task ${OLD_TASK_NAME} is ${TASK_NAME} now, in this account's own folder.`), said);
  assert.ok(said.includes(`Its task ${OLD_WAKE_TASK_NAME} is gone: its page registers ${WAKE_TASK_NAME} as it starts.`), said);

  // Another account's, of the same names: never ended, never deleted.
  const q = place();
  const g = fakes({ root: q.release, data: q.data });
  g.state.tasks.set(OLD_TASK_NAME, THEIR_SID).set(OLD_WAKE_TASK_NAME, 'PC\\sam');
  assert.equal(await install({}, g.deps), 0, g.lines.join('\n'));
  assert.deepEqual(verbs(g.calls), ['/Create', ...OLD_LOOKS, '/Run']);
  assert.deepEqual([...g.state.tasks.keys()].sort(), [OLD_TASK_NAME, OLD_WAKE_TASK_NAME, TASK_NAME].sort());
  assert.doesNotMatch(g.lines.join('\n'), /in this account's own folder|is gone/);

  // A task that couldn't be registered under its new name leaves the old one working.
  const r = place();
  const h = fakes({ root: r.release, data: r.data });
  h.state.tasks.set(OLD_TASK_NAME, MY_SID);
  const schtasks = h.deps.schtasks;
  h.deps.schtasks = async (args) => (args[0] === '/Create' ? (h.calls.push(args), { code: 1, out: 'ERROR: Access is denied.' }) : schtasks(args));
  assert.equal(await install({}, h.deps), 1);
  assert.deepEqual(verbs(h.calls), ['/Create']);
  assert.ok(h.state.tasks.has(OLD_TASK_NAME));
});

test("uninstall deletes the tasks by their new names, and by the old ones only where they're this account's", async () => {
  const p = place();
  const f = fakes({ root: p.release, data: p.data });
  assert.equal(await install({ noStart: true }, f.deps), 0);
  f.state.tasks.set(OLD_TASK_NAME, MY_SID).set(OLD_WAKE_TASK_NAME, THEIR_SID);
  f.calls.length = 0;
  assert.equal(await uninstall({}, f.deps), 0, f.lines.join('\n'));
  assert.deepEqual(f.calls.filter((c) => c[0] === '/Delete').map((c) => c[2]), [TASK_NAME, OLD_TASK_NAME]);
  assert.deepEqual([...f.state.tasks.keys()], [OLD_WAKE_TASK_NAME], "another account's task of the old name stays");
  assert.ok(f.lines.includes(`Deleted the task ${OLD_TASK_NAME}.`));
});

test("a task is run by its new name, else by its old one only when that's this account's", async () => {
  const fake = (tasks: Record<string, string>) => {
    const runs: string[] = [];
    const d = {
      user: 'PC\\pat',
      userSid: async () => MY_SID,
      schtasks: async (args: string[]) => {
        const [verb, , name] = args;
        if (!(name in tasks)) return { code: 1, out: 'ERROR: The system cannot find the file specified.' };
        if (verb === '/Run') runs.push(name);
        return { code: 0, out: verb === '/Query' ? queriedXml(name, tasks[name]) : 'SUCCESS' };
      },
    };
    return { d, runs };
  };
  const both = fake({ [TASK_NAME]: MY_SID, [OLD_TASK_NAME]: MY_SID });
  assert.equal((await runOwnTask([TASK_NAME, OLD_TASK_NAME], both.d)).name, TASK_NAME);
  assert.deepEqual(both.runs, [TASK_NAME], 'the new name first');

  const old = fake({ [OLD_TASK_NAME]: MY_SID });
  const ran = await runOwnTask([TASK_NAME, OLD_TASK_NAME], old.d);
  assert.deepEqual([ran.code, ran.name, old.runs], [0, OLD_TASK_NAME, [OLD_TASK_NAME]], 'an older install of this account');

  const theirs = fake({ [OLD_TASK_NAME]: THEIR_SID });
  const none = await runOwnTask([TASK_NAME, OLD_TASK_NAME], theirs.d);
  assert.deepEqual([none.code, none.name, theirs.runs], [1, TASK_NAME, []], "another account's is never run");
  assert.match(none.out, /cannot find/);

  assert.equal(await dropOldTask(OLD_TASK_NAME, theirs.d), false, "and never dropped");
  assert.equal(await dropOldTask(OLD_TASK_NAME, fake({}).d), false, 'a task that isn\'t there');
});

// ---------------------------------------------------------------- install

test("with Castellan in Startup apps, Manor starts the staff: the task has no sign-in trigger, and runs only when asked", async () => {
  const xml = homePageTaskXml({ node: 'C:\\node.exe', app: 'C:\\Users\\pat\\.agent\\app', user: 'PC\\pat', pageUrl: 'http://agent.localhost:1/', atSignIn: false });
  assert.doesNotMatch(xml, /LogonTrigger/);
  assert.match(xml, /<Triggers><\/Triggers>/);
  assert.match(xml, /Castellan starts it at sign-in/);
  assert.equal(MANOR_STARTUP.key, 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
  assert.equal(MANOR_STARTUP.value, 'Castellan', "Manor's install.ts STARTUP_VALUE");

  const p = place();
  const f = fakes({ root: p.release, data: p.data });
  f.deps.manorStarts = async () => true;
  assert.equal(await install({}, f.deps), 0);
  const registered = readFileSync(taskXmlFile(p.data)).subarray(2).toString('utf16le');
  assert.doesNotMatch(registered, /LogonTrigger/, 'Manor starts it at sign-in');
  assert.deepEqual(verbs(f.calls), ['/Create', ...OLD_LOOKS, '/Run'], 'the install still starts it through its task');
  assert.ok(f.lines.some((l) => /task: .+ \(open, when asked: Manor starts it at sign-in\)/.test(l)));

  // Without Manor's entry: at sign-in, as before.
  const q = place();
  const g = fakes({ root: q.release, data: q.data });
  g.deps.manorStarts = async () => false;
  assert.equal(await install({}, g.deps), 0);
  assert.match(readFileSync(taskXmlFile(q.data)).subarray(2).toString('utf16le'), /<LogonTrigger>/);
});

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
  assert.deepEqual(verbs(f.calls), ['/Create', ...OLD_LOOKS, '/Run']);
  assert.deepEqual(f.calls[0], ['/Create', '/TN', TASK_NAME, '/XML', taskXmlFile(p.data), '/F']);
  assert.deepEqual(f.calls[1], ['/Query', '/TN', OLD_TASK_NAME, '/XML']);
  assert.deepEqual(f.calls[2], ['/Query', '/TN', OLD_WAKE_TASK_NAME, '/XML']);
  assert.deepEqual(f.calls[3], ['/Run', '/TN', TASK_NAME]);
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
  assert.deepEqual(verbs(f.calls), ['/Create', ...OLD_LOOKS, '/Run']);
  assert.match(f.lines.join('\n'), /updated from 1\.0\.0[\s\S]*off duty/);
});

/**
 * An update whose new page, once /Run starts it, answers `upAfterMs` later (null: never), its process there until
 * `goneAfterMs` (null: throughout). The clock moves only as the install sleeps.
 */
async function slowStart(upAfterMs: number | null, goneAfterMs: number | null = null) {
  const p = place();
  const app = appFolder(p.data);
  mkdirSync(path.join(app, 'src'), { recursive: true });
  writeFileSync(path.join(app, 'release.json'), JSON.stringify({ version: '1.0.0' }));
  const f = fakes({ root: p.release, data: p.data, up: true });
  let t = 0;
  let ranAt: number | null = null;
  const looked: string[] = [];
  const schtasks = f.deps.schtasks;
  f.deps.schtasks = async (args) => {
    if (args[0] !== '/Run') return schtasks(args);
    ranAt = t;
    return { code: 0, out: 'SUCCESS' };
  };
  f.deps.sleep = async (ms) => {
    t += ms;
  };
  f.deps.ping = async () => (ranAt === null ? f.state.up : upAfterMs !== null && t - ranAt >= upAfterMs);
  f.deps.pagesStarting = async (dir) => {
    looked.push(dir);
    return ranAt !== null && (goneAfterMs === null || t - ranAt < goneAfterMs) ? [4242] : [];
  };
  const code = await install({}, f.deps);
  return { code, lines: f.lines.join('\n'), app, looked, waited: ranAt === null ? 0 : t - ranAt };
}

test('a page slow to start on a busy PC is waited for while its process is there, not taken for a broken release (kit 2.75.2)', async () => {
  const quick = await slowStart(3_000);
  assert.equal(quick.code, 0, quick.lines);
  assert.deepEqual(quick.looked, [], 'a page up within 20 s: no process looked for');
  assert.match(quick.lines, /page: .*\(up\)/);

  // The Steward's 0.36.46 answered later than the 20 s an install gave it, and was rolled back for it.
  const slow = await slowStart(90_000);
  assert.equal(slow.code, 0, slow.lines);
  assert.ok(slow.looked.length > 0 && slow.looked.every((d) => d === slow.app), 'its process looked for under app');
  assert.match(slow.lines, /page: .*\(up, after \d+ s: the PC is busy\)/);
  assert.ok(slow.waited >= 90_000 && slow.waited < 100_000, `answered at ${slow.waited} ms`);
});

test("a page whose process has ended isn't waited for past the first 20 s, and one still starting after 5 minutes is given up on", async () => {
  const gone = await slowStart(null, 5_000);
  assert.equal(gone.code, 1);
  assert.match(gone.lines, /didn't answer, and its process has ended; see .*serve\.log/);
  assert.ok(gone.waited <= 21_000, `waited ${gone.waited} ms`);

  const stuck = await slowStart(null);
  assert.equal(stuck.code, 1);
  assert.match(stuck.lines, /still starting after 5 minutes; see .*serve\.log/);
  assert.ok(stuck.waited >= PAGE_START_MS && stuck.waited < PAGE_START_MS + 10_000, `waited ${stuck.waited} ms`);
});

test("an update that moves the port ends the old page on the old port, where this version's ping can't see it", async () => {
  const p = place();
  const app = appFolder(p.data);
  mkdirSync(path.join(app, 'src'), { recursive: true });
  writeFileSync(path.join(app, 'release.json'), JSON.stringify({ version: '1.0.0' }));
  const f = fakes({ root: p.release, data: p.data });
  // The old page answers only on the port server.json says it took: running, though ping (the new port) says no.
  let old = true;
  f.deps.running = async () => old || f.state.up;
  const shutdown = f.deps.shutdown;
  f.deps.shutdown = async () => {
    old = false;
    return shutdown();
  };
  assert.equal(await install({}, f.deps), 0, f.lines.join('\n'));
  assert.equal(f.state.shutdowns, 1, 'the old page was ended, so it no longer holds the old port');
  assert.equal(old, false);
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

test('the release is on the disk before it is swapped in, so a crash after the swap finds it whole', async () => {
  const { f } = installed();
  const order: string[] = [];
  f.deps.flush = (dir) => {
    assert.equal(readFileSync(path.join(dir, 'src', 'cli.ts'), 'utf8'), '// the new cli\n', 'flushed once copied');
    order.push(`flush ${path.basename(dir)}`);
  };
  f.deps.rename = (from, to) => {
    order.push(`rename ${path.basename(from)} ${path.basename(to)}`);
    renameSync(from, to);
  };
  assert.equal(await install({}, f.deps), 0, f.lines.join('\n'));
  assert.deepEqual(order, ['flush app.new', 'rename app app.old', 'rename app.new app']);

  // Copied into an app that can't be moved: what it was copied into is flushed.
  const held = installed();
  const flushed: string[] = [];
  held.f.deps.flush = (dir) => flushed.push(path.basename(dir));
  held.f.deps.rename = (from, to) => {
    if (from === held.app) throw busy();
    renameSync(from, to);
  };
  assert.equal(await install({}, held.f.deps), 0, held.f.lines.join('\n'));
  assert.deepEqual(flushed, ['app.new', 'app']);
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
  assert.deepEqual(verbs(f.calls), ['/Create', ...OLD_LOOKS, '/Run']);
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
  assert.deepEqual(verbs(f.calls), ['/Create', ...OLD_LOOKS]);
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
  // The agent woke the PC for its work (wake.ts): that task goes too.
  f.state.tasks.set(WAKE_TASK_NAME, MY_SID);
  assert.equal(await uninstall({}, f.deps), 0, f.lines.join('\n'));
  assert.deepEqual(verbs(f.calls), ['/Query', '/End', '/Delete', '/Query', '/End', '/Delete', ...OLD_LOOKS]);
  assert.deepEqual(f.calls[2], ['/Delete', '/TN', TASK_NAME, '/F']);
  assert.deepEqual(f.calls[5], ['/Delete', '/TN', WAKE_TASK_NAME, '/F']);
  assert.deepEqual([...f.state.tasks], []);
  assert.equal(f.state.shutdowns, 1);
  assert.ok(!existsSync(appFolder(p.data)));
  assert.ok(!existsSync(taskXmlFile(p.data)));
  assert.ok(existsSync(path.join(p.data, 'state.json')), 'the data stays');

  f.calls.length = 0;
  assert.equal(await uninstall({ purge: true }, f.deps), 0, 'a task that is already gone is fine');
  assert.deepEqual(verbs(f.calls), ['/Query', '/Query', ...OLD_LOOKS]);
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

test("--purge removes only a folder of the agent's own: never a drive, the profile, its folders or a repository", async () => {
  const p = place();
  const profile = path.join(p.dir, 'Users', 'jo');
  const env = { USERPROFILE: profile, LOCALAPPDATA: path.join(profile, 'AppData', 'Local'), APPDATA: path.join(profile, 'AppData', 'Roaming'), ProgramFiles: path.join(p.dir, 'Program Files') };
  const refused = (dir: string) => purgeRefusal(dir, profile, env);
  assert.equal(refused(path.join(profile, `.${APP.id}`)), null, 'its own data folder');
  assert.equal(refused(path.join(p.dir, 'data', APP.id)), null, `a <ID>_HOME named for it`);
  assert.match(String(refused(path.parse(p.dir).root)), /whole drive/);
  assert.match(String(refused(profile)), /it is /);
  assert.match(String(refused(path.join(profile, 'Documents'))), /it is .*Documents/);
  assert.match(String(refused(path.join(profile, 'AppData'))), /it holds .*Local/, 'a folder holding AppData\\Local');
  assert.match(String(refused(path.join(p.dir, 'Program Files'))), /it is /);
  const stuff = path.join(p.dir, 'stuff');
  mkdirSync(stuff, { recursive: true });
  assert.match(String(refused(stuff)), /isn't named for/, 'a folder of something else');
  mkdirSync(appFolder(stuff), { recursive: true });
  assert.match(String(refused(stuff)), /isn't named for/, "an app folder that isn't a release of the agent's doesn't make it the agent's");
  cpSync(path.join(p.release, 'release.json'), path.join(appFolder(stuff), 'release.json'));
  assert.equal(refused(stuff), null, 'unless it holds a copy of the agent');
  const clone = path.join(p.dir, `${APP.id}-clone`);
  mkdirSync(path.join(clone, '.git'), { recursive: true });
  assert.match(String(refused(clone)), /git repository/);

  // uninstall --purge with a <ID>_HOME that's someone's projects: nothing is removed, not even the program.
  const projects = path.join(p.dir, 'projects');
  mkdirSync(path.join(projects, 'mine'), { recursive: true });
  writeFileSync(path.join(projects, 'mine', 'work.txt'), 'mine');
  const f = fakes({ root: p.release, data: projects });
  assert.equal(await uninstall({ purge: true }, f.deps), 2);
  assert.match(f.lines.join('\n'), /isn't one uninstall may touch: it isn't named for/);
  assert.deepEqual(f.calls, []);
  assert.ok(existsSync(path.join(projects, 'mine', 'work.txt')));

  // The profile, holding a copy of the agent: a plain uninstall would remove only that copy, but --purge nothing.
  const pf = fakes({ root: p.release, data: profile });
  pf.deps.home = profile;
  mkdirSync(appFolder(profile), { recursive: true });
  cpSync(path.join(p.release, 'release.json'), path.join(appFolder(profile), 'release.json'));
  assert.equal(await uninstall({ purge: true }, pf.deps), 2);
  assert.match(pf.lines.join('\n'), /--purge won't remove it/);
  assert.deepEqual(pf.calls, []);
  assert.ok(existsSync(appFolder(profile)));
});

test("an empty, relative or someone else's data folder: uninstall and install refuse, and touch nothing, not even a task (kit 2.136.6)", async (t) => {
  const p = place();
  // `.\app` in the folder the command runs from, where an empty or relative <ID>_HOME put the program: the person's own.
  const cwd = path.join(p.dir, 'somewhere');
  const theirs = appFolder(cwd);
  mkdirSync(theirs, { recursive: true });
  writeFileSync(path.join(theirs, 'mine.txt'), 'mine');
  const was = process.cwd();
  process.chdir(cwd);
  t.after(() => process.chdir(was));
  const untouched = (f: ReturnType<typeof fakes>, what: string) => {
    assert.deepEqual(f.calls, [], `${what}: no task asked about, ended or deleted`);
    assert.equal(f.state.shutdowns, 0, `${what}: no page ended`);
    assert.ok(f.state.tasks.has(TASK_NAME), `${what}: the task stays`);
    assert.deepEqual(readdirSync(cwd), ['app'], `${what}: no app.new or app.old beside it`);
    assert.deepEqual(readdirSync(theirs), ['mine.txt'], `${what}: the folder that was .\\app is as it was`);
  };
  for (const data of ['', '  ', 'relative', '.', 'app\\..', '\\on-this-drive', 'C:on-this-drive']) {
    for (const purge of [false, true]) {
      const f = fakes({ root: p.release, data });
      f.state.tasks.set(TASK_NAME, MY_SID);
      assert.equal(await uninstall({ purge }, f.deps), 2, `uninstall${purge ? ' --purge' : ''} with ${JSON.stringify(data)}`);
      assert.match(f.lines.join('\n'), /isn't one uninstall may touch: it (is empty|isn't a full path, such as C:\\Users\\you\\\.fixture)\. So nothing was removed, and no task deleted\. Set FIXTURE_HOME to the full path/);
      untouched(f, `uninstall with ${JSON.stringify(data)}`);
    }
    const i = fakes({ root: p.release, data });
    i.state.tasks.set(TASK_NAME, MY_SID);
    assert.equal(await install({}, i.deps), 2, `install with ${JSON.stringify(data)}`);
    assert.match(i.lines.join('\n'), /isn't one install may touch: .*So nothing was installed\./);
    untouched(i, `install with ${JSON.stringify(data)}`);
  }

  // A full path that isn't the agent's: a folder of the person's whose app is theirs.
  const f = fakes({ root: p.release, data: cwd });
  f.state.tasks.set(TASK_NAME, MY_SID);
  assert.equal(await uninstall({}, f.deps), 2);
  assert.match(f.lines.join('\n'), /isn't one uninstall may touch: its .*app isn't Fixture's: it holds no release\.json of Fixture's/);
  untouched(f, "someone else's app");
  const i = fakes({ root: p.release, data: cwd });
  i.state.tasks.set(TASK_NAME, MY_SID);
  assert.equal(await install({}, i.deps), 2);
  untouched(i, "install over someone else's app");
  // Nor one with no app at all, but not the agent's either: nothing to uninstall there.
  const empty = path.join(p.dir, 'empty');
  mkdirSync(empty);
  const e = fakes({ root: p.release, data: empty });
  assert.equal(await uninstall({}, e.deps), 2);
  assert.match(e.lines.join('\n'), /it isn't named for Fixture, and holds no copy of it/);
  assert.deepEqual(e.calls, []);

  // The agent installed into a folder not named for it (a <ID>_HOME of D:\data, say): its copy says it's the agent's.
  const elsewhere = path.join(p.dir, 'data');
  const g = fakes({ root: p.release, data: elsewhere });
  assert.equal(await install({ noStart: true }, g.deps), 0, g.lines.join('\n'));
  assert.equal(await install({ noStart: true }, g.deps), 0, 'and updated there');
  writeFileSync(path.join(elsewhere, 'state.json'), '{}');
  assert.equal(await uninstall({}, g.deps), 0, g.lines.join('\n'));
  assert.ok(!existsSync(appFolder(elsewhere)));
  assert.ok(existsSync(path.join(elsewhere, 'state.json')), 'the data stays');
});

test('a mistyped option is refused before anything is done', async () => {
  assert.equal(await installCli('install', ['--dryrun']), 2);
  assert.equal(await installCli('uninstall', ['--no-start']), 2);
});

// ---------------------------------------------------------------- the release

test('a release carries src (no tests) with the kit in src/kit, art, package.json, LICENSE, kit.json and tools/kit.ts, and nothing else: no README, no document', () => {
  const picked = pickReleaseFiles([
    'src/cli.ts', 'src\\watch\\index.ts', 'src/ocr.ps1', 'src/thing.test.ts', 'src/kit/npu.ts', 'src/kit/VERSION', 'src/kit/spec/RELEASES.md', 'art/icon.svg', 'package.json', 'README.md', 'LICENSE',
    'test/agent.test.ts', 'tools/kit.ts', 'tools\\convert.ts', 'kit.json', 'tsconfig.json', 'package-lock.json', '.gitignore', 'artifacts/x/X-1.zip', 'node_modules/typescript/package.json', 'docs/x.md',
  ]);
  assert.deepEqual(picked, ['LICENSE', 'art/icon.svg', 'kit.json', 'package.json', 'src/cli.ts', 'src/kit/VERSION', 'src/kit/npu.ts', 'src/ocr.ps1', 'src/watch/index.ts', 'tools/kit.ts']);

  const own = pickReleaseFiles(repoFiles(appRoot));
  for (const f of ['src/cli.ts', 'src/app.ts', 'src/kit/install.ts', 'src/kit/release.ts', 'src/kit/minify.ts', 'art/icon.svg', 'package.json']) assert.ok(own.includes(f), f);
  assert.ok(own.every((f) => f.startsWith('src/') || f.startsWith('art/') || ['package.json', 'LICENSE', 'kit.json', 'tools/kit.ts'].includes(f)));
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

/** A manor-agent.json Manor would take, for the fixture's agent: it names no repository. */
const announcement = (agent: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => ({
  agent: {
    id: APP.id, name: APP.name, role: 'Keeps a fixture', fills: ['fixture'],
    paths: { app: [`%USERPROFILE%\\.${APP.id}\\app`] },
    release: { kind: 'node' },
    ...agent,
  },
  ...more,
});

test("a release's manor-agent.json is checked as Manor checks it: this agent, a Node release, installed in .<id>\\app, naming no repository", () => {
  const repo = 'someone/Fixture';
  assert.equal(checkAnnouncement(announcement(), APP.id, repo), null);
  assert.equal(checkAnnouncement(announcement(), APP.id, null), null, "no repository named: origin needn't be on GitHub");
  assert.equal(checkAnnouncement(announcement({ release: { repo: 'SOMEONE/fixture', kind: 'node' } }), APP.id, repo), null, "one still named: origin's, in any case");
  assert.equal(checkAnnouncement(announcement({}, { roles: [{ id: 'fixture', name: 'Fixture' }] }), APP.id, repo), null, 'with the roles it brings');

  assert.match(checkAnnouncement(announcement({ release: { repo: 'someone/Other', kind: 'node' } }), APP.id, repo)!, /names someone\/Other as its "release\.repo", but origin is someone\/Fixture\. Leave "release\.repo" out/);
  assert.match(checkAnnouncement(announcement({ release: { repo: null, kind: 'node' } }), APP.id, repo)!, /names no repository/);
  assert.match(checkAnnouncement(announcement({ release: { repo: 'someone/Fixture', kind: 'node' } }), APP.id, null)!, /origin is not on GitHub/);
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
  assert.equal(announcementOf(dir, APP.id, 'someone/Fixture'), null, 'no manor-agent.json: the release is as before');

  writeFileSync(path.join(dir, ANNOUNCEMENT), '\uFEFF' + JSON.stringify(announcement(), null, 2));
  assert.deepEqual(announcementOf(dir, APP.id, 'someone/Fixture'), { file: path.join(dir, 'manor-agent.json') });
  writeFileSync(path.join(dir, ANNOUNCEMENT), JSON.stringify(announcement({ release: { repo: 'someone/Fixture', kind: 'node' } })));
  assert.match((announcementOf(dir, APP.id, 'someone/Fork') as { error: string }).error, /but origin is someone\/Fork.*Fix it, or remove it, and release again\.$/);
  assert.match((announcementOf(dir, 'other', 'someone/Fixture') as { error: string }).error, /but this release is "other"/);

  writeFileSync(path.join(dir, ANNOUNCEMENT), '{ "agent": ');
  assert.match((announcementOf(dir, APP.id, 'someone/Fixture') as { error: string }).error, /^manor-agent\.json isn't JSON/);
});

test('SHA256SUMS.txt lists the zip, and manor-agent.json after it, as sha256sum writes them', () => {
  assert.equal(sumsText([{ name: 'Fixture-1.0.0.zip', hash: 'ab'.repeat(32) }]), `${'ab'.repeat(32)}  Fixture-1.0.0.zip\n`);
  assert.equal(
    sumsText([{ name: 'Fixture-1.0.0.zip', hash: 'ab'.repeat(32) }, { name: ANNOUNCEMENT, hash: 'cd'.repeat(32) }]),
    `${'ab'.repeat(32)}  Fixture-1.0.0.zip\n${'cd'.repeat(32)}  manor-agent.json\n`,
  );
});

test("the zip's name has no spaces: GitHub stores one as a dot, which SHA256SUMS.txt and Manor wouldn't match", () => {
  assert.equal(zipName('Porter', '0.4.17'), 'Porter-0.4.17.zip');
  assert.equal(zipName('Developer Herald', '0.5.3'), 'DeveloperHerald-0.5.3.zip');
});

/**
 * The release builds beyond the first (a readable one, a dirty one, one without an announcement): STEWARD_RELEASE_TESTS=1,
 * which `npm run test:release` sets and tools/kit-release.ts runs before it publishes a kit. Every other run builds once:
 * each build stages, minifies and packs the whole kit, and what the others add is tested without a build above.
 */
const FULL_RELEASE = process.env.STEWARD_RELEASE_TESTS === '1';

test('npm run release copies manor-agent.json beside the zip and lists it in SHA256SUMS.txt; a mismatched one builds nothing', { skip: process.platform !== 'win32' && 'needs Windows tar.exe' }, () => {
  // A copy of the fixture as an agent's own repository, from Jcollier0120/Fixture, committed, its kit filled.
  const repo = path.join(tmp, 'fixture-repo');
  cpSync(appRoot, repo, { recursive: true });
  writeFileSync(path.join(repo, 'kit.json'), JSON.stringify({ kit: readFileSync(path.join(appRoot, 'src', 'kit', 'VERSION'), 'utf8').trim() }) + '\n');
  writeFileSync(path.join(repo, '.gitignore'), 'artifacts/\nsrc/kit/\n');
  writeFileSync(path.join(repo, ANNOUNCEMENT), JSON.stringify(announcement(), null, 2) + '\n');
  // A changelog of 25 versions: the release carries its opening and newest 20, for About's What's new (kit 2.143.0).
  const versions = Array.from({ length: 25 }, (_, i) => `0.0.${25 - i}`);
  writeFileSync(path.join(repo, 'CHANGELOG.md'), ["# Fixture's changelog", '', ...versions.flatMap((v) => [`## ${v}`, '', `**${v}.**`, ''])].join('\n'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: repo, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/Jcollier0120/Fixture.git');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  // The fixture's copy has no node_modules: esbuild is the Steward checkout's (STEWARD_ESBUILD).
  const env = { ...process.env, STEWARD_ESBUILD: path.resolve(appRoot, '..', '..', '..') };
  const release = (...args: string[]) => spawnSync(process.execPath, [path.join(repo, 'src', 'kit', 'release.ts'), ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, env });
  const out = path.join(repo, 'artifacts', APP.id);
  const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
  // Each build stages and packs the whole kit, and Defender reads every file tar does: so the zip is listed, and only
  // what the built copy needs to run is unpacked. One build, the minified one as released, and 2 more with FULL_RELEASE;
  // there were 5, and 2 whole unpackings.
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const zipOf = () => path.join(out, readdirSync(out).find((f) => f.endsWith('.zip'))!);
  const listed = () => execFileSync(tar, ['-t', '-f', zipOf()], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter((f) => f && !f.endsWith('/'));

  let r = release();
  assert.equal(r.status, 0, r.stderr);
  const zip = `${APP.name}-${pkg.version}.zip`;
  assert.equal(zipOf(), path.join(out, zip));
  // Built: no TypeScript but the entry's stub, no README, release.json says so; and the built copy runs.
  const files = listed();
  assert.deepEqual(files.filter((f) => f.endsWith('.ts') && !f.startsWith('tools/')), ['src/cli.ts']);
  assert.ok(files.includes('src/cli.js') && files.includes('src/kit/install.js') && files.includes('src/kit/release.js'));
  assert.ok(!files.includes('README.md'));
  assert.deepEqual(files.filter((f) => /\.md$/i.test(f)), ['CHANGELOG.md'], 'no document, the kit\'s included, but its changelog\'s newest entries');
  assert.ok(files.includes('THIRD-PARTY-NOTICES.txt') && files.includes('src/kit/geniex/NOTICE'));
  const built = path.join(tmp, 'built');
  mkdirSync(built, { recursive: true });
  execFileSync(tar, ['-x', '-f', zipOf(), '-C', built, 'src', 'package.json', 'release.json', 'THIRD-PARTY-NOTICES.txt', 'CHANGELOG.md'], { windowsHide: true });
  const carried = readFileSync(path.join(built, 'CHANGELOG.md'), 'utf8');
  assert.deepEqual([...carried.matchAll(/^## (.+)$/gm)].map((m) => m[1]), versions.slice(0, 20), 'its newest 20 entries');
  assert.ok(carried.startsWith("# Fixture's changelog\n\n## 0.0.25\n\n**0.0.25.**\n"));
  // Its notices: the kit's vendored builds, each with its license and notice (the fixture has no page to bundle).
  const notices = readFileSync(path.join(built, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  assert.deepEqual(noticeHeadings(notices), ['src\\kit\\geniex', 'src\\kit\\openvino']);
  assert.match(notices, /BSD 3-Clause License[\s\S]*not Qualcomm's release/);
  assert.match(r.stdout, /THIRD-PARTY-NOTICES\.txt: src\\kit\\geniex, src\\kit\\openvino/);
  assert.equal(readFileSync(path.join(built, 'src', 'cli.ts'), 'utf8'), "import './cli.js';\n");
  assert.equal(JSON.parse(readFileSync(path.join(built, 'release.json'), 'utf8')).form, 'minified');
  assert.match(r.stdout, /built with esbuild \d+\.\d+\.\d+: \d+ TypeScript/);
  const ran = spawnSync(process.execPath, [path.join(built, 'src', 'cli.ts'), 'status', '--json'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, FIXTURE_HOME: path.join(tmp, 'built-home') } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(JSON.parse(ran.stdout).app, APP.id, 'the built copy answers as the agent');
  // Its manor-agent.json, as committed, beside the zip and in SHA256SUMS.txt.
  assert.equal(readFileSync(path.join(out, ANNOUNCEMENT), 'utf8'), readFileSync(path.join(repo, ANNOUNCEMENT), 'utf8'), 'the checkout\'s file, as committed');
  assert.equal(readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8'), `${sha(path.join(out, zip))}  ${zip}\n${sha(path.join(out, ANNOUNCEMENT))}  ${ANNOUNCEMENT}\n`);
  assert.match(r.stdout, /manor-agent\.json, announcing/);
  assert.doesNotMatch(r.stdout, /with uncommitted changes/);

  // Readable: for a look on this PC, never published. And a change to manor-agent.json makes the release dirty: it is
  // published, so it must be the commit's (a dirty tree's version is tested without a build: "+dev.<commit>", above).
  if (FULL_RELEASE) {
    writeFileSync(path.join(repo, ANNOUNCEMENT), JSON.stringify(announcement({ role: 'Keeps a fixture well' })) + '\n');
    r = release('--readable');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(listed().includes('src/kit/install.ts'));
    assert.match(r.stdout, /readable: not built/);
    assert.match(r.stdout, /with uncommitted changes/);
  }
  r = release('--readable', '--publish');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /a readable release is never published/);
  // --urgent goes with a publish to the Exchequer, and --exchequer with nothing else but it.
  r = release('--urgent');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--urgent is for a release published to the Exchequer/);
  r = release('--exchequer', '--install');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /give it alone \(or with --urgent\)/);

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

  // None: the zip alone, and an earlier build's manor-agent.json is gone (readable or built, it's the same; without a
  // build, "none is nothing" above).
  if (!FULL_RELEASE) return;
  rmSync(path.join(repo, ANNOUNCEMENT));
  git('commit', '-q', '-am', 'no announcement');
  r = release('--readable');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(path.join(out, ANNOUNCEMENT)));
  assert.equal(readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8'), `${sha(path.join(out, zip))}  ${zip}\n`);
});
