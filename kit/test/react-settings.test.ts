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

const m = await bundleForNode<{ form: (data: unknown, keys?: string[]) => string; tour: (o: unknown, start: string, from?: string | null, needs?: unknown, manorName?: string | null) => string; tourFrom: (hash: string) => string | null; tourStart: (hash: string) => string; onPage: (parts: unknown[], doc?: unknown) => { tour: string }[] }>(
  `import { renderToStaticMarkup as r } from 'react-dom/server';
   import { onPage, SettingsForm, Tour, tourFrom, tourStart } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
   export const form = (data, keys) => r(<SettingsForm initial={data} keys={keys} />);
   export const tour = (o, start, from = null, needs = null, manorName = null) => r(<Tour onboarding={o} app={{ id: 'fixture', name: 'Fixture', role: 'r', version: '1' }} start={start} from={from} needs={needs} manorName={manorName} />);
   export { onPage, tourFrom, tourStart };`,
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
// The same with fewer ordinary settings than a form in tabs has (TAB_FIELDS): the short page.
const short = (warnings = {}) => ({ ...data(warnings), schema: schema.filter((f) => !['agents', 'jobs', 'env'].includes(f.key)) });

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
  assert.match(h, /<div class="sf-record"><div class="sf-record-line"><button type="button" class="sf-record-title" aria-expanded="false"[^>]*>build<\/button>/, 'records with a list in them: folded to their titles');
  assert.match(h, /<th scope="col">Name<\/th><th scope="col">Value<\/th>/, 'a map: its two columns');
  assert.match(h, /<span class="sf-name">Since<\/span>.*<span class="muted">2026-10-05<\/span>/, 'read-only: the value, a time as its day');
  assert.match(h, /aria-label="Remove agent 1"/);
  assert.match(h, /<button type="submit" disabled="">Save<\/button>/, 'nothing changed: nothing to save');
  assert.match(h, /Set every field to its default/);
});

test('the short page: groups are sections with jump links, the advanced folded, a field shown only when it applies', () => {
  const h = m.form(short());
  assert.doesNotMatch(h, /role="tablist"/, 'a short page has no tabs');
  assert.match(h, /<nav class="sf-jump" aria-label="Sections"><button type="button" class="link">Limits<\/button><button type="button" class="link">Alarms<\/button><\/nav>/);
  assert.match(h, /<details class="sf sf-section" data-key="limits" id="sf-section-limits">/, 'two groups: each folded');
  assert.match(h, /<details class="sf-advanced"><summary>Advanced \(1\)<\/summary>.*Port/, 'the advanced top-level setting, folded at the end');
  assert.match(h, /data-key="limits".*<details class="sf-advanced"><summary>Advanced \(1\)<\/summary>.*Share/, "and a group's advanced field, folded in it");
  assert.doesNotMatch(h, /data-key="stocks"/, 'stocks is for the financial variant: hidden for gamer');
  assert.match(m.form({ ...short(), values: { ...values, variant: 'financial' } }), /data-key="stocks"/, 'and shown for financial');
  const err = m.form(short({ stocks: 'Not a ticker.', share: 'x', 'limits.share': 'Between 0 and 1.' }));
  assert.match(err, /data-key="stocks"/, 'a message about a hidden field shows it anyway');
  assert.match(err, /<details class="sf sf-section" data-key="limits" id="sf-section-limits" open="">/, 'and opens the section it is in');
});

test('a record wider than a table row, or with an advanced field, folds to one line; its advanced fields fold inside it', () => {
  const wide = { key: 'projects', kind: 'records', label: 'Projects', noun: 'project', title: 'name', fields: ['name', 'a', 'b', 'c', 'd'].map((k) => ({ key: k, kind: 'text', label: k.toUpperCase(), advanced: k === 'd' })) };
  const h = m.form({ schema: [wide], values: { projects: [{ name: 'Porter', a: '', b: '', c: '', d: 'x' }] }, defaults: { projects: [] }, problems: [], warnings: {}, file: 'f' });
  assert.match(h, /<button type="button" class="sf-record-title" aria-expanded="false"[^>]*>Porter<\/button>/, 'one line, its title');
  assert.doesNotMatch(h, /sf-table/, 'not a table of five columns');
  assert.match(h, /<div [^>]*class="sf-record-body" role="group" aria-label="Porter" hidden="">.*<details class="sf-advanced"><summary>Advanced \(1\)<\/summary>.*data-key="d"/, "folded: its fields drawn but hidden, the advanced one folded in it");
});

