import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// The trial's end, checked by the agent itself (node/license-check.ts, kit 2.45.0): an agent the Exchequer sells reads
// the license Manor holds (licence.json), verified offline, and holds its rounds only once a trial's runsUntil has
// passed. Everything else (paid, lapsed, no license, one it can't read or verify) runs.
const root = mkdtempSync(path.join(os.tmpdir(), 'fixture-license-'));
const manor = path.join(root, 'manor');
mkdirSync(path.join(manor, 'app'), { recursive: true });
process.env.FIXTURE_HOME = path.join(root, 'data');
process.env.MANOR_HOME = manor;
process.env.MANOR_LICENSE_CHECK = 'on';
after(() => rmSync(root, { recursive: true, force: true }));

/** The Exchequer's key, made for the tests, and trusted through MANOR_LICENCE_KEYS as a development key is. */
const exchequer = generateKeyPairSync('ed25519');
const publicJwk = { ...(exchequer.publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'test-key' };
process.env.MANOR_LICENCE_KEYS = JSON.stringify(publicJwk);

const lic = await import('./fixture/src/kit/license.ts');
const check = await import('./fixture/src/kit/license-check.ts');
const { every, roundFile } = await import('./fixture/src/kit/schedule.ts');
const { readJson } = await import('./fixture/src/kit/store.ts');
const { dutyStatus } = await import('./fixture/src/kit/service.ts');
const { page, pillOf } = await import('./fixture/src/kit/page.ts');
const { pageShell } = await import('./fixture/src/kit/react-page.ts');

const DAY = 24 * 60 * 60_000;
const iso = (t: number) => new Date(t).toISOString();

function signed(payload: Record<string, unknown>, key: KeyObject = exchequer.privateKey, kid = 'test-key'): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = `${part({ alg: 'EdDSA', typ: 'JWT', kid })}.${part(payload)}`;
  return `${head}.${sign(null, Buffer.from(head), key).toString('base64url')}`;
}

/** A license as the Exchequer signs it: `iat` an hour ago unless said. */
function license(o: { tier: 'trial' | 'household' | 'workshop'; runsUntil?: number; updatesUntil?: number | null; iat?: number }): Record<string, unknown> {
  const iat = Math.floor((o.iat ?? Date.now() - 60 * 60_000) / 1000);
  return {
    lic: 'lic_test',
    tier: o.tier,
    updatesUntil: o.updatesUntil === undefined ? (o.tier === 'trial' ? null : iso(Date.now() + 30 * DAY)) : o.updatesUntil === null ? null : iso(o.updatesUntil),
    ...(o.runsUntil !== undefined ? { runsUntil: iso(o.runsUntil) } : {}),
    devices: 1,
    sub: '00000000-0000-4000-8000-000000000000',
    iat,
    exp: iat + 7 * 24 * 3600,
  };
}

const licenceFile = path.join(manor, 'licence.json');
function hold(payload: Record<string, unknown>, key?: KeyObject): void {
  rmSync(licenceFile, { recursive: true, force: true });
  writeFileSync(licenceFile, JSON.stringify({ token: 'secret-token', licence: signed(payload, key) }));
}

/** Manor's exchequer.json (the Exchequer's GET /agents, as Manor keeps it) and its staff.json. */
function sells(agents: { id: string; tier: string }[] | null, staff: Record<string, unknown>[] = []): void {
  const file = path.join(manor, 'exchequer.json');
  if (agents) writeFileSync(file, JSON.stringify({ agents }));
  else rmSync(file, { force: true });
  writeFileSync(path.join(manor, 'app', 'staff.json'), JSON.stringify({ agents: staff }));
}

const SOLD = [
  { id: 'fixture', tier: 'household' },
  { id: 'reeve', tier: 'workshop' },
  { id: 'manor', tier: 'free' },
];

beforeEach(() => {
  sells(SOLD);
  rmSync(path.join(root, 'data'), { recursive: true, force: true });
  check.forgetLicenseCheck();
});

const at = (id = 'fixture', now = Date.now(), latestSeen = 0) => check.checkLicense({ id, home: manor, now, latestSeen });

test('a trial still running: checked, and it runs', () => {
  hold(license({ tier: 'trial', runsUntil: Date.now() + 3 * DAY }));
  const c = at();
  assert.deepEqual([c.checked, c.state, c.ended, c.problem], [true, 'trial', false, null]);
  assert.equal(check.licenseNow().ended, false);
  assert.equal(check.trialEnded(), null);
});

