import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { Ran, Runner } from '../src/run.ts';
import type { Employee } from '../src/settings.ts';

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

const { forgetSigningLooks, HUNG_MS, loadSigningWaits, noteSigningWaits, signingDown, signingHung, signingProblem, signsWith, TRIAL_MS } = await import('../src/signing.ts');
const { releaseOne } = await import('../src/stages/release.ts');
const { releaseUnreleased, roundFailuresFile } = await import('../src/stages/round.ts');
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
  forgetSigningLooks();
  assert.equal(await signingProblem(looking('ok', { code: 1, out: '', err: 'SignTool Error: something else' }).run, PRINT, { signtool }), null, 'anything else is left to the release, which says it better');
});

/** A repository whose release signs (kit.json's native), pushed to its origin; an employee for it. */
function signer(name: string, kitJson: object): Employee {
  const origin = path.join(tmp, `${name}-origin.git`);
  const checkout = path.join(tmp, name);
  sh(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '--quiet', origin, checkout);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false' })) sh(checkout, 'config', k, v);
  writeFileSync(path.join(checkout, 'package.json'), `{\n  "name": "${name.toLowerCase()}",\n  "version": "0.2.3",\n  "scripts": { "release": "node tools/kit.ts && node src/kit/release.ts" }\n}\n`);
  writeFileSync(path.join(checkout, 'kit.json'), JSON.stringify(kitJson));
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', `${name} 0.2.3`);
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const envoy = STAFF.find((x) => x.id === 'porter')!;
  return { ...envoy, checkout, versionFiles: ['package.json'], release: 'npm run release -- --publish' };
}

/** gh lists v0.2.2 as released, and v0.2.3 once the release command has run and exited 0; npm (that command) is noted, and answers `npm`. */
function releasing(o: { npm: Ran; store?: string; sign?: Ran }): { run: Runner; npm: string[][] } {
  const npm: string[][] = [];
  const out = () => (npm.length && o.npm.code === 0 ? ['v0.2.3', 'v0.2.2'] : ['v0.2.2']);
  const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok(out().map((tagName) => ({ tagName, isDraft: false }))) : undefined));
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
  const c = roundConditions({ round, held: [], failedReleases: {}, signingWaits, employees: STAFF, settings }).filter((x) => x.id.startsWith('signing'));
  assert.deepEqual(c.map((x) => [x.id, x.who, x.afterMs, x.since]), [['signing:waits', 'steward', 0, '2026-10-14T17:00:00.000Z']]);
  assert.equal(c[0].title, `${porter.name} 0.5.51, ${clerk.name} 0.3.5 wait to be released until this PC can sign`);
  assert.equal(c[0].detail[0], 'Why: the reason');
  assert.equal(roundConditions({ round, held: [], failedReleases: {}, signingWaits: {}, employees: STAFF, settings }).some((x) => x.id.startsWith('signing')), false);
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
