import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STAFF as DEFAULT_EMPLOYEES } from './fixtures/staff.ts';
import {
  carriedOldKit,
  changelogBetween,
  compareVersions,
  filesUnder,
  hirePathOf,
  kitPathOfHire,
  kitVersionOf,
  newPathOfOld,
  OLD_KIT_HIRES,
  oldKitFilesIn,
  OLD_KIT_PATHS,
  partFiles,
  pinText,
} from '../src/kitfiles.ts';
import { entryFor, KIT_RELEASE_PATHS } from '../tools/kit-release.ts';

// The kit's layout, and the Steward's kit\ itself: the parts, the version and changelog, and the Steward
// running the kit it hands out.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const kitDir = path.join(root, 'kit');

test('a kit file lands in a hire by its part: node in src/kit, web and spec beside it', () => {
  assert.equal(hirePathOf('node/npu.ts'), 'src/kit/npu.ts');
  assert.equal(hirePathOf('web/settings-panel.js'), 'src/kit/web/settings-panel.js');
  assert.equal(hirePathOf('spec\\NPU-QUEUE.md'), 'src/kit/spec/NPU-QUEUE.md');
  assert.equal(hirePathOf('test/kit.test.ts'), null, "the kit's tests stay in the Steward");
  for (const p of ['node/npu.ts', 'web/settings-panel.css', 'spec/npu-queue-vectors.json']) assert.equal(kitPathOfHire(hirePathOf(p)!), p);
  assert.equal(kitPathOfHire('src/app.ts'), null);
});

test('the old kit: where each file was, where it is now, and which a hire still tracks', () => {
  assert.equal(newPathOfOld('src/npu.ts'), 'src/kit/npu.ts');
  assert.equal(newPathOfOld('tools/release.ts'), 'src/kit/release.ts');
  assert.equal(newPathOfOld('src/settings-panel.js'), 'src/kit/web/settings-panel.js');
  assert.equal(newPathOfOld('test/npu-queue-vectors.json'), 'src/kit/spec/npu-queue-vectors.json');
  assert.equal(newPathOfOld('test/kit.test.ts'), null);
  assert.equal(newPathOfOld('src/app.ts'), null, "an agent's own file isn't the kit's");
  assert.deepEqual(oldKitFilesIn(['src/app.ts', 'src\\npu.ts', 'tools/release.ts', 'src/kit/npu.ts']), ['src/npu.ts', 'tools/release.ts']);
});

test('only the eight hires carried the old kit: in Reeve, Heiward or a new employee its paths are their own', () => {
  assert.deepEqual(OLD_KIT_HIRES, ['porter', 'auditor', 'clerk', 'herald', 'warrener', 'aletaster', 'miller', 'pinder']);
  assert.deepEqual(DEFAULT_EMPLOYEES.filter((e) => carriedOldKit(e.id)).map((e) => e.id), OLD_KIT_HIRES, "Settings' hires");
  for (const id of ['reeve', 'heiward', 'surveyor', 'lamplighter', 'developer-herald', 'chamberlain', '', null, undefined]) assert.equal(carriedOldKit(id), false, String(id));
});

test("every old kit file is in the kit now, and every kit file came from the old kit or is new in the changelog", () => {
  const now = partFiles(kitDir);
  for (const old of OLD_KIT_PATHS) {
    const at = newPathOfOld(old);
    if (at) assert.ok(now.includes(kitPathOfHire(at)!), `${old} is in the kit as ${kitPathOfHire(at)}`);
    else assert.ok(existsSync(path.join(kitDir, old)), `${old} runs in the Steward as kit/${old}`);
  }
  const changelog = readFileSync(path.join(kitDir, 'CHANGELOG.md'), 'utf8');
  for (const f of now) {
    const fromOld = OLD_KIT_PATHS.some((o) => newPathOfOld(o) && kitPathOfHire(newPathOfOld(o)!) === f);
    if (!fromOld) assert.ok(changelog.includes(path.posix.basename(f)), `${f} is new in the kit, and the changelog says so`);
  }
});

test("kit\\VERSION has its changelog entry, the Steward pins it, and its fixture carries no pin", () => {
  const version = kitVersionOf(kitDir)!;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const entry = entryFor(readFileSync(path.join(kitDir, 'CHANGELOG.md'), 'utf8'), version);
  assert.ok(entry?.startsWith(`## ${version}`), 'the changelog has an entry for kit\\VERSION');
  const pin = JSON.parse(readFileSync(path.join(root, 'kit.json'), 'utf8'));
  assert.equal(pin.kit, version, "the Steward runs the kit it hands out: set kit.json's kit to kit\\VERSION");
  assert.ok(!existsSync(path.join(kitDir, 'test', 'fixture', 'kit.json')));
});

test('a kit release carries VERSION, CHANGELOG.md and the parts (react, the core and dotnet too), never the tests', () => {
  assert.deepEqual(KIT_RELEASE_PATHS, ['VERSION', 'CHANGELOG.md', 'LICENSE', 'node', 'web', 'spec', 'react', 'core', 'dotnet']);
  assert.ok(filesUnder(kitDir).some((f) => f.startsWith('test/')));
});

test("the spec's vectors are plain JSON any language reads", () => {
  const v = JSON.parse(readFileSync(path.join(kitDir, 'spec', 'npu-queue-vectors.json'), 'utf8'));
  assert.ok(Array.isArray(v.order) && v.order.length);
  assert.match(v.about, /Steward's kit/);
});

test('kit.json is written one key a line, its lists on one line, other keys kept', () => {
  assert.equal(pinText({ kit: '1.0.0', parts: ['node', 'web', 'spec'] }), '{\n  "kit": "1.0.0",\n  "parts": ["node", "web", "spec"]\n}\n');
  assert.equal(pinText({ note: 'x', kit: '1.0.1' }), '{\n  "kit": "1.0.1",\n  "note": "x"\n}\n');
});

test('the changelog between two versions, newest first; versions compare number by number', () => {
  const log = '# Kit\n\n## 1.2.0\n\n- c\n\n## 1.1.0\n\n- b\n\n## 1.0.0\n\n- a\n';
  assert.equal(changelogBetween(log, '1.0.0', '1.2.0'), '## 1.2.0\n\n- c\n\n## 1.1.0\n\n- b');
  assert.equal(changelogBetween(log, null, '1.0.0'), '## 1.0.0\n\n- a');
  assert.equal(entryFor(log, '1.1.0'), '## 1.1.0\n\n- b');
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});
