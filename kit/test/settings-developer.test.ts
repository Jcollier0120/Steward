import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Settings panel's API and the manor's Developer options (spec/DEVELOPER-OPTIONS.md): a developer's settings,
// choices, record fields and whole form, left out of what is sent with the switch off and kept through a save then.
// Each case runs both ways of the switch (`developer`, as server.ts reads it for each request).
const id: string = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8')).name;
const home = mkdtempSync(path.join(os.tmpdir(), `${id}-settings-dev-test-`));
after(() => rmSync(home, { recursive: true, force: true }));
process.env[`${id.toUpperCase().replace(/-/g, '_')}_HOME`] = home;
process.env.MANOR_HOME = path.join(home, 'no-manor');

const { DEVELOPER_ONLY_FORM, KEPT, saveSettingsReply, schemaFor, settingsReply, valuesFor } = await import('./fixture/src/kit/settings-kit.ts');
type Field = import('./fixture/src/kit/settings-kit.ts').Field;
type SettingsSpec = import('./fixture/src/kit/settings-kit.ts').SettingsSpec;

const file = path.join(home, 'settings.json');
const read = () => JSON.parse(readFileSync(file, 'utf8'));

/** The Porter's What to watch, the Surveyor's checks, the Reckoner's Comes and goes, and a developer's own setting. */
const schema: Field[] = [
  { key: 'watch', kind: 'choices', label: 'What to watch', options: [{ value: 'files', label: 'Files' }, { value: 'ports', label: 'Listening ports', developerOnly: true }, { value: 'tasks', label: 'Scheduled tasks' }] },
  { key: 'checks', kind: 'group', label: 'Checks', fields: [{ key: 'pc', kind: 'switch', label: 'The PC' }, { key: 'code', kind: 'switch', label: 'The code checkouts', developerOnly: true }] },
  {
    key: 'devices', kind: 'records', label: 'Comes and goes', noun: 'device', unique: 'thing', title: 'name',
    fields: [
      { key: 'thing', kind: 'text', label: 'Which', developerOnly: true, pattern: 'dev:.+', patternHint: 'dev:<id>' },
      { key: 'name', kind: 'text', label: 'Name', optional: true, plain: { label: 'Device' } },
    ],
  },
  { key: 'repoRoots', kind: 'list', label: 'Repository folders', item: { label: 'Folder' }, developerOnly: true },
  { key: 'every', kind: 'whole', label: 'A round every', min: 1, max: 60, plain: { help: 'Minutes between rounds.' }, help: 'Minutes between rounds (round.json).' },
];
const defaults = { watch: ['files', 'ports', 'tasks'], checks: { pc: true, code: true }, devices: [], repoRoots: [], every: 10 };
/** An agent that reads its settings for whoever is looking, as the Porter did: no ports while the switch is off. */
const spec = (developer: () => boolean, extra: Partial<SettingsSpec> = {}): SettingsSpec => ({
  schema,
  defaults,
  file: () => file,
  normalize: (raw: any) => {
    const s = { ...structuredClone(defaults), ...raw };
    if (!developer()) s.watch = s.watch.filter((w: string) => w !== 'ports');
    return { settings: s, problems: [] };
  },
  ...extra,
});
const stored = { watch: ['files', 'ports'], checks: { pc: true, code: false }, devices: [{ thing: 'dev:USB\\VID_1', name: 'Phone' }, { thing: 'dev:USB\\VID_2', name: 'Pen' }], repoRoots: ['D:\\src'], every: 10 };

test('the schema: all of it for a developer; for everyone else no developer field or choice, in plain words, a handle in place of a hidden record field', () => {
  assert.equal(schemaFor(schema, true), schema);
  const plain = schemaFor(schema, false);
  assert.deepEqual(plain.map((f: Field) => f.key), ['watch', 'checks', 'devices', 'every']);
  assert.deepEqual((plain[0] as any).options.map((o: any) => o.value), ['files', 'tasks']);
  assert.deepEqual((plain[1] as any).fields.map((f: Field) => f.key), ['pc']);
  assert.deepEqual((plain[2] as any).fields.map((f: Field) => [f.key, f.label, !!f.kept]), [['name', 'Device', false], [KEPT, 'Kept', true]]);
  assert.equal(plain[3].help, 'Minutes between rounds.', 'its plain words');
  assert.ok(!('plain' in plain[3]));
});

