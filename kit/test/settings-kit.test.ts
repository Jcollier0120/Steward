import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// The kit's Settings panel and its API, run with the fixture agent's schema. Each agent's own schema is
// checked in that agent, by agent-checks.ts (test/agent.test.ts here).
const id: string = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8')).name;
const ENV = id.toUpperCase().replace(/-/g, '_');
const home = mkdtempSync(path.join(os.tmpdir(), `${id}-settings-test-`));
process.env[`${ENV}_HOME`] = home;
process.env[`${ENV}_PORT`] = String(50000 + Math.floor(Math.random() * 9000));
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'no-manor'); // the title bar's Back to Manor: never the real Manor's settings
process.env.REEVE_HOME = path.join(home, 'reeve'); // the page names this PC's accelerators: never the real Reeve's

const { port } = await import('./fixture/src/app.ts');
const { serve } = await import('./fixture/src/kit/server.ts');
const { SETTINGS_BODY_LIMIT } = await import('./fixture/src/kit/settings-kit.ts');
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

test('the page carries the panel and loads its script, which the server serves', async () => {
  const html = page({ token: 'tok', body: `<h2>Settings</h2>${settingsPanel()}` });
  assert.match(html, /data-settings-panel/);
  assert.match(html, /<script src="\/settings\.js" defer><\/script>/);
  assert.match(html, /<meta name="page-token" content="tok">/);
  assert.match(html, /<link rel="stylesheet" href="\/settings\.css">/);
  // Settings is a page of its own: the title bar's gear (hidden until the script finds a panel to move; its
  // label only at wide widths), the script that lifts the Settings section into #settings-view, and the rule
  // that hides the rest.
  assert.match(html, /<a class="tool-link" id="settings-link" href="#\/settings" title="Settings" hidden><svg[^>]*>.*?<\/svg><span>Settings<\/span><\/a>/s);
  assert.match(html, /\.tool-link span \{ display: none; \}/, "the label goes at a phone's width");
  assert.match(html, /view\.id = 'settings-view'/);
  assert.ok(html.includes('/^#\\/?settings$/'), 'the route matches #/settings and #settings, as written into the page');
  assert.match(html, /body\.on-settings main > :not\(#settings-view\)/);
  assert.ok(html.includes('[data-dirty], body.on-settings, #theme-menu:not([hidden])'), 'no refresh while Settings or the Theme menu is open');
  const r = await fetch(`${base}/settings.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.match(await r.text(), /\/api\/settings/);
  const css = await fetch(`${base}/settings.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
  assert.match(await css.text(), /\.sf-panel/);
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
