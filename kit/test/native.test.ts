import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { freePort } from './free-port.ts';

// Native files in a release (spec/RELEASES.md, "Native files"): kit.json's "native", the build and its signing, the
// zip carrying both processors, and an install keeping this PC's. Nothing here signs or touches the real home folder.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'native-test-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
const ENV = String(pkg.name).toUpperCase().replace(/-/g, '_');
process.env[`${ENV}_HOME`] = path.join(tmp, 'own-home');
process.env[`${ENV}_PORT`] = String(await freePort());
after(() => rmSync(tmp, { recursive: true, force: true }));

const { APP, appRoot } = await import('./fixture/src/app.ts');
const { ARCHES, archOf, buildNative, keepOwnArch, nativeFolder, nativeOf, nativeRelease, nativeSources, signable, stageNative } = await import('./fixture/src/kit/native.ts');
const { appFolder, install, readRelease } = await import('./fixture/src/kit/install.ts');
const { nativeFor, signingFor } = await import('./fixture/src/kit/release.ts');
const { AGAIN_MS, findSignTool, signArgs, signFiles, signProblem, TRIAL_FAILED, TRIAL_TRIES, trialProblem, TRIAL_MS, verifySigned } = await import('./fixture/src/kit/sign.ts');
const { KEEP_PER_ARCH, keepSigned, keptSigned, signedKey, signedStoreOf, sourcesAt, takeSigned } = await import('./fixture/src/kit/signed-native.ts');
type Deps = import('./fixture/src/kit/install.ts').InstallDeps;
type Native = import('./fixture/src/kit/native.ts').Native;

