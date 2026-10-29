import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { until } from './until.ts';

// The license, checked by the agent itself (node/license-check.ts, kit 2.45.0, 2.110.0 and 2.113.0): every agent but
// Manor and Heiward reads the license Manor holds (licence.json), verified offline and held against this PC's id, and
// holds its rounds once a trial's runsUntil has passed, or when this PC holds no license for it (none, one it can't
// read or verify, another PC's). Paid, lapsed and pending licenses run.
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
function license(o: { tier: 'trial' | 'household' | 'workshop' | 'workshop-pro' | 'enterprise'; runsUntil?: number; updatesUntil?: number | null; iat?: number }): Record<string, unknown> {
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
  rmSync(path.join(manor, 'device.json'), { force: true });
  rmSync(path.join(root, 'data'), { recursive: true, force: true });
  check.forgetLicenseCheck();
});

const at = (id = 'fixture', now = Date.now(), latestSeen = 0) => check.checkLicense({ id, home: manor, now, latestSeen, guid: null });

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
    await until(() => readJson<any>(roundFile(), {}).rounds?.trial, 10_000, 'the trial round in round.json');
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
  assert.deepEqual(check.licensePing(check.licenseNow()), { license: { state: 'trial-ended', held: true, ended: true, runsUntil: c.runsUntil, problem: null } });

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

test('Workshop Pro (kit 2.144.1): its license verifies and runs every employee, the Wright, the Bailiff and the Crier too', () => {
  hold(license({ tier: 'workshop-pro' }));
  const v = lic.verifyLicense(lic.readHeld(manor)!.licence, lic.trustedKeys());
  assert.ok('payload' in v && v.payload.tier === 'workshop-pro');
  sells([...SOLD, { id: 'wright', tier: 'workshop-pro' }, { id: 'bailiff', tier: 'workshop-pro' }, { id: 'crier', tier: 'workshop-pro' }]);
  for (const id of ['fixture', 'reeve', 'wright', 'bailiff', 'crier', 'seneschal']) {
    const c = at(id);
    assert.deepEqual([id, c.checked, c.held, c.ended, c.state, c.problem], [id, true, false, false, 'paid', null]);
  }
  assert.deepEqual([check.licenseNow().state, check.licenseHeld()], ['paid', null]);
  hold(license({ tier: 'workshop-pro', updatesUntil: null }));
  assert.deepEqual([at('wright').state, at('wright').held], ['pending', false]);
  hold(license({ tier: 'workshop-pro', updatesUntil: Date.now() - 400 * DAY }));
  assert.deepEqual([at('wright').state, at('wright').held], ['lapsed', false]);
});

test('a tier this kit does not know is refused: no license for this PC, so it holds', () => {
  hold(license({ tier: 'enterprise' }));
  assert.ok('error' in lic.verifyLicense(lic.readHeld(manor)!.licence, lic.trustedKeys()));
  const c = at();
  assert.deepEqual([c.checked, c.state, c.held, c.ended], [true, 'bad-signature', true, false]);
  assert.match(c.problem ?? '', /payload isn't a license's/);
  assert.deepEqual(lic.LICENSE_TIERS, ['household', 'workshop', 'workshop-pro', 'trial']);
});

test('paid and lapsed: the Freehold license runs, forever', () => {
  hold(license({ tier: 'workshop', updatesUntil: Date.now() - 400 * DAY }));
  for (const now of [Date.now(), Date.now() + 10 * 365 * DAY]) {
    const c = at('fixture', now);
    assert.deepEqual([c.state, c.ended, c.problem], ['lapsed', false, null]);
  }
});

