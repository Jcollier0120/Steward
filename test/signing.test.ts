import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { Ran, Runner } from '../src/run.ts';
import type { Employee } from '../src/settings.ts';
import type { Ctx } from '../src/stages/common.ts';

// Steward 0.36.30: a release that signs waits while this PC can't sign (SimplySign Desktop not connected), rather than
// failing for good. On 2026-10-14 Manor's, Envoy's and Heiward's releases each failed for it, an alarm and a Wright
// issue apiece, and the rounds wouldn't try them again.
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'steward-signing-')));
process.env.STEWARD_HOME = tmp;
after(() => rmSync(tmp, { recursive: true, force: true }));
// A Windows SDK's signtool where findSignTool looks, whatever this PC has installed (Steward 0.36.85): a release's look
// before it builds finds it, and the tests' runner answers it. On a PC without the SDK, the release was told "signtool
// isn't installed" instead of the answer the test gave it.
const kits = path.join(tmp, 'Program Files (x86)');
const sdk = path.join(kits, 'Windows Kits', '10', 'bin', '10.0.26100.0', 'x64');
mkdirSync(sdk, { recursive: true });
writeFileSync(path.join(sdk, 'signtool.exe'), '');
process.env['ProgramFiles(x86)'] = kits;

const { forgetSigningLooks, HUNG_MS, keptSigningDown, loadSigningAhead, loadSigningWaits, needsSigning, noteSigningAhead, noteSigningWaits, signingDown, signingHung, signingProblem, signsWith, TRIAL_MS } = await import('../src/signing.ts');
const { releaseOne } = await import('../src/stages/release.ts');
const { AHEAD_MS, forgetSigningAhead, releaseUnreleased, roundFailuresFile, SIGNED_AGAIN_MS, signedBetween, signingAhead } = await import('../src/stages/round.ts');
const { AGAIN_MS, TRIAL_FAILED } = await import('../src/kit/sign.ts');
const { nativeOf } = await import('../src/kit/native.ts');
const { keepSigned, signedKey, signedStoreOf, sourcesAt } = await import('../src/kit/signed-native.ts');
const { keepScript } = await import('../src/kit/signed-scripts.ts');
const { run: realRun } = await import('../src/run.ts');
type Native = import('../src/kit/native.ts').Native;
type BuildRun = import('../src/pipeline.ts').BuildRun;
const { releaseDirOf } = await import('../src/stages/common.ts');
const { checksLogOf } = await import('../src/stages/bump.ts');
const { roundConditions } = await import('../src/alarms.ts');
const { DEFAULT_SETTINGS } = await import('../src/settings.ts');
const { STAFF } = await import('./fixtures/staff.ts');
const { ctxFor, ok, runner, sh } = await import('./helpers.ts');

const PRINT = '6B654D9C34800D4307D42ACD63B925EDA5CE8D33';
const NO_KEY = 'SignTool Error: No certificates were found that met all the given criteria.';
beforeEach(() => forgetSigningLooks());

test('signsWith: kit.json\'s native thumbprint for a release that publishes, else a tools/sign.ts that names one', () => {
  const kitJson = JSON.stringify({ kit: '2.73.2', native: { build: 'native/build.ps1', out: 'native/build', thumbprint: PRINT.toLowerCase() } });
  assert.equal(signsWith({ kitJson, signTs: null, release: 'npm run release -- --publish' }), PRINT);
  assert.equal(signsWith({ kitJson, signTs: null, release: 'npm run release' }), null, 'built here alone: not signed');
  assert.equal(signsWith({ kitJson: '{"kit":"2.73.2"}', signTs: `export const THUMBPRINT = '${PRINT}';\n`, release: 'npm run release -- --publish' }), PRINT, "Manor's setup");
  assert.equal(signsWith({ kitJson: 'not json', signTs: null, release: 'npm run release -- --publish' }), null);
  assert.equal(signsWith({ kitJson: '{"kit":"2.73.2"}', signTs: null, release: 'npm run release -- --publish' }), null, 'signs nothing');
});

