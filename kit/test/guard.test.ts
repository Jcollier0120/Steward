import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The kit's guard helpers, the agent side (guard.ts, kit 2.87.0: the Watchman's and the Lamplighter's): the release's
// manifest of the guard's scripts, turning the guard on and off and refusing to uninstall while it's on. Every command
// goes to a recorder: nothing here asks Windows for an administrator, runs a guard script or touches a real guard
// folder. Only scratch folders.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-guard-'));
after(() => rmSync(home, { recursive: true, force: true }));

const G = await import('./fixture/src/kit/guard.ts');
const { powershell, psQuote } = await import('./fixture/src/kit/ps.ts');
type Runner = import('./fixture/src/kit/guard.ts').Runner;
type GuardWords = import('./fixture/src/kit/guard.ts').GuardWords;

const WATCHMAN: GuardWords = { agent: 'the Watchman', command: 'watchman', does: ', keeping System Protection on and making restore points', offLeaves: 'System Protection and the restore points are left as they are' };
const LAMPLIGHTER: GuardWords = { agent: 'the Lamplighter', command: 'lamplighter', does: ' and rolls graphics drivers back by itself', offLeaves: 'it turns back on any graphics card it disabled, and offers again any driver update it hid' };

let n = 0;
const folder = (name: string) => {
  const d = path.join(home, `${name}-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
/** An agent's src\guard: its installer, the guard's scripts and (a release's) manifest. */
function sourceDir(o: { manifest?: boolean } = {}) {
  const d = folder('source');
  for (const f of ['install-guard.ps1', 'guard.ps1', 'confirm.ps1']) writeFileSync(path.join(d, f), `# ${f}\r\n`);
  if (o.manifest !== false) writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(G.guardManifest(d, SCRIPTS)));
  return d;
}
const SCRIPTS = ['guard.ps1', 'confirm.ps1', 'install-guard.ps1'];

/** Every command, answered `code` (and `out`); `act` stands in for what the elevated script does meanwhile. */
function recorder(code = 0, out = '', act?: (args: string[]) => void) {
  const calls: { cmd: string; args: string[]; timeoutMs?: number }[] = [];
  const runner: Runner = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, timeoutMs: opts.timeoutMs });
    act?.(args);
    return { code, out, err: '' };
  };
  return { calls, runner };
}
const options = (o: Partial<import('./fixture/src/kit/guard.ts').GuardCommandOptions> = {}) => ({
  dryRun: false,
  out: () => {},
  source: o.source ?? sourceDir(),
  guardRoot: path.join(home, 'no-guard-root'),
  dataDir: folder('data'),
  args: ['-Countdown', '60'],
  dev: false,
  ...o,
});

// ---------------------------------------------------------------- the release's scripts

test("the release's manifest: each script's SHA-256, in lower case; none, or one missing or malformed, is no manifest", () => {
  const d = sourceDir();
  const m = G.readScriptManifest(d, SCRIPTS)!;
  assert.equal(m['guard.ps1'], createHash('sha256').update(readFileSync(path.join(d, 'guard.ps1'))).digest('hex'));
  assert.deepEqual(G.guardManifest(d, SCRIPTS), { schema: 1, files: m });
  assert.equal(G.readScriptManifest(sourceDir({ manifest: false }), SCRIPTS), null, 'a checkout');
  assert.equal(G.readScriptManifest(d, [...SCRIPTS, G.GUARD_KIT]), null, 'one the manifest lacks');
  const upper = folder('upper');
  writeFileSync(path.join(upper, 'manifest.json'), JSON.stringify({ files: { 'guard.ps1': m['guard.ps1'].toUpperCase() } }));
  assert.equal(G.readScriptManifest(upper, ['guard.ps1'])!['guard.ps1'], m['guard.ps1']);
  writeFileSync(path.join(upper, 'manifest.json'), JSON.stringify({ files: { 'guard.ps1': 'abc' } }));
  assert.equal(G.readScriptManifest(upper, ['guard.ps1']), null);
  writeFileSync(path.join(upper, 'manifest.json'), '\uFEFF{ not json');
  assert.equal(G.readScriptManifest(upper, ['guard.ps1']), null);
});

