import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The kit's guard helpers, the PowerShell side (guard-kit.ps1, kit 2.87.0: the Watchman's and the Lamplighter's
// install-guard.ps1 helpers), dot-sourced into a test script as an installer dot-sources it, in Windows PowerShell 5.1,
// unelevated. Owners are stood in for; a task is registered only under -WhatIf, or with schtasks stood in for and
// Windows' folder moved away, so no task is ever made. Only scratch folders.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-guard-kit-'));
after(() => rmSync(home, { recursive: true, force: true }));

const { POWERSHELL, guardManifest, psFile, run } = await import('./fixture/src/kit/guard.ts');
const { psQuote } = await import('./fixture/src/kit/ps.ts');
const KIT = fileURLToPath(new URL('./fixture/src/kit/guard-kit.ps1', import.meta.url));
const windows = { skip: process.platform !== 'win32' };

let n = 0;
const folder = (name: string) => {
  const d = path.join(home, `${name}-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const q = psQuote;

/** Runs `body` after dot-sourcing guard-kit.ps1, as an installer does; its last line of output is JSON. */
async function ps(body: string): Promise<any> {
  const file = path.join(home, `t-${++n}.ps1`);
  writeFileSync(file, `﻿$ErrorActionPreference = 'Stop'\r\n. ${q(KIT)}\r\n${body.replace(/\r?\n/g, '\r\n')}\r\n`, 'utf8');
  const r = await run(POWERSHELL, psFile(file, []), { timeoutMs: 120_000 });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  return JSON.parse(r.out.trim().split(/\r?\n/).at(-1)!);
}

test('guard-kit.ps1 is only functions: no parameters, no exit, and the names an installer calls', windows, async () => {
  const r = await ps(`$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(KIT)}, [ref]$tokens, [ref]$errors)
@{
  errors = @($errors).Count
  param = $null -ne $ast.ParamBlock
  exits = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.ExitStatementAst] }, $true)).Count
  functions = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name })
  ascii = -not ([IO.File]::ReadAllText(${q(KIT)}) -match '[^\\x00-\\x7F]')
} | ConvertTo-Json -Compress`);
  assert.deepEqual([r.errors, r.param, r.exits, r.ascii], [0, false, 0, true]);
  assert.deepEqual(r.functions, ['Initialize-GuardKit', 'Open-Log', 'Close-Log', 'Write-Out', 'Invoke-Do', 'Invoke-Native', 'Test-Admin', 'ConvertTo-XmlText', 'Get-OwnerSid', 'Test-Trusted', 'Read-ScriptManifest', 'Test-ScriptHashes', 'Set-FolderRights', 'Get-ProfileList', 'Get-AccountSid', 'Test-LetGo', 'Get-OtherHolders', 'Set-LetGo', 'Clear-LetGo', 'Register-Task']);
});

test('Invoke-Do: nothing before Initialize-GuardKit; under -WhatIf only said; else said and done', windows, async () => {
  const r = await ps(`$r = @{}
try { Invoke-Do 'early' { $script:ran = 'early' } } catch { $r.uninit = $_.Exception.Message }
$r.early = $script:ran
Initialize-GuardKit -WhatIf
Invoke-Do 'Delete everything' { $script:ran = 'deleted' }
$r.whatIf = $script:ran
Initialize-GuardKit
Invoke-Do 'Make a folder' { $script:ran = 'made' }
$r.done = $script:ran
$r.lines = @($script:GuardLines)
$r.xml = ConvertTo-XmlText '<a & "b">'
$r.admin = (Test-Admin) -is [bool]
$x = Invoke-Native $env:ComSpec @('/c', 'echo hi& exit 3')
$r.native = @($x.code, $x.out)
$r | ConvertTo-Json -Compress`);
  assert.equal(r.uninit, "guard-kit.ps1: Initialize-GuardKit wasn't called, so nothing is done (early).");
  assert.deepEqual([r.early, r.whatIf, r.done], [null, null, 'made']);
  assert.deepEqual(r.lines, ['WhatIf: Delete everything', 'Make a folder']);
  assert.equal(r.xml, '&lt;a &amp; &quot;b&quot;&gt;');
  assert.equal(r.admin, true, 'Test-Admin answers yes or no');
  assert.deepEqual(r.native, [3, 'hi']);
});

test('the log: made afresh; never a file already there, nor in a folder that is a link; Write-Out still prints', windows, async () => {
  const dir = folder('logs');
  writeFileSync(path.join(dir, 'planted.log'), 'keep');
  const target = folder('target');
  const link = path.join(home, `link-${++n}`);
  symlinkSync(target, link, 'junction');
  await ps(`Initialize-GuardKit -Log ${q(path.join(dir, 'fresh.log'))}
