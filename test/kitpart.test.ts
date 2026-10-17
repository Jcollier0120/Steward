import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kitClaimKey, kitTitleVersions, kitVersionText, repinKit } from '../src/stages/kitpart.ts';

// The kit as a second version in the Steward's repository: what names it, and moving it in its files.

test('the kit\u2019s claim key and the kit versions PR titles name', () => {
  assert.equal(kitClaimKey('Jcollier0120/Steward'), 'Jcollier0120/Steward#kit');
  assert.deepEqual(kitTitleVersions(['Steward 0.21.3, kit 2.36.1: GenieX', 'Kit 2.32.0: a Steward not yet migrated', 'Porter 0.5.12: the kit']), ['2.36.1', '2.32.0']);
  assert.equal(kitVersionText('2.36.2', '2.36.1\r\n'), '2.36.2\r\n');
});

test("kit.json pins the kit's new version, whatever it pinned", () => {
  assert.equal(repinKit('{\n  "kit": "2.36.0",\n  "parts": ["node"]\n}\n', '2.36.2'), '{\n  "kit": "2.36.2",\n  "parts": ["node"]\n}\n');
  assert.equal(repinKit('{\n  "kit": "2.36.2"\n}\n', '2.36.2'), null);
  assert.equal(repinKit('{}', '2.36.2'), null);
});