test("the guard's scripts behind the release: changed or missing in its bin\\; none when it isn't set up, or there's no manifest", () => {
  const source = sourceDir();
  const root = folder('guard');
  assert.deepEqual(G.scriptsBehind(root, source, SCRIPTS), [], 'not set up: no bin\\guard.ps1');
  mkdirSync(path.join(root, 'bin'));
  for (const f of SCRIPTS) writeFileSync(path.join(root, 'bin', f), readFileSync(path.join(source, f)));
  assert.deepEqual(G.scriptsBehind(root, source, SCRIPTS), []);
  writeFileSync(path.join(root, 'bin', 'confirm.ps1'), '# an older one, longer\r\n');
  rmSync(path.join(root, 'bin', 'install-guard.ps1'));
  assert.deepEqual(G.scriptsBehind(root, source, SCRIPTS), ['confirm.ps1', 'install-guard.ps1']);
  assert.deepEqual(G.scriptsBehind(root, sourceDir({ manifest: false }), SCRIPTS), [], 'a checkout says nothing');
  assert.equal(G.sha256Of(path.join(root, 'nope.ps1')), null);
});

test('guard-kit.ps1 is copied beside install-guard.ps1 once, as the kit has it, so the manifest carries it', () => {
  const d = sourceDir();
  assert.equal(G.copyGuardKit(d), true);
  assert.deepEqual(readFileSync(path.join(d, G.GUARD_KIT)), readFileSync(new URL('./fixture/src/kit/guard-kit.ps1', import.meta.url)));
  assert.equal(G.copyGuardKit(d), false, 'the same already: nothing changed');
  writeFileSync(path.join(d, G.GUARD_KIT), '# edited by hand');
  assert.equal(G.copyGuardKit(d), true, 'put back as the kit has it');
  const m = G.guardManifest(d, [...SCRIPTS, G.GUARD_KIT]);
  assert.match(m.files[G.GUARD_KIT], /^[0-9a-f]{64}$/);
});

test("the guard is there while its scripts, its state or its settings are", () => {
  assert.equal(G.guardPresent(path.join(home, 'nowhere')), false);
  for (const f of ['bin/guard.ps1', 'bin/install-guard.ps1', 'state.json', 'config.json']) {
    const root = folder('present');
    mkdirSync(path.join(root, 'bin'), { recursive: true });
    writeFileSync(path.join(root, f), '{}');
    assert.equal(G.guardPresent(root), true, f);
  }
  const empty = folder('empty');
  mkdirSync(path.join(empty, 'bin'));
  assert.equal(G.guardPresent(empty), false, 'an empty folder is no guard');
});

// ---------------------------------------------------------------- turning it on and off

test('--dry-run runs the installer with -WhatIf, unelevated, with the agent\'s settings', async () => {
  const r = recorder();
  const o = options({ dryRun: true, args: ['-Countdown', '75'], dev: true });
  assert.equal(await G.guardCommand('install', { ...o, runner: r.runner }), 0);
  const args = r.calls[0].args;
  assert.equal(r.calls[0].cmd, G.POWERSHELL);
  assert.ok(args.includes('-WhatIf'));
  assert.ok(!args.join(' ').includes('RunAs'));
  assert.equal(args[args.indexOf('-Countdown') + 1], '75');
  assert.equal(args[args.indexOf('-File') + 1], path.join(o.source, 'install-guard.ps1'));
  assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.equal(r.calls[0].timeoutMs, 60_000);
});