const THUMB = '6B654D9C34800D4307D42ACD63B925EDA5CE8D33';
let n = 0;
const fresh = (name: string) => {
  const dir = path.join(tmp, `${name}-${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test('kit.json\'s "native": none is none; its paths stay in the repository; both processors unless it says', () => {
  assert.equal(nativeOf({ kit: '2.62.0' }), null);
  const ok = nativeOf({ native: { build: 'native\\build.ps1', out: 'native/build/', thumbprint: THUMB.toLowerCase() } });
  assert.deepEqual(ok, { build: 'native/build.ps1', out: 'native/build', arch: ['arm64', 'x64'], notices: [], inputs: [], thumbprint: THUMB, timestamp: 'http://time.certum.pl' });
  const fed = nativeOf({ native: { build: 'native/build.ps1', out: 'native/build', inputs: ['vendor\\media\\', 'native/host.json'] } }) as Native;
  assert.deepEqual(fed.inputs, ['vendor/media', 'native/host.json']);
  assert.deepEqual(nativeSources(fed), ['native', 'vendor/media', 'native/host.json'], "the build script's folder, then its inputs");
  assert.deepEqual((nativeOf({ native: { build: 'b.ps1', out: 'o', arch: ['x64'], notices: ['N.txt'], timestamp: 'http://ts.example' } }) as Native).arch, ['x64']);
  const wrong = (native: unknown) => {
    const r = nativeOf({ native });
    assert.ok(r && 'error' in r, JSON.stringify(native));
    return (r as { error: string }).error;
  };
  assert.match(wrong('native/build.ps1'), /should be an object/);
  assert.match(wrong({ build: 'native/build.sh', out: 'o' }), /PowerShell script/);
  assert.match(wrong({ build: '../other/build.ps1', out: 'o' }), /PowerShell script in the repository/);
  assert.match(wrong({ build: 'C:\\b.ps1', out: 'o' }), /in the repository/);
  assert.match(wrong({ build: 'b.ps1' }), /"out"/);
  assert.match(wrong({ build: 'b.ps1', out: 'o', arch: ['ia32'] }), /"arch"/);
  assert.match(wrong({ build: 'b.ps1', out: 'o', arch: [] }), /"arch"/);
  assert.match(wrong({ build: 'b.ps1', out: 'o', notices: ['/etc/x'] }), /"notices"/);
  assert.match(wrong({ build: 'b.ps1', out: 'o', inputs: ['../vendor'] }), /"inputs"/);
  assert.match(wrong({ build: 'b.ps1', out: 'o', inputs: 'vendor' }), /"inputs"/);
  assert.match(wrong({ build: 'b.ps1', out: 'o', thumbprint: 'abc' }), /thumbprint/);
  assert.deepEqual(ARCHES, ['arm64', 'x64']);
  assert.equal(archOf('arm64'), 'arm64');
  assert.equal(archOf('x64'), 'x64');
  assert.equal(archOf('ia32'), 'x64', 'anything else runs the x64 build');
});

test("a copy finds its native files for this PC where its kit.json says, checkout or installed; none when it declares none", () => {
  const root = fresh('copy');
  writeFileSync(path.join(root, 'kit.json'), JSON.stringify({ kit: '2.62.0', native: { build: 'native/build.ps1', out: 'native/build' } }));
  mkdirSync(path.join(root, 'native', 'build', 'arm64'), { recursive: true });
  assert.equal(nativeFolder(root, 'arm64'), path.join(root, 'native', 'build', 'arm64'));
  assert.equal(nativeFolder(root, 'x64'), null, "not built for x64");
  writeFileSync(path.join(root, 'kit.json'), JSON.stringify({ kit: '2.62.0' }));
  assert.equal(nativeFolder(root, 'arm64'), null);
});

test('a release checks its "native" against the checkout: its build folder ignored by git, and a certificate to publish with', () => {
  const root = fresh('pin');
  writeFileSync(path.join(root, 'kit.json'), JSON.stringify({ kit: '2.62.0', native: { build: 'native/build.ps1', out: 'native/build' } }));
  assert.throws(() => nativeFor(root, false, () => false), /native\/build, which git doesn't ignore/);
  assert.equal(nativeFor(root, false, () => true)?.out, 'native/build');
  assert.throws(() => nativeFor(root, true, () => true), /never published unsigned/);
  writeFileSync(path.join(root, 'kit.json'), JSON.stringify({ kit: '2.62.0', native: { build: 'native/build.ps1', out: 'native/build', thumbprint: THUMB } }));
  assert.equal(nativeFor(root, true, () => true)?.thumbprint, THUMB);
  writeFileSync(path.join(root, 'kit.json'), JSON.stringify({ kit: '2.62.0' }));
  assert.equal(nativeFor(root, true, () => false), null, 'an agent with no native files releases as before');
  writeFileSync(path.join(root, 'kit.json'), JSON.stringify({ kit: '2.62.0', native: { build: 'x.sh', out: 'o' } }));
  assert.throws(() => nativeFor(root, false, () => true), /PowerShell script/);
});

/** A repository with a stand-in build: it writes each processor's files, and remembers what it was asked. */
function repo(o: { fail?: Partial<Record<'arm64' | 'x64', boolean>>; empty?: boolean } = {}) {
  const root = fresh('repo');
  mkdirSync(path.join(root, 'native'), { recursive: true });
  writeFileSync(path.join(root, 'native', 'build.ps1'), '# stand-in');
  writeFileSync(path.join(root, 'native', 'NOTICES.txt'), 'ONNX Runtime: MIT');
  const n = nativeOf({ native: { build: 'native/build.ps1', out: 'native/build', notices: ['native/NOTICES.txt'], thumbprint: THUMB } }) as Native;
  const asked: string[] = [];
  const signed: string[][] = [];
  const steps = {
    build: (script: string, arch: 'arm64' | 'x64') => {
      asked.push(`${script} ${arch}`);
      if (o.fail?.[arch]) return { code: 1, out: 'error CS1002: ; expected' };
      if (!o.empty) {
        const dir = path.join(root, 'native', 'build', arch);
        mkdirSync(path.join(dir, 'sub'), { recursive: true });
        writeFileSync(path.join(dir, 'host.exe'), `exe ${arch}`);
        writeFileSync(path.join(dir, 'onnxruntime.dll'), 'signed by its maker');
        writeFileSync(path.join(dir, 'sub', 'model.json'), '{}');
      }
      return { code: 0, out: 'built' };
    },
    unsigned: (files: string[]) => files.filter((f) => !f.endsWith('onnxruntime.dll')),
    sign: (files: string[]) => void signed.push(files.map((f) => path.relative(root, f).replace(/\\/g, '/'))),
    log: () => {},
  };
  return { root, n, asked, signed, steps };
}

test("the build runs once per processor, afresh; a published release signs only what isn't signed already", () => {
  const r = repo();
  const stale = path.join(r.root, 'native', 'build', 'x64', 'old.dll');
  mkdirSync(path.dirname(stale), { recursive: true });
  writeFileSync(stale, 'from an earlier build');
  const b = buildNative(r.root, r.n, true, r.steps);
  assert.deepEqual(r.asked, ['native/build.ps1 arm64', 'native/build.ps1 x64']);
  assert.ok(!existsSync(stale), "an earlier build's leftovers never ride along");
  assert.deepEqual(r.signed, [['native/build/arm64/host.exe'], ['native/build/x64/host.exe']], "the runtime's own DLL keeps its maker's signature");
  assert.deepEqual(b.arch.map((a) => [a.arch, a.files.sort(), a.signed]), [
    ['arm64', ['native/build/arm64/host.exe', 'native/build/arm64/onnxruntime.dll', 'native/build/arm64/sub/model.json'], 1],
    ['x64', ['native/build/x64/host.exe', 'native/build/x64/onnxruntime.dll', 'native/build/x64/sub/model.json'], 1],
  ]);
  assert.deepEqual(b.notices, ['native/build/notices/NOTICES.txt']);

  // Staged at the same paths, with the notices beside them.
  const stage = fresh('stage');
  assert.equal(stageNative(r.root, stage, r.n, b), 7);
  assert.equal(readFileSync(path.join(stage, 'native', 'build', 'x64', 'host.exe'), 'utf8'), 'exe x64');
  assert.equal(readFileSync(path.join(stage, 'native', 'build', 'notices', 'NOTICES.txt'), 'utf8'), 'ONNX Runtime: MIT');

  // Not published: nothing is signed.
  const u = repo();
  buildNative(u.root, u.n, false, u.steps);
  assert.deepEqual(u.signed, []);
  assert.deepEqual(signable(['a.exe', 'b.DLL', 'c.json', 'd.so']), ['a.exe', 'b.DLL']);
});

test('a build that fails, or leaves nothing, stops the release with why', () => {
  const f = repo({ fail: { x64: true } });
  assert.throws(() => buildNative(f.root, f.n, false, f.steps), /native\/build\.ps1 -Arch x64 failed \(exit 1\):\nerror CS1002/);
  const e = repo({ empty: true });
  assert.throws(() => buildNative(e.root, e.n, false, e.steps), /left nothing in native\/build\/arm64/);
  const m = repo();
  rmSync(path.join(m.root, 'native', 'NOTICES.txt'));
  assert.throws(() => buildNative(m.root, m.n, false, m.steps), /names native\/NOTICES\.txt, which isn't in the repository/);
});

test("release.json's native: read when it's one, else none, never an error", () => {
  assert.deepEqual(nativeRelease({ out: 'native/build', arch: ['arm64', 'x64'], signed: true }), { out: 'native/build', arch: ['arm64', 'x64'], signed: true });
  assert.equal(nativeRelease(undefined), undefined);
  assert.equal(nativeRelease({ out: '../x', arch: ['x64'] }), undefined);
  assert.equal(nativeRelease({ out: 'o', arch: ['mips'] }), undefined);
});

test("at install, the copy keeps this PC's processor's files and the notices; a release without any for it keeps all and says so", () => {
  const app = fresh('app');
  for (const d of ['arm64', 'x64', 'notices']) mkdirSync(path.join(app, 'native', 'build', d), { recursive: true });
  assert.equal(keepOwnArch(app, { out: 'native/build', arch: ['arm64', 'x64'], signed: true }, 'arm64'), null);
  assert.deepEqual(readdirSync(path.join(app, 'native', 'build')).sort(), ['arm64', 'notices']);
  const only = fresh('app');
  mkdirSync(path.join(only, 'native', 'build', 'x64'), { recursive: true });
  assert.match(keepOwnArch(only, { out: 'native/build', arch: ['x64'], signed: true }, 'arm64')!, /no native files for arm64 \(it has x64\)/);
  assert.ok(existsSync(path.join(only, 'native', 'build', 'x64')));
  assert.equal(keepOwnArch(only, undefined, 'arm64'), null, 'no native files: nothing to do');
});

/** An unpacked release and the data folder it installs into, with stand-ins for Task Scheduler and the page. */
function installCase(o: { native?: boolean; beforeNative?: boolean; running?: number[][] } = {}) {
  const dir = fresh('install');
  const release = path.join(dir, 'unpacked');
  const data = path.join(dir, `.${APP.id}`);
  mkdirSync(path.join(release, 'src'), { recursive: true });
  writeFileSync(path.join(release, 'src', 'cli.ts'), '// the new cli\n');
  const native = { out: 'native/build', arch: ['arm64', 'x64'], signed: true };
  if (o.native) for (const a of ['arm64', 'x64']) {
    mkdirSync(path.join(release, 'native', 'build', a), { recursive: true });
    writeFileSync(path.join(release, 'native', 'build', a, 'host.exe'), a);
  }
  writeFileSync(path.join(release, 'release.json'), JSON.stringify({ id: APP.id, name: APP.name, version: '9.9.9', commit: 'abc1234', dirty: false, built: '2026-10-12T12:00:00.000Z', ...(o.native ? { native } : {}) }));
  const app = appFolder(data);
  mkdirSync(path.join(app, 'src'), { recursive: true });
  writeFileSync(path.join(app, 'release.json'), JSON.stringify({ version: '1.0.0', ...(o.beforeNative ? { native } : {}) }));
  const running = [...(o.running ?? [])];
  const state = { up: true, asked: 0, ended: [] as number[][] };
  const lines: string[] = [];
  const deps: Deps = {
    root: release, dev: false, dataDir: data, node: 'node.exe', user: 'PC\\pat', pageUrl: 'http://x.localhost:1/', home: dir,
    schtasks: async (args) => {
      if (args[0] === '/Run') state.up = true;
      return { code: 0, out: 'SUCCESS' };
    },
    ping: async () => state.up,
    shutdown: async () => {
      state.up = false;
      return 0;
    },
    onDuty: () => true,
    setDuty: () => {},
    sleep: async () => {},
    out: (l) => lines.push(l),
    arch: 'x64',
    programsIn: async (d) => {
      state.asked++;
      assert.equal(d, app);
      return running.length > 1 ? running.shift()! : (running[0] ?? []);
    },
    endPrograms: async (ids) => {
      state.ended.push(ids);
      running.splice(0, running.length, []);
    },
  };
  return { deps, app, state, lines };
}

test("an update carrying native files keeps this PC's processor's, and readRelease says what it carries", async () => {
  const c = installCase({ native: true });
  assert.equal(await install({}, c.deps), 0, c.lines.join('\n'));
  assert.deepEqual(readdirSync(path.join(c.app, 'native', 'build')), ['x64']);
  assert.deepEqual(readRelease(c.app)?.native, { out: 'native/build', arch: ['arm64', 'x64'], signed: true });
  assert.equal(c.state.asked, 0, 'the copy it replaced had no native files: Windows is asked nothing');
});

test('an update first waits for the old copy\'s programs to end with its page, and ends those that stay', async () => {
  // One leaves on its own (the page said bye): nothing is ended.
  const left = installCase({ native: true, beforeNative: true, running: [[4242], []] });
  assert.equal(await install({}, left.deps), 0, left.lines.join('\n'));
  assert.deepEqual(left.state.ended, []);
  // One stays past 5 seconds: it is ended, and said so.
  const stays = installCase({ native: true, beforeNative: true, running: [[4242]] });
  assert.equal(await install({}, stays.deps), 0, stays.lines.join('\n'));
  assert.deepEqual(stays.state.ended, [[4242]]);
  assert.match(stays.lines.join('\n'), /Ending a program still running from .+ \(process 4242\)/);
});

test('signing: the x64 signtool of the newest SDK, timestamped, and a cloud key that isn\'t connected said in words', () => {
  const bin = path.join('C:\\PF86', 'Windows Kits', '10', 'bin');
  const tool = findSignTool({ 'ProgramFiles(x86)': 'C:\\PF86' }, () => ['10.0.22621.0', '10.0.26100.0', 'x64'], (p) => p.includes('x64'));
  assert.equal(tool, path.join(bin, '10.0.26100.0', 'x64', 'signtool.exe'));
  assert.equal(findSignTool({ 'ProgramFiles(x86)': 'C:\\PF86' }, () => { throw new Error('none'); }), null);
  assert.deepEqual(signArgs(['a.exe', 'b.dll'], THUMB, 'http://time.certum.pl'), ['sign', '/sha1', THUMB, '/fd', 'SHA256', '/tr', 'http://time.certum.pl', '/td', 'SHA256', 'a.exe', 'b.dll']);
  assert.match(signProblem('SignTool Error: No certificates were found that met all the given criteria.', THUMB)!, /connect SimplySign Desktop/);
  // Kit 2.92.0: SimplySign Desktop's session had dropped, and signtool said so in words the kit didn't know (2026-10-20).
  assert.match(signProblem('SignTool Error: The specified CSP could not be found.\r\nSignTool Error: An error occurred while attempting to sign: C:\\a.exe', THUMB)!, /^signtool can't reach the signing certificate's key \(6B654D9C.*\)\. If its key is in Certum's cloud, connect SimplySign Desktop/);
  assert.match(signProblem('SignTool Error: Keyset does not exist', THUMB)!, /connect SimplySign Desktop/);
  assert.equal(signProblem('SignTool Error: The specified timestamp server could not be reached.', THUMB), null);
});

// Kit 2.77.9: SimplySign Desktop asks for its sign-in once its session has ended, and holds signtool until someone
// answers. A trial that timed out counted as "can sign", and signFiles then waited ten minutes a batch.
test("signing: a trial signature that doesn't answer in a minute is can't sign, and signFiles tries one before it signs", () => {
  const calls: { args: string[]; timeout: number }[] = [];
  const paused: number[] = [];
  const pause = (ms: number) => void paused.push(ms);
  // The trial signs a throwaway trial.ps1; anything else is the release's own files.
  const answering =
    (...trials: { ok: boolean; timedOut: boolean; text: string }[]) =>
    (tool: string, args: string[], timeout: number) => {
      calls.push({ args, timeout });
      return args.some((a) => a.endsWith('trial.ps1')) ? (trials.length > 1 ? trials.shift()! : trials[0]) : { ok: true, timedOut: false, text: 'Successfully signed' };
    };
  const hung = answering({ ok: false, timedOut: true, text: '' });
  assert.match(trialProblem('signtool.exe', THUMB, { run: hung, pause })!, /^signtool didn't answer within 60 seconds with the signing certificate's key \(6B654D9C.*\): SimplySign Desktop may be waiting for you to sign in/);
  assert.deepEqual(
    calls.map((c) => [c.args.slice(0, 9), c.timeout]),
    [[['sign', '/sha1', THUMB, '/fd', 'SHA256', '/tr', 'http://time.certum.pl', '/td', 'SHA256'], TRIAL_MS]],
    "a real trial signature (kit 2.92.0), timestamped as the release's, a minute",
  );
  assert.deepEqual(paused, [], "a sign-in that's waiting isn't waited on again");

  // The key can't be reached: said at once, as signProblem says it, with no second try.
  for (const text of ['SignTool Error: No certificates were found that met all the given criteria.', 'SignTool Error: The specified CSP could not be found.']) {
    calls.length = 0;
    assert.match(trialProblem('signtool.exe', THUMB, { run: answering({ ok: false, timedOut: false, text }), pause })!, /^signtool can't reach the signing certificate's key .*connect SimplySign Desktop/, text);
    assert.equal(calls.length, 1, text);
  }
  assert.deepEqual(paused, []);

  // Anything else (a timestamp server that didn't answer) is tried again after AGAIN_MS, then said as signtool said it.
  calls.length = 0;
  const other = { ok: false, timedOut: false, text: 'Number of errors: 1\r\nSignTool Error: The specified timestamp server could not be reached.' };
  assert.equal(
    trialProblem('signtool.exe', THUMB, { run: answering(other), pause }),
    `${TRIAL_FAILED} with the signing certificate (${THUMB}), ${TRIAL_TRIES} tries: Number of errors: 1 SignTool Error: The specified timestamp server could not be reached.`,
  );
  assert.equal(calls.length, TRIAL_TRIES);
  assert.deepEqual(paused, Array(TRIAL_TRIES - 1).fill(AGAIN_MS));
  paused.length = 0;
  assert.equal(trialProblem('signtool.exe', THUMB, { run: answering(other, { ok: true, timedOut: false, text: 'Successfully signed' }), pause }), null, 'it signed on the second try');
  assert.deepEqual(paused, [AGAIN_MS]);
  assert.equal(trialProblem('signtool.exe', THUMB, { run: answering({ ok: true, timedOut: false, text: '' }), pause }), null);
  calls.length = 0;
  trialProblem('signtool.exe', THUMB, { run: answering({ ok: true, timedOut: false, text: '' }), timestamp: 'http://ts.example' });
  assert.deepEqual(calls[0].args.slice(5, 7), ['/tr', 'http://ts.example'], "kit.json's own timestamp server");

  // The key's sign-in started waiting while the release built: signFiles gives up after the trial's minute, signing nothing.
  calls.length = 0;
  const signer = { signtool: 'signtool.exe', thumbprint: THUMB, timestamp: 'http://time.certum.pl' };
  assert.throws(() => signFiles(signer, ['a.exe', 'b.dll'], () => {}, { run: hung, pause }), /^Error: couldn't sign the native files: signtool didn't answer within 60 seconds .*SimplySign Desktop may be waiting for you to sign in/);
  assert.deepEqual(calls.map((c) => c.timeout), [TRIAL_MS], 'only the trial ran');
  // The session dropped between the trial and the files (Envoy 0.1.25): said in words, not tried three times.
  calls.length = 0;
  const dropped = (tool: string, args: string[], timeout: number) => {
    calls.push({ args, timeout });
    return args.some((a) => a.endsWith('trial.ps1')) ? { ok: true, timedOut: false, text: 'Successfully signed' } : { ok: false, timedOut: false, text: 'SignTool Error: The specified CSP could not be found.' };
  };
  assert.throws(() => signFiles(signer, ['a.exe'], () => {}, { run: dropped, pause }), /^Error: couldn't sign the native files: signtool can't reach the signing certificate's key/);
  assert.equal(calls.length, 2, 'the trial, then one try of the files');
});

test('verifySigned: signtool verify /pa takes every program kept, a batch at a time, and those signed here are the certificate\'s', () => {
  const calls: string[][] = [];
  const verifying = (ok: boolean) => (tool: string, args: string[]) => {
    calls.push([tool, ...args]);
    return { ok, timedOut: false, text: ok ? 'Successfully verified' : 'SignTool Error: A certificate chain processed, but terminated in a root certificate which is not trusted.\r\nNumber of errors: 1' };
  };
  const programs = Array.from({ length: 45 }, (_, i) => `C:\\kept\\p${i}.dll`);
  const asked: string[][] = [];
  const fine = (files: string[]) => (asked.push(files), '');
  assert.equal(verifySigned('signtool.exe', programs, ['C:\\kept\\p0.dll'], THUMB, { run: verifying(true), wrong: fine }), null);
  assert.deepEqual(calls.map((c) => [c[0], c[1], c[2], c.length - 3]), [['signtool.exe', 'verify', '/pa', 40], ['signtool.exe', 'verify', '/pa', 5]]);
  assert.deepEqual(asked, [['C:\\kept\\p0.dll']], 'only those signed here are checked for the certificate and a timestamp');

  assert.match(verifySigned('signtool.exe', programs, [], THUMB, { run: verifying(false), wrong: fine })!, /^signtool verify \/pa refused them: .*not trusted\. Number of errors: 1$/);
  assert.match(verifySigned('signtool.exe', programs, ['C:\\kept\\p0.dll'], THUMB, { run: verifying(true), wrong: () => 'C:\\kept\\p0.dll|HashMismatch' })!, /^their signatures aren't all 6B654D9C.*'s and timestamped: C:\\kept\\p0\.dll\|HashMismatch$/);
  assert.match(verifySigned(null, programs, [], THUMB)!, /signtool isn't installed/);
  assert.equal(verifySigned(null, [], [], THUMB), null, 'nothing to verify needs no signtool');
});

// Kit 2.92.0: a processor's signed files are kept by what they were built from, and a release with the same native
// sources takes them instead of building and signing (signed-native.ts). Never the real thumbprint: nothing signs here.
const FAKE = 'AB'.repeat(20);
const kitNative = (o: Record<string, unknown> = {}) => nativeOf({ native: { build: 'native/build.ps1', out: 'native/build', thumbprint: FAKE, ...o } }) as Native;
const objectIds = (seed: string) => (p: string) => createHash('sha1').update(`${seed}:${p}`).digest('hex');
const builtFiles = (dir: string, what: string) => {
  mkdirSync(path.join(dir, 'sub'), { recursive: true });
  writeFileSync(path.join(dir, 'host.exe'), `host ${what}`);
  writeFileSync(path.join(dir, 'sub', 'model.json'), '{}');
};

test('signed native files are kept by their native sources, processor and certificate, two a processor', () => {
  const n = kitNative({ inputs: ['vendor/media'] });
  const sources = sourcesAt(n, objectIds('one'))!;
  assert.deepEqual(Object.keys(sources), ['native', 'vendor/media']);
  assert.equal(sourcesAt(n, (p) => (p === 'vendor/media' ? null : objectIds('one')(p))), null, "a source git can't name keys nothing");
  assert.equal(sourcesAt(n, () => 'fatal: not a tree'), null);

  const key = signedKey(n, 'arm64', sources);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(signedKey(kitNative({ inputs: ['vendor/media'] }), 'arm64', { ...sources }), key, 'the same sources, the same key');
  for (const [why, other] of [
    ['another processor', signedKey(n, 'x64', sources)],
    ['another certificate', signedKey(kitNative({ inputs: ['vendor/media'], thumbprint: 'CD'.repeat(20) }), 'arm64', sources)],
    ['a source changed', signedKey(n, 'arm64', sourcesAt(n, objectIds('two'))!)],
    ['another out folder', signedKey(kitNative({ inputs: ['vendor/media'], out: 'native/out' }), 'arm64', sources)],
  ]) assert.notEqual(other, key, why);

  assert.equal(signedStoreOf('envoy', { ENVOY_HOME: 'D:\\envoy-home' }, 'C:\\Users\\me'), path.join('D:\\envoy-home', 'signed-native'));
  assert.equal(signedStoreOf('media-host', {}, 'C:\\Users\\me'), path.join('C:\\Users\\me', '.media-host-dev', 'signed-native'));

  const store = fresh('store');
  const built = fresh('built');
  builtFiles(built, 'one');
  assert.equal(keptSigned(store, key), null);
  keepSigned(store, key, built, { arch: 'arm64', thumbprint: FAKE, sources, version: '0.1.24', commit: 'abc1234', signed: [path.join(built, 'host.exe')], now: new Date('2026-10-19T10:00:00Z') });
  const kept = keptSigned(store, key)!;
  assert.deepEqual([kept.version, kept.commit, kept.arch, kept.signed, Object.keys(kept.files).sort()], ['0.1.24', 'abc1234', 'arm64', ['host.exe'], ['host.exe', 'sub/model.json']]);
  assert.equal(kept.files['host.exe'], createHash('sha256').update('host one').digest('hex'));
  assert.deepEqual(readdirSync(store), [key], 'nothing half-written is left beside it');

  // Taken back into a release's own folder, checked, and verified with what signtool would be given.
  const into = path.join(fresh('release'), 'native', 'build', 'arm64');
  const verified: string[][][] = [];
  const took = takeSigned(store, key, into, (programs, here) => (verified.push([programs, here]), null));
  assert.ok(took && 'kept' in took, JSON.stringify(took));
  assert.equal(readFileSync(path.join(into, 'host.exe'), 'utf8'), 'host one');
  assert.deepEqual(verified, [[[path.join(into, 'host.exe')], [path.join(into, 'host.exe')]]]);
  assert.equal(takeSigned(store, 'f'.repeat(32), into, () => null), null, 'none kept by that key');

  // Signatures that don't check out now: refused, the folder emptied, the copy kept for a later look.
  const refused = takeSigned(store, key, into, () => 'signtool verify /pa refused them: not trusted');
  assert.deepEqual(refused, { why: 'signtool verify /pa refused them: not trusted' });
  assert.ok(!existsSync(into));
  assert.ok(keptSigned(store, key));

  // A kept file that isn't the one kept: refused, and the copy let go.
  writeFileSync(path.join(store, key, 'files', 'host.exe'), 'someone else');
  const tampered = takeSigned(store, key, into, () => null);
  assert.deepEqual(tampered, { why: "host.exe isn't the file kept" });
  assert.equal(keptSigned(store, key), null);
  keepSigned(store, key, built, { arch: 'arm64', thumbprint: FAKE, sources, version: '0.1.24', commit: 'abc1234', signed: [], now: new Date('2026-10-19T10:00:00Z') });
  rmSync(path.join(store, key, 'files', 'sub'), { recursive: true });
  assert.match((takeSigned(store, key, into, () => null) as { why: string }).why, /has 1 files, not the 2 it should/);

  // The newest KEEP_PER_ARCH copies of each processor stay; the other processor's aren't counted with them.
  const x64 = signedKey(n, 'x64', sources);
  keepSigned(store, x64, built, { arch: 'x64', thumbprint: FAKE, sources, version: '0.1.20', commit: 'aaa', signed: [], now: new Date('2026-10-01T10:00:00Z') });
  const keys = ['one', 'two', 'three'].map((seed, i) => {
    const k = signedKey(n, 'arm64', sourcesAt(n, objectIds(seed))!);
    keepSigned(store, k, built, { arch: 'arm64', thumbprint: FAKE, sources: sourcesAt(n, objectIds(seed))!, version: `0.2.${i}`, commit: 'bbb', signed: [], now: new Date(Date.UTC(2026, 9, 10 + i)) });
    return k;
  });
  assert.equal(KEEP_PER_ARCH, 2);
  assert.deepEqual(readdirSync(store).sort(), [keys[1], keys[2], x64].sort(), "arm64's oldest is let go; x64's one stays");
});

test("a release takes a processor's kept signed files instead of building and signing it, and keeps those it signs", () => {
  const r = repo();
  const kept: string[] = [];
  const from = new Map<string, { from: string; signed: number } | null>([['arm64', { from: 'v0.1.24', signed: 1 }], ['x64', null]]);
  const lines: string[] = [];
  const steps = {
    ...r.steps,
    log: (l: string) => void lines.push(l),
    reuse: (arch: 'arm64' | 'x64', dir: string) => {
      const took = from.get(arch) ?? null;
      if (took) builtFiles(dir, `kept ${arch}`);
      return took;
    },
    keep: (arch: 'arm64' | 'x64', dir: string, signed: string[]) => void kept.push(`${arch}: ${signed.map((f) => path.relative(dir, f)).join(',')}`),
  };
  const b = buildNative(r.root, r.n, true, steps);
  assert.deepEqual(r.asked, ['native/build.ps1 x64'], 'only the processor with nothing kept is built');
  assert.deepEqual(r.signed, [['native/build/x64/host.exe']], 'and only it is signed');
  assert.deepEqual(kept, ['x64: host.exe'], 'what it signed is kept for the releases after it');
  assert.deepEqual(b.arch.map((a) => [a.arch, a.signed, a.reused]), [['arm64', 1, 'v0.1.24'], ['x64', 1, undefined]]);
  assert.equal(readFileSync(path.join(r.root, 'native', 'build', 'arm64', 'host.exe'), 'utf8'), 'host kept arm64');
  assert.match(lines.join('\n'), /native files for arm64: the signed ones v0\.1\.24 kept, from the same native sources/);

  // A copy that couldn't be kept is said, and the release goes on.
  const k = repo();
  const said: string[] = [];
  buildNative(k.root, k.n, true, { ...k.steps, log: (l: string) => void said.push(l), keep: () => { throw new Error('the disk is full'); } });
  assert.match(said.join('\n'), /couldn't keep the signed files for arm64, so the next release signs them again: the disk is full/);
  assert.equal(k.signed.length, 2);

  // A release that isn't published neither takes nor keeps any.
  const u = repo();
  let asked = 0;
  buildNative(u.root, u.n, false, { ...u.steps, reuse: () => (asked++, { from: 'v0.1.24', signed: 1 }), keep: () => void asked++ });
  assert.equal(asked, 0);
  assert.deepEqual(u.asked, ['native/build.ps1 arm64', 'native/build.ps1 x64']);
});

test("signingFor: the key is asked for before building only when a processor's signed files aren't kept", () => {
  const n = kitNative({ inputs: ['vendor/media'] });
  const store = fresh('signing-store');
  const ids = objectIds('same');
  // This PC has no certificate FAKE names, so asking for the key always fails, in words, before anything is built.
  const cantSign = /^Error: Not published: its native files can't be signed: /;
  assert.throws(() => signingFor(n, { dirty: false, version: '0.1.25', commit: 'd644e5c', store, objectOf: ids, log: () => {} }), cantSign, 'nothing kept');
  assert.throws(() => signingFor(n, { dirty: true, version: '0.1.25', commit: 'd644e5c', store, objectOf: ids, log: () => {} }), cantSign, 'a dirty tree takes none');

  const sources = sourcesAt(n, ids)!;
  const built = fresh('signing-built');
  mkdirSync(built, { recursive: true });
  writeFileSync(path.join(built, 'host.json'), '{"host": 1}');
  keepSigned(store, signedKey(n, 'arm64', sources), built, { arch: 'arm64', thumbprint: FAKE, sources, version: '0.1.24', commit: 'c0ffee1', signed: [] });
  assert.throws(() => signingFor(n, { dirty: false, version: '0.1.25', commit: 'd644e5c', store, objectOf: ids, log: () => {} }), cantSign, "x64's aren't kept");
  keepSigned(store, signedKey(n, 'x64', sources), built, { arch: 'x64', thumbprint: FAKE, sources, version: '0.1.24', commit: 'c0ffee1', signed: [] });

  // Every processor's kept: no key needed, and each is taken from the store.
  const lines: string[] = [];
  const s = signingFor(n, { dirty: false, version: '0.1.25', commit: 'd644e5c', store, objectOf: ids, log: (l) => void lines.push(l) });
  const into = path.join(fresh('signing-into'), 'x64');
  assert.deepEqual(s.reuse!('x64', into), { from: 'v0.1.24', signed: 0 });
  assert.equal(readFileSync(path.join(into, 'host.json'), 'utf8'), '{"host": 1}');
  assert.throws(() => s.signer(), cantSign, 'still asked for, should a copy not check out');

  // A changed source keys afresh: the key is asked for again.
  assert.throws(() => signingFor(n, { dirty: false, version: '0.1.26', commit: 'e1', store, objectOf: (p) => (p === 'native' ? objectIds('changed')(p) : ids(p)), log: () => {} }), cantSign);
});

test('npm run release carries both processors\' native files and their notices; publishing them unsigned is refused', { skip: process.platform !== 'win32' && 'needs Windows tar.exe and PowerShell' }, () => {
  // The fixture as an agent's own repository with a native build: a script that writes each processor's files.
  const root = path.join(tmp, 'native-repo');
  cpSync(appRoot, root, { recursive: true });
  const kit = readFileSync(path.join(appRoot, 'src', 'kit', 'VERSION'), 'utf8').trim();
  mkdirSync(path.join(root, 'native'), { recursive: true });
  writeFileSync(path.join(root, 'native', 'build.ps1'), "param([string]$Arch)\n$o = Join-Path $PSScriptRoot \"build\\$Arch\"\nNew-Item -ItemType Directory -Force $o | Out-Null\nSet-Content -LiteralPath (Join-Path $o 'host.txt') -Value \"host for $Arch\"\n");
  writeFileSync(path.join(root, 'native', 'NOTICES.txt'), 'Runtime: MIT\n');
  writeFileSync(path.join(root, 'kit.json'), JSON.stringify({ kit, native: { build: 'native/build.ps1', out: 'native/build', notices: ['native/NOTICES.txt'] } }) + '\n');
  writeFileSync(path.join(root, '.gitignore'), 'artifacts/\nsrc/kit/\nnative/build/\n');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: root, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/Jcollier0120/Fixture.git');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture with native files');
  const env = { ...process.env, STEWARD_ESBUILD: path.resolve(appRoot, '..', '..', '..') };
  const release = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'src', 'kit', 'release.ts'), ...args], { cwd: root, encoding: 'utf8', windowsHide: true, env });

  let r = release();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /native files for arm64: native\/build\/arm64, 1 files, .*not signed/);
  assert.doesNotMatch(r.stdout, /with uncommitted changes/, 'the build folder is ignored, so building leaves the tree clean');
  const zip = path.join(root, 'artifacts', APP.id, `${APP.name}-${pkg.version}.zip`);
  const into = path.join(tmp, 'native-unpacked');
  mkdirSync(into, { recursive: true });
  // Only what's asserted is unpacked: Defender reads every file tar writes.
  execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-x', '-f', zip, '-C', into, 'native', 'release.json'], { windowsHide: true });
  assert.match(readFileSync(path.join(into, 'native', 'build', 'arm64', 'host.txt'), 'utf8'), /host for arm64/);
  assert.match(readFileSync(path.join(into, 'native', 'build', 'x64', 'host.txt'), 'utf8'), /host for x64/);
  assert.equal(readFileSync(path.join(into, 'native', 'build', 'notices', 'NOTICES.txt'), 'utf8'), 'Runtime: MIT\n');
  assert.deepEqual(JSON.parse(readFileSync(path.join(into, 'release.json'), 'utf8')).native, { out: 'native/build', arch: ['arm64', 'x64'], signed: false });

  // A change to the native sources makes the release dirty: a second build, so only before a kit is published
  // (STEWARD_RELEASE_TESTS=1, as install.test.ts's FULL_RELEASE).
  if (process.env.STEWARD_RELEASE_TESTS === '1') {
    writeFileSync(path.join(root, 'native', 'build.ps1'), `${readFileSync(path.join(root, 'native', 'build.ps1'), 'utf8')}# changed\n`);
    r = release();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /with uncommitted changes/);
    git('commit', '-q', '-am', 'changed');
  }

  // No certificate named: refused before anything is built.
  r = release('--publish');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /never published unsigned/);
});