Write-Out 'one'; Write-Out 'two'; Close-Log
Initialize-GuardKit -Log ${q(path.join(dir, 'planted.log'))}
Write-Out 'three'; Close-Log
Initialize-GuardKit -Log ${q(path.join(link, 'through.log'))}
Write-Out 'four'; Close-Log
Initialize-GuardKit
Write-Out 'five'
@{ lines = @($script:GuardLines) } | ConvertTo-Json -Compress`).then((r) => assert.deepEqual(r.lines, ['one', 'two', 'three', 'four', 'five']));
  const fresh = readFileSync(path.join(dir, 'fresh.log'));
  assert.equal(fresh.toString('utf8'), 'one\r\ntwo\r\n');
  assert.notEqual(fresh[0], 0xef, 'no byte-order mark');
  assert.equal(readFileSync(path.join(dir, 'planted.log'), 'utf8'), 'keep', 'a file already there is never written to');
  assert.ok(!existsSync(path.join(target, 'through.log')), 'nothing written through a link');
});

test("Test-Trusted: the folder and all in it SYSTEM's, Administrators' or TrustedInstaller's; -Except's contents not asked", windows, async () => {
  const make = (name: string, files: string[]) => {
    const root = folder(name);
    for (const f of files) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), 'x');
    }
    return root;
  };
  const roots = {
    ok: make('ok', ['a.txt', 'sub\\b.txt', 'sub\\admins.txt', 'sub\\ti.txt']),
    planted: make('ok', ['a.txt', 'sub\\planted.txt']),
    inbox: make('ok', ['a.txt', 'inbox\\planted.txt']),
    sibling: make('ok', ['inbox\\a.txt', 'inbox2\\planted.txt']),
    own: make('planted', ['a.txt']),
  };
  const r = await ps(`function Get-OwnerSid([string]$Path) {
  $leaf = Split-Path -Leaf $Path
  if ($leaf -like 'planted*') { return 'S-1-5-21-1-2-3-1001' }
  if ($leaf -eq 'admins.txt') { return 'S-1-5-32-544' }
  if ($leaf -eq 'ti.txt') { return 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464' }
  return 'S-1-5-18'
}
@{
  ok = Test-Trusted ${q(roots.ok)}
  planted = Test-Trusted ${q(roots.planted)}
  inboxExcept = Test-Trusted ${q(roots.inbox)} -Except 'inbox'
  inbox = Test-Trusted ${q(roots.inbox)}
  sibling = Test-Trusted ${q(roots.sibling)} -Except 'inbox'
  own = Test-Trusted ${q(roots.own)}
  missing = Test-Trusted ${q(path.join(home, 'not-there'))}
} | ConvertTo-Json -Compress`);
  assert.deepEqual(r, { ok: true, planted: false, inboxExcept: true, inbox: false, sibling: false, own: false, missing: true });
});

test("the scripts' SHA-256 against the release's manifest: each named one, in lower case; a changed or missing one found", windows, async () => {
  const dir = folder('scripts');
  for (const f of ['a.ps1', 'b.ps1']) writeFileSync(path.join(dir, f), `# ${f}\r\n`);
  const want = guardManifest(dir, ['a.ps1', 'b.ps1']).files;
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 1, files: want }));
  const upper = folder('upper');
  writeFileSync(path.join(upper, 'manifest.json'), JSON.stringify({ files: { 'a.ps1': want['a.ps1'].toUpperCase() } }));
  const broken = folder('broken');
  writeFileSync(path.join(broken, 'manifest.json'), '{ not json');
  const r = await ps(`$files = @('a.ps1', 'b.ps1')
$m = Read-ScriptManifest ${q(dir)} $files
$r = @{ count = $m.hashes.Count; a = $m.hashes['a.ps1'] }
$r.same = Test-ScriptHashes ${q(dir)} $m.hashes $files
Set-Content -LiteralPath (Join-Path ${q(dir)} 'b.ps1') -Value '# changed'
Remove-Item -LiteralPath (Join-Path ${q(dir)} 'a.ps1')
$r.changed = Test-ScriptHashes ${q(dir)} $m.hashes $files
$r.noneNamed = Test-ScriptHashes ${q(dir)} $m.hashes @()
$r.noManifest = (Read-ScriptManifest ${q(folder('empty'))} $files).error
$r.upper = (Read-ScriptManifest ${q(upper)} @('a.ps1')).error
$r.broken = (Read-ScriptManifest ${q(broken)} @('a.ps1')).error
$r.lacks = (Read-ScriptManifest ${q(dir)} @('a.ps1', 'c.ps1')).error
$r.noFiles = (Read-ScriptManifest ${q(dir)} @()).error
$r | ConvertTo-Json -Compress`);
  assert.equal(r.count, 2);
  assert.equal(r.a, want['a.ps1']);
  assert.deepEqual(r.same, []);
  assert.deepEqual(r.changed, ['a.ps1 (missing)', 'b.ps1']);
  assert.deepEqual(r.noneNamed, ['(no scripts named)'], 'no scripts named is never "all match"');
  assert.match(r.noManifest, /^There's no manifest\.json in .* install a release, and turn the guard on from it\.$/);
  assert.match(r.upper, /gives no SHA-256 for a\.ps1\.$/, 'lower case only, as the release writes it');
  assert.match(r.broken, /manifest\.json isn't JSON: /);
  assert.match(r.lacks, /gives no SHA-256 for c\.ps1\.$/);
  assert.equal(r.noFiles, 'guard-kit.ps1: no scripts were named to check.');
});