test('for real, it asks Windows for an administrator (Start-Process -Verb RunAs), from an installed copy only', async () => {
  const lines: string[] = [];
  const r = recorder();
  assert.equal(await G.guardCommand('install', { ...options({ dev: true }), out: (l) => lines.push(l), runner: r.runner }), 2, 'a development checkout refuses');
  assert.deepEqual(lines, [G.DEV_GUARD]);
  assert.equal(r.calls.length, 0);
  const o = options();
  await G.guardCommand('uninstall', { ...o, out: (l) => lines.push(l), runner: r.runner, dev: true });
  const command = r.calls[0].args.at(-1)!;
  assert.match(command, /Start-Process -FilePath '.*powershell\.exe' -Verb RunAs -Wait -PassThru/);
  assert.match(command, /-Action uninstall/);
  assert.match(command, /-Countdown 60/);
  assert.ok(command.includes(`-Log ${path.join(o.dataDir, 'guard-uninstall.log')}`) || command.includes(`-Log "${path.join(o.dataDir, 'guard-uninstall.log')}"`), command);
  assert.equal(lines.at(-1), 'Turning off the guard: Windows asks for an administrator (it may wait in the taskbar).', 'turning it off works from a checkout too');
  assert.equal(r.calls[0].timeoutMs, 15 * 60_000, "the Lamplighter's 15 minutes unless given");
  const w = recorder();
  await G.guardCommand('install', { ...options({ args: ['-TurnOnProtection', '0', '-DailyRestorePoint', '1'], timeoutMs: 30 * 60_000 }), runner: w.runner });
  assert.match(w.calls[0].args.at(-1)!, /-TurnOnProtection 0 -DailyRestorePoint 1/, "the Watchman's settings");
  assert.equal(w.calls[0].timeoutMs, 30 * 60_000, "the Watchman's 30 minutes");
});

test('turning it off when already elevated (Manor uninstalling) runs the script directly: no administrator prompt', async () => {
  const lines: string[] = [];
  const r = recorder();
  const o = options({ dev: true, elevated: true });
  assert.equal(await G.guardCommand('uninstall', { ...o, out: (l) => lines.push(l), runner: r.runner }), 0);
  assert.ok(!r.calls[0].args.join(' ').includes('RunAs'));
  assert.equal(r.calls[0].args[r.calls[0].args.indexOf('-File') + 1], path.join(o.source, 'install-guard.ps1'));
  assert.equal(r.calls[0].args[r.calls[0].args.indexOf('-Action') + 1], 'uninstall');
  assert.deepEqual(lines, ['Turning off the guard (already running as an administrator).']);
});

test("with the agent's own scripts gone, turning it off uses the guard's own copy in its folder", async () => {
  const root = folder('guard');
  mkdirSync(path.join(root, 'bin'));
  writeFileSync(path.join(root, 'bin', 'install-guard.ps1'), '# its own');
  const r = recorder();
  await G.guardCommand('uninstall', { ...options({ dryRun: true, source: path.join(home, 'gone'), root }), runner: r.runner });
  const args = r.calls[0].args;
  assert.equal(args[args.indexOf('-File') + 1], path.join(root, 'bin', 'install-guard.ps1'));
  assert.equal(args[args.indexOf('-Root') + 1], root);
  const viaGuardRoot = recorder();
  await G.guardCommand('uninstall', { ...options({ dryRun: true, source: path.join(home, 'gone'), guardRoot: root }), runner: viaGuardRoot.runner });
  assert.equal(viaGuardRoot.calls[0].args.includes('-Root'), false, 'the usual folder: no -Root');
  assert.equal(viaGuardRoot.calls[0].args[viaGuardRoot.calls[0].args.indexOf('-Source') + 1], path.join(root, 'bin'));
});