test("a long list of records: each line says what it is and does, its inline switch works there, a box finds one", () => {
  const repos = {
    key: 'repos',
    kind: 'records',
    label: 'Repositories',
    noun: 'repository',
    title: 'name',
    line: ['repo', 'branch'],
    advancedLabel: 'Found by the agent',
    noAdd: true,
    fields: [
      { key: 'merges', kind: 'switch', label: 'Merges PRs', inline: true },
      { key: 'release', kind: 'text', label: 'Release it', chip: 'releases', chipOff: 'not released' },
      { key: 'test', kind: 'list', label: 'Test it', item: { label: 'Command' }, chipOff: 'no tests' },
      { key: 'kit', kind: 'switch', label: 'Takes the kit', hidden: true },
      { key: 'name', kind: 'text', label: 'Name', advanced: true },
      { key: 'repo', kind: 'text', label: 'Repository', advanced: true },
      { key: 'branch', kind: 'text', label: 'Branch', advanced: true },
    ],
  };
  const rec = (n: number) => ({ name: `App${n}`, repo: `me/app${n}`, branch: 'main', merges: n === 1, release: n === 1 ? 'npm run release' : '', test: n === 1 ? ['npm test'] : [], kit: true });
  const values = { repos: Array.from({ length: 9 }, (_, i) => rec(i + 1)) };
  const h = m.form({ schema: [repos], values, defaults: { repos: [] }, problems: [], warnings: { 'repos.1.repo': 'No such folder.' }, file: 'f' });
  assert.match(h, /<input type="search" placeholder="Find a repository" aria-label="Find a repository" value=""\/><span class="muted">9 repositories<\/span>/, 'more than eight: a box to find one by');
  assert.match(h, />App1<\/button><span class="sf-record-info" title="me\/app1 · main">me\/app1 · main<\/span><span class="sf-chips"><span class="sf-chip">releases<\/span><\/span><label class="sf-switch"><input type="checkbox" role="switch"[^>]*aria-label="Merges PRs, App1"[^>]*checked=""\/><span>Merges PRs<\/span><\/label>/, 'its repository and branch, a chip for what is set, its switch on the line');
  assert.match(h, />App2<\/button>.*?<span class="sf-chips"><span class="sf-chip warn" title="No such folder\.">needs a look<\/span><span class="sf-chip off">not released<\/span><span class="sf-chip off">no tests<\/span><\/span>/, "what isn't set, and a warning, said on the line; a warning doesn't open it");
  assert.doesNotMatch(h, /aria-expanded="true"/, 'every record folded');
  assert.doesNotMatch(h, /Takes the kit|data-key="kit"/, 'a hidden field is never drawn');
  assert.match(h, /<details class="sf-advanced"><summary>Found by the agent \(3\)<\/summary>/, 'what the agent found, folded under its own words');
  assert.equal(h.match(/data-key="merges"/g), null, 'the inline switch is on the line, not again inside');
  assert.doesNotMatch(h, /Add repository/, 'noAdd: records arrive another way');
  assert.match(h, /Remove repository 1/, 'and can still be removed');
});

test('a setting at its default says nothing more; one that differs says its default, and the way back', () => {
  const f = { key: 'every', kind: 'whole', min: 1, max: 60, unit: 'minutes', label: 'A round every' };
  const at = m.form({ schema: [f], values: { every: 10 }, defaults: { every: 10 }, problems: [], warnings: {}, file: 'f' });
  assert.doesNotMatch(at, /Default: |Reset to default</);
  const off = m.form({ schema: [f], values: { every: 5 }, defaults: { every: 10 }, problems: [], warnings: {}, file: 'f' });
  assert.match(off, /Default: 10 minutes\..*Reset to default/);
});

test("tabs named in the schema: a long list split up without changing the file's shape, in the schema's order", () => {
  const sw = (key: string, tab?: string) => ({ key, kind: 'switch', label: key, ...(tab ? { tab } : {}) });
  const schema = [
    { key: 'repos', kind: 'list', label: 'Repos', tab: 'Repositories', item: { label: 'Repo' } },
    ...['a', 'b', 'c', 'd'].map((k) => sw(k, 'Rounds')),
    ...['e', 'f', 'g', 'h', 'i'].map((k) => sw(k)),
    { key: 'alarms', kind: 'group', label: 'Alarms', fields: [sw('on')] },
    { ...sw('here', 'Alarms'), readOnly: true },
  ];
  const values = Object.fromEntries(schema.map((f) => [f.key, f.kind === 'list' ? [] : f.kind === 'group' ? { on: true } : false]));
  const h = m.form({ schema, values, defaults: values, problems: [], warnings: {}, file: 'f' });
  const tabs = [...h.matchAll(/role="tab"[^>]*id="sf-tab-([^"]+)"[^>]*>([^<]+)</g)].map((x) => `${x[1]}:${x[2]}`);
  assert.deepEqual(tabs, ['tab-repositories:Repositories', 'tab-rounds:Rounds', 'general:General', 'alarms:Alarms']);
  assert.match(h, /id="sf-tab-tab-repositories" aria-selected="true"/, 'the first tab open');
  assert.match(h, /id="sf-panel-alarms"[^>]*hidden="">.*data-key="alarms".*data-key="here"/, "a field naming a group's label is in that group's tab");
  assert.match(h, /id="sf-panel-tab-rounds"[^>]*hidden="">(?:(?!sf-panel).)*data-key="d"/, 'and the rest in theirs');
});