test("Register-Task: under -WhatIf only said; otherwise the XML written as UTF-16 and schtasks given it (stood in for)", windows, async () => {
  const dir = folder('task');
  const said = path.join(dir, 'said.xml');
  const made = path.join(dir, 'made.xml');
  const fakeWindows = folder('not-windows');
  const r = await ps(`$r = @{}
# Before anything: schtasks stood in for, and Windows' folder moved away from this script, so no task can be made.
$windows = $env:SystemRoot
$env:SystemRoot = ${q(fakeWindows)}
function Invoke-Native([string]$File, [string[]]$Arguments) { $script:native += , (@($File) + $Arguments); return @{ code = $script:nativeCode; out = 'nope' } }
if (-not (Get-Command Invoke-Native).ScriptBlock.ToString().Contains('$script:native')) { throw 'schtasks was not stood in for' }
$script:native = @(); $script:nativeCode = 0
Initialize-GuardKit -WhatIf
Register-Task 'Kit Test Task' '<Task />' ${q(said)}
$r.said = @($script:GuardLines)
$r.saidWritten = Test-Path -LiteralPath ${q(said)}
$r.saidRan = $script:native.Count
Initialize-GuardKit
Register-Task 'Kit Test Task' '<Task>é</Task>' ${q(made)}
$r.native = $script:native[0]
$script:nativeCode = 1
try { Register-Task 'Kit Test Task' '<Task />' ${q(path.join(dir, 'failed.xml'))}; $r.failed = $null } catch { $r.failed = $_.Exception.Message }
$env:SystemRoot = $windows
$r | ConvertTo-Json -Compress`);
  assert.deepEqual(r.said, [`WhatIf: Write ${said} and register the task Kit Test Task from it: schtasks /Create /TN Kit Test Task /XML "${said}" /F`]);
  assert.deepEqual([r.saidWritten, r.saidRan], [false, 0]);
  assert.deepEqual(r.native, [path.join(fakeWindows, 'System32', 'schtasks.exe'), '/Create', '/TN', 'Kit Test Task', '/XML', made, '/F']);
  const bytes = readFileSync(made);
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe], 'UTF-16 with its byte-order mark');
  assert.equal(bytes.subarray(2).toString('utf16le'), '<Task>é</Task>');
  assert.equal(r.failed, "schtasks couldn't register Kit Test Task: nope");
});

