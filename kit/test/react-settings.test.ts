import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The React Settings form (react/settings-form.tsx) and the onboarding Tour (react/tour.tsx), rendered with
// react-dom/server from data in hand: every field kind, the short page (sections, jump links, Advanced, shownWhen),
// onboarding's few settings, and the Tour's three steps.
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.STEWARD_ESBUILD = STEWARD;
const { bundleForNode, importPath } = await import('./react-render.ts');

const m = await bundleForNode<{ form: (data: unknown, keys?: string[]) => string; tour: (o: unknown, start: string, from?: string | null) => string; tourFrom: (hash: string) => string | null; onPage: (parts: unknown[], doc?: unknown) => { tour: string }[] }>(
  `import { renderToStaticMarkup as r } from 'react-dom/server';
   import { onPage, SettingsForm, Tour, tourFrom } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
   export const form = (data, keys) => r(<SettingsForm initial={data} keys={keys} />);
   export const tour = (o, start, from = null) => r(<Tour onboarding={o} app={{ id: 'fixture', name: 'Fixture', role: 'r', version: '1' }} start={start} from={from} />);
   export { onPage, tourFrom };`,
  { location: { hash: '' }, document: { documentElement: { dataset: {} } } },
);

const schema = [
  { key: 'variant', kind: 'choice', label: 'Variant', options: [{ value: 'gamer', label: 'Gamer' }, { value: 'financial', label: 'Financial guru' }] },
  { key: 'stocks', kind: 'list', label: 'Stocks', item: { label: 'Ticker' }, shownWhen: { key: 'variant', is: ['financial'] } },
  { key: 'notes', kind: 'switch', label: 'Notes', help: 'Ask the model for a note.' },
  { key: 'interval', kind: 'whole', label: 'A round every', min: 1, max: 60, unit: 'minutes', applies: 'restart' },
  { key: 'folders', kind: 'list', label: 'Folders', item: { label: 'Folder' }, nullable: 'Automatic' },
  { key: 'kinds', kind: 'choices', label: 'Kinds', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  { key: 'agents', kind: 'records', label: 'Agents', noun: 'agent', fields: [{ key: 'port', kind: 'whole', label: 'Port', min: 1, max: 65535 }, { key: 'name', kind: 'text', label: 'Agent' }] },
  { key: 'jobs', kind: 'records', label: 'Jobs', noun: 'job', title: 'name', fields: [{ key: 'name', kind: 'text', label: 'Name' }, { key: 'cmds', kind: 'list', label: 'Commands', item: { label: 'Command' } }] },
  { key: 'env', kind: 'map', label: 'Environment', keyLabel: 'Name', valueLabel: 'Value' },
  { key: 'limits', kind: 'group', label: 'Limits', fields: [{ key: 'piece', kind: 'whole', label: 'Piece size', min: 1, max: 9 }, { key: 'share', kind: 'number', label: 'Share', min: 0, max: 1, advanced: true }] },
  { key: 'alarms', kind: 'group', label: 'Alarms', fields: [{ key: 'on', kind: 'switch', label: 'Raise alarms' }] },
  { key: 'port', kind: 'whole', label: 'Port', min: 1, max: 65535, advanced: true },
  { key: 'since', kind: 'text', label: 'Since', readOnly: true },
];
const values = { variant: 'gamer', stocks: ['MSFT'], notes: true, interval: 5, folders: null, kinds: ['b'], agents: [{ port: 18383, name: 'Reeve' }], jobs: [{ name: 'build', cmds: ['npm test'] }], env: { A: '1' }, limits: { piece: 6, share: 0.5 }, alarms: { on: true }, port: 19494, since: '2026-10-05T12:00:00.000Z' };
const data = (warnings = {}) => ({ schema, values, defaults: { ...values, interval: 10 }, problems: ['settings.json had a stray key.'], warnings, file: 'C:\\x\\settings.json' });

test('every field kind, drawn as settings-panel.js draws it, class for class', () => {
  const h = m.form(data());
  assert.match(h, /<div class="card sf-panel" data-tour="settings-panel">/);
  assert.match(h, /Changes are checked and saved here, into <code>C:\\x\\settings.json<\/code>\. They are used from the next round on, except those marked (&quot;|")takes effect at the next start(&quot;|")\./);
  assert.match(h, /<span class="badge tone-caution">settings.json<\/span> settings.json had a stray key\./, "the agent's problems");
  assert.match(h, /<label class="sf-switch"><input type="checkbox" role="switch" class="ui-switch"[^>]*checked=""\/><span>Notes<\/span><\/label>/, 'a switch is its own label');
  assert.match(h, /<input type="number"[^>]*min="1" max="60" step="1" inputMode="numeric"[^>]*value="5"/);
  assert.match(h, /<span class="muted">minutes<\/span>/);
  assert.match(h, /Default: 10 minutes\./, 'its default, in words');
  assert.match(h, /<button type="button" class="link">Reset to default<\/button>/, 'and the way back to it, while it differs');
  assert.match(h, /<span class="badge tone-caution">takes effect at the next start<\/span>/);
  assert.match(h, /<span>Automatic<\/span>/, 'a nullable list: its Automatic switch');
  assert.match(h, /<div class="sf-choices"><label><input type="checkbox"\/><span>A<\/span><\/label><label><input type="checkbox" checked=""\/><span>B<\/span>/);
  assert.match(h, /<table class="sf-table"><thead><tr><th scope="col">Port<\/th><th scope="col">Agent<\/th><th><\/th><\/tr><\/thead>/, 'records of plain fields: a table');
  assert.match(h, /aria-label="Port, agent 1"/);
  assert.match(h, /<details class="sf-record"><summary>build<\/summary>/, 'records with a list in them: folded to their titles');
  assert.match(h, /<th scope="col">Name<\/th><th scope="col">Value<\/th>/, 'a map: its two columns');
  assert.match(h, /<span class="sf-name">Since<\/span>.*<span class="muted">2026-10-05<\/span>/, 'read-only: the value, a time as its day');
  assert.match(h, /aria-label="Remove agent 1"/);
  assert.match(h, /<button type="submit" disabled="">Save<\/button>/, 'nothing changed: nothing to save');
  assert.match(h, /Set every field to its default/);
});

test('the short page: groups are sections with jump links, the advanced folded, a field shown only when it applies', () => {
  const h = m.form(data());
  assert.match(h, /<nav class="sf-jump" aria-label="Sections"><button type="button" class="link">Limits<\/button><button type="button" class="link">Alarms<\/button><\/nav>/);
  assert.match(h, /<details class="sf sf-section" data-key="limits" id="sf-section-limits">/, 'two groups: each folded');
  assert.match(h, /<details class="sf-advanced"><summary>Advanced \(1\)<\/summary>.*Port/, 'the advanced top-level setting, folded at the end');
  assert.match(h, /data-key="limits".*<details class="sf-advanced"><summary>Advanced \(1\)<\/summary>.*Share/, "and a group's advanced field, folded in it");
  assert.doesNotMatch(h, /data-key="stocks"/, 'stocks is for the financial variant: hidden for gamer');
  assert.match(m.form({ ...data(), values: { ...values, variant: 'financial' } }), /data-key="stocks"/, 'and shown for financial');
  const err = m.form(data({ stocks: 'Not a ticker.', share: 'x', 'limits.share': 'Between 0 and 1.' }));
  assert.match(err, /data-key="stocks"/, 'a message about a hidden field shows it anyway');
  assert.match(err, /<details class="sf sf-section" data-key="limits" id="sf-section-limits" open="">/, 'and opens the section it is in');
});

test('a record wider than a table row, or with an advanced field, folds to one line; its advanced fields fold inside it', () => {
  const wide = { key: 'projects', kind: 'records', label: 'Projects', noun: 'project', title: 'name', fields: ['name', 'a', 'b', 'c', 'd'].map((k) => ({ key: k, kind: 'text', label: k.toUpperCase(), advanced: k === 'd' })) };
  const h = m.form({ schema: [wide], values: { projects: [{ name: 'Porter', a: '', b: '', c: '', d: 'x' }] }, defaults: { projects: [] }, problems: [], warnings: {}, file: 'f' });
  assert.match(h, /<details class="sf-record"><summary>Porter<\/summary>/, 'one line, its title');
  assert.doesNotMatch(h, /sf-table/, 'not a table of five columns');
  assert.match(h, /<summary>Porter<\/summary>.*<details class="sf-advanced"><summary>Advanced \(1\)<\/summary>.*data-key="d"/, "the record's advanced field, folded in it");
});

test('onboarding: only the keys asked for, never an advanced one; none at all says so', () => {
  const h = m.form(data(), ['interval', 'port', 'notes']);
  assert.match(h, /data-key="interval"/);
  assert.match(h, /data-key="notes"/);
  assert.doesNotMatch(h, /data-key="port"/, 'advanced: left out, even when asked for');
  assert.doesNotMatch(h, /sf-jump|Advanced/);
  assert.match(m.form(data(), []), /Nothing to set: the defaults just work\./);
});

test("the Tour's three steps: what the role is, its settings, what its page shows", () => {
  const o = { intro: { title: 'Meet the fixture', text: 'It carries the kit.' }, settings: [], tour: [{ tour: 'status', title: 'Its status', text: 'On duty or off.' }, { tour: 'staff', text: 'Who works here.' }] };
  const intro = m.tour(o, 'intro');
  assert.match(intro, /<div class="tour-backdrop"><div class="tour-card tour-center">/);
  assert.match(intro, /Step 1 of 3.*Meet the fixture.*It carries the kit\..*Skip the tour.*>Next</);
  const settings = m.tour(o, 'settings');
  assert.match(settings, /Step 2 of 3.*Your settings.*Fixture needs nothing from you to start\./);
  assert.match(settings, />Back<.*>Next</);
  const walk = m.tour(o, 'tour');
  assert.match(walk, /<div class="tour-card tour-dock">.*Step 3 of 3 · 1 of 2.*Its status.*On duty or off\./, 'a card docked at the bottom, the page beside it');
  assert.match(m.tour({ ...o, tour: [] }, 'settings'), /Step 2 of 2.*>Done</, 'no tour steps: the settings are the last step');
});

test('a setting used only at the next start, install, or install as an administrator: marked so, and the intro says each', () => {
  const fields = [
    { key: 'a', kind: 'whole', label: 'A', min: 1, max: 9, applies: 'restart' },
    { key: 'b', kind: 'whole', label: 'B', min: 1, max: 9, applies: 'reinstall' },
    { key: 'c', kind: 'switch', label: 'C', applies: 'admin' },
    { key: 'd', kind: 'switch', label: 'D', applies: 'now' },
  ];
  const h = m.form({ schema: fields, values: { a: 1, b: 2, c: true, d: false }, defaults: { a: 1, b: 2, c: true, d: false }, problems: [], warnings: {}, file: 'f' });
  assert.match(h, /except those marked (&quot;|")takes effect at the next start(&quot;|") or (&quot;|")takes effect at the next install or update(&quot;|") or (&quot;|")takes effect when installed as an administrator(&quot;|")\./);
  assert.match(h, /data-key="b".*<span class="badge tone-caution">takes effect at the next install or update<\/span>/);
  assert.match(h, /data-key="c".*<span class="badge tone-caution">takes effect when installed as an administrator<\/span>/);
  assert.equal(h.match(/badge tone-caution/g)?.length, 3, "'now' isn't marked");
});

test('opened from Manor (#/tour?from=): its last step offers Back to Manor, and only to an address on this PC', () => {
  const o = { intro: { title: 'Meet the fixture', text: 'It carries the kit.' }, settings: [], tour: [{ tour: 'status', text: 'On duty or off.' }] };
  const manor = 'http://manor.localhost:8888/#/roles/fixture';
  assert.match(m.tour(o, 'tour', manor), />Done<.*>Back to Manor</, 'the last step: Done, and Back to Manor');
  assert.doesNotMatch(m.tour(o, 'intro', manor), /Back to Manor/, 'not before the last step');
  assert.doesNotMatch(m.tour(o, 'tour'), /Back to Manor/, 'not without a from');
  assert.match(m.tour({ ...o, tour: [] }, 'settings', manor), /Back to Manor/, 'the settings step, when it is the last');
  assert.equal(m.tourFrom('#/tour?from=' + encodeURIComponent(manor)), manor);
  assert.equal(m.tourFrom('#/tour?from=' + encodeURIComponent('http://127.0.0.1:8888/')), 'http://127.0.0.1:8888/');
  assert.equal(m.tourFrom('#/tour?from=' + encodeURIComponent('http://[::1]:8888/')), 'http://[::1]:8888/');
  assert.equal(m.tourFrom('#/tour?from=' + encodeURIComponent('http://localhost:8888/x')), 'http://localhost:8888/x');
  assert.equal(m.tourFrom('#/tour'), null);
  assert.equal(m.tourFrom('#/tour?from='), null);
  assert.equal(m.tourFrom('#/tour?from=' + encodeURIComponent('https://example.com/')), null, 'off the PC: ignored');
  assert.equal(m.tourFrom('#/tour?from=' + encodeURIComponent('http://localhost.example.com/')), null);
  assert.equal(m.tourFrom('#/tour?from=' + encodeURIComponent('javascript:alert(1)')), null);
  assert.equal(m.tourFrom('#/tour?from=not a url'), null);
});

test("only the parts on the page are walked: a page that differs by variant keeps one onboarding", () => {
  const o = { intro: { title: 'Meet the fixture', text: 'x' }, settings: [], tour: [{ tour: 'games', text: 'Games.' }, { tour: 'weather', text: 'Weather.' }, { tour: 'drivers', text: 'Drivers.' }] };
  const doc = (names: string[]) => ({ querySelector: (sel: string) => (names.some((n) => sel === `[data-tour="${n}"]`) ? {} : null) });
  globalThis.CSS ??= { escape: (s: string) => s } as typeof CSS;
  assert.deepEqual(m.onPage(o.tour, doc(['games', 'drivers'])).map((p) => p.tour), ['games', 'drivers']);
  assert.deepEqual(m.onPage(o.tour, {}).map((p) => p.tour), ['games', 'weather', 'drivers'], 'no page to look in: all of them');
  const d = globalThis.document as unknown as Record<string, unknown>;
  d.querySelector = doc(['games', 'drivers']).querySelector;
  try {
    assert.match(m.tour(o, 'intro'), /Step 1 of 3/);
    assert.match(m.tour(o, 'tour'), /Step 3 of 3 · 1 of 2.*Games./, 'two of the three: Weather is not on the page');
    d.querySelector = doc([]).querySelector;
    assert.match(m.tour(o, 'settings'), /Step 2 of 2.*>Done</, 'none on the page: the settings are the last step');
  } finally {
    delete d.querySelector;
  }
});
