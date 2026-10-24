import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Setting up outside a packaged app (outside.ts, kit 2.113.5): the Claude desktop app is one, and Windows keeps what a
// session in it writes to AppData to the app alone. Which process runs inside one, which paths are AppData, and the
// one-off Task Scheduler task a step runs as instead: Task Scheduler stands in, and the run outside (outside-run.ts)
// runs for real, in a temporary folder.
const home = mkdtempSync(path.join(tmpdir(), 'kit-outside-'));
process.env.REEVE_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const O = await import('./fixture/src/kit/outside.ts');
const RUNNER = fileURLToPath(new URL('./fixture/src/kit/outside-run.ts', import.meta.url));

const CLAUDE = 'C:\\Program Files\\WindowsApps\\Claude_1.1.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe';
// What PROCESS_TABLE_PS prints: a session's node under the Claude app, and the staff's under Task Scheduler.
const TABLE = [
  '4|0|',
  '900|4|C:\\Windows\\System32\\svchost.exe',
  `1200|900|${CLAUDE}`,
  '1300|1200|C:\\Program Files\\Git\\bin\\bash.exe',
  '1400|1300|C:\\Program Files\\nodejs\\node.exe',
  '2000|900|C:\\Windows\\System32\\conhost.exe',
  '2100|2000|C:\\Program Files\\nodejs\\node.exe',
  'not a line',
  '',
].join('\r\n');

test("a packaged app is found among a process's ancestors (Manor's insidePackagedApp, as the kit asks it)", async () => {
  const table = O.parseProcessTable(TABLE);
  assert.equal(table.size, 7, 'the line that is none skipped');
  assert.equal(table.get(1200)?.exe, CLAUDE);
  assert.equal(O.packagedAncestor(table, 1400)?.pid, 1200, "a session's node, under the Claude app");
  assert.equal(O.packagedAncestor(table, 1200)?.pid, 1200, 'the app itself');
  assert.equal(O.packagedAncestor(table, 2100), null, "the staff's, under Task Scheduler");
  assert.equal(O.packagedAncestor(table, 77), null, 'a process the table lacks');
  const loop = O.parseProcessTable('10|11|C:\\a.exe\n11|10|C:\\b.exe');
  assert.equal(O.packagedAncestor(loop, 10), null, 'a loop ends');

  const at = (pid: number, env: NodeJS.ProcessEnv = {}) => O.packagedApp({ pid, table: async () => TABLE, env });
  const win = process.platform === 'win32';
  assert.equal((await at(1400))?.exe, win ? CLAUDE : undefined, 'only Windows has packaged apps');
  assert.equal(await at(2100), null);
  assert.equal(await at(1400, { [O.OUTSIDE_ENV]: '1' }), null, 'a run outside never looks again');
  assert.equal(await O.packagedApp({ pid: 1400, table: async () => Promise.reject(new Error('no CIM')) }), null, "a table that can't be read: none");
  assert.equal(await O.packagedOutsideTests(), null, 'none in a test run');
});

test("AppData is %LOCALAPPDATA%, %APPDATA% and the profile's AppData, in any case; %TEMP% and the rest of the profile aren't", () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\me', TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp' };
  assert.deepEqual(O.appDataFolders(env), [env.LOCALAPPDATA, env.APPDATA, 'C:\\Users\\me\\AppData']);
  for (const p of ['C:\\Users\\me\\AppData\\Local\\GenieX CLI\\geniex.exe', 'c:\\users\\ME\\appdata\\local\\geniex cli\\llama_cpp', 'C:\\Users\\me\\AppData\\Roaming\\x', 'C:\\Users\\me\\AppData\\LocalLow\\y', 'C:\\Users\\me\\AppData\\Local\\']) assert.equal(O.inAppData(p, env), true, p);
  for (const p of ['C:\\Users\\me\\.manor\\accelerators\\servers\\ovms-2026.4.1\\ovms.exe', 'C:\\Users\\me\\.flm\\models', 'C:\\Users\\me\\AppDataX\\z', 'C:\\Users\\me\\AppData\\Local\\Temp\\setup-1', 'C:\\ProgramData\\Castellan\\accelerators', 'relative\\AppData\\Local', '']) assert.equal(O.inAppData(p, env), false, p);
});