test('one guard for the PC: the other accounts that hold it have the agent installed and never let go; letting go is a mark, taken back on turning it on', windows, async () => {
  const root = folder('guard-root');
  const profiles = folder('profiles');
  const me = 'S-1-5-21-1-2-3-1001';
  const has = (name: string) => (mkdirSync(path.join(profiles, name, '.lamplighter', 'app'), { recursive: true }), path.join(profiles, name));
  const ann = has('ann');
  const bob = has('bob');
  const cat = path.join(profiles, 'cat');
  // Cat's account has only what the Confirm window leaves (seen.json): no Lamplighter of her own.
  mkdirSync(path.join(cat, '.lamplighter'), { recursive: true });
  writeFileSync(path.join(cat, '.lamplighter', 'seen.json'), '{}');
  const r = await ps(`$r = @{}
function Get-ProfileList { return , @(@{ sid = ${q(me)}; profile = ${q(has('me'))} }, @{ sid = 'S-1-5-21-1-2-3-1002'; profile = ${q(ann)} }, @{ sid = 'S-1-12-1-9-1003'; profile = ${q(bob)} }, @{ sid = 'S-1-5-21-1-2-3-1004'; profile = ${q(cat)} }) }
$none = Get-OtherHolders ${q(path.join(root, 'missing'))} 'lamplighter' ${q(me)}
$r.none = $none.Count
$held = Get-OtherHolders ${q(root)} 'lamplighter' ${q(me)}
$r.held = @($held | ForEach-Object { $_.account })
$r.given = Get-AccountSid ${q(me)}
$r.own = (Get-AccountSid '') -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$r.notASid = (Get-AccountSid 'S-1-5-21-1\\..\\x') -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Initialize-GuardKit -WhatIf
Set-LetGo ${q(root)} 'S-1-5-21-1-2-3-1002'
$r.whatIf = @($script:GuardLines)
$r.markedUnderWhatIf = Test-LetGo ${q(root)} 'S-1-5-21-1-2-3-1002'
Initialize-GuardKit
# icacls, which only an administrator may run so: what it was asked, never run here.
$global:native = @()
function Invoke-Native([string]$File, [string[]]$Arguments) { $global:native += ((Split-Path -Leaf $File) + ' ' + ($Arguments -join ' ')); return @{ code = 0; out = '' } }
Set-LetGo ${q(root)} 'S-1-5-21-1-2-3-1002'
$r.marked = Test-LetGo ${q(root)} 'S-1-5-21-1-2-3-1002'
$r.owned = @($global:native)
function Invoke-Native([string]$File, [string[]]$Arguments) { return @{ code = 5; out = 'Access is denied.' } }
try { Set-LetGo ${q(root)} 'S-1-5-21-1-2-3-1004'; $r.failed = 'no' } catch { $r.failed = $_.Exception.Message }
$r.leftAfterFail = Test-LetGo ${q(root)} 'S-1-5-21-1-2-3-1004'
try { Set-LetGo ${q(root)} 'S-1-5-21-1\\..\\x'; $r.badSid = 'no' } catch { $r.badSid = $_.Exception.Message }
$r.badSidTested = Test-LetGo ${q(root)} '..\\let-go'
$after = Get-OtherHolders ${q(root)} 'lamplighter' ${q(me)}
$r.after = @($after | ForEach-Object { $_.account })
Clear-LetGo ${q(root)} 'S-1-5-21-1-2-3-1002'
Clear-LetGo ${q(root)} 'S-1-5-21-1-2-3-1009'
$r.cleared = Test-LetGo ${q(root)} 'S-1-5-21-1-2-3-1002'
$r.empty = Test-LetGo ${q(root)} ''
$r | ConvertTo-Json -Compress`);
  assert.equal(r.none, 0, 'no guard there: no one holds it');
  assert.deepEqual(r.held, ['ann', 'bob'], "not this account, nor one with only the Confirm window's seen.json");
  assert.equal(r.given, me);
  assert.deepEqual([r.own, r.notASid], [true, true], 'unset, or not a SID: the account it runs as');
  assert.deepEqual(r.whatIf, [`WhatIf: Mark that this account lets go of the guard: ${path.join(root, 'let-go', 'S-1-5-21-1-2-3-1002')}`]);
  assert.equal(r.markedUnderWhatIf, false);
  assert.equal(r.marked, true);
  assert.deepEqual(r.owned, [`icacls.exe ${path.join(root, 'let-go')} /setowner *S-1-5-32-544 /t /c /q`], "owned by Administrators, as everything in the guard's folder is, whatever owner Windows gave it");
  assert.equal(r.failed, 'icacls /setowner: Access is denied.');
  assert.equal(r.leftAfterFail, false, "a mark that couldn't be made the guard's own is taken away again");
  assert.match(r.badSid, /isn't an account's SID/);
  assert.equal(r.badSidTested, false);
  assert.deepEqual(r.after, ['bob'], 'an account that let go no longer holds it');
  assert.deepEqual([r.cleared, r.empty], [false, false]);
  assert.ok(existsSync(path.join(root, 'let-go')), 'the folder stays, empty');
});
