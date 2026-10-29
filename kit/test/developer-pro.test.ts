import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// Workshop Pro (node/developer-pro.ts, named Developer Pro until kit 2.144.1): the Wright's and the Bailiff's work with
// the rest of the staff, on the maker's laptop and on a PC holding a Workshop Pro license. Nothing here depends on this
// PC's firmware or reads its own license: the test stands in for the PC, and Manor's folder is a scratch one.
const root = mkdtempSync(path.join(os.tmpdir(), 'fixture-workshop-pro-'));
const manor = path.join(root, 'manor');
mkdirSync(manor, { recursive: true });
process.env.MANOR_HOME = manor;
process.env.MANOR_LICENSE_CHECK = 'on';
after(() => rmSync(root, { recursive: true, force: true }));

/** The Exchequer's key, made for the tests, and trusted through MANOR_LICENCE_KEYS as a development key is. */
const exchequer = generateKeyPairSync('ed25519');
process.env.MANOR_LICENCE_KEYS = JSON.stringify({ ...(exchequer.publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'test-key' });

const { developerPro, developerProForTests, forgetWorkshopProLicense, isMakersUuid, uuidIn, workshopProLicense } = await import('./fixture/src/kit/developer-pro.ts');
after(() => developerProForTests(null));

const DAY = 24 * 60 * 60_000;
const SUB = '00000000-0000-4000-8000-000000000000';

/** Manor's licence.json holding a license the Exchequer signed (with `key`), and device.json naming this PC `device`. */
function hold(tier: string, o: { updatesUntil?: number | null; runsUntil?: number; device?: string; key?: typeof exchequer.privateKey } = {}): void {
  const iat = Math.floor((Date.now() - 60 * 60_000) / 1000);
  const updatesUntil = o.updatesUntil === undefined ? (tier === 'trial' ? null : Date.now() + 30 * DAY) : o.updatesUntil;
  const payload = {
    lic: 'lic_test',
    tier,
    updatesUntil: updatesUntil === null ? null : new Date(updatesUntil).toISOString(),
    ...(o.runsUntil !== undefined ? { runsUntil: new Date(o.runsUntil).toISOString() } : {}),
    devices: 1,
    sub: SUB,
    iat,
    exp: iat + 7 * 24 * 3600,
  };
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = `${part({ alg: 'EdDSA', typ: 'JWT', kid: 'test-key' })}.${part(payload)}`;
  const licence = `${head}.${sign(null, Buffer.from(head), o.key ?? exchequer.privateKey).toString('base64url')}`;
  writeFileSync(path.join(manor, 'licence.json'), JSON.stringify({ token: 'secret-token', licence }));
  writeFileSync(path.join(manor, 'device.json'), JSON.stringify({ id: o.device ?? SUB }));
}

beforeEach(() => {
  rmSync(path.join(manor, 'licence.json'), { force: true });
  rmSync(path.join(manor, 'device.json'), { force: true });
  forgetWorkshopProLicense();
  developerProForTests(null);
});

test("the firmware UUID is read from reg's answer, upper case and without braces", () => {
  assert.equal(uuidIn('    LastConfig    REG_SZ    {4c4c4544-0042-3510-8051-b4c04f4a4e33}\r\n'), '4C4C4544-0042-3510-8051-B4C04F4A4E33');
  assert.equal(uuidIn('ERROR: The system was unable to find the specified registry key or value.'), null);
});

test("only the UUID whose salted hash is the maker's is the maker's", () => {
  const uuid = '4C4C4544-0042-3510-8051-B4C04F4A4E33';
  const hash = createHash('sha256').update('castellan-makers-pc:' + uuid).digest('hex');
  assert.equal(isMakersUuid(uuid, hash), true);
  assert.equal(isMakersUuid('00000000-0000-0000-0000-000000000000', hash), false);
  assert.equal(isMakersUuid(null, hash), false);
  assert.equal(isMakersUuid(uuid), false, 'any UUID but the laptop\'s is no maker\'s');
});

test('a test stands in for the PC; CASTELLAN_CUSTOMER=1 makes even the maker\'s laptop a customer\'s', () => {
  developerProForTests(() => true);
  assert.equal(developerPro(), true);
  process.env.CASTELLAN_CUSTOMER = '1';
  try {
    assert.equal(developerPro(), false);
  } finally {
    delete process.env.CASTELLAN_CUSTOMER;
  }
  developerProForTests(() => false);
  assert.equal(developerPro(), false);
});

test('a Workshop Pro license made for this PC turns it on (kit 2.144.1): paid, waiting for its first payment, or lapsed', () => {
  hold('workshop-pro');
  assert.equal(workshopProLicense(), true);
  assert.equal(developerPro(), true, 'on any PC, the maker\'s or not');
  for (const updatesUntil of [null, Date.now() - 400 * DAY]) {
    hold('workshop-pro', { updatesUntil });
    forgetWorkshopProLicense();
    assert.equal(workshopProLicense(), true, `updatesUntil ${updatesUntil}`);
  }
});

test('a trial does not turn it on yet, even one still running, nor a Household or Workshop license', () => {
  for (const [tier, o] of [['trial', { runsUntil: Date.now() + 3 * DAY }], ['household', {}], ['workshop', {}]] as const) {
    hold(tier, o);
    forgetWorkshopProLicense();
    assert.equal(workshopProLicense(), false, tier);
  }
});

test("no Workshop Pro license for this PC: another PC's, one whose signature doesn't verify, a tier the kit doesn't know, or none", () => {
  hold('workshop-pro', { device: '11111111-1111-4111-8111-111111111111' });
  assert.equal(workshopProLicense(), false, "another PC's");
  hold('workshop-pro', { key: generateKeyPairSync('ed25519').privateKey });
  forgetWorkshopProLicense();
  assert.equal(workshopProLicense(), false, 'signed with a key not trusted');
  hold('workshop-pro-plus');
  forgetWorkshopProLicense();
  assert.equal(workshopProLicense(), false, 'a tier the kit does not know');
  rmSync(path.join(manor, 'licence.json'), { force: true });
  forgetWorkshopProLicense();
  assert.equal(workshopProLicense(), false, 'no licence.json');
  writeFileSync(path.join(manor, 'licence.json'), '{ not json');
  forgetWorkshopProLicense();
  assert.equal(workshopProLicense(), false, 'one that cannot be read');
});

test('CASTELLAN_CUSTOMER=1 answers no, a Workshop Pro license and all', () => {
  hold('workshop-pro');
  process.env.CASTELLAN_CUSTOMER = '1';
  try {
    assert.equal(developerPro(), false);
  } finally {
    delete process.env.CASTELLAN_CUSTOMER;
  }
  assert.equal(developerPro(), true);
});

test("under node --test it reads no license unless MANOR_LICENSE_CHECK=on: no agent's tests read this PC's", () => {
  hold('workshop-pro');
  assert.equal(workshopProLicense({ ...process.env, NODE_TEST_CONTEXT: 'child', MANOR_LICENSE_CHECK: undefined }), false);
  assert.equal(workshopProLicense({ ...process.env, NODE_TEST_CONTEXT: 'child', MANOR_LICENSE_CHECK: 'on' }), true);
});

test('a new licence.json is read at once; an unchanged one is kept, an hour at most', () => {
  hold('household');
  assert.equal(workshopProLicense(), false);
  hold('workshop-pro');
  assert.equal(workshopProLicense(), true, 'licence.json changed: read again at once');
  // device.json now names another PC, licence.json unchanged: the reading is kept, until an hour on.
  writeFileSync(path.join(manor, 'device.json'), JSON.stringify({ id: '11111111-1111-4111-8111-111111111111' }));
  assert.equal(workshopProLicense(), true);
  assert.equal(workshopProLicense(process.env, Date.now() + 60 * 60_000), false);
});
