import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';

// Developer Pro (node/developer-pro.ts): the Wright's and the Bailiff's work with the rest of the staff, on the maker's
// laptop only for now. Nothing here reads this PC's firmware: the test stands in for it.
const { developerPro, developerProForTests, isMakersUuid, uuidIn } = await import('./fixture/src/kit/developer-pro.ts');
after(() => developerProForTests(null));

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
