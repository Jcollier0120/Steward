import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { paced, until } from './until.ts';

// The agent's name in Task Manager (named.ts): its page started through a launcher named for it, in a job of its own.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-named-'));
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');

const { NAMED_TITLE, namedBuilt, namedExe, namedId, namedLauncher, namedSource, namedWanted } = await import('./fixture/src/kit/named.ts');
const { pageLaunch } = await import('./fixture/src/kit/service.ts');
const { powershell } = await import('./fixture/src/kit/ps.ts');

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
  const o = { kitDir: dir, platform: 'win32' as const, env: { KIT_NAMED: '1' } };
  assert.equal(namedBuilt(smith, o), null, 'not built yet');
  const exe = namedExe(smith.id, namedSource(smith.name), dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(exe, '');
  assert.equal(namedBuilt(smith, o), exe);
  assert.equal(namedBuilt({ id: 'reeve', name: 'Reeve' }, o), null, "another agent's isn't this one's");
  assert.equal(namedBuilt(smith, { ...o, platform: 'linux' }), null);
  assert.equal(namedBuilt(smith, { kitDir: dir, platform: 'win32', env: { NODE_TEST_CONTEXT: 'child' } }), null);
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
});

test("on Windows the launcher compiles with the agent's name, runs the page as it was in the agent's job, and what the page starts detached outlives it", { skip: process.platform !== 'win32' }, async () => {
  const logged: string[] = [];
  const agent = { id: 'kit-named-test', name: 'Kit Named Test' };
  const exe = await namedLauncher(agent, { kitDir, env: { ...process.env, KIT_NAMED: '1' }, log: (l) => logged.push(l) });
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
  const launcher = spawn(exe, [agent.id, `"${process.execPath}"`, `"${page}"`], { windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
[NamedTestJob]::In(${pagePid}, 'Local\\Castellan-${agent.id}') + ' ' + [NamedTestJob]::In(${detached}, 'Local\\Castellan-${agent.id}')`, { timeoutMs: paced(60_000) })).trim();
    assert.equal(inJob, 'True True', "the page and what it starts are in the agent's job");
    writeFileSync(go, '');
    assert.equal(await ended, 3, "the launcher ends with the page, with the page's exit code");
    assert.ok(!alive(pagePid));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(alive(detached), 'what the page started detached runs on: the job ends nothing');
  } finally {
    for (const pid of [pagePid, detached]) if (alive(pid)) process.kill(pid);
  }
});