test('/api/settings: with the switch off, no developer value is sent; each record carries a handle instead', async () => {
  writeFileSync(file, JSON.stringify(stored));
  const on = await settingsReply(spec(() => true), true);
  assert.deepEqual(on.values, stored);
  assert.equal(on.schema, schema);
  const off = await settingsReply(spec(() => false), false);
  const sent = JSON.stringify(off);
  for (const word of ['ports', 'code', 'dev:', 'repoRoots', 'D:\\\\src', 'Which']) assert.ok(!sent.includes(word), `${word} isn't sent`);
  assert.deepEqual(off.values.watch, ['files']);
  assert.deepEqual(off.values.checks, { pc: true });
  assert.equal((off.values.devices as any[]).length, 2);
  assert.match((off.values.devices as any[])[0][KEPT], /^[0-9a-f]{16}$/);
  assert.notEqual((off.values.devices as any[])[0][KEPT], (off.values.devices as any[])[1][KEPT]);
  assert.deepEqual(off.defaults, { watch: ['files', 'tasks'], checks: { pc: true }, devices: [], every: 10 });
  assert.deepEqual(valuesFor(schema, stored, true), stored, 'a developer: as it is');
});

test('a save with the switch off keeps what it left out, as settings.json had it', async () => {
  writeFileSync(file, JSON.stringify(stored));
  const off = await settingsReply(spec(() => false), false);
  const [phone, pen] = (off.values.devices as any[]);
  // A round every 20, Scheduled tasks on, the code check's group changed, the first device renamed and the second removed.
  const r = await saveSettingsReply(spec(() => false), { values: { every: 20, watch: ['files', 'tasks'], checks: { pc: false }, devices: [{ ...phone, name: 'My phone' }] } }, false);
  assert.equal(r.status, undefined, JSON.stringify(r.json));
  assert.deepEqual(read(), { watch: ['files', 'ports', 'tasks'], checks: { pc: false, code: false }, devices: [{ thing: 'dev:USB\\VID_1', name: 'My phone' }], repoRoots: ['D:\\src'], every: 20 });
  assert.ok(!JSON.stringify(r.json).includes('ports') && !JSON.stringify(r.json).includes('dev:'), 'nor in what the save answers');
  assert.ok(pen);
  // A developer's setting can't be sent with the switch off, nor a new device whose id the panel can't give.
  const hidden = await saveSettingsReply(spec(() => false), { values: { repoRoots: [] } }, false);
  assert.equal(hidden.status, 400);
  assert.deepEqual(Object.keys((hidden.json as any).errors), ['repoRoots']);
  const fresh = await saveSettingsReply(spec(() => false), { values: { devices: [{ ...phone }, { name: 'Mouse' }] } }, false);
  assert.equal(fresh.status, 400);
  assert.equal((fresh.json as any).errors['devices.1'], "A new device can't be added here.");
  assert.equal(read().devices.length, 1, 'nothing written');
});

test('a save with the switch on: every field and choice is the developer\'s to change, as ever', async () => {
  writeFileSync(file, JSON.stringify(stored));
  const r = await saveSettingsReply(spec(() => true), { values: { watch: ['tasks'], checks: { pc: true, code: true }, devices: [{ thing: 'dev:USB\\VID_3', name: 'Mouse' }], repoRoots: [] } }, true);
  assert.equal(r.status, undefined, JSON.stringify(r.json));
  assert.deepEqual(read(), { watch: ['tasks'], checks: { pc: true, code: true }, devices: [{ thing: 'dev:USB\\VID_3', name: 'Mouse' }], repoRoots: [], every: 10 });
});

test("a developer's whole form: left out with the switch off (said, or every field is), and as ever with it on", async () => {
  writeFileSync(file, JSON.stringify({ every: 5 }));
  const only = (developer: boolean) => spec(() => developer, { developerOnly: true });
  const off = await settingsReply(only(false), false);
  assert.equal(off.developerOnly, true);
  assert.deepEqual([off.schema, off.values, off.file], [[], {}, '']);
  const save = await saveSettingsReply(only(false), { values: { every: 6 } }, false);
  assert.equal(save.status, 400);
  assert.equal((save.json as any).errors[''], DEVELOPER_ONLY_FORM);
  assert.deepEqual(read(), { every: 5 }, 'nothing written');
  const on = await settingsReply(only(true), true);
  assert.equal(on.developerOnly, undefined);
  assert.equal(on.schema.length, schema.length);
  assert.equal((await saveSettingsReply(only(true), { values: { every: 6 } }, true)).status, undefined);
  // Every field a developer's: the same, unsaid.
  const all: SettingsSpec = { schema: [{ key: 'every', kind: 'whole', label: 'Every', min: 1, max: 60, developerOnly: true }], defaults: { every: 10 }, file: () => file, normalize: (raw: any) => ({ settings: { every: 10, ...raw }, problems: [] }) };
  assert.equal((await settingsReply(all, false)).developerOnly, true);
  assert.equal((await settingsReply(all, true)).developerOnly, undefined);
  // And an agent with no settings at all still says "Nothing to set", not left out.
  assert.equal((await settingsReply({ ...all, schema: [], defaults: {} }, false)).developerOnly, undefined);
});
