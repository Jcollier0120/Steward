import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { paced, until } from './until.ts';

// The agent's name in Task Manager (named.ts): its page started through a launcher named for it, in a job of its own.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-named-'));
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');

const { NAMED_TITLE, namedBuilt, namedExe, namedHeld, namedHold, namedHoldFile, namedId, namedLauncher, namedSource, namedWanted } = await import('./fixture/src/kit/named.ts');
const { pageLaunch } = await import('./fixture/src/kit/service.ts');
const { powershell } = await import('./fixture/src/kit/ps.ts');
const { smartAppControlState } = await import('./fixture/src/kit/app-control.ts');
// The tests that compile a launcher and run it need Windows, and Smart App Control off (kit 2.104.0).
const ownExe = process.platform !== 'win32' || (smartAppControlState() === 'on' && 'Smart App Control is on: it blocks the launcher this test compiles, which nothing signs');

const template = readFileSync(new URL('../node/named.cs', import.meta.url), 'utf8');
const smith = { id: 'smith', name: 'Smith' };
const kitDir = path.join(home, 'kit');

test("the launcher's source: the agent's name written in as its title, once, as a C# string holds it", () => {
  assert.equal(template.split(`"${NAMED_TITLE}"`).length, 2, 'the title, once');
  const s = namedSource('Smith', template);
  assert.ok(s.includes('[assembly: AssemblyTitle("Smith")]'));
  assert.ok(!s.includes(NAMED_TITLE));
  assert.ok(namedSource('A "B" C\\D', template).includes('AssemblyTitle("A \\"B\\" C\\\\D")'), 'quotes and backslashes kept as they are');
  assert.ok(namedSource('Two\r\nlines', template).includes('AssemblyTitle("Two lines")'), 'one line');
});

test('the launcher: in the kit folder, named for the agent and its source, a new one for a new source', () => {
  const exe = namedExe('Smith', 'a', kitDir);
  assert.equal(path.dirname(exe), kitDir);
  assert.match(path.basename(exe), /^named-smith-[0-9a-f]{12}\.exe$/);
  assert.notEqual(exe, namedExe('Smith', 'b', kitDir), 'a running page never holds the exe a new kit compiles');
  assert.notEqual(exe, namedExe('reeve', 'a', kitDir));
  assert.equal(path.basename(path.dirname(namedExe('smith', 'a'))), 'kit', "beside the checks pace's by default");
});

test("an agent's id as the launcher takes it, and who gets one: Windows, and under node --test only with KIT_NAMED=1", () => {
  for (const id of ['smith', 'Smith-dev', 'a1', 'x'.repeat(64)]) assert.ok(namedId(id), id);
  for (const id of ['', 'a b', 'a/b', 'a"b', 'x'.repeat(65), 'é']) assert.ok(!namedId(id), JSON.stringify(id));
  assert.equal(namedWanted(smith, { platform: 'win32', env: {} }), true);
  assert.equal(namedWanted(smith, { platform: 'linux', env: {} }), false);
  assert.equal(namedWanted({ id: 'a b' }, { platform: 'win32', env: {} }), false);
  assert.equal(namedWanted(smith, { platform: 'win32', env: { NODE_TEST_CONTEXT: 'child' } }), false, "a test never builds one in the PC's kit folder");
  assert.equal(namedWanted(smith, { platform: 'win32', env: { NODE_TEST_CONTEXT: 'child', KIT_NAMED: '1' } }), true);
  assert.equal(namedWanted(smith), process.platform === 'win32' && !process.env.NODE_TEST_CONTEXT, 'here, by default');
});