test("the run outside keeps the kit's own variables, none that names a secret; its task is a one-off, hidden, as this user", () => {
  const env = { MANOR_HOME: 'C:\\m', REEVE_HOME: 'C:\\r', ACCELERATORS_HOME: 'C:\\a', KIT_PACE: '1', smith_x: 'y', PATH: 'C:\\Windows', GITHUB_TOKEN: 't', MANOR_LICENSE_KEY: 'k', REEVE_API_KEYS: 'k', STEWARD_SECRET: 's', KIT_OUTSIDE: '1', NPU_AGENT_NPU_LOCK: 'C:\\l' };
  assert.deepEqual(O.carriedEnv(env), { MANOR_HOME: 'C:\\m', REEVE_HOME: 'C:\\r', ACCELERATORS_HOME: 'C:\\a', KIT_PACE: '1', smith_x: 'y', NPU_AGENT_NPU_LOCK: 'C:\\l' });
  assert.equal(O.outsideTaskName('ab12cd34', { USERPROFILE: 'C:\\Users\\Jo Smith\\' }), '\\Castellan (Jo Smith)\\Outside the app ab12cd34');
  assert.equal(O.outsideTaskName('ab12cd34', { USERNAME: 'jo' }), '\\Castellan (jo)\\Outside the app ab12cd34');

  const xml = O.outsideTaskXml({ name: '\\Castellan (jo)\\Outside the app 1', user: 'PC\\jo', node: 'C:\\Program Files\\nodejs\\node.exe', folder: 'C:\\Users\\jo\\.manor\\accelerators\\outside\\R&D', what: 'Local AI setup' });
  assert.match(xml, /<Triggers \/>/, 'no trigger: it runs when asked');
  assert.match(xml, /<UserId>PC\\jo<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<Priority>7<\/Priority>/);
  assert.match(xml, /<Command>[^<]*\\conhost\.exe<\/Command>/);
  const args = /<Arguments>([^<]*)<\/Arguments>/.exec(xml)![1];
  assert.match(args, /^--headless &quot;C:\\Program Files\\nodejs\\node\.exe&quot; &quot;[^&]*outside-run\.ts&quot; &quot;C:\\Users\\jo\\\.manor\\accelerators\\outside\\R&amp;D&quot;$/);
  assert.match(xml, /<WorkingDirectory>C:\\Users\\jo\\\.manor\\accelerators\\outside\\R&amp;D<\/WorkingDirectory>/);
  assert.match(xml, /<Description>Local AI setup, run by Task Scheduler outside the app/);
});