test('a bad signature: no license for this PC, so it holds, and says why', () => {
  const other = generateKeyPairSync('ed25519');
  hold(license({ tier: 'trial', runsUntil: Date.now() - DAY }), other.privateKey);
  let c = at();
  assert.deepEqual([c.checked, c.state, c.held, c.ended], [true, 'bad-signature', true, false]);
  assert.match(c.problem ?? '', /doesn't verify.*rounds wait until this PC holds one/);

  // A payload changed after signing doesn't verify either.
  const jws = signed(license({ tier: 'trial', runsUntil: Date.now() - DAY })).split('.');
  jws[1] = Buffer.from(JSON.stringify(license({ tier: 'trial', runsUntil: Date.now() - 2 * DAY }))).toString('base64url');
  writeFileSync(licenceFile, JSON.stringify({ token: 'x', licence: jws.join('.') }));
  c = at();
  assert.deepEqual([c.state, c.held, c.ended], ['bad-signature', true, false]);
  assert.equal(check.licenseNow().held, true);
  assert.equal(check.licenseHeld(), 'This PC holds no license for it: signing in brings it back');
});

test('no licence.json: the agent holds, says why, and its page says signing in brings it back', async () => {
  rmSync(licenceFile, { recursive: true, force: true });
  const c = at();
  assert.deepEqual([c.checked, c.state, c.held, c.ended], [true, 'missing', true, false]);
  assert.match(c.problem ?? '', /holds no license, so its rounds wait until this PC holds one/);
  const now = check.licenseNow();
  assert.deepEqual([now.held, now.ended], [true, false]);
  assert.equal(check.licenseHeld(), 'This PC holds no license for it: signing in brings it back');
  assert.equal(check.trialEnded(), check.licenseHeld(), "kit 2.45.0's name says the same");

  // Its rounds wait, and Run now with them.
  let ran = 0;
  const job = every(60_000, async () => void ran++, { firstDelayMs: 0, name: 'unlicensed' });
  try {
    await until(() => readJson<any>(roundFile(), {}).rounds?.unlicensed, 10_000, 'the unlicensed round in round.json');
    assert.deepEqual([ran, readJson<any>(roundFile(), {}).rounds.unlicensed.waiting], [0, 'This PC holds no license for it: signing in brings it back']);
    assert.equal(job.runNow(), false);
  } finally {
    job.stop();
  }

  // What Manor reads, and its page.
  const s = check.holdText(now);
  const status = dutyStatus({ onDuty: true, since: null }, true, s);
  assert.equal(status.running, false);
  assert.match(status.summary, /^This PC holds no license for it: signing in brings it back. Its rounds wait/);
  assert.equal(check.licensePing(now).license && (check.licensePing(now).license as { held: boolean }).held, true);
  const look = { busy: 'Working' } as Parameters<typeof pillOf>[0]['look'];
  assert.equal(pillOf({ look, duty: { onDuty: true, since: null }, ended: check.licenseHeld() }).text, 'No license');
  const html = page({ token: 't', body: '<p>body</p>' });
  assert.match(html, /This PC holds no license for it: signing in brings it back. Its settings and data are kept/);
  assert.doesNotMatch(html, /Back on duty/);
  const shell = pageShell({ onboarding: null });
  assert.match(shell.trialEnded ?? '', /^This PC holds no license for it/);
  assert.equal(shell.pill.text, 'No license');
});

test('in demo mode the page shows no hold (kit 2.142.1), so its pictures show a licensed page; its rounds still hold', () => {
  rmSync(licenceFile, { recursive: true, force: true });
  process.env.KIT_DEMO = root;
  try {
    assert.equal(check.licenseHeld(), 'This PC holds no license for it: signing in brings it back');
    assert.equal(check.shownHold(), null);
    assert.doesNotMatch(page({ token: 't', body: '<p>body</p>' }), /holds no license|No license/);
    const shell = pageShell({ onboarding: null });
    assert.equal(shell.trialEnded, null);
    assert.notEqual(shell.pill.text, 'No license');
  } finally {
    delete process.env.KIT_DEMO;
  }
  assert.equal(check.shownHold(), check.licenseHeld());
});

test('an unreadable licence.json: it holds, and says why', () => {
  writeFileSync(licenceFile, '{ not json');
  let c = at();
  assert.deepEqual([c.state, c.held, c.ended], ['unreadable', true, false]);
  assert.match(c.problem ?? '', /isn't JSON.*rounds wait/);
  writeFileSync(licenceFile, JSON.stringify({ token: 'x' }));
  assert.deepEqual([at().state, at().held], ['unreadable', true]);
  // Not a file at all.
  rmSync(licenceFile, { force: true });
  mkdirSync(licenceFile);
  c = at();
  assert.deepEqual([c.state, c.held], ['unreadable', true]);
  assert.equal(check.licenseNow().held, true);
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

test('only Manor and Heiward never check (kit 2.113.0): whatever the Exchequer lists or staff.json says, every other agent needs a license', () => {
  hold(license({ tier: 'trial', runsUntil: Date.now() - DAY }));
  sells([...SOLD, { id: 'heiward', tier: 'household' }, { id: 'auditor', tier: 'workshop' }, { id: 'bailiff', tier: 'workshop' }, { id: 'farrier', tier: 'free' }], [
    { id: 'auditor', heldBack: true },
    { id: 'bailiff', internal: true },
  ]);
  for (const id of ['manor', 'heiward']) {
    const c = at(id);
    assert.deepEqual([id, c.checked, c.held, c.ended, c.state], [id, false, false, false, null]);
    assert.deepEqual(check.licensePing(c), {}, 'its ping is as before');
    assert.equal(check.checksLicense(id), false);
  }
  // Sold, held back, internal, listed as free, or not listed at all (the Wright, the Crier): each holds alike.
  for (const id of ['fixture', 'reeve', 'auditor', 'bailiff', 'farrier', 'wright', 'crier']) {
    const c = at(id);
    assert.deepEqual([id, c.checked, c.held, c.ended, c.state], [id, true, true, true, 'trial-ended']);
    assert.equal(check.checksLicense(id), true);
  }
  // No exchequer.json (Manor hasn't heard from the Exchequer): it still checks, and with no license it holds.
  rmSync(licenceFile, { force: true });
  sells(null);
  for (const id of ['fixture', 'wright']) assert.deepEqual([id, at(id).checked, at(id).held, at(id).state], [id, true, true, 'missing']);
  // An exchequer.json that can't be read is no reason to run either.
  writeFileSync(path.join(manor, 'exchequer.json'), '{ not json');
  assert.deepEqual([at('fixture').checked, at('fixture').held], [true, true]);
  // And with a license for this PC, every one of them runs.
  hold(license({ tier: 'household' }));
  for (const id of ['fixture', 'reeve', 'auditor', 'bailiff', 'farrier', 'wright', 'crier']) assert.deepEqual([id, at(id).held, at(id).state], [id, false, 'paid']);
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

test("another PC's license holds it: device.json's id, or one made again from MachineGuid when there's none", () => {
  const device = path.join(manor, 'device.json');
  const payload = license({ tier: 'household' });
  hold(payload);
  // device.json says this PC is another than the license's: as Manor's readLicense has it.
  writeFileSync(device, JSON.stringify({ id: '11111111-1111-4111-8111-111111111111' }));
  let c = at();
  assert.deepEqual([c.state, c.held, c.ended], ['another-pc', true, false]);
  assert.match(c.problem ?? '', /made for another PC, so its rounds wait until this PC holds one/);
  writeFileSync(device, JSON.stringify({ id: payload.sub }));
  assert.deepEqual([at().state, at().held], ['paid', false]);

  // No device.json (licence.json copied alone): an id made from a PC is made again here, from MachineGuid and Manor's folder.
  rmSync(device, { force: true });
  const guid = '6f1d2c3b-4a59-4e1f-9b2a-0c1d2e3f4a5b';
  const made = lic.deviceIdFor(guid, manor);
  assert.match(made, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  hold({ ...payload, sub: made });
  const on = (g: string | null) => check.checkLicense({ id: 'fixture', home: manor, guid: g });
  assert.deepEqual([on(guid).state, on(guid).held], ['paid', false], "this PC's own");
  assert.deepEqual([on('0f0e0d0c-0b0a-4909-8807-060504030201').state, on('0f0e0d0c-0b0a-4909-8807-060504030201').held], ['another-pc', true], "another PC's");
  assert.equal(lic.deviceIdFor(guid.toUpperCase(), manor.toUpperCase()), made, 'made the same whatever the case');
  // Nothing to check it by: MachineGuid unread, or an id from before 2026-10-21 (random, version 4).
  assert.equal(on(null).held, false);
  hold(payload);
  assert.equal(on('0f0e0d0c-0b0a-4909-8807-060504030201').held, false);
});

test("an Everyone install: the PC's id is in the shared license folder, and the license is its", () => {
  const shared = path.join(root, 'shared');
  mkdirSync(path.join(shared, 'license'), { recursive: true });
  writeFileSync(path.join(shared, 'everyone.json'), '{}');
  const env = { ...process.env, CASTELLAN_SHARED: shared };
  const payload = license({ tier: 'workshop' });
  hold(payload);
  writeFileSync(path.join(shared, 'license', 'device.json'), JSON.stringify({ id: payload.sub }));
  const c = check.checkLicense({ id: 'fixture', home: manor, env, guid: null });
  assert.deepEqual([c.state, c.held], ['paid', false]);
  writeFileSync(path.join(shared, 'license', 'device.json'), JSON.stringify({ id: '11111111-1111-4111-8111-111111111111' }));
  assert.equal(check.checkLicense({ id: 'fixture', home: manor, env, guid: null }).state, 'another-pc');
  rmSync(shared, { recursive: true, force: true });
});

test("a release saying it isn't sold (release.json's \"sold\": false) is no reason to run (kit 2.113.0): nothing reads it", () => {
  rmSync(licenceFile, { force: true });
  sells(null, [{ id: 'fixture', heldBack: true }]);
  // Kit 2.110.0 read release.json's `sold` (ownSale) and let a copy saying false run; the check takes no such say now.
  assert.equal('ownSale' in check, false);
  assert.equal('soldHere' in check, false);
  const told = { id: 'fixture', home: manor, guid: null, sold: false } as Parameters<typeof check.checkLicense>[0];
  assert.deepEqual([check.checkLicense(told).checked, check.checkLicense(told).held], [true, true]);
  const c = check.licenseNow();
  assert.deepEqual([c.checked, c.held, c.state], [true, true, 'missing']);
  // Heiward never checks, whatever anything says.
  assert.equal(check.checkLicense({ ...told, id: 'heiward' }).checked, false);
});