test("signingDown: the line that says the key couldn't be reached, in signtool's, the kit's or Manor's words", () => {
  const manor = `release: signtool can't reach the signing certificate's key (${PRINT}): SimplySign Desktop is running but not connected. Connect it`;
  assert.equal(signingDown(`building…\r\n${manor}\r\n`), manor);
  assert.match(signingDown(`Not published: its native files can't be signed: signtool can't reach the signing certificate's key (${PRINT}).`)!, /^Not published/);
  assert.match(signingDown("release: SimplySign Desktop isn't running, and the signing key is in its cloud")!, /isn't running/);
  assert.equal(signingDown(`x\n${NO_KEY}\n`), NO_KEY);
  assert.equal(signingDown('npm ERR! code ELIFECYCLE\nError: tests failed'), null);
  // A signtool that didn't answer (0.36.62): kit 2.77.9's trial, the kit's batches before it, and Manor's tools/sign.ts.
  const hangs = [
    `Error: couldn't sign the native files: signtool didn't answer within 60 seconds with the signing certificate's key (${PRINT}): SimplySign Desktop may be waiting for you to sign in`,
    "Error: couldn't sign the native files: signtool didn't finish within 10 minutes: is the certificate's sign-in waiting?",
    "Error: couldn't sign Castellan-Setup.exe: signtool didn't finish within 10 minutes. Is SimplySign Desktop connected? Its sign-in may be waiting.",
  ];
  for (const line of hangs) {
    assert.equal(signingDown(`building…\n${line}\n`), line);
    assert.equal(signingHung(line), true, line);
  }
  assert.equal(signingHung(NO_KEY), false, 'the key gone is not a hang');
});

// Steward 0.36.161: on 2026-10-20 SimplySign Desktop's session dropped while Envoy 0.1.25 built, and signtool said so in
// words neither the kit nor the Steward knew: a failed release the rounds wouldn't try again.
test("signingDown: the words a dropped SimplySign session gives signtool, and kit 2.92.0's test signature that failed", () => {
  // Kit 2.91.0's release, as Envoy 0.1.25's said it: its files tried three times, then their last lines.
  const old = [
    '  signing failed (try 2 of 3), trying again in 15 s: SignTool Error: The specified CSP could not be found.',
    "Error: couldn't sign the native files: Done Adding Additional Store",
    'SignTool Error: The specified CSP could not be found.',
    'SignTool Error: An error occurred while attempting to sign: D:\\envoy\\native\\build\\x64\\media-host.exe',
  ].join('\r\n');
  assert.equal(signingDown(`building…\r\n${old}\r\n`), 'SignTool Error: The specified CSP could not be found.');
  assert.equal(signingDown('SignTool Error: Keyset does not exist'), 'SignTool Error: Keyset does not exist');
  const trial = `Not published: its native files can't be signed: ${TRIAL_FAILED} with the signing certificate (${PRINT}), 2 tries: SignTool Error: The specified timestamp server either could not be reached or returned an invalid response.`;
  assert.equal(signingDown(`building…\n${trial}\n`), trial);
  assert.equal(signingHung(trial), false);
  const noTool = "Not published: its native files can't be signed: the Windows SDK's signtool isn't installed (winget install Microsoft.WindowsSDK.10.0.26100)";
  assert.equal(signingDown(noTool), noTool, "any signer the kit couldn't have");
  // The output a round kept of such a release: it waits, rather than standing failed.
  const dir = path.join(tmp, 'kept-csp');
  mkdirSync(path.dirname(checksLogOf(dir)), { recursive: true });
  writeFileSync(checksLogOf(dir), `npm run release -- --publish (exit 1)\n\n${old}\n`);
  assert.equal(keptSigningDown(dir), true);
});

/** A runner for the look: the certificate store says `store`, a trial signature exits `sign`. */
function looking(store: string, sign: Ran): { run: Runner; asked: string[] } {
  const asked: string[] = [];
  const run: Runner = async (cmd) => {
    asked.push(path.basename(cmd));
    if (cmd === 'powershell.exe') return ok(`${store}\r\n`);
    if (/signtool\.exe$/i.test(cmd)) return sign;
    return { code: 1, out: '', err: `not here: ${cmd}` };
  };
  return { run, asked };
}

test('signingProblem: the certificate and its key, then a trial signature; one look a minute, shared', async () => {
  const signtool = 'C:\\Kits\\x64\\signtool.exe';
  const down = looking('ok', { code: 1, out: '', err: NO_KEY });
  const why = await signingProblem(down.run, PRINT, { signtool, now: 1000 });
  assert.match(why!, /can't reach the code-signing key .*connect SimplySign Desktop/);
  assert.equal(await signingProblem(down.run, PRINT, { signtool, now: 30_000 }), why, 'the same look');
  assert.deepEqual(down.asked, ['powershell.exe', 'signtool.exe'], 'looked once');
  assert.equal(await signingProblem(looking('ok', ok('Successfully signed')).run, PRINT, { signtool, now: 70_000 }), null, 'a minute on, looked again: it can sign');
  forgetSigningLooks();
  assert.match((await signingProblem(looking('none', ok('')).run, PRINT, { signtool }))!, /isn't in Cert:\\CurrentUser\\My: .*SimplySign/);
  forgetSigningLooks();
  assert.match((await signingProblem(looking('ok', ok('')).run, PRINT, { signtool: null }))!, /signtool isn't installed/);

  // Anything else (Steward 0.36.161): tried again after AGAIN_MS, as the kit's trial is, then said as signtool said it.
  forgetSigningLooks();
  const paused: number[] = [];
  const pause = async (ms: number) => void paused.push(ms);
  const blip = looking('ok', { code: 1, out: '', err: 'SignTool Error: The specified timestamp server either could not be reached or returned an invalid response.' });
  assert.equal(await signingProblem(blip.run, PRINT, { signtool, pause }), `${TRIAL_FAILED} with the code-signing key (${PRINT}): SignTool Error: The specified timestamp server either could not be reached or returned an invalid response.`);
  assert.deepEqual([blip.asked, paused], [['powershell.exe', 'signtool.exe', 'signtool.exe'], [AGAIN_MS]], 'two tries, a pause between');
  forgetSigningLooks();
  let tries = 0;
  const second: Runner = async (cmd) => (cmd === 'powershell.exe' ? ok('ok\r\n') : ++tries === 1 ? { code: 1, out: '', err: 'SignTool Error: timestamp' } : ok('Successfully signed'));
  assert.equal(await signingProblem(second, PRINT, { signtool, pause }), null, 'it signed the second time');
  // A dropped session's words (2026-10-20): the key gone, said at once.
  forgetSigningLooks();
  paused.length = 0;
  const csp = looking('ok', { code: 1, out: 'Done Adding Additional Store\r\n', err: 'SignTool Error: The specified CSP could not be found.' });
  assert.match((await signingProblem(csp.run, PRINT, { signtool, pause }))!, /^signtool can't reach the code-signing key \(6B654D9C.*\): connect SimplySign Desktop/);
  assert.deepEqual([csp.asked, paused], [['powershell.exe', 'signtool.exe'], []]);
  // The trial is a real signature, timestamped as a release's (kit 2.92.0).
  forgetSigningLooks();
  const args: string[][] = [];
  const recording: Runner = async (cmd, a) => (cmd === 'powershell.exe' ? ok('ok\r\n') : (args.push(a), ok('Successfully signed')));
  assert.equal(await signingProblem(recording, PRINT, { signtool, timestamp: 'http://ts.example' }), null);
  assert.deepEqual(args[0].slice(0, 9), ['sign', '/sha1', PRINT, '/fd', 'SHA256', '/tr', 'http://ts.example', '/td', 'SHA256']);
  assert.match(args[0][9], /trial\.ps1$/);
});

/** A repository with native sources (native\, vendor\), committed: its folder, and a commit of more files in it. */
function nativeRepo(name: string) {
  const repo = path.join(tmp, name);
  sh(tmp, 'init', '--quiet', '-b', 'main', repo);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false' })) sh(repo, 'config', k, v);
  const commit = (files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      writeFileSync(path.join(repo, f), t);
    }
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '--quiet', '-m', Object.keys(files).join(', '));
    return sh(repo, 'rev-parse', 'HEAD');
  };
  return { repo, commit };
}

/** Keeps signed files for each processor, as the kit's release does once it has signed them (signed-native.ts). */
function keepBoth(store: string, n: Native, repo: string, commit: string, arches = n.arch) {
  const sources = sourcesAt(n, (p) => sh(repo, 'rev-parse', `${commit}:${p}`))!;
  const built = mkdtempSync(path.join(tmp, 'built-'));
  writeFileSync(path.join(built, 'media-host.exe'), 'signed here');
  for (const arch of arches) keepSigned(store, signedKey(n, arch, sources), built, { arch, thumbprint: n.thumbprint!, sources, version: '0.1.24', commit: commit.slice(0, 7), signed: [path.join(built, 'media-host.exe')] });
}

test("needsSigning: a release with kit 2.92.0 signs nothing once every processor's signed files are kept for its native sources", async () => {
  const { repo, commit } = nativeRepo('needs-signing');
  const first = commit({ 'native/build.ps1': 'param($Arch)\n', 'vendor/media.txt': 'v1\n', 'README.md': 'one\n' });
  const kitJson = (kit: string) => JSON.stringify({ kit, native: { build: 'native/build.ps1', out: 'native/build', inputs: ['vendor'], thumbprint: PRINT } });
  const env = { ENVOY_HOME: path.join(tmp, 'envoy-home') };
  const ask = (o: { commit?: string; kitJson?: string | null } = {}) => needsSigning(realRun, { id: 'envoy', repo, commit: o.commit ?? first, kitJson: o.kitJson === undefined ? kitJson('2.92.0') : o.kitJson, env });
  assert.equal(await ask(), true, 'nothing kept yet');
  const n = nativeOf(JSON.parse(kitJson('2.92.0'))) as Native;
  const store = signedStoreOf('envoy', env);
  assert.equal(store, path.join(tmp, 'envoy-home', 'signed-native'));
  keepBoth(store, n, repo, first, ['arm64']);
  assert.equal(await ask(), true, "x64's aren't kept");
  keepBoth(store, n, repo, first);
  assert.equal(await ask(), false, 'both kept: it signs nothing');
  assert.equal(await ask({ kitJson: kitJson('2.91.0') }), true, 'a kit before 2.92.0 signs every time');
  assert.equal(await ask({ kitJson: '{"kit":"2.92.0"}' }), true, "Manor's setup (tools/sign.ts) signs every time");
  assert.equal(await ask({ kitJson: 'not json' }), true);
  assert.equal(await ask({ kitJson: null }), true);
  assert.equal(await ask({ commit: 'f'.repeat(40) }), true, "a commit git doesn't have");
  const elsewhere = commit({ 'README.md': 'two\n' });
  assert.equal(await ask({ commit: elsewhere }), false, 'a change outside the native sources keeps them');
  const media = commit({ 'vendor/media.txt': 'v2\n' });
  assert.equal(await ask({ commit: media }), true, 'a change to an input builds and signs afresh');
});

// Steward 0.36.209: from kit 2.123.0 a published release signs its PowerShell scripts, with the owner's certificate on the
// PC that releases Castellan; most take the signed copies kept from a release before (the kit's signed-scripts.ts).
const BLOCK = '\r\n# SIG # Begin signature block\r\n# MIIAAAA\r\n# SIG # End signature block\r\n';
const keepSignedScript = (store: string, file: string, text: string) => keepScript(store, file, Buffer.from(text), PRINT, Buffer.from(`${text}${BLOCK}`));

test("signsWith: from kit 2.123.0, on the PC that releases Castellan, the owner's certificate for its scripts", () => {
  const kitJson = (kit: string) => JSON.stringify({ kit, parts: ['node'] });
  const publish = 'npm run release -- --publish';
  assert.equal(signsWith({ kitJson: kitJson('2.123.0'), signTs: null, release: publish, castellan: true }), PRINT);
  assert.equal(signsWith({ kitJson: kitJson('2.120.0'), signTs: null, release: publish, castellan: true }), null, 'a kit before signs no scripts');
  assert.equal(signsWith({ kitJson: kitJson('2.123.0'), signTs: null, release: publish }), null, "anyone else's PC: nothing of the owner's");
  assert.equal(signsWith({ kitJson: kitJson('2.123.0'), signTs: null, release: 'npm run release', castellan: true }), null, 'built here alone: not signed');
  const other = 'A'.repeat(40);
  assert.equal(signsWith({ kitJson: JSON.stringify({ kit: '2.123.0', native: { build: 'native/build.ps1', out: 'native/build', thumbprint: other } }), signTs: null, release: publish, castellan: true }), other, "kit.json's native certificate first");
  const line = "Not published: its scripts can't be signed: the Windows SDK's signtool isn't installed.";
  assert.equal(signingDown(`building…\r\n${line}\r\n`), line, 'a wait, in the kit\'s words');
});

test('needsSigning: from kit 2.123.0 a Castellan release signs nothing once every script it ships has a signed copy kept', async () => {
  const { repo, commit } = nativeRepo('needs-scripts');
  const first = commit({ '.gitignore': 'src/kit/\n', 'src/guard/install-guard.ps1': 'Write-Output 1\n', 'src/app.ts': 'export {};\n' });
  const kitDir = path.join(repo, 'src', 'kit');
  mkdirSync(kitDir, { recursive: true });
  writeFileSync(path.join(kitDir, 'VERSION'), '2.123.0\n');
  writeFileSync(path.join(kitDir, 'ps-worker.ps1'), 'worker\r\n');
  const env = { KIT_SIGNED_SCRIPTS: path.join(tmp, 'scripts-store'), STEWARD_KITS: path.join(tmp, 'kits') };
  const pin = (kit = '2.123.0') => JSON.stringify({ kit, parts: ['node'] });
  const ask = (o: { commit?: string; kitJson?: string; castellan?: boolean } = {}) => needsSigning(realRun, { id: 'lamplighter', repo, commit: o.commit ?? first, kitJson: o.kitJson ?? pin(), castellan: o.castellan ?? true, checkout: repo, env });
  assert.equal(await ask(), true, 'nothing kept yet');
  // As the release's checkout has it (CRLF), where git has LF: the same script.
  keepSignedScript(env.KIT_SIGNED_SCRIPTS, 'install-guard.ps1', 'Write-Output 1\r\n');
  assert.equal(await ask(), true, "the kit's script isn't kept");
  keepSignedScript(env.KIT_SIGNED_SCRIPTS, 'ps-worker.ps1', 'worker\r\n');
  assert.equal(await ask(), false, 'every script kept: it signs nothing, so it never waits for SimplySign');
  assert.equal(await ask({ kitJson: pin('2.120.0') }), true, 'a kit before 2.123.0 with no native files: as before (asked only when signsWith says it signs)');
  assert.equal(await ask({ castellan: false }), true, 'likewise anywhere else');

  // The checkout's src\kit at another kit: the kit as this PC keeps it, the parts pinned (dotnet isn't).
  writeFileSync(path.join(kitDir, 'VERSION'), '2.120.0\n');
  assert.equal(await ask(), true, "neither the checkout's kit nor a kept one is 2.123.0");
  const kept = path.join(env.STEWARD_KITS, '2.123.0');
  for (const [f, t] of Object.entries({ VERSION: '2.123.0\n', 'node/ps-worker.ps1': 'worker\n', 'dotnet/other.ps1': 'not pinned\n' })) {
    mkdirSync(path.dirname(path.join(kept, f)), { recursive: true });
    writeFileSync(path.join(kept, f), t);
  }
  assert.equal(await ask(), false, 'the kit as kept here');
  const changed = commit({ 'src/guard/install-guard.ps1': 'Write-Output 2\n' });
  assert.equal(await ask({ commit: changed }), true, 'a script changed: it signs it');
});

test("a Castellan release whose scripts are all kept doesn't wait while this PC can't sign; one with a script to sign does", async () => {
  const e = signer('Scripts', { kit: '2.123.0', parts: ['node'] }, { '.gitignore': 'src/kit/\n', 'src/run.ps1': 'Write-Output "run"\n' });
  const kitDir = path.join(e.checkout!, 'src', 'kit');
  mkdirSync(kitDir, { recursive: true });
  writeFileSync(path.join(kitDir, 'VERSION'), '2.123.0\n');
  const store = path.join(tmp, 'scripts-store-release');
  process.env.KIT_SIGNED_SCRIPTS = store;
  try {
    const r = releasing({ npm: ok('') });
    const waits = await releaseOne(ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-scripts-wait'), run: r.run, neutralDir: tmp }), e, { kit: null });
    assert.equal(waits.outcome, 'skipped', waits.message);
    assert.match(waits.message, /^v0\.2\.3 waits until this PC can sign: /);
    assert.deepEqual(r.npm, [], 'its release command never ran');

    keepSignedScript(store, 'run.ps1', 'Write-Output "run"\n');
    forgetSigningLooks();
    const r2 = releasing({ npm: ok('') });
    const w = watched(r2.run);
    const done = await releaseOne(ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-scripts-kept'), run: w.run, neutralDir: tmp }), e, { kit: null });
    assert.equal(done.outcome, 'done', done.message);
    assert.equal(r2.npm.length, 1, 'its release ran');
    assert.deepEqual(w.looked, [], "no look at signing: SimplySign Desktop isn't needed");
  } finally {
    delete process.env.KIT_SIGNED_SCRIPTS;
  }
});

test("a release whose signed native files are kept from the same sources doesn't wait while this PC can't sign: it signs nothing", async () => {
  const native = { kit: '2.92.0', parts: ['node'], native: { build: 'native/build.ps1', out: 'native/build', thumbprint: PRINT } };
  const e = signer('Kept', native, { 'native/build.ps1': 'param($Arch)\n' });
  const head = sh(e.checkout!, 'rev-parse', 'HEAD');
  const home = path.join(tmp, 'porter-home');
  process.env.PORTER_HOME = home;
  try {
    keepBoth(signedStoreOf(e.id), nativeOf(native) as Native, e.checkout!, head);
    const r = releasing({ npm: ok('') });
    const w = watched(r.run);
    const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-kept'), run: w.run, neutralDir: tmp });
    const out = await releaseOne(ctx, e, { kit: null });
    assert.equal(out.outcome, 'done', out.message);
    assert.equal(r.npm.length, 1, 'its release ran');
    assert.deepEqual(w.looked, [], "no look at signing: SimplySign Desktop isn't needed");
  } finally {
    delete process.env.PORTER_HOME;
  }
});

/** A repository whose release signs (kit.json's native), pushed to its origin; an employee for it. */
function signer(name: string, kitJson: object, files: Record<string, string> = {}): Employee {
  const origin = path.join(tmp, `${name}-origin.git`);
  const checkout = path.join(tmp, name);
  sh(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '--quiet', origin, checkout);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false' })) sh(checkout, 'config', k, v);
  writeFileSync(path.join(checkout, 'package.json'), `{\n  "name": "${name.toLowerCase()}",\n  "version": "0.2.3",\n  "scripts": { "release": "node tools/kit.ts && node src/kit/release.ts" }\n}\n`);
  writeFileSync(path.join(checkout, 'kit.json'), JSON.stringify(kitJson));
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true });
    writeFileSync(path.join(checkout, f), t);
  }
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', `${name} 0.2.3`);
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const envoy = STAFF.find((x) => x.id === 'porter')!;
  return { ...envoy, checkout, versionFiles: ['package.json'], release: 'npm run release -- --publish' };
}

/**
 * gh lists v0.2.2 as released, and v0.2.3 once the release command has run and exited 0; npm (that command) is noted, and
 * answers `npm`. Every commit is vouched for by the team, so a build's test of main's head before its release
 * (mainbuild.ts's mainGate) is done already.
 */
function releasing(o: { npm: Ran; store?: string; sign?: Ran }): { run: Runner; npm: string[][] } {
  const npm: string[][] = [];
  const out = () => (npm.length && o.npm.code === 0 ? ['v0.2.3', 'v0.2.2'] : ['v0.2.2']);
  const r = runner((args) => {
    if (args[0] === 'release' && args[1] === 'list') return ok(out().map((tagName) => ({ tagName, isDraft: false })));
    if (args[0] === 'api' && /\/commits\/[0-9a-f]{40}\/statuses/.test(args[1])) return ok([{ context: 'steward/tested', state: 'success', creator: { login: 'Jcollier0120' } }]);
  });
  const run: Runner = async (cmd, args, opts) => {
    if (cmd === 'npm') {
      npm.push(args);
      return o.npm;
    }
    if (cmd === 'powershell.exe') return ok(`${o.store ?? 'ok'}\r\n`);
    if (/signtool\.exe$/i.test(cmd)) return o.sign ?? { code: 1, out: '', err: NO_KEY };
    return r.run(cmd, args, opts);
  };
  return { run, npm };
}

test('a release that signs waits while this PC cannot sign: nothing built, nothing failed, looked at again next round', async () => {
  const e = signer('Signer', { kit: '2.73.2', parts: ['node'], native: { build: 'native/build.ps1', out: 'native/build', thumbprint: PRINT } });
  const r = releasing({ npm: ok('') });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-wait'), run: r.run, neutralDir: tmp });
  const waits = await releaseOne(ctx, e, { kit: null });
  assert.equal(waits.outcome, 'skipped', waits.message);
  assert.match(waits.message, /^v0\.2\.3 waits until this PC can sign: /);
  assert.ok(waits.signing && waits.again, 'a wait, looked at again');
  assert.deepEqual(r.npm, [], 'its release command never ran');
  assert.equal(existsSync(releaseDirOf(ctx.settings, e)), false, 'no worktree made');
});

// Steward 0.36.60: a trial signature that didn't answer (SimplySign Desktop waiting for its sign-in) counted as "can
// sign", so the release built and then sat in its own signtool up to its half-hour limit, with the round waiting on it.
test("a trial signature that doesn't answer is can't sign, and stands a quarter of an hour: no round waits on signtool again meanwhile, and nothing is built", async () => {
  const signtool = 'C:\\Kits\\x64\\signtool.exe';
  const limits: (number | undefined)[] = [];
  const hung = looking('ok', { code: 1, out: '', err: '', timedOut: true });
  const run: Runner = (cmd, args, opts) => {
    if (/signtool\.exe$/i.test(cmd)) limits.push(opts?.timeoutMs);
    return hung.run(cmd, args, opts);
  };
  const why = await signingProblem(run, PRINT, { signtool, now: 0 });
  assert.match(why!, /^signtool didn't answer within 60 seconds with the code-signing key \(6B654D9C.*\): SimplySign Desktop may be waiting for you to sign in/);
  assert.deepEqual(limits, [TRIAL_MS], 'the trial has a minute');
  assert.equal(await signingProblem(run, PRINT, { signtool, now: 5 * 60_000 }), why, 'five minutes on: the same answer');
  assert.equal(await signingProblem(run, PRINT, { signtool, now: HUNG_MS - 1 }), why, 'and just before the quarter of an hour');
  assert.deepEqual(hung.asked, ['powershell.exe', 'signtool.exe'], 'signtool asked once in all that time');
  assert.equal(await signingProblem(looking('ok', ok('Successfully signed')).run, PRINT, { signtool, now: HUNG_MS }), null, 'then looked at again: it can sign');

  // A release that signs, while its look stands: it waits, and its release command never runs.
  forgetSigningLooks();
  await signingProblem(run, PRINT, { signtool, now: Date.now() });
  const e = signer('Hung', { kit: '2.73.2', parts: ['node'], native: { build: 'native/build.ps1', out: 'native/build', thumbprint: PRINT } });
  const r = releasing({ npm: ok(''), sign: ok('Successfully signed') });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-hung'), run: r.run, neutralDir: tmp });
  const waits = await releaseOne(ctx, e, { kit: null });
  assert.equal(waits.outcome, 'skipped', waits.message);
  assert.equal(waits.message, `v0.2.3 waits until this PC can sign: ${why}`);
  assert.deepEqual(r.npm, [], 'its release command never ran');
});

test("a release that loses the key while it builds waits too, rather than failing; a round's failure for it before isn't held", async () => {
  // No native in kit.json, so no look first: the release finds the key gone itself (SimplySign's session ended).
  const e = signer('Lapsed', { kit: '2.73.2', parts: ['node'] });
  const said = `Not published: its native files can't be signed: signtool can't reach the signing certificate's key (${PRINT}). If its key is in Certum's cloud, connect SimplySign Desktop`;
  const lapsed = releasing({ npm: { code: 1, out: '', err: `${said}\n` } });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-lapsed'), run: lapsed.run, neutralDir: tmp });
  const out = await releaseUnreleased(ctx, [e]);
  assert.equal(out[0].outcome, 'skipped', out[0].message);
  assert.equal(out[0].signing, said);
  assert.match(ctx.lines.join('\n'), /\[porter\] Jcollier0120 vouched for [0-9a-f]{7}: not tested again before its release/, 'the build tests main before its release: its vouch covers it');
  assert.deepEqual(JSON.parse(readFileSync(roundFailuresFile(), 'utf8')), {}, 'nothing held against its commit');
  const commit = sh(e.checkout!, 'rev-parse', 'HEAD').slice(0, 7);
  assert.deepEqual(Object.entries(loadSigningWaits()).map(([id, w]) => [id, w.version, w.commit, w.why]), [[e.id, '0.2.3', commit, said]]);

  // As a round before 0.36.30 kept it: failed at this commit, its output kept beside the worktree. It's tried again.
  writeFileSync(roundFailuresFile(), JSON.stringify({ [e.id]: commit }));
  mkdirSync(path.dirname(checksLogOf(releaseDirOf(ctx.settings, e))), { recursive: true });
  writeFileSync(checksLogOf(releaseDirOf(ctx.settings, e)), `npm run release -- --publish (exit 1)\n\n${said}\n`);
  const fixed = releasing({ npm: ok('') });
  const again = await releaseUnreleased({ ...ctx, run: fixed.run }, [e]);
  assert.equal(fixed.npm.length, 1, 'tried again');
  assert.equal(again[0].outcome, 'done', again[0].message);
  assert.deepEqual(loadSigningWaits(), {}, 'no longer waits');
});

// Steward 0.36.62: the sign-in started waiting while a release built. The kit's release gave up on signtool after ten
// minutes, in words the Steward didn't know: a failed release, left to a person, and each signed release after it in the
// round built and waited its ten minutes too.
test("a release whose signtool hangs while it builds waits rather than failing, and the signed releases after it don't build: the hang stands a quarter of an hour", async () => {
  const native = { kit: '2.77.9', parts: ['node'], native: { build: 'native/build.ps1', out: 'native/build', thumbprint: PRINT } };
  const first: Employee = { ...signer('First', native), id: 'first', name: 'First' };
  const second: Employee = { ...signer('Second', native), id: 'second', name: 'Second' };
  const hang = `Error: couldn't sign the native files: signtool didn't answer within 60 seconds with the signing certificate's key (${PRINT}): SimplySign Desktop may be waiting for you to sign in`;
  // The look before it says this PC can sign; the release itself then meets the hang.
  const r = releasing({ npm: { code: 1, out: 'built\n', err: `${hang}\n` }, sign: ok('Successfully signed') });
  const ctx = ctxFor({ employees: [first, second], workRoot: path.join(tmp, 'work-hang'), run: r.run, neutralDir: tmp });
  const a = await releaseOne(ctx, first, { kit: null });
  assert.equal(a.outcome, 'skipped', a.message);
  assert.equal(a.message, `v0.2.3 waits until this PC can sign: ${hang}`);
  assert.ok(a.signing && a.again, 'a wait, looked at again');
  assert.equal(r.npm.length, 1, "the first's release ran, and met the hang");

  const b = await releaseOne(ctx, second, { kit: null });
  assert.equal(b.outcome, 'skipped', b.message);
  assert.equal(b.message, `v0.2.3 waits until this PC can sign: ${hang}`);
  assert.equal(r.npm.length, 1, "the second's release never ran");
  const later = looking('ok', ok('Successfully signed'));
  assert.equal(await signingProblem(later.run, PRINT, { signtool: 'signtool.exe', now: Date.now() + HUNG_MS - 60_000 }), hang, 'nearly a quarter of an hour on: the same answer');
  assert.deepEqual(later.asked, [], 'signtool not asked meanwhile');
  assert.equal(await signingProblem(later.run, PRINT, { signtool: 'signtool.exe', now: Date.now() + HUNG_MS + 1000 }), null, 'then looked at again: it can sign');
});

test('the alarm: one for every release that waits until this PC can sign, raised at once, gone once none waits', () => {
  const round = { stage: 'round' as const, started: '', finished: '', kit: null, asked: {}, results: [], log: [] };
  const settings = { ...DEFAULT_SETTINGS, employees: STAFF };
  const [porter, clerk] = ['porter', 'clerk'].map((id) => STAFF.find((x) => x.id === id)!);
  const signingWaits = {
    porter: { version: '0.5.51', commit: 'abc1234', why: 'the reason', since: '2026-10-14T17:00:00.000Z' },
    clerk: { version: '0.3.5', commit: 'def5678', why: 'the later reason', since: '2026-10-14T18:00:00.000Z' },
  };
  const c = roundConditions({ round, failedReleases: {}, signingWaits, employees: STAFF, settings }).filter((x) => x.id.startsWith('signing'));
  assert.deepEqual(c.map((x) => [x.id, x.who, x.afterMs, x.since]), [['signing:waits', 'steward', 0, '2026-10-14T17:00:00.000Z']]);
  assert.equal(c[0].title, `${porter.name} 0.5.51, ${clerk.name} 0.3.5 wait to be released until this PC can sign`);
  assert.equal(c[0].detail[0], 'Why: the reason');
  assert.match(c[0].detail[1], /^Reconnect SimplySign Desktop \(your SimplySign ID and the one-time code from the phone app\)/);
  assert.match(c[0].detail[2], /^Nothing failed, and nothing needs a click or a new commit: .*releases them by itself, between builds too, and this alarm clears\.$/);
  assert.equal(roundConditions({ round, failedReleases: {}, signingWaits: {}, employees: STAFF, settings }).some((x) => x.id.startsWith('signing')), false);
});

test('noteSigningWaits: a wait keeps its first time while its version waits; one forgotten once it no longer does', () => {
  noteSigningWaits({ a: { version: '1.0.0', commit: 'aaaaaaa', why: 'x' } }, new Date('2026-10-14T10:00:00Z'));
  noteSigningWaits({ a: { version: '1.0.0', commit: 'bbbbbbb', why: 'y' } }, new Date('2026-10-14T11:00:00Z'));
  assert.deepEqual(loadSigningWaits().a, { version: '1.0.0', commit: 'bbbbbbb', why: 'y', since: '2026-10-14T10:00:00.000Z' });
  noteSigningWaits({ a: { version: '1.0.1', commit: 'ccccccc', why: 'y' } }, new Date('2026-10-14T12:00:00Z'));
  assert.equal(loadSigningWaits().a.since, '2026-10-14T12:00:00.000Z', 'a new version waits afresh');
  noteSigningWaits({ a: null });
  assert.deepEqual(loadSigningWaits(), {});
});

/** A runner that notes each look at signing (the certificate store, signtool) before `run` answers it. */
function watched(run: Runner): { run: Runner; looked: string[] } {
  const looked: string[] = [];
  return {
    looked,
    run: (cmd, args, opts) => {
      if (cmd === 'powershell.exe' || /signtool\.exe$/i.test(cmd)) looked.push(path.basename(cmd));
      return run(cmd, args, opts);
    },
  };
}

const nativeKit = (kit: string) => ({ kit, parts: ['node'], native: { build: 'native/build.ps1', out: 'native/build', thumbprint: PRINT } });

// Steward 0.36.161: a release that waited until this PC could sign was released only at the next build time, after a
// person reconnected SimplySign Desktop. Now each round between builds signs a test file, and builds it once it can.
test('signedBetween: between builds, each release that waits is looked at with a test signature, and those that can sign build at once', async () => {
  const e = signer('Between', nativeKit('2.91.0'));
  const commit = sh(e.checkout!, 'rev-parse', 'HEAD').slice(0, 7);
  noteSigningWaits({ [e.id]: { version: '0.2.3', commit, why: 'SignTool Error: The specified CSP could not be found.' } }, new Date('2026-10-20T13:55:00Z'));
  const now = new Date('2026-10-20T14:30:00Z');
  const workRoot = path.join(tmp, 'work-between');

  // Still can't sign: no build, and the wait says why as the look found it, waiting since it began.
  const down = releasing({ npm: ok('') });
  const ctx = ctxFor({ employees: [e], workRoot, run: down.run, neutralDir: tmp });
  assert.deepEqual(await signedBetween(ctx, [e], [], now), []);
  assert.match(loadSigningWaits()[e.id].why, /^signtool can't reach the code-signing key \(6B654D9C.*\): connect SimplySign Desktop/);
  assert.equal(loadSigningWaits()[e.id].since, '2026-10-20T13:55:00.000Z');
  assert.deepEqual(down.npm, [], 'nothing built to find out');
  assert.deepEqual(await signedBetween(ctxFor({ employees: [e], workRoot, run: down.run, neutralDir: tmp }), [], [], now), [], 'not among the repositories asked about');

  // SimplySign Desktop reconnected: a build of its own, at once.
  forgetSigningLooks();
  const up = watched(releasing({ npm: ok(''), sign: ok('Successfully signed') }).run);
  const back = ctxFor({ employees: [e], workRoot, run: up.run, neutralDir: tmp });
  assert.deepEqual(await signedBetween(back, [e], [], now), [e.id]);
  assert.match(back.lines.join('\n'), new RegExp(`${e.name} v0\\.2\\.3 waited until this PC could sign, and it can now: it builds at once, a build of its own`));
  assert.deepEqual(up.looked, ['powershell.exe', 'signtool.exe'], 'one test signature');

  // Its build met the key gone again: not another while that build is under SIGNED_AGAIN_MS old.
  forgetSigningLooks();
  up.looked.length = 0;
  const build: BuildRun = { due: now.toISOString(), by: 'signing', started: now.toISOString(), rounds: 1, merged: [], released: [], failed: [], employees: [e.id] };
  assert.deepEqual(await signedBetween(back, [e], [build], new Date(now.getTime() + SIGNED_AGAIN_MS - 60_000)), []);
  assert.deepEqual(up.looked, [], 'not looked at meanwhile');
  assert.deepEqual(await signedBetween(back, [e], [{ ...build, by: 'urgent' }], new Date(now.getTime() + 60_000)), [e.id], "another kind of build doesn't count");
  assert.deepEqual(await signedBetween(back, [e], [build], new Date(now.getTime() + SIGNED_AGAIN_MS)), [e.id], 'a quarter of an hour on, it builds again');

  // Released since (by hand, or on another PC): forgotten, and nothing builds.
  const released = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok([{ tagName: 'v0.2.3', isDraft: false }]) : undefined));
  const gone = ctxFor({ employees: [e], workRoot, run: released.run, neutralDir: tmp });
  assert.deepEqual(await signedBetween(gone, [e], [], now), []);
  assert.match(gone.lines.join('\n'), /v0\.2\.3 no longer waits until this PC can sign: it is released/);
  assert.deepEqual(loadSigningWaits(), {});
  // One of an employee Settings no longer have: forgotten too.
  noteSigningWaits({ dropped: { version: '1.0.0', commit: 'abc1234', why: 'x' } });
  assert.deepEqual(await signedBetween(back, [e], [], now), []);
  assert.deepEqual(loadSigningWaits(), {});
});

test("signingAhead: within the hour before a build that would sign, a test signature, and an alarm at once while this PC can't sign", async () => {
  forgetSigningLooks();
  forgetSigningAhead();
  const e = signer('Ahead', nativeKit('2.91.0'));
  const head = sh(e.checkout!, 'rev-parse', 'HEAD');
  const glance = (releases: string[]) => ({ at: '', stewardReleases: null, repos: { [e.id]: { head, prs: [], releases: releases.map((tagName) => ({ tagName, isDraft: false, publishedAt: null, commit: null })) } }, errors: {} }) as unknown as Ctx['glance'];
  const down = watched(releasing({ npm: ok('') }).run);
  const ctx: Ctx = { ...ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-ahead'), run: down.run, neutralDir: tmp }), glance: glance(['v0.2.2']) };
  const next = new Date('2026-10-20T16:00:00Z');

  // More than an hour before it: nothing looked at.
  assert.equal(await signingAhead(ctx, [e], next, new Date(next.getTime() - AHEAD_MS - 60_000)), null);
  assert.equal(await signingAhead(ctx, [e], null, new Date(next.getTime() - 60_000)), null, 'no build to come');
  assert.deepEqual(down.looked, []);

  // Within the hour, it can't sign, and the build would sign v0.2.3: kept for the alarm.
  const at = new Date(next.getTime() - 50 * 60_000);
  const a = await signingAhead(ctx, [e], next, at);
  assert.deepEqual(a && [a.build, a.names, a.since], [next.toISOString(), [`${e.name} 0.2.3`], at.toISOString()]);
  assert.match(a!.why, /^signtool can't reach the code-signing key/);
  assert.deepEqual(loadSigningAhead(), a);
  const round = { stage: 'round' as const, started: '', finished: '', kit: null, asked: {}, results: [], log: [] };
  const settings = { ...DEFAULT_SETTINGS, employees: [e] };
  const c = roundConditions({ round, failedReleases: {}, signingWaits: {}, signingAhead: a, employees: [e], settings }).filter((x) => x.id.startsWith('signing'));
  assert.deepEqual(c.map((x) => [x.id, x.who, x.afterMs, x.since]), [[`signing:ahead:${next.toISOString()}`, 'steward', 0, at.toISOString()]]);
  assert.match(c[0].title, new RegExp(`^This PC can't sign now, and the .+ build would sign ${e.name} 0\\.2\\.3: reconnect SimplySign Desktop before it$`));
  assert.equal(c[0].detail[0], `Why: ${a!.why}`);

  // Ten minutes on, still not: the same alarm, since it began.
  forgetSigningLooks();
  assert.equal((await signingAhead(ctx, [e], next, new Date(at.getTime() + 10 * 60_000)))!.since, at.toISOString());

  // Reconnected: the test signature works, and the alarm clears. That head isn't looked at again for this build.
  forgetSigningLooks();
  const up = watched(releasing({ npm: ok(''), sign: ok('Successfully signed') }).run);
  assert.equal(await signingAhead({ ...ctx, run: up.run }, [e], next, new Date(at.getTime() + 20 * 60_000)), null);
  assert.equal(loadSigningAhead(), null);
  forgetSigningLooks();
  down.looked.length = 0;
  assert.equal(await signingAhead(ctx, [e], next, new Date(at.getTime() + 30 * 60_000)), null);
  assert.deepEqual(down.looked, [], 'found fine for this build');

  // Released already, or one that waits (with its own alarm): nothing looked at.
  forgetSigningAhead();
  assert.equal(await signingAhead({ ...ctx, glance: glance(['v0.2.3', 'v0.2.2']) }, [e], next, at), null);
  noteSigningWaits({ [e.id]: { version: '0.2.3', commit: head.slice(0, 7), why: 'x' } });
  assert.equal(await signingAhead(ctx, [e], next, at), null);
  noteSigningWaits({ [e.id]: null });
  assert.deepEqual(down.looked, []);
  noteSigningAhead(null);
});