test('a trial that has ended holds it: its rounds, Run now, its ping and its page say "The trial ended: a license brings it back"', async () => {
  hold(license({ tier: 'trial', runsUntil: Date.now() - 60_000 }));
  const c = at();
  assert.deepEqual([c.checked, c.state, c.ended, c.problem], [true, 'trial-ended', true, null]);
  assert.equal(check.trialEnded(), 'The trial ended: a license brings it back');

  // Its rounds: none runs, Run now included, and round.json says why (never a failure, never silent).
  let ran = 0;
  const job = every(60_000, async () => void ran++, { firstDelayMs: 0, name: 'trial' });
  try {
    while (!readJson<any>(roundFile(), {}).rounds?.trial) await new Promise((r) => setTimeout(r, 5));
    const r = readJson<any>(roundFile(), {}).rounds.trial;
    assert.deepEqual([ran, r.ok, r.error, r.waiting], [0, null, null, 'The trial ended: a license brings it back']);
    assert.equal(job.runNow(), false);
    assert.equal(job.state.nextRunAt, null);
    assert.equal(job.state.waiting, 'The trial ended: a license brings it back');
  } finally {
    job.stop();
  }

  // What Manor reads: not running, whatever duty.json says, and why; duty.json itself is left alone.
  const s = dutyStatus({ onDuty: true, since: null }, true, true);
  assert.equal(s.running, false);
  assert.match(s.summary, /^The trial ended: a license brings it back\. .*settings and data are kept/);
  assert.deepEqual(check.licensePing(check.licenseNow()), { license: { state: 'trial-ended', ended: true, runsUntil: c.runsUntil, problem: null } });

  // Its page, string-built and React: the pill and the banner, in plain words, and no "Back on duty".
  const look = { busy: 'Working' } as Parameters<typeof pillOf>[0]['look'];
  assert.equal(pillOf({ look, duty: { onDuty: true, since: null }, ended: check.trialEnded() }).text, 'Trial ended');
  const html = page({ token: 't', body: '<p>body</p>' });
  assert.match(html, /The trial ended: a license brings it back\. Its settings and data are kept/);
  assert.doesNotMatch(html, /Back on duty/);
  const shell = pageShell({ onboarding: null });
  assert.match(shell.trialEnded ?? '', /^The trial ended: a license brings it back\./);
  assert.equal(shell.pill.text, 'Trial ended');
});

test('a new license lifts the hold at once: licence.json changing is read straight away', () => {
  hold(license({ tier: 'trial', runsUntil: Date.now() - 60_000 }));
  assert.equal(check.licenseNow().ended, true);
  hold({ ...license({ tier: 'household' }), lic: 'lic_paid_one_longer' });
  const c = check.licenseNow();
  assert.deepEqual([c.state, c.ended], ['paid', false]);
});

test('paid: it runs, and so does a license of another tier (Manor holds back the updates it does not cover)', () => {
  hold(license({ tier: 'household' }));
  assert.deepEqual([at().state, at().ended, at().problem], ['paid', false, null]);
  assert.deepEqual([at('reeve').state, at('reeve').ended], ['paid', false], 'a Workshop agent under a Household license runs');
  hold(license({ tier: 'workshop', updatesUntil: null }));
  assert.deepEqual([at().state, at().ended], ['pending', false]);
});

test('paid and lapsed: the Freehold license runs, forever', () => {
  hold(license({ tier: 'workshop', updatesUntil: Date.now() - 400 * DAY }));
  for (const now of [Date.now(), Date.now() + 10 * 365 * DAY]) {
    const c = at('fixture', now);
    assert.deepEqual([c.state, c.ended, c.problem], ['lapsed', false, null]);
  }
});