test("open's launcher: the agent's once it's been built, else none (the page starts as node.exe)", () => {
  const dir = path.join(home, 'built');
  const o = { kitDir: dir, platform: 'win32' as const, env: { KIT_NAMED: '1' }, sac: () => 'off' as const };
  assert.equal(namedBuilt(smith, o), null, 'not built yet');
  const exe = namedExe(smith.id, namedSource(smith.name), dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(exe, '');
  assert.equal(namedBuilt(smith, o), exe);
  assert.equal(namedBuilt({ id: 'reeve', name: 'Reeve' }, o), null, "another agent's isn't this one's");
  assert.equal(namedBuilt(smith, { ...o, platform: 'linux' }), null);
  assert.equal(namedBuilt(smith, { kitDir: dir, platform: 'win32', env: { NODE_TEST_CONTEXT: 'child' } }), null);
});

test('Smart App Control on, or Windows weighing it: no launcher, held for every agent until it is off (kit 2.93.1)', () => {
  const dir = path.join(home, 'held');
  const at = (sac: 'on' | 'evaluation' | 'off' | null) => ({ kitDir: dir, platform: 'win32' as const, env: { KIT_NAMED: '1' }, sac: () => sac });
  const exe = namedExe(smith.id, namedSource(smith.name), dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(exe, '');
  assert.equal(namedBuilt(smith, at('off')), exe);
  assert.ok(!existsSync(namedHoldFile(dir)), 'nothing held while it is off');

  for (const sac of ['on', 'evaluation'] as const) {
    assert.equal(namedBuilt(smith, at(sac)), null, sac);
    assert.equal(readFileSync(namedHoldFile(dir), 'utf8'), 'smart-app-control');
  }
  assert.equal(namedBuilt(smith, at(null)), null, "held while its state can't be read");
  assert.equal(namedBuilt(smith, at('off')), exe, 'let go once it is off');
  assert.ok(!existsSync(namedHoldFile(dir)));

  // A block another policy made (an organization's) stays held, whatever Smart App Control's state.
  namedHold('blocked', dir);
  assert.equal(namedHeld(at('off')), true);
  assert.equal(namedBuilt(smith, at('off')), null);
  rmSync(namedHoldFile(dir));
});

test("pageLaunch with the launcher: start runs it, and it the page; an id or path it can't pass, as before", () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const entry = 'C:\\Users\\a b\\.smith\\app\\src\\cli.ts';
  const exe = 'C:\\Users\\a b\\.manor\\kit\\named-smith-0123456789ab.exe';
  const comspec = 'C:\\Windows\\system32\\cmd.exe';
  const line = (named: string) => ['/d', '/s', '/c', `"start "" /b ${named}"${node}" "${entry}" serve"`];
  assert.deepEqual(pageLaunch(node, entry, { platform: 'win32', comspec, named: { exe, id: 'smith' } }).args, line(`"${exe}" smith `));
  assert.deepEqual(pageLaunch(node, entry, { platform: 'win32', comspec, named: { exe, id: 'smith-dev' } }).args, line(`"${exe}" smith-dev `));
  assert.deepEqual(pageLaunch(node, entry, { platform: 'win32', comspec, named: null }).args, line(''));
  assert.deepEqual(pageLaunch(node, entry, { platform: 'win32', comspec, named: { exe, id: 'a b' } }).args, line(''), "an id it wouldn't take");
  assert.deepEqual(pageLaunch(node, entry, { platform: 'win32', comspec, named: { exe: 'C:\\100%\\n.exe', id: 'smith' } }).args, line(''), '%NAME% would be expanded');
  assert.deepEqual(pageLaunch(node, entry, { platform: 'linux', named: { exe, id: 'smith' } }).args, [entry, 'serve'], 'elsewhere: detached, as before');
  // A page with a command of its own (Reeve's dashboard), and an argument with a space quoted.
  const reeve = (args: string[]) => pageLaunch(node, entry, { platform: 'win32', comspec, named: { exe, id: 'reeve' }, args }).args;
  assert.deepEqual(reeve(['dashboard', '--port', '18383']), ['/d', '/s', '/c', `"start "" /b "${exe}" reeve "${node}" "${entry}" dashboard --port 18383"`]);
  assert.deepEqual(reeve(['x y']).at(-1), `"start "" /b "${exe}" reeve "${node}" "${entry}" "x y""`);
  assert.deepEqual(pageLaunch(node, entry, { platform: 'win32', args: ['a"b'] }).args, [entry, 'a"b'], 'one cmd would misread: detached, as before');
  assert.deepEqual(pageLaunch(node, entry, { platform: 'linux', args: ['dashboard'] }).args, [entry, 'dashboard']);
});

test("on Windows the launcher compiles with the agent's name, runs the page as it was in the agent's job, and what the page starts detached outlives it", { skip: ownExe }, async () => {
  const logged: string[] = [];
  const agent = { id: 'kit-named-test', name: 'Kit Named Test' };
  const exe = await namedLauncher(agent, { kitDir, env: { ...process.env, KIT_NAMED: '1' }, sac: () => 'off', log: (l) => logged.push(l) });
  assert.deepEqual(logged, [], 'built');
  assert.ok(exe);
  const info = (await powershell(`$v = (Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo; $v.FileDescription + '|' + $v.ProductName`, { timeoutMs: paced(60_000) })).trim();
  assert.equal(info, 'Kit Named Test|Castellan', "Task Manager's name for it");

  // Its arguments, output and exit code as they were.
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const p = spawn(exe, args, { windowsHide: true, windowsVerbatimArguments: true });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => resolve({ code, out, err }));
    });
  const r = await run([agent.id, `"${process.execPath}"`, '-e', '"console.log(process.argv.slice(1).join(\'|\')); console.error(\'e\'); process.exit(7)"', 'a', '"b c"']);
  assert.deepEqual([r.code, r.out.trim(), r.err.trim()], [7, 'a|b c', 'e']);
  const bad = await run(['a/b', `"${process.execPath}"`]);
  assert.equal(bad.code, 2, 'an id it would not name a job for: nothing run');
  assert.match(bad.err, /usage/);
  const missing = await run([agent.id, 'no-such-program-anywhere']);
  assert.equal(missing.code, 127, 'a program that is not there: 127, as a shell says');

  // A page that starts a program detached (as an install starts its watcher, which must outlive the page it replaces), then
  // ends when told: both are in the agent's job while it runs, and the detached one runs on once the page and the launcher
  // have ended.
  const page = path.join(home, 'page.cjs');
  const go = path.join(home, 'go');
  writeFileSync(page, `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', detached: true });
c.unref();
console.log(JSON.stringify({ page: process.pid, detached: c.pid }));
const t = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(go)})) { clearInterval(t); process.exit(3); } }, 100);
`);
  // With the manor's ceiling (kit 2.78.7): a test's own, named for it.
  const ceiling = `kit-test-ceiling-${process.pid}`;
  const launcher = spawn(exe, [agent.id, `"${process.execPath}"`, `"${page}"`], { windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, KIT_CEILING: '9000', KIT_CEILING_JOB_NAME: ceiling } });
  let said = '';
  launcher.stdout.on('data', (d) => (said += d));
  const ended = new Promise<number | null>((resolve) => launcher.on('exit', (code) => resolve(code)));
  await until(() => said.includes('}'), paced(20_000), 'the page said its pids');
  const { page: pagePid, detached } = JSON.parse(said);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const inJob = (await powershell(`Add-Type @'
using System; using System.Runtime.InteropServices;
public static class NamedTestJob {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr p, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string In(int pid, string name) {
    IntPtr j = OpenJobObject(0x4, false, name); if (j == IntPtr.Zero) return "no job";
    IntPtr p = OpenProcess(0x1000, false, pid); bool r = false; bool ok = p != IntPtr.Zero && IsProcessInJob(p, j, out r);
    if (p != IntPtr.Zero) CloseHandle(p); CloseHandle(j); return ok ? r.ToString() : "unknown";
  }
}
'@
[NamedTestJob]::In(${pagePid}, 'Local\\Castellan-${agent.id}') + ' ' + [NamedTestJob]::In(${detached}, 'Local\\Castellan-${agent.id}') + ' ' + [NamedTestJob]::In(${pagePid}, 'Local\\${ceiling}')`, { timeoutMs: paced(60_000) })).trim();
    assert.equal(inJob, 'True True True', "the page and what it starts are in the agent's job, and the page in the manor's ceiling");
    writeFileSync(go, '');
    assert.equal(await ended, 3, "the launcher ends with the page, with the page's exit code");
    assert.ok(!alive(pagePid));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(alive(detached), 'what the page started detached runs on: the job ends nothing');
  } finally {
    for (const pid of [pagePid, detached]) if (alive(pid)) process.kill(pid);
  }
});