test("pagesIn: the Node processes running an app folder's page, serve or the open that starts it, however they're quoted; nothing else (kit 2.75.2)", { skip: process.platform !== 'win32' && 'Windows paths' }, async () => {
  const { pagesIn } = await import('./fixture/src/kit/native.ts');
  const app = String.raw`C:\Users\pat\.steward\app`;
  const lines = [
    String.raw`101 "C:\Program Files\nodejs\node.exe" "C:\Users\pat\.steward\app\src\cli.ts" serve`,
    String.raw`102 node C:\Users\pat\.steward\app\src\cli.ts open`,
    String.raw`103 "C:\Program Files\nodejs\node.exe" c:/users/pat/.steward/app/src/cli.js serve `,
    // The install's probation watcher runs from app too, and is never a page.
    String.raw`201 node C:\Users\pat\.steward\app\src\cli.ts install --watch-probation 0.36.49 --from 0.36.46 --since 1`,
    String.raw`202 node C:\Users\pat\.steward-dev\app\src\cli.ts serve`,
    String.raw`203 node C:\Users\pat\.steward\app.prev\src\cli.ts serve`,
    String.raw`204 node C:\Users\pat\.reeve\app\src\cli.ts serve`,
    String.raw`205 node D:\copy\C:\Users\pat\.steward\app\src\cli.ts serve`,
    String.raw`206 node C:\Users\pat\.steward\app\src\cli.ts serve --port 1`,
    '207',
    '',
    'not a process',
  ].join('\r\n');
  assert.deepEqual(pagesIn(lines, app), [101, 102, 103]);
});

test('pagesFrom finds a page process running from an app folder, and endProcesses ends it', { skip: process.platform !== 'win32' && 'needs PowerShell' }, async () => {
  const { endProcesses, pagesFrom } = await import('./fixture/src/kit/native.ts');
  const app = path.join(tmp, 'starting', 'app');
  mkdirSync(path.join(app, 'src'), { recursive: true });
  writeFileSync(path.join(app, 'src', 'cli.ts'), 'setInterval(() => {}, 1000);\n');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(app, 'src', 'cli.ts'), 'serve'], { stdio: 'ignore', windowsHide: true });
  try {
    let found: number[] = [];
    for (let i = 0; i < 20 && !found.includes(child.pid!); i++) {
      found = pagesFrom(app);
      if (!found.includes(child.pid!)) await new Promise((r) => setTimeout(r, 250));
    }
    assert.deepEqual(found, [child.pid], 'the page, and only it');
    assert.deepEqual(pagesFrom(path.join(tmp, 'starting', 'other')), []);
    endProcesses(found);
    for (let i = 0; i < 20 && pagesFrom(app).length; i++) await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(pagesFrom(app), []);
  } finally {
    child.kill();
  }
});