/** Task Scheduler, standing in: what it was asked, and on /Run the run it starts (outside-run.ts, unless `run` says otherwise). */
function scheduler(o: { create?: number; run?: number; start?: (folder: string) => void } = {}) {
  const asked: string[][] = [];
  let folder = '';
  const children: Promise<void>[] = [];
  const schtasks = async (args: string[]) => {
    asked.push(args);
    if (args[0] === '/Create') {
      folder = path.dirname(args[2]);
      return { code: o.create ?? 0, out: o.create ? 'ERROR: Access is denied.' : 'SUCCESS' };
    }
    if (args[0] === '/Run') {
      if (o.run) return { code: o.run, out: 'ERROR: The task is disabled.' };
      if (o.start) o.start(folder);
      else {
        const child = spawn(process.execPath, [RUNNER, folder], { stdio: 'ignore', windowsHide: true });
        children.push(new Promise((r) => child.on('exit', () => r())));
      }
      return { code: 0, out: 'SUCCESS' };
    }
    return { code: 0, out: 'SUCCESS' };
  };
  return { schtasks, asked, folder: () => folder, children };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const fast = { everyMs: 20, startMs: 30_000, timeoutMs: 60_000 };

test("the plugin's moves run outside: the kit's build put in with GenieX's own kept, then put back, the task deleted after", async () => {
  const dir = path.join(home, 'patch');
  const llama = path.join(dir, 'GenieX CLI', 'llama_cpp');
  mkdirSync(llama, { recursive: true });
  const target = path.join(llama, 'geniex_plugin.dll');
  const from = path.join(dir, 'build.dll');
  writeFileSync(target, "GenieX's own");
  writeFileSync(from, "Castellan's build");
  const env = { ...process.env, USERNAME: 'jo', MANOR_HOME: path.join(home, 'no-manor'), GITHUB_TOKEN: 'never written' };
  const ts = scheduler();
  const jobs = path.join(home, 'jobs');
  assert.equal(await O.runOutside({ kind: 'patch-in', target, from, want: sha("Castellan's build"), isStock: true }, { ...fast, dir: jobs, env, schtasks: ts.schtasks }), null);
  await Promise.all(ts.children);
  assert.equal(readFileSync(target, 'utf8'), "Castellan's build");
  assert.equal(readFileSync(`${target}.stock`, 'utf8'), "GenieX's own");
  assert.deepEqual(ts.asked.map((a) => a[0]), ['/Create', '/Run', '/Delete']);
  const name = ts.asked[0][4];
  assert.match(name, /^\\Castellan \(.+\)\\Outside the app [0-9a-f]{8}$/);
  assert.deepEqual(ts.asked[2], ['/Delete', '/TN', name, '/F']);
  assert.ok(!existsSync(ts.folder()), 'its folder removed once it succeeded');

  const back = scheduler();
  await O.runOutside({ kind: 'stock-back', target }, { ...fast, dir: jobs, env, schtasks: back.schtasks });
  await Promise.all(back.children);
  assert.equal(readFileSync(target, 'utf8'), "GenieX's own");
  assert.ok(!existsSync(`${target}.stock`) && !existsSync(`${target}.old`));

  // A build that isn't the pinned one: the run's error comes back, and its folder (its log) stays.
  const wrong = scheduler();
  await assert.rejects(O.runOutside({ kind: 'patch-in', target, from, want: sha('another'), isStock: true }, { ...fast, dir: jobs, env, schtasks: wrong.schtasks }), /is [0-9a-f]{64}, not the pinned/);
  await Promise.all(wrong.children);
  assert.equal(readFileSync(target, 'utf8'), "GenieX's own", 'left as it was');
  assert.match(readFileSync(path.join(wrong.folder(), 'log.txt'), 'utf8'), /not the pinned/);
  assert.equal(wrong.asked.at(-1)?.[0], '/Delete', 'its task deleted all the same');
  const job = JSON.parse(readFileSync(path.join(wrong.folder(), 'job.json'), 'utf8'));
  assert.equal(job.env.MANOR_HOME, env.MANOR_HOME);
  assert.equal(job.env.GITHUB_TOKEN, undefined, 'no secret in job.json');
});

test("the run's lines come as it writes them, whole lines only; a run that dies, or never starts, says so; Task Scheduler refusing is OutsideUnavailable", async () => {
  const jobs = path.join(home, 'lines');
  const env = { ...process.env, USERNAME: 'jo' };
  const job = { kind: 'stock-back', target: 'C:\\nowhere\\x.dll' } as const;
  // A run of its own: two lines and half of one; the rest and its result once the first two were passed on.
  const said: string[] = [];
  const lines = scheduler({
    start: (folder) => {
      writeFileSync(path.join(folder, 'pid.json'), JSON.stringify({ pid: process.pid }));
      writeFileSync(path.join(folder, 'log.txt'), 'Looking up what this PC needs\nDownloading GenieX\nUnpack');
      const deadline = Date.now() + 30_000;
      const finish = setInterval(() => {
        if (said.length < 2 && Date.now() < deadline) return;
        clearInterval(finish);
        assert.deepEqual(said, ['Looking up what this PC needs', 'Downloading GenieX'], 'the half line waits for its end');
        writeFileSync(path.join(folder, 'log.txt'), 'Looking up what this PC needs\nDownloading GenieX\nUnpacking\n');
        writeFileSync(path.join(folder, 'result.json'), JSON.stringify({ ok: true, value: { code: 0, entries: [] } }));
      }, 10);
    },
  });
  assert.deepEqual(await O.runOutside(job, { ...fast, dir: jobs, env, schtasks: lines.schtasks, log: (l) => said.push(l) }), { code: 0, entries: [] });
  assert.deepEqual(said, ['Looking up what this PC needs', 'Downloading GenieX', 'Unpacking'], 'the rest passed on before its result');

  // Gone without a result: it stopped part-way.
  const dies = scheduler({
    start: (folder) => {
      const child = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(folder, 'pid.json'))}, JSON.stringify({ pid: process.pid }))`], { stdio: 'ignore' });
      dies.children.push(new Promise((r) => child.on('exit', () => r())));
    },
  });
  await assert.rejects(O.runOutside(job, { ...fast, dir: jobs, env, schtasks: dies.schtasks }), /it stopped without finishing \(its log: .*log\.txt\)/);
  assert.ok(existsSync(dies.folder()), 'its folder kept, for whoever looks');

  const never = scheduler({ start: () => {} });
  await assert.rejects(O.runOutside(job, { ...fast, startMs: 200, dir: jobs, env, schtasks: never.schtasks }), (e: any) => e instanceof O.OutsideUnavailable && /didn't start it within/.test(e.message));
  assert.ok(!existsSync(never.folder()), 'a run that never started leaves nothing');

  for (const [ts, re] of [
    [scheduler({ create: 1 }), /wouldn't take the task \(ERROR: Access is denied\.\)/],
    [scheduler({ run: 1 }), /wouldn't start the task \(ERROR: The task is disabled\.\)/],
  ] as const) {
    await assert.rejects(O.runOutside(job, { ...fast, dir: jobs, env, schtasks: ts.schtasks }), (e: any) => e instanceof O.OutsideUnavailable && re.test(e.message));
    assert.equal(ts.asked.at(-1)?.[0], '/Delete');
    assert.ok(!existsSync(ts.folder()));
  }
  assert.deepEqual(readdirSync(jobs), [path.basename(dies.folder())], "only the run that died left its folder");
});