test("the elevated run's log is made afresh and printed when it ends; 1223 says the prompt was turned down", async () => {
  const dataDir = folder('data');
  const log = path.join(dataDir, 'guard-install.log');
  writeFileSync(log, 'an old run\r\n');
  const lines: string[] = [];
  const r = recorder(0, '', (args) => {
    assert.ok(!existsSync(log), 'the old log removed before the prompt');
    writeFileSync(log, '\uFEFFTurning on the guard.\r\n\r\nDone.\r\n');
  });
  assert.equal(await G.runElevated('C:\\x\\install-guard.ps1', ['-Action', 'install'], { log, out: (l) => lines.push(l), runner: r.runner }), 0);
  assert.deepEqual(lines, ['Turning on the guard.', 'Done.']);
  const no = recorder(1223, 'The operation was canceled by the user.');
  const said: string[] = [];
  assert.equal(await G.runElevated('C:\\x\\install-guard.ps1', [], { log, out: (l) => said.push(l), runner: no.runner }), 1223);
  assert.deepEqual(said, ["The administrator prompt was turned down or couldn't open, so nothing changed. The operation was canceled by the user."]);
  assert.ok(!existsSync(log));
});

test('a folder with curly quotes, $( ) or backticks in it stays text in the elevated command: no command of its own', { skip: process.platform !== 'win32' }, async () => {
  for (const source of ['C:\\Users\\O\u2019Brien\\guard', 'C:\\x\u2019; Write-Output INJECTED; \u2019y', "C:\\x'; Write-Output INJECTED; 'y", 'C:\\a $(Write-Output INJECTED) `n b']) {
    const r = recorder();
    await G.guardCommand('install', { ...options({ source }), runner: r.runner });
    const command = r.calls[0].args.at(-1)!;
    // Parsed, never run: the commands in it, and the text Start-Process is given.
    const parsed = JSON.parse(await powershell(`$ast = [System.Management.Automation.Language.Parser]::ParseInput(${psQuote(command)}, [ref]$null, [ref]$null)
$cmds = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true))
$start = $cmds | Where-Object { $_.GetCommandName() -eq 'Start-Process' } | Select-Object -First 1
$i = [array]::IndexOf(@($start.CommandElements | ForEach-Object { if ($_ -is [System.Management.Automation.Language.CommandParameterAst]) { $_.ParameterName } else { '' } }), 'ArgumentList')
[pscustomobject]@{ names = @($cmds | ForEach-Object { $_.GetCommandName() }); argumentList = $start.CommandElements[$i + 1].Value } | ConvertTo-Json -Compress`));
    assert.deepEqual(parsed.names, ['Start-Process', 'Write-Output'], source);
    assert.ok(parsed.argumentList.includes(`-Source "${source}"`) || parsed.argumentList.includes(`-Source ${source}`), parsed.argumentList);
  }
});

test('elevated or not: the answer of a check that changes nothing', async () => {
  const yes = recorder(0, 'True\r\n');
  assert.equal(await G.isElevated(yes.runner), true);
  assert.match(yes.calls[0].args.at(-1)!, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
  assert.equal(await G.isElevated(recorder(0, 'False').runner), false);
  assert.equal(await G.isElevated(recorder(1, 'True').runner), false);
});

test('run: a program that runs, one that fails, one that never starts; lines as they come', { skip: process.platform !== 'win32' }, async () => {
  const lines: string[] = [];
  const ok = await G.run(G.POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', "'one'; 'two'"], { onLine: (l) => lines.push(l) });
  assert.deepEqual([ok.code, lines], [0, ['one', 'two']]);
  assert.equal((await G.run(G.POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'exit 7'])).code, 7);
  const none = await G.run(path.join(home, 'no-such.exe'), []);
  assert.notEqual(none.code, 0);
  assert.ok(none.err);
});

// ---------------------------------------------------------------- uninstalling the agent

function guardDir() {
  const root = folder('guard');
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'bin', 'guard.ps1'), '# guard');
  return root;
}
const deps = (root: string, words: GuardWords, guardOff: (dryRun: boolean) => Promise<number> = async () => 0) => {
  const done: string[][] = [];
  const lines: string[] = [];
  return { done, lines, d: { root, words, out: (l: string) => lines.push(l), uninstall: async (a: string[]) => (done.push(a), 0), guardOff } };
};