test('onboarding: only the keys asked for, never an advanced one; none at all says so', () => {
  const h = m.form(data(), ['interval', 'port', 'notes']);
  assert.match(h, /data-key="interval"/);
  assert.match(h, /data-key="notes"/);
  assert.doesNotMatch(h, /data-key="port"/, 'advanced: left out, even when asked for');
  assert.doesNotMatch(h, /sf-jump|Advanced/);
  assert.match(m.form(data(), []), /Nothing to set: the defaults just work\./);
});

test('a long form (two groups or more, TAB_FIELDS ordinary settings) is in tabs: General, then each group, one Save', () => {
  const h = m.form(data());
  assert.match(h, /<div class="tabs" role="tablist" aria-label="Settings sections">/);
  assert.match(h, /<button type="button" role="tab" class="tab" id="sf-tab-general" aria-selected="true" aria-controls="sf-panel-general" tabindex="0">General<\/button>/);
  assert.match(h, /id="sf-tab-limits" aria-selected="false"[^>]*>Limits<\/button>.*id="sf-tab-alarms"[^>]*>Alarms<\/button>/);
  assert.match(h, /<div class="tab-panel" role="tabpanel" id="sf-panel-general" aria-labelledby="sf-tab-general">.*data-key="interval".*<details class="sf-advanced"><summary>Advanced \(1\)<\/summary>.*Port/, 'General: the settings in no group, then Advanced');
  assert.match(h, /<div class="tab-panel" role="tabpanel" id="sf-panel-limits" aria-labelledby="sf-tab-limits" hidden="">.*data-key="limits"/, 'each group in a tab of its own, drawn while hidden so one Save sends it');
  assert.doesNotMatch(h, /sf-jump|sf-section/, 'no jump links, no folded sections');
  assert.equal(h.match(/<form /g)?.length, 1, 'one form');
  const err = m.form(data({ 'limits.share': 'Between 0 and 1.' }));
  assert.match(err, /id="sf-tab-limits"[^>]*>Limits<span class="tab-mark" title="Something here needs a look" aria-label="Something here needs a look"><\/span><\/button>/, 'a tab with a problem in it, marked');
  assert.doesNotMatch(err, /id="sf-tab-alarms"[^>]*>Alarms<span class="tab-mark"/);
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

test("its required settings: the settings step says what it can't start without; the page's Fill them in opens that step", () => {
  const o = { intro: { title: 'Meet the fixture', text: 'It carries the kit.' }, settings: ['folders'], tour: [], required: ['folders'] };
  assert.match(m.tour(o, 'settings', null, { keys: [['folders']], text: 'Folders' }), /<p class="tour-needs" role="status"><strong>Needed before it can start:<\/strong> Folders\.<\/p>/);
  assert.doesNotMatch(m.tour(o, 'settings'), /tour-needs/, 'filled in: nothing said');
  assert.equal(m.tourStart('#/tour?step=settings'), 'settings');
  assert.equal(m.tourStart('#/tour'), 'intro');
  assert.equal(m.tourStart('#/tour?step=nonsense'), 'intro');
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

test('opened from Manor (#/tour?from=): its last step offers Back to <manor>, and only to an address on this PC', () => {
  const o = { intro: { title: 'Meet the fixture', text: 'It carries the kit.' }, settings: [], tour: [{ tour: 'status', text: 'On duty or off.' }] };
  const manor = 'http://manor.localhost:8888/#/roles/fixture';
  assert.match(m.tour(o, 'tour', manor, null, 'Weasel Manor'), />Done<.*>Back to Weasel Manor</, "the last step: Done, and Back to the manor's name");
  assert.match(m.tour(o, 'tour', manor), />Done<.*>Back to Castellan</, 'with no name: Castellan');
  assert.match(m.tour(o, 'tour', manor, null, '  '), />Back to Castellan</, 'a blank name: Castellan');
  assert.doesNotMatch(m.tour(o, 'intro', manor), /Back to Castellan/, 'not before the last step');
  assert.doesNotMatch(m.tour(o, 'tour'), /Back to Castellan/, 'not without a from');
  assert.match(m.tour({ ...o, tour: [] }, 'settings', manor), /Back to Castellan/, 'the settings step, when it is the last');
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

test("Developer options off: a developer's whole form is left out, and a record's handle is carried, never drawn", () => {
  assert.equal(m.form({ developerOnly: true, schema: [], values: {}, defaults: {}, problems: [], warnings: {}, file: '' }), '', 'no empty form, no card');
  const kept = { key: '~kept', kind: 'text', label: 'Kept', readOnly: true, optional: true, kept: true };
  const devices = { key: 'devices', kind: 'records', label: 'Comes and goes', noun: 'device', fields: [{ key: 'name', kind: 'text', label: 'Name', optional: true }, kept] };
  const h = m.form({ schema: [devices], values: { devices: [{ name: 'Phone', '~kept': 'abc123' }] }, defaults: { devices: [] }, problems: [], warnings: {}, file: '' });
  assert.match(h, /<table class="sf-table"><thead><tr><th scope="col">Name<\/th><th><\/th><\/tr><\/thead>/, 'its own fields only');
  assert.doesNotMatch(h, /Kept|abc123/);
  // With the switch on the same form is drawn whole, as ever.
  assert.match(m.form(data()), /<div class="card sf-panel" data-tour="settings-panel">/);
});

test('a list with item.options is picked, not typed: each item by its label with Remove, and a dropdown of the rest', () => {
  const repos = [{ value: 'acme/site', label: 'acme/site' }, { value: 'acme/api', label: 'acme/api (Reeve)' }, { value: 'acme/docs', label: 'acme/docs' }];
  const field = { key: 'repos', kind: 'list', label: 'Repositories', item: { label: 'Repository', options: repos } };
  const h = m.form({ schema: [field], values: { repos: ['acme/api', 'gone/old'] }, defaults: { repos: [] }, problems: [], warnings: {}, file: 's.json' });
  assert.match(h, /<span class="sf-item-text">acme\/api \(Reeve\)<\/span>/, 'an item by its option label');
  assert.match(h, /<span class="sf-item-text">gone\/old<\/span>/, 'an item no longer offered still shows, as it is');
  assert.match(h, /aria-label="Remove repository 2"/);
  assert.match(h, /<select class="sf-pick" aria-label="Add repository">/);
  const pick = h.match(/<select class="sf-pick".*?<\/select>/)?.[0] ?? '';
  assert.match(pick, /<option value="" selected="">Add repository…<\/option><option value="acme\/site">acme\/site<\/option><option value="acme\/docs">acme\/docs<\/option>/, 'only the options not picked yet');
  assert.doesNotMatch(h, /<input type="text"[^>]*aria-label="Repository/, 'nothing to type');
  const all = m.form({ schema: [field], values: { repos: repos.map((r) => r.value) }, defaults: { repos: [] }, problems: [], warnings: {}, file: 's.json' });
  assert.match(all, /Every repository there is to pick is in the list\./);
  assert.doesNotMatch(all, /sf-pick/);
  const none = m.form({ schema: [{ ...field, item: { label: 'Repository', options: [] } }], values: { repos: [] }, defaults: { repos: [] }, problems: [], warnings: {}, file: 's.json' });
  assert.match(none, /No repository to pick from yet\./);
});

test("with Manor installed: the settings set on its Staff settings are said in a line, with the way there (kit 2.140.0)", () => {
  const inManor = { manor: 'Oakfield Manor', url: 'http://castellan.localhost:18585/#/settings/staff', labels: ['Plain-words notes', 'A round every'] };
  const html = m.form({ ...short(), inManor });
  assert.match(html, /<p class="sf-intro muted sf-in-manor">Plain-words notes and A round every are set with the rest of the staff&#x27;s settings, on Oakfield Manor&#x27;s <a href="http:\/\/castellan\.localhost:18585\/#\/settings\/staff">Staff settings<\/a>\.<\/p>/);
  assert.match(m.form({ ...short(), inManor: { ...inManor, labels: ['Video quality'] } }), /Video quality is set with/);
  assert.doesNotMatch(m.form(short()), /sf-in-manor/, 'without Manor, nothing');
  assert.doesNotMatch(m.form({ ...short(), inManor }, ['notes']), /sf-in-manor/, "onboarding's few settings say nothing of it");
});

test('a list of short words is drawn in columns; a list of paths, or of two, one a line (kit 2.140.0)', () => {
  const list = (item: object, v: string[]) => m.form({ schema: [{ key: 'l', kind: 'list', label: 'L', item: { label: 'Item', ...item } }], values: { l: v }, defaults: { l: [] }, problems: [], warnings: {}, file: '' });
  assert.match(list({}, ['node', 'python', 'dotnet']), /<ul class="sf-list sf-short">/);
  assert.doesNotMatch(list({}, ['node', 'python']), /sf-short/, 'two fit on their lines');
  assert.doesNotMatch(list({ path: { is: 'folder' } }, ['C:\a', 'D:\b', 'E:\c']), /sf-short/, 'paths get the width');
  assert.doesNotMatch(list({}, ['node', 'python', 'a command line far longer than a word']), /sf-short/);
});