test('a bad signature: it runs, and says why', () => {
  const other = generateKeyPairSync('ed25519');
  hold(license({ tier: 'trial', runsUntil: Date.now() - DAY }), other.privateKey);
  let c = at();
  assert.deepEqual([c.checked, c.state, c.ended], [true, 'bad-signature', false]);
  assert.match(c.problem ?? '', /doesn't verify.*keeps running/);

  // A payload changed after signing doesn't verify either.
  const jws = signed(license({ tier: 'trial', runsUntil: Date.now() - DAY })).split('.');
  jws[1] = Buffer.from(JSON.stringify(license({ tier: 'trial', runsUntil: Date.now() - 2 * DAY }))).toString('base64url');
  writeFileSync(licenceFile, JSON.stringify({ token: 'x', licence: jws.join('.') }));
  c = at();
  assert.deepEqual([c.state, c.ended], ['bad-signature', false]);
  assert.equal(check.licenseNow().ended, false);
});

test('no licence.json: it runs, and says why', () => {
  rmSync(licenceFile, { recursive: true, force: true });
  const c = at();
  assert.deepEqual([c.checked, c.state, c.ended], [true, 'missing', false]);
  assert.match(c.problem ?? '', /no license file.*keeps running/);
  assert.equal(check.licenseNow().ended, false);
  assert.equal(check.trialEnded(), null);
});

test('an unreadable licence.json: it runs, and says why', () => {
  writeFileSync(licenceFile, '{ not json');
  let c = at();
  assert.deepEqual([c.state, c.ended], ['unreadable', false]);
  assert.match(c.problem ?? '', /isn't JSON.*keeps running/);
  writeFileSync(licenceFile, JSON.stringify({ token: 'x' }));
  assert.deepEqual([at().state, at().ended], ['unreadable', false]);
  // Not a file at all.
  rmSync(licenceFile, { force: true });
  mkdirSync(licenceFile);
  c = at();
  assert.deepEqual([c.state, c.ended], ['unreadable', false]);
  assert.equal(check.licenseNow().ended, false);
  rmSync(licenceFile, { recursive: true, force: true });
});

test('the clock set back: the latest time seen, or the license\'s own iat, keeps an ended trial ended', () => {
  const runsUntil = Date.now() - DAY;
  hold(license({ tier: 'trial', runsUntil, iat: runsUntil - 3 * DAY }));
  const before = runsUntil - 2 * DAY;
  // Never seen past its end, a clock set back reads as a running trial...
  assert.equal(at('fixture', before).ended, false);
  // ...but once this agent has seen a later time, it stays ended.
  assert.equal(at('fixture', before, Date.now()).ended, true);
  // As the agent keeps it: seen ended now, then the clock set back, after a restart too (license-check.json).
  assert.equal(check.licenseNow({ now: Date.now() }).ended, true);
  check.forgetLicenseCheck();
  assert.equal(check.licenseNow({ now: before }).ended, true);
  // A license the Exchequer signed after the trial's end proves the time, whatever the clock says.
  check.forgetLicenseCheck();
  rmSync(path.join(root, 'data'), { recursive: true, force: true });
  hold(license({ tier: 'trial', runsUntil, iat: runsUntil + 60 * 60_000 }));
  assert.equal(at('fixture', before).ended, true);
  assert.equal(check.licenseNow({ now: before }).ended, true);
});

test('free and internal agents never check: Manor, Heiward, an agent the Exchequer does not sell, one held back or internal', () => {
  hold(license({ tier: 'trial', runsUntil: Date.now() - DAY }));
  sells([...SOLD, { id: 'heiward', tier: 'household' }, { id: 'auditor', tier: 'workshop' }, { id: 'bailiff', tier: 'workshop' }], [
    { id: 'auditor', heldBack: true },
    { id: 'bailiff', internal: true },
  ]);
  for (const id of ['manor', 'heiward', 'wright', 'auditor', 'bailiff']) {
    const c = at(id);
    assert.deepEqual([id, c.checked, c.ended, c.state], [id, false, false, null]);
    assert.deepEqual(check.licensePing(c), {}, 'its ping is as before');
  }
  assert.equal(at('fixture').ended, true, 'while the sold one is held');
  // No exchequer.json (Manor hasn't heard from the Exchequer): when in doubt, it doesn't check.
  sells(null);
  assert.equal(at('fixture').checked, false);
  // One listed as free isn't sold either.
  sells([{ id: 'fixture', tier: 'free' }]);
  assert.equal(at('fixture').checked, false);
});

test('under node --test, an agent checks only when MANOR_LICENSE_CHECK says so: no agent\'s tests read this PC\'s license', () => {
  hold(license({ tier: 'trial', runsUntil: Date.now() - DAY }));
  assert.equal(check.licenseNow({ env: { NODE_TEST_CONTEXT: 'child' } }).checked, false);
  assert.equal(check.licenseCheckOn({ NODE_TEST_CONTEXT: 'child', MANOR_LICENSE_CHECK: 'on' }), true);
  assert.equal(check.licenseCheckOn({}), true, 'outside the tests it always checks');
});

test("the shared part reads licence.json as Manor's license.ts does", () => {
  hold(license({ tier: 'household' }));
  assert.equal(lic.readHeld(manor)?.token, 'secret-token');
  const v = lic.verifyLicense(lic.readHeld(manor)!.licence, lic.trustedKeys());
  assert.ok('payload' in v && v.payload.tier === 'household');
  assert.ok('error' in lic.verifyLicense(lic.readHeld(manor)!.licence, lic.LICENSE_KEYS), 'the carried key does not verify a test license');
  rmSync(licenceFile, { force: true });
  assert.equal(lic.readHeld(manor), null);
  assert.deepEqual(lic.readHeldFile(manor), { missing: true });
});