test("uninstall refuses while the guard is on, in each agent's own words, and says how to turn it off first", async () => {
  const root = guardDir();
  const x = deps(root, WATCHMAN);
  assert.equal(await G.uninstallAgent(['--purge'], x.d), G.GUARD_STILL_ON);
  assert.equal(G.GUARD_STILL_ON, 3);
  assert.deepEqual(x.done, [], 'the agent stays');
  const own = `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(root, 'bin', 'install-guard.ps1')}" -Action uninstall`;
  assert.deepEqual(x.lines, [
    `The guard is still on: it runs as SYSTEM from ${root}, keeping System Protection on and making restore points, so the Watchman isn't uninstalled while it is.`,
    'Turn it off first (Windows asks for an administrator once; System Protection and the restore points are left as they are), then uninstall:',
    '  watchman guard off',
    '  watchman uninstall',
    'Or both at once: watchman uninstall --guard-off',
    `Without the agent, as an administrator: ${own}`,
  ]);
  assert.deepEqual(G.guardOnWords(root, LAMPLIGHTER), [
    `The guard is still on: it runs as SYSTEM from ${root} and rolls graphics drivers back by itself, so the Lamplighter isn't uninstalled while it is.`,
    'Turn it off first (Windows asks for an administrator once; it turns back on any graphics card it disabled, and offers again any driver update it hid), then uninstall:',
    '  lamplighter guard off',
    '  lamplighter uninstall',
    'Or both at once: lamplighter uninstall --guard-off',
    `Without the agent, as an administrator: ${own}`,
  ]);
  for (const f of ['state.json', 'config.json']) {
    const only = folder(`only-${f}`);
    writeFileSync(path.join(only, f), '{}');
    assert.equal(await G.uninstallAgent([], deps(only, LAMPLIGHTER).d), G.GUARD_STILL_ON, `${f} alone is a guard that's there`);
  }
});

test('with no guard there, it uninstalls as before', async () => {
  const x = deps(path.join(home, 'no-guard-here'), LAMPLIGHTER);
  assert.equal(await G.uninstallAgent(['--purge', '--dry-run'], x.d), 0);
  assert.deepEqual(x.done, [['--purge', '--dry-run']]);
});

test('--guard-off turns the guard off first, and uninstalls only when that worked', async () => {
  const root = guardDir();
  const ok = deps(root, WATCHMAN, async () => (rmSync(path.join(root, 'bin'), { recursive: true, force: true }), 0));
  assert.equal(await G.uninstallAgent(['--guard-off'], ok.d), 0);
  assert.deepEqual(ok.done, [[]], '--guard-off is not passed on');
  const declined = deps(guardDir(), LAMPLIGHTER, async () => 1223);
  assert.equal(await G.uninstallAgent(['--guard-off'], declined.d), 1223);
  assert.deepEqual(declined.done, [], 'the administrator prompt was turned down: the agent stays');
  assert.deepEqual(declined.lines, ["The guard couldn't be turned off (exit 1223), so the Lamplighter isn't uninstalled."]);
  const stayRoot = guardDir();
  const stays = deps(stayRoot, WATCHMAN, async () => 0);
  assert.equal(await G.uninstallAgent(['--guard-off'], stays.d), G.GUARD_STILL_ON, 'said 0, but the guard is still there');
  assert.deepEqual(stays.lines, [`The guard is still in ${stayRoot}, so the Watchman isn't uninstalled.`]);
  assert.deepEqual(stays.done, []);
  let dry: boolean | null = null;
  const dryRun = deps(guardDir(), WATCHMAN, async (d) => ((dry = d), 0));
  assert.equal(await G.uninstallAgent(['--guard-off', '--dry-run'], dryRun.d), 0, 'a dry run goes on to the dry uninstall, the guard still there');
  assert.equal(dry, true);
  assert.deepEqual(dryRun.done, [['--dry-run']]);
});
