import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// The kit's Settings panel and its API, run with this agent's own schema: the same file in every agent.
const id: string = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8')).name;
const ENV = id.toUpperCase().replace(/-/g, '_');
const home = mkdtempSync(path.join(os.tmpdir(), `${id}-settings-test-`));
process.env[`${ENV}_HOME`] = home;
process.env[`${ENV}_PORT`] = String(50000 + Math.floor(Math.random() * 9000));
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');

const { port } = await import('./fixture/src/app.ts');
const { serve } = await import('./fixture/src/kit/server.ts');
const { checkValues, schemaGaps, SETTINGS_BODY_LIMIT } = await import('./fixture/src/kit/settings-kit.ts');
type Field = import('./fixture/src/kit/settings-kit.ts').Field;
const { SETTINGS_SPEC: spec } = await import('./fixture/src/settings.ts');
const { page, settingsPanel } = await import('./fixture/src/kit/page.ts');
const { every } = await import('./fixture/src/kit/schedule.ts');

const file = spec.file();
const base = `http://127.0.0.1:${port}`;
let server: { token: string; close: () => Promise<void> };
before(async () => {
  server = await serve({ port, icon: '<svg/>', settings: spec });
});
after(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const post = (body: unknown, headers: Record<string, string> = { 'x-token': server.token }) =>
  fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const getSettings = async () => (await fetch(`${base}/api/settings`)).json();

/** The first setting of a kind at the top level. */
const first = (kind: Field['kind']) => spec.schema.find((f: Field) => f.kind === kind && !f.readOnly) as (Field & { min: number; max: number }) | undefined;
const whole = first('whole')!;

test('the schema and the defaults name the same settings', () => {
  assert.deepEqual(schemaGaps(spec.schema, spec.defaults), []);
  assert.ok(whole, 'every agent has a whole-number setting (its interval, at least)');
});

test('the defaults pass the schema, and the agent reads them as they are', () => {
  assert.deepEqual(checkValues(spec.schema, spec.defaults).errors, {});
  const { settings, problems } = spec.normalize(json(spec.defaults));
  assert.deepEqual(problems, []);
  assert.deepEqual(json(settings), json(spec.defaults));
});

test("each number's limits are the agent's own: normalizeSettings keeps both ends and nothing past them", () => {
  const numbers: [string[], Field & { min: number; max: number }][] = [];
  for (const f of spec.schema as Field[]) {
    if (f.kind === 'whole' || f.kind === 'number') numbers.push([[f.key], f]);
    if (f.kind === 'group') for (const g of f.fields) if (g.kind === 'whole' || g.kind === 'number') numbers.push([[f.key, g.key], g]);
  }
  const at = (p: string[], v: number) => {
    const raw = json(spec.defaults);
    if (p.length === 1) raw[p[0]] = v;
    else raw[p[0]] = { ...raw[p[0]], [p[1]]: v };
    const s = spec.normalize(raw).settings as any;
    return p.length === 1 ? s[p[0]] : s[p[0]][p[1]];
  };
  for (const [p, f] of numbers) {
    const step = f.kind === 'whole' ? 1 : (f.max - f.min) / 10;
    assert.equal(at(p, f.min), f.min, `${p.join('.')} keeps its least, ${f.min}`);
    assert.equal(at(p, f.max), f.max, `${p.join('.')} keeps its most, ${f.max}`);
    assert.notEqual(at(p, f.max + step), f.max + step, `${p.join('.')} doesn't keep ${f.max + step}`);
    assert.notEqual(at(p, f.min - step), f.min - step, `${p.join('.')} doesn't keep ${f.min - step}`);
  }
});

test('the page carries the panel and loads its script, which the server serves', async () => {
  const html = page({ token: 'tok', body: `<h2>Settings</h2>${settingsPanel()}` });
  assert.match(html, /data-settings-panel/);
  assert.match(html, /<script src="\/settings\.js" defer><\/script>/);
  assert.match(html, /<meta name="page-token" content="tok">/);
  const r = await fetch(`${base}/settings.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.match(await r.text(), /\/api\/settings/);
});

test('GET /api/settings returns the schema, the values in use and the defaults', async () => {
  const r = await fetch(`${base}/api/settings`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.schema, json(spec.schema));
  assert.deepEqual(j.defaults, json(spec.defaults));
  assert.deepEqual(j.values, json(spec.normalize({}).settings));
  assert.equal(j.file, file);
  assert.ok(Array.isArray(j.problems) && typeof j.warnings === 'object');
});

test('a POST without the token, or from another site, is refused and writes nothing', async () => {
  const change = { values: { [whole.key]: whole.min } };
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  assert.equal((await post(change, {})).status, 403);
  assert.equal((await post(change, { 'x-token': 'not-the-token' })).status, 403);
  assert.equal((await post(change, { 'x-token': server.token, origin: 'http://evil.example' })).status, 403);
  assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : null, before);
});

test('a bad value, a wrong type or an unknown setting is refused field by field, and the file is left as it was', async () => {
  writeFileSync(file, JSON.stringify(spec.defaults, null, 2));
  const before = readFileSync(file, 'utf8');
  const sw = first('switch');
  const r = await post({ values: { [whole.key]: whole.max + 1, noSuchSetting: 1, ...(sw ? { [sw.key]: 'yes' } : {}) } });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.match(j.error, /^Not saved/);
  assert.match(j.errors[whole.key], new RegExp(`from ${whole.min} to ${whole.max}`));
  assert.match(j.errors.noSuchSetting, /no setting/);
  if (sw) assert.match(j.errors[sw.key], /on or off/);
  const typed = await post({ values: { [whole.key]: String(whole.min) } });
  assert.equal(typed.status, 400, 'a number sent as text is the wrong type');
  assert.equal((await post('{"values": ')).status, 400, 'not JSON');
  assert.equal((await post({ nothing: true })).status, 400, 'no values');
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('a body over the small limit is refused', async () => {
  const r = await post({ values: { [whole.key]: 'x'.repeat(SETTINGS_BODY_LIMIT + 1) } });
  assert.equal(r.status, 413);
});

test('a good value is saved, returned, and kept in settings.json with the rest of the file', async () => {
  writeFileSync(file, JSON.stringify({ ...json(spec.defaults), someoneElsesNote: 'kept' }, null, 2));
  const current = (await getSettings()).values[whole.key];
  const v = current === whole.min ? whole.min + 1 : whole.min;
  const r = await post({ values: { [whole.key]: v } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.values[whole.key], v);
  assert.deepEqual(j.changed, [whole.key]);
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk[whole.key], v);
  assert.equal(onDisk.someoneElsesNote, 'kept', 'what the panel did not change stays as it was');
  assert.equal((await getSettings()).values[whole.key], v);
  if (whole.applies === 'restart') assert.match(j.notes.join(' '), /next start/);
});

test('a setting set back to its default is saved as the default', async () => {
  const def = (spec.defaults as any)[whole.key];
  const r = await post({ values: { [whole.key]: def } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).values[whole.key], def);
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))[whole.key], def);
  assert.equal((await getSettings()).values[whole.key], def);
});

test('an unreadable settings.json is kept aside when the panel saves over it', async () => {
  writeFileSync(file, '{ not json');
  assert.match((await getSettings()).problems.join(' '), /isn't a JSON object/);
  const r = await post({ values: { [whole.key]: whole.min } });
  assert.equal(r.status, 200);
  assert.equal(readFileSync(`${file}.broken`, 'utf8'), '{ not json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))[whole.key], whole.min);
});

test('a new interval applies to the wait under way', async () => {
  let ms = 60_000;
  let rounds = 0;
  const job = every(() => ms, async () => void rounds++, { firstDelayMs: 1 });
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(rounds, 1, 'the first round ran; the next waits a minute');
    ms = 20;
    job.reschedule();
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(rounds >= 2, 'the shorter interval took over the wait');
  } finally {
    job.stop();
  }
});
