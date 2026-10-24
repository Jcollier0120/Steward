import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// A release's PowerShell scripts, signed (spec/RELEASES.md, "Signed scripts"): the kept copies, the staged release's
// scripts signed or taken, a guard's manifest following them, and the zip carrying them exactly as signed. A fake signer
// stands in for signtool; the last test signs for real with a throwaway certificate that never enters a store.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'signed-scripts-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const { changedSinceSigning, keepScript, keptScript, keptScriptFile, pruneScripts, rewriteHashes, scriptBody, scriptKey, scriptsIn, scriptsStoreOf, signStagedScripts, UNUSED_DAYS } = await import('./fixture/src/kit/signed-scripts.ts');
const { scriptSigningFor, scriptsThumbprint } = await import('./fixture/src/kit/release.ts');
const { SIGNED_BY } = await import('./fixture/src/kit/prebuilt.ts');
type ScriptSigner = import('./fixture/src/kit/signed-scripts.ts').ScriptSigner;

const THUMB = '6B654D9C34800D4307D42ACD63B925EDA5CE8D33';
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
let n = 0;
const fresh = (name: string) => {
  const dir = path.join(tmp, `${name}-${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const put = (dir: string, files: Record<string, string | Buffer>) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), text);
  }
};
/** What signing appends, with made-up base64: the block as signtool writes it. */
const block = (tag = 'AAAA') => `\r\n# SIG # Begin signature block\r\n# MII${tag}\r\n# ${tag}==\r\n# SIG # End signature block\r\n`;
const signedAs = (body: Buffer | string, tag?: string) => Buffer.concat([Buffer.from(body), Buffer.from(block(tag), 'latin1')]);

/** A signer that signs as signtool would (appending a block), and counts what it signed. */
function fakeSigner(store: string, o: { wrong?: (files: string[]) => string; invalid?: (files: string[]) => string[]; refuse?: boolean } = {}) {
  const signed: string[][] = [];
  const lines: string[] = [];
  const s: ScriptSigner = {
    thumbprint: THUMB,
    store,
    sign: (files) => {
      if (o.refuse) throw new Error("couldn't sign the scripts: signtool can't reach the signing certificate's key");
      signed.push(files.map((f) => path.basename(f)));
      for (const f of files) writeFileSync(f, signedAs(readFileSync(f), `S${signed.length}`));
    },
    wrong: o.wrong ?? (() => ''),
    invalid: o.invalid ?? (() => []),
    log: (l) => lines.push(l),
  };
  return { s, signed, lines };
}

test("a script's signature block: what's before it is the script; anything else after it isn't one", () => {
  const body = Buffer.from('Write-Output "hi"\r\n');
  assert.deepEqual(scriptBody(signedAs(body)), body);
  assert.deepEqual(scriptBody(signedAs('no line end')), Buffer.from('no line end'));
  assert.equal(scriptBody(body), null);
  assert.equal(scriptBody(Buffer.concat([signedAs(body), Buffer.from('Write-Output "after"\r\n')])), null, 'code after the block: not a block signing wrote');
  assert.equal(scriptBody(Buffer.from(`x${block().replace('# MIIAAAA', '# not base64!')}`)), null);
  // A BOM, and text that isn't ASCII, are kept byte for byte.
  const bom = Buffer.from('\uFEFFWrite-Output "Größe"\r\n', 'utf8');
  assert.deepEqual(scriptBody(signedAs(bom)), bom);
});

test('the key: the certificate and the text with plain line ends, so a checkout and git name the same script', () => {
  assert.equal(scriptKey('a\r\nb\r\n', THUMB), scriptKey('a\nb\n', THUMB));
  assert.equal(scriptKey(Buffer.from('a\r\n'), THUMB.toLowerCase()), scriptKey('a\n', THUMB));
  assert.notEqual(scriptKey('a\n', THUMB), scriptKey('b\n', THUMB));
  assert.notEqual(scriptKey('a\n', THUMB), scriptKey('a\n', 'A'.repeat(40)));
  assert.match(scriptKey('a\n', THUMB), /^[0-9a-f]{32}$/);
  assert.equal(scriptsStoreOf({ KIT_SIGNED_SCRIPTS: 'D:\\s' }, 'C:\\Users\\me'), 'D:\\s');
  assert.equal(scriptsStoreOf({}, 'C:\\Users\\me'), path.join('C:\\Users\\me', '.steward', 'signed-scripts'));
});

test('a kept copy is taken only for exactly the bytes it was signed from; one that isn\'t those bytes and a block is never kept', () => {
  const store = fresh('store');
  const body = Buffer.from('Get-Date\r\n');
  keepScript(store, 'src/a.ps1', body, THUMB, signedAs(body));
  assert.deepEqual(keptScript(store, 'src/other/a.ps1', body, THUMB), signedAs(body), 'by its text, wherever it is');
  assert.equal(keptScript(store, 'src/a.ps1', Buffer.from('Get-Date\n'), THUMB), null, 'same key, other line ends: signed again');
  assert.equal(keptScript(store, 'src/a.psm1', body, THUMB), null, 'kept by its extension too');
  assert.equal(keptScript(store, 'src/a.ps1', body, 'A'.repeat(40)), null, 'another certificate');
  keepScript(store, 'src/b.ps1', Buffer.from('b\r\n'), THUMB, signedAs('changed\r\n'));
  keepScript(store, 'src/c.ps1', Buffer.from('c\r\n'), THUMB, Buffer.from('c\r\n'));
  assert.equal(existsSync(keptScriptFile(store, scriptKey('b\r\n', THUMB), 'b.ps1')), false);
  assert.equal(existsSync(keptScriptFile(store, scriptKey('c\r\n', THUMB), 'c.ps1')), false);
  // One no release has taken for UNUSED_DAYS goes; taking one keeps it.
  const old = keptScriptFile(store, scriptKey(body, THUMB), 'a.ps1');
  const then = new Date(Date.now() - (UNUSED_DAYS + 1) * 86_400_000);
  utimesSync(old, then, then);
  assert.equal(pruneScripts(store, Date.now()), 1);
  assert.equal(existsSync(old), false);
  assert.equal(pruneScripts(path.join(store, 'none')), 0, 'no store: nothing to do');
});

test("a staged release's scripts: signed and kept, then taken by the next release with no key; a guard's manifest follows them", () => {
  const store = fresh('store');
  const files = {
    'src/guard/install-guard.ps1': 'Write-Output "install"\r\n',
    'src/kit/ps-worker.ps1': 'Write-Output "worker"\r\n',
    'src/mod/m.psm1': 'function F { 1 }\r\n',
    'src/mod/m.psd1': '@{ ModuleVersion = "1.0" }\r\n',
    'src/app.js': 'console.log(1)',
  };
  const manifest = (dir: string) => JSON.stringify({ schema: 1, files: { 'install-guard.ps1': sha(readFileSync(path.join(dir, 'src/guard/install-guard.ps1'))) } }, null, 2);
  const first = fresh('stage');
  put(first, files);
  put(first, { 'src/guard/manifest.json': manifest(first), 'release.json': '{"upper":"' + sha(files['src/kit/ps-worker.ps1']).toUpperCase() + '"}' });
  const a = fakeSigner(store);
  const one = signStagedScripts(first, a.s);
  assert.deepEqual(one.signed, ['src/guard/install-guard.ps1', 'src/kit/ps-worker.ps1', 'src/mod/m.psd1', 'src/mod/m.psm1']);
  assert.deepEqual([one.reused, one.theirs], [[], []]);
  assert.equal(a.signed.length, 1, 'one signtool run for them all');
  for (const [f, text] of Object.entries(files).filter(([f]) => f.endsWith('.ps1') || f.endsWith('.psm1') || f.endsWith('.psd1'))) {
    const now = readFileSync(path.join(first, f));
    assert.deepEqual(scriptBody(now), Buffer.from(text), `${f}: the script as it was, then its block`);
    assert.equal(one.hashes[f], sha(now));
  }
  assert.equal(readFileSync(path.join(first, 'src/app.js'), 'utf8'), files['src/app.js'], 'nothing but scripts is signed');
  assert.deepEqual(one.rewritten, ['release.json', 'src/guard/manifest.json']);
  assert.equal(JSON.parse(readFileSync(path.join(first, 'src/guard/manifest.json'), 'utf8')).files['install-guard.ps1'], one.hashes['src/guard/install-guard.ps1'], "the manifest has the signed script's SHA-256, as install-guard.ps1 will find it");
  assert.equal(JSON.parse(readFileSync(path.join(first, 'release.json'), 'utf8')).upper, one.hashes['src/kit/ps-worker.ps1'].toUpperCase(), 'in the case it was written in');

  // The next release, its scripts unchanged: every one taken from the store, nothing signed, no key needed.
  const second = fresh('stage');
  put(second, files);
  const b = fakeSigner(store, { refuse: true });
  const two = signStagedScripts(second, b.s);
  assert.deepEqual([two.signed, two.reused.length], [[], 4]);
  assert.deepEqual(two.hashes, one.hashes, 'the same bytes as the release before shipped');

  // One script changed: it alone is signed.
  const third = fresh('stage');
  put(third, { ...files, 'src/mod/m.psm1': 'function F { 2 }\r\n' });
  const c = fakeSigner(store);
  const three = signStagedScripts(third, c.s);
  assert.deepEqual([three.signed, three.reused.length, c.signed], [['src/mod/m.psm1'], 3, [['m.psm1']]]);
});

test("a kept copy whose signature doesn't check out now is signed again; a script signed by its maker stays theirs; a broken one is signed afresh", () => {
  const store = fresh('store');
  const files = { 'src/a.ps1': 'a\r\n', 'src/b.ps1': 'b\r\n' };
  const before = fresh('stage');
  put(before, files);
  signStagedScripts(before, fakeSigner(store).s);
  const stage = fresh('stage');
  put(stage, files);
  const f = fakeSigner(store, { wrong: (list) => list.filter((x) => x.endsWith('a.ps1')).map((x) => `${x}|NotTimeStamped`).join('\n') });
  const out = signStagedScripts(stage, f.s);
  assert.deepEqual([out.signed, out.reused], [['src/a.ps1'], ['src/b.ps1']]);
  assert.match(f.lines.join('\n'), /src\/a\.ps1: its kept signature doesn't check out \(NotTimeStamped\), so it's signed again/);
  assert.deepEqual(scriptBody(readFileSync(path.join(stage, 'src/a.ps1'))), Buffer.from('a\r\n'), 'signed from the script, not from the kept copy');

  const theirs = fresh('stage');
  put(theirs, { 'src/vendor/v.ps1': signedAs('vendor\r\n', 'MAKER'), 'src/stale.ps1': signedAs('changed since\r\n', 'OLD') });
  put(theirs, { 'src/m.json': JSON.stringify({ stale: sha(signedAs('changed since\r\n', 'OLD')) }) });
  const g = fakeSigner(store, { invalid: (list) => list.filter((x) => x.endsWith('stale.ps1')) });
  const got = signStagedScripts(theirs, g.s);
  assert.deepEqual([got.theirs, got.signed], [['src/vendor/v.ps1'], ['src/stale.ps1']]);
  assert.deepEqual(readFileSync(path.join(theirs, 'src/vendor/v.ps1')), signedAs('vendor\r\n', 'MAKER'), "its maker's signature, as it came");
  const stale = readFileSync(path.join(theirs, 'src/stale.ps1'));
  assert.deepEqual(scriptBody(stale), Buffer.from('changed since\r\n'), 'its old block taken off, then signed');
  assert.equal(stale.toString('latin1').match(/# SIG # Begin signature block/g)?.length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(theirs, 'src/m.json'), 'utf8')).stale, got.hashes['src/stale.ps1'], "the checkout's hash, block and all, follows it too");

  const none = fresh('stage');
  put(none, { 'src/a.js': '1' });
  assert.deepEqual(signStagedScripts(none, fakeSigner(store, { refuse: true }).s), { signed: [], reused: [], theirs: [], hashes: {}, rewritten: [] });
});

test("a script that can't be signed stops the release, and nothing of it is kept", () => {
  const store = fresh('store');
  const stage = fresh('stage');
  put(stage, { 'src/a.ps1': 'a\r\n' });
  assert.throws(() => signStagedScripts(stage, fakeSigner(store, { refuse: true }).s), /couldn't sign the scripts: signtool can't reach/);
  assert.equal(keptScript(store, 'a.ps1', Buffer.from('a\r\n'), THUMB), null);
});

test('the zip must carry each script exactly as it was signed: a script changed after signing is found', () => {
  const store = fresh('store');
  const stage = fresh('stage');
  put(stage, { 'src/a.ps1': 'a\r\n', 'src/kit/b.ps1': 'b\r\n', 'package.json': '{}' });
  const out = signStagedScripts(stage, fakeSigner(store).s);
  const zip = path.join(fresh('out'), 'Agent-1.0.0.zip');
  const pack = () => execFileSync(TAR, ['-a', '-c', '-f', zip, '-C', stage, 'package.json', 'src'], { windowsHide: true });
  pack();
  assert.deepEqual(changedSinceSigning(zip, out.hashes, TAR), []);
  // A step after signing that touched a script (here, its line ends): the zip no longer carries what was signed.
  const a = path.join(stage, 'src', 'a.ps1');
  writeFileSync(a, readFileSync(a, 'latin1').replace(/\r\n/g, '\n'), 'latin1');
  pack();
  assert.deepEqual(changedSinceSigning(zip, out.hashes, TAR), ['src/a.ps1: changed after it was signed']);
  assert.deepEqual(changedSinceSigning(zip, { ...out.hashes, 'src/gone.ps1': sha('x') }, TAR).at(-1), 'src/gone.ps1: not in the zip');
  assert.deepEqual(changedSinceSigning(zip, {}, TAR), []);
});

test("rewriteHashes: only .json files, only the hashes it's given", () => {
  const stage = fresh('stage');
  const [was, now] = [sha('was'), sha('now')];
  put(stage, { 'a.json': `{"h":"${was}","o":"${sha('other')}"}`, 'b.txt': was, 'c.json': '{}' });
  assert.deepEqual(rewriteHashes(stage, new Map([[was, now]])), ['a.json']);
  assert.equal(readFileSync(path.join(stage, 'a.json'), 'utf8'), `{"h":"${now}","o":"${sha('other')}"}`);
  assert.equal(readFileSync(path.join(stage, 'b.txt'), 'utf8'), was);
  assert.deepEqual(scriptsIn(stage), []);
});

test("which certificate: kit.json's native one, else the owner's where Castellan is released, else none; the signer asked for only when a script isn't kept", () => {
  const native = { thumbprint: 'A'.repeat(40) } as Parameters<typeof scriptsThumbprint>[0];
  assert.equal(scriptsThumbprint(native, null), 'A'.repeat(40));
  assert.equal(scriptsThumbprint(null, 'Jcollier0120/Manor-releases'), SIGNED_BY);
  assert.equal(scriptsThumbprint({ thumbprint: null } as Parameters<typeof scriptsThumbprint>[0], 'Jcollier0120/Manor-releases'), SIGNED_BY);
  assert.equal(scriptsThumbprint(null, null), null, "anyone else's agent: none");

  const store = fresh('store');
  const body = Buffer.from('kept\r\n');
  keepScript(store, 'k.ps1', body, THUMB, signedAs(body));
  let asked = 0;
  const ready = () => (asked++, { signtool: 'signtool.exe', thumbprint: THUMB, timestamp: 'http://time.certum.pl' });
  const all = scriptSigningFor([{ file: 'src/k.ps1', bytes: body }], { thumbprint: THUMB, store, ready });
  assert.deepEqual([asked, all.unkept], [0, []], 'every script kept: no key needed, not even looked for');
  const some = scriptSigningFor([{ file: 'src/k.ps1', bytes: body }, { file: 'src/new.ps1', bytes: Buffer.from('new\r\n') }], { thumbprint: THUMB, store, ready });
  assert.deepEqual([asked, some.unkept], [1, ['src/new.ps1']], 'asked at once, before anything is built');
  some.signer();
  assert.equal(asked, 1, 'once');
  assert.throws(
    () => scriptSigningFor([{ file: 'src/new.ps1', bytes: Buffer.from('new\r\n') }], { thumbprint: THUMB, store, ready: () => ({ problem: "signtool can't reach the signing certificate's key (6B65…)" }) }),
    /^Error: Not published: its scripts can't be signed: signtool can't reach the signing certificate's key/,
  );
});

test("npm run release -- --publish on the PC that releases Castellan: a script to sign and no way to sign it is refused before anything is built", { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const fixture = path.dirname(path.dirname(fileURLToPath(new URL('./fixture/src/app.ts', import.meta.url))));
  const root = fresh('agent');
  cpSync(fixture, root, { recursive: true, filter: (f) => !/[\\/](node_modules|artifacts)([\\/]|$)/.test(f) });
  const kit = readFileSync(path.join(root, 'src', 'kit', 'VERSION'), 'utf8').trim();
  put(root, { 'kit.json': JSON.stringify({ kit }) + '\n', '.gitignore': 'artifacts/\nsrc/kit/\n', 'src/run.ps1': 'Write-Output "run"\r\n' });
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: root, windowsHide: true });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'an agent with a script');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const env = { ...process.env, MANOR_RELEASES_REPO: 'Someone/Releases', KIT_SIGNED_SCRIPTS: fresh('store'), 'ProgramFiles(x86)': fresh('no-sdk'), [`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`]: fresh('home') };
  const r = spawnSync(process.execPath, [path.join(root, 'src', 'kit', 'release.ts'), '--publish'], { cwd: root, encoding: 'utf8', windowsHide: true, env, timeout: 60_000 });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /^Not published: its scripts can't be signed: the Windows SDK's signtool isn't installed/m, 'the words the Steward waits on');
  assert.equal(existsSync(path.join(root, 'artifacts')), false, 'nothing built');
});

test(
  'signed for real (a throwaway certificate, in no store): the block is as scriptBody reads it; tar, an install\'s copy and the kit\'s fill keep the signature; a byte changed breaks it',
  { skip: process.platform !== 'win32' && 'Windows only', timeout: 120_000 },
  () => {
    const dir = fresh('real');
    const body = Buffer.from('\uFEFFWrite-Output "signed"\r\n', 'utf8');
    writeFileSync(path.join(dir, 'a.ps1'), body);
    // The certificate lives in this PowerShell's memory only: nothing is added to any certificate store.
    const ps = (script: string) => {
      const file = path.join(dir, `run-${++n}.ps1`);
      writeFileSync(file, script);
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true, timeout: 90_000 });
      rmSync(file, { force: true });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      return r.stdout.trim();
    };
    ps(`$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest('CN=Kit test signer', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$eku = New-Object System.Security.Cryptography.OidCollection
[void]$eku.Add((New-Object System.Security.Cryptography.Oid('1.3.6.1.5.5.7.3.3')))
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($eku, $false)))
$made = $req.CreateSelfSigned((Get-Date).AddDays(-1), (Get-Date).AddDays(1))
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($made.Export('Pfx', 'x'), 'x', 'Exportable')
$s = Set-AuthenticodeSignature -LiteralPath '${path.join(dir, 'a.ps1')}' -Certificate $cert -HashAlgorithm SHA256
if (-not $s.SignerCertificate) { throw "not signed: $($s.StatusMessage)" }`);
    const signed = readFileSync(path.join(dir, 'a.ps1'));
    assert.deepEqual(scriptBody(signed), body, 'the script as it was, its BOM too, then the block signing appended');

    // What ships: through the zip, an install's copy (cpSync, install.ts), and the kit's fill (tools/kit.ts).
    const zip = path.join(dir, 'r.zip');
    execFileSync(TAR, ['-a', '-c', '-f', zip, '-C', dir, 'a.ps1'], { windowsHide: true });
    mkdirSync(path.join(dir, 'unzipped'));
    execFileSync(TAR, ['-x', '-f', zip, '-C', path.join(dir, 'unzipped')], { windowsHide: true });
    cpSync(path.join(dir, 'unzipped'), path.join(dir, 'installed'), { recursive: true });
    const tree = path.join(dir, 'kit-tree');
    put(tree, { VERSION: '9.9.9\n', 'node/a.ps1': signed });
    const agent = path.join(dir, 'agent');
    put(agent, { 'kit.json': '{"kit": "9.9.9", "parts": ["node"]}' });
    execFileSync(process.execPath, [path.join(import.meta.dirname, '..', '..', 'tools', 'kit.ts'), '--from', tree, '--root', agent], { windowsHide: true, stdio: 'ignore' });
    const filled = path.join(agent, 'src', 'kit', 'a.ps1');
    for (const f of [path.join(dir, 'unzipped', 'a.ps1'), path.join(dir, 'installed', 'a.ps1'), filled]) assert.deepEqual(readFileSync(f), signed, f);

    // A byte of the script changed after signing: Windows no longer finds the signature it had.
    const changed = Buffer.from(signed);
    changed[body.indexOf('signed')] = 'S'.charCodeAt(0);
    writeFileSync(path.join(dir, 'changed.ps1'), changed);
    const status = (f: string) => `(Get-AuthenticodeSignature -LiteralPath '${f}').Status`;
    const said = ps(['a.ps1', path.join('installed', 'a.ps1'), 'changed.ps1'].map((f) => status(path.join(dir, f))).join('\n') + `\n${status(filled)}`).split(/\r?\n/);
    // Signed by a certificate no root vouches for: UnknownError, not Valid; a release's, from Certum, is Valid.
    assert.equal(said[0], 'UnknownError', 'signed, by a certificate Windows has no root for');
    assert.equal(said[1], said[0], 'the installed copy: the same signature');
    assert.equal(said[3], said[0], "the kit's fill: the same signature");
    assert.equal(said[2], 'HashMismatch', 'a byte changed: the signature no longer matches the script');
  },
);