// kit 2.86.1: the console cmd's `start /b` gave the launcher has its host in the jobs the page leaves (Task Scheduler's,
// for every page Manor starts), and Manor's update ends them. The page has a windowless console of its own instead, and the
// launcher lets go of cmd's, whose host ends with cmd.
test("on Windows the page started through the launcher has a console of its own: cmd's ends with cmd, and the page's git still starts", { skip: ownExe }, async () => {
  const agent = { id: 'kit-named-test', name: 'Kit Named Test' };
  const exe = await namedLauncher(agent, { kitDir, env: { ...process.env, KIT_NAMED: '1' }, sac: () => 'off' });
  assert.ok(exe);
  const ready = path.join(home, 'console-ready');
  const go = path.join(home, 'console-go');
  const out = path.join(home, 'console.json');
  const cmdPid = path.join(home, 'console-cmd');
  const page = path.join(home, 'console-page.cjs');
  // The page: once told, whether it has a console, and how a program started to share it (cmd standing in for git) exits.
  writeFileSync(
    page,
    `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, '');
const t = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(go)})) return;
  clearInterval(t);
  let has = false;
  try { fs.closeSync(fs.openSync(String.raw\`\\\\.\\CONOUT$\`, 'w')); has = true; } catch {}
  const exit = require('node:child_process').spawnSync('cmd.exe', ['/d', '/c', 'exit 0'], { windowsHide: false }).status;
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ has, exit }));
}, 50);
`,
  );
  // As Manor starts a page: its open detached, with no console, starting cmd as pageLaunch says and waiting for the page.
  const how = pageLaunch(process.execPath, page, { named: { exe, id: agent.id } });
  const opener = path.join(home, 'console-open.cjs');
  writeFileSync(
    opener,
    `const log = require('node:fs').openSync(${JSON.stringify(path.join(home, 'console-serve.log'))}, 'a');
const c = require('node:child_process').spawn(${JSON.stringify(how.file)}, ${JSON.stringify(how.args)}, { ...${JSON.stringify(how.options)}, stdio: ['ignore', log, log], cwd: ${JSON.stringify(os.tmpdir())} });
require('node:fs').writeFileSync(${JSON.stringify(cmdPid)}, String(c.pid));
c.unref();
// As open waits for the page to answer: cmd is in the job Node ends with this process.
const t = setInterval(() => require('node:fs').existsSync(${JSON.stringify(ready)}) && clearInterval(t), 50);
`,
  );
  spawn(process.execPath, [opener], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, KIT_CEILING: '0' } }).unref();
  await until(() => existsSync(ready), paced(20_000), 'the page to start');
  const hostsOfCmd = async () =>
    (await powershell(`@(Get-CimInstance Win32_Process -Filter "Name='conhost.exe' AND ParentProcessId=${readFileSync(cmdPid, 'utf8')}").ProcessId -join ','`, { timeoutMs: paced(60_000) }))
      .trim()
      .split(',')
      .filter(Boolean)
      .map(Number);
  try {
    await until(async () => (await hostsOfCmd()).length === 0, paced(20_000), "the host of cmd's console to end with cmd");
  } finally {
    // As Task Scheduler would end it, had it stayed.
    for (const pid of await hostsOfCmd()) process.kill(pid);
    writeFileSync(go, '');
  }
  await until(() => existsSync(out), paced(20_000), 'the page to say');
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { has: true, exit: 0 }, 'its console is its own, and a program shares it');
  // The launcher holds its output file until the page, and then it, have ended.
  await until(
    () => {
      try {
        rmSync(path.join(home, 'console-serve.log'));
        return true;
      } catch {
        return false;
      }
    },
    paced(20_000),
    'the launcher to end',
  );
});
