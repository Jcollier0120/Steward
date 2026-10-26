import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

// A page drawn in the browser (kit 2.21.0): the server's half (node/react-page.ts: the shell, its first data, the
// bundle, the release's page) and the react part's frame (react/shell.tsx), rendered here with react-dom/server.
// Nothing here reads the real Reeve's or Manor's settings.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-react-test-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(home, 'agent');
process.env.REEVE_HOME = path.join(home, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'no-manor');
/** The Steward's checkout: its esbuild and React, for agents in temporary folders with no node_modules. */
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.STEWARD_ESBUILD = STEWARD;
after(() => rmSync(home, { recursive: true, force: true }));

const { hasTour, pageShell, pageScript, reactPage, releasePage, scriptJson, PAGE_BUNDLE, PAGE_ENTRY } = await import('./fixture/src/kit/react-page.ts');
const { loadEsbuild } = await import('./fixture/src/kit/minify.ts');
const { ago: serverAgo } = await import('./fixture/src/kit/page.ts');
const { ago: browserAgo } = await import('../react/time.ts');
const { bundleForNode, importPath } = await import('./react-render.ts');

const LS = String.fromCharCode(0x2028);

test("the first data is safe in the page's <script>, and reads back as it was", () => {
  const v = { a: `</script><!-- ${LS}`, n: 1 };
  const out = scriptJson(v);
  assert.ok(!out.includes('<') && !out.includes(LS), out);
  assert.deepEqual(JSON.parse(out), v);
});

test("the browser's ago() says what the server's says", () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  for (const s of [null, 'x', '2026-10-05T11:59:30Z', '2026-10-05T11:59:00Z', '2026-10-05T11:30:00Z', '2026-10-05T10:59:00Z', '2026-10-05T09:00:00Z', '2026-10-04T12:00:00Z', '2026-09-20T12:00:00Z', '2026-10-05T12:00:30Z', '2026-10-05T12:01:00Z', '2026-10-05T18:00:00Z', '2026-10-07T12:00:00Z']) {
    assert.equal(browserAgo(s, now), serverAgo(s, now), String(s));
  }
  assert.equal(browserAgo('2026-10-05T18:00:00Z', now), 'in 6 hours', 'a time still to come');
  assert.equal(browserAgo('2026-10-05T12:00:30Z', now), 'just now', 'a clock a moment ahead');
});

test('the shell: the token, the theme at first paint, the first data, and the bundle', () => {
  const shell = pageShell({ busy: true, title: '(bump) Fixture' });
  assert.equal(shell.pill.kind, 'busy');
  assert.equal(shell.title, '(bump) Fixture');
  assert.ok(shell.themes.some((t) => t.name === 'system' && t.groupLabel));
  assert.match(shell.work, /Where its work runs/);
  assert.deepEqual(shell.onboarding?.settings, ['folders'], "the agent's src/onboarding.ts, found by itself");
  assert.equal(pageShell({ onboarding: null }).onboarding, null, 'unless the caller says otherwise');
  const html = reactPage({ token: 'tok', data: { shell, body: { words: '</script>' } } });
  assert.match(html, /<meta name="page-token" content="tok">/);
  assert.match(html, /<title>\(bump\) Fixture<\/title>/);
  assert.match(html, /<div id="root">/);
  assert.match(html, /<script type="module" src="\/page\.js"><\/script>/);
  assert.match(html, /\.titlebar \{/, "page.ts's CSS");
  const data = JSON.parse(html.match(/<script type="application\/json" id="page-data">([^<]*)<\/script>/)![1]);
  assert.equal(data.body.words, '</script>');
  assert.equal(data.shell.app.id, shell.app.id);
});

/** An agent's root in a temporary folder, with a page of its own (no React: no node_modules here). */
function agentRoot(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(home, 'agent-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), text);
  }
  return root;
}
const call = async (h: ReturnType<typeof pageScript>) => (await h({ path: '/page.js', query: new URLSearchParams(), body: {}, token: 't' })) as { status?: number; body?: string; json?: unknown };

test('/page.js: none without a page; built in a checkout, again after a change; a release\'s as it is', async () => {
  assert.equal((await call(pageScript(agentRoot({})))).status, 404);

  const root = agentRoot({ [PAGE_ENTRY]: "import { words } from './words.ts';\ndocument.title = words;\n", 'src/web/words.ts': "export const words: string = 'first';\n" });
  const h = pageScript(root);
  const built = await call(h);
  assert.equal(built.status, undefined);
  assert.match(built.body!, /first/);
  writeFileSync(path.join(root, 'src/web/words.ts'), "export const words: string = 'second';\n");
  assert.match((await call(h)).body!, /second/, 'built again after a change');

  writeFileSync(path.join(root, PAGE_BUNDLE), 'console.log("released");');
  assert.equal((await call(h)).body, 'console.log("released");', "a release's bundle, not built again");
});

test("a release's page: bundled into src/web/page.js, its sources left out", async () => {
  const stage = agentRoot({
    [PAGE_ENTRY]: "import { words } from './words.ts';\ndocument.title = words;\n",
    'src/web/words.ts': "export const words = 'released';\n",
    'src/web/types.ts': 'export interface X { a: number }\n',
    'src/kit/react/index.ts': 'export {};\n',
    'src/kit/page.ts': 'export {};\n',
  });
  const esbuild = await loadEsbuild(STEWARD);
  if ('error' in esbuild) throw new Error(esbuild.error);
  const r = await releasePage(stage, STEWARD, esbuild);
  assert.ok(r && r.kb >= 1);
  assert.deepEqual(readdirSync(path.join(stage, 'src', 'web')), ['page.js']);
  assert.match(readFileSync(path.join(stage, PAGE_BUNDLE), 'utf8'), /released/);
  assert.ok(!existsSync(path.join(stage, 'src', 'kit', 'react')), "the react part is in the bundle");
  assert.ok(existsSync(path.join(stage, 'src', 'kit', 'page.ts')), 'the rest of the kit stays');
  assert.equal(await releasePage(agentRoot({}), STEWARD, esbuild), null, 'no page, nothing done');
});

test("the react part's frame is page.ts's, class for class: title bar, notice, Settings and footer", async () => {
  const shell = { ...pageShell({ busy: true }), offDutySince: '3 minutes ago', manor: { name: 'Weasel Manor', url: 'http://manor.localhost:18585/', theme: 'system', settingsUrl: 'http://manor.localhost:18585/#/settings' } };
  const { render } = await bundleForNode<{ render: (d: unknown) => string }>(
    `import { renderToStaticMarkup } from 'react-dom/server';
     import { Page, Card, Text, Badge, PostButton } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
     export const render = (data) => renderToStaticMarkup(
       <Page data={data} reload={() => {}} action={<PostButton title="Run now" variant="secondary" path="/api/run" confirm="Now?" />} tour={<p>Step one</p>} about={data.about && <p className="mine-about">{data.about}</p>}>
         <Card className="empty" tour="mine"><Text variant="muted">quiet</Text> <Badge label="fine" tone="success" /></Card>
       </Page>);`,
    { location: { hash: '' }, document: { documentElement: { dataset: {} } } },
  );
  const html = render({ shell, body: {} });
  assert.match(html, /<header class="titlebar busy" data-agent="[a-z-]+" data-tour="titlebar">/);
  assert.match(html, /<a class="manor-back" href="http:\/\/manor\.localhost:18585\/" title="Back to Weasel Manor">/);
  assert.match(html, /<span class="status-pill busy" title="A round is under way/);
  // The pill on the name's line, after the name, plain text in the brand's link; the role alone under them (its whole
  // text its title); none in the tools.
  assert.match(html, /<div class="name-line"><h1>[^<]+<\/h1><span class="status-pill busy" title="A round is under way[^"]*" data-tour="status">[^<]+<\/span><\/div><p class="role" title="([^"]+)">\1<\/p><\/div><\/a>/);
  assert.match(html, /<div class="tools"><a class="tool-link" id="about-link"/);
  assert.equal((html.match(/class="status-pill/g) ?? []).length, 1);
  assert.match(html, /<a class="tool-link" id="settings-link" href="#\/settings"/);
  assert.match(html, /Weasel Manor chooses the theme, for every page in the manor/);
  assert.match(html, /<span class="titlebar-action" data-tour="action"><button type="button" class="quiet" data-post="\/api\/run">Run now<\/button><\/span>/);
  assert.match(html, /<div class="banner-note offduty" role="status"><span><strong>Off duty<\/strong> since 3 minutes ago/);
  assert.match(html, /<div class="card empty" data-tour="mine"><span class="muted">quiet<\/span> <span class="badge tone-success">fine<\/span><\/div>/);
  assert.match(html, /<section id="settings-view"><a class="back-link" href="#\/">Back to /);
  assert.match(html, /<div class="card sf-panel" data-tour="settings-panel"><p class="muted">Loading the settings…<\/p><\/div>/, "the kit's React Settings form, loading");
  assert.match(html, /<a class="tool-link" id="about-link" href="#\/about" title="About" aria-current="false" data-tour="about">.*<span>About<\/span><\/a><a class="tool-link" id="settings-link"/, 'About, beside Settings, as Manor has it');
  assert.match(html, /<section id="about-view"><a class="back-link" href="#\/">Back to [^<]+<\/a><h2>About [^<]+<\/h2><div data-tour="work" style="display:contents">[\s\S]*Where its work runs/, 'About: Where its work runs');
  assert.doesNotMatch(html.slice(html.indexOf('id="settings-view"'), html.indexOf('id="about-view"')), /Where its work runs/, "no longer in Settings");
  assert.match(render({ shell, body: {}, about: "How it works" }), /<h2>About [^<]+<\/h2><p class="mine-about">How it works<\/p><div data-tour="work"/, "the agent's own, then the work");
  assert.doesNotMatch(render({ shell: { ...shell, work: "" }, body: {} }), /about-link|about-view/, "nothing to say: no About");
  assert.match(html, /<footer>[^<]+ · this PC only<\/footer>/, 'Developer options off (no Manor, no switch of its own): no data folder');
  const dev = render({ shell: { ...shell, developer: true, dataDir: 'D:\\agent-data' }, body: {} });
  assert.match(dev, /<footer>[^<]+ · this PC only · its files are in <code>D:\\agent-data<\/code><\/footer>/);
  // Room for the onboarding tour: every part of the frame named, and the tour drawn over the page only at #/tour.
  for (const name of ['titlebar', 'status', 'about', 'settings', 'theme', 'action', 'settings-panel', 'work']) assert.match(html, new RegExp(`data-tour="${name}"`), name);
  assert.doesNotMatch(html, /tour-layer/);
  (globalThis as unknown as { location: { hash: string } }).location.hash = '#/tour';
  assert.match(render({ shell, body: {} }), /<div class="tour-layer" role="dialog" aria-label="A tour of [^"]+(&#x27;|')s page"><p>Step one<\/p><\/div>/);
});

test("a ping's round state: news when a round starts or ends, not when nothing changed", async () => {
  const { roundState } = await import('../react/page-data.ts');
  const idle = roundState({ busy: false, lastRunAt: '2026-10-05T12:00:00Z', runningSince: null });
  assert.equal(roundState({ busy: false, lastRunAt: '2026-10-05T12:00:00Z' }), idle, 'the same state, said either way');
  assert.notEqual(roundState({ busy: true, lastRunAt: '2026-10-05T12:00:00Z', runningSince: '2026-10-05T12:10:00Z' }), idle, 'one started');
  assert.notEqual(roundState({ busy: false, lastRunAt: '2026-10-05T12:10:30Z' }), idle, 'one ended');
});

test("/api/ping's tour: a React page with an onboarding, in a checkout or a release; nothing else", () => {
  const o = { intro: { title: 't', text: 'x' }, settings: [], tour: [] };
  assert.equal(hasTour(agentRoot({ [PAGE_ENTRY]: '' }), o), true, 'a checkout');
  assert.equal(hasTour(agentRoot({ [PAGE_BUNDLE]: '' }), o), true, 'a release');
  assert.equal(hasTour(agentRoot({ [PAGE_ENTRY]: '' }), null), false, 'no onboarding');
  assert.equal(hasTour(agentRoot({ 'src/app.ts': '' }), o), false, 'a page built in strings: no #/tour');
});

test("the shell carries the manor's Developer options: off, no data folder and the work section in plain words; Manor's on, both", () => {
  const off = pageShell();
  assert.equal(off.developer, false, 'no Manor and no switch of its own: off');
  assert.equal(off.dataDir, '', 'a path is developer content: not even sent');
  assert.doesNotMatch(off.work, /Reeve/);
  const manor = path.join(home, 'manor-dev');
  mkdirSync(path.join(manor, 'app'), { recursive: true });
  writeFileSync(path.join(manor, 'settings.json'), JSON.stringify({ developerOptions: true }));
  const was = process.env.MANOR_HOME;
  process.env.MANOR_HOME = manor;
  try {
    const on = pageShell();
    assert.equal(on.developer, true);
    assert.ok(on.dataDir.length > 0, 'the data folder, for the footer');
    writeFileSync(path.join(manor, 'settings.json'), JSON.stringify({ developerOptions: false }));
    assert.equal(pageShell().developer, false, 'flipped in Manor: the next page has it, with no restart');
  } finally {
    process.env.MANOR_HOME = was;
  }
});

test('useDeveloper() and <DeveloperOnly>: what the page hides follows the shell, off unless it says on', async () => {
  const shell = pageShell();
  const { render, bare } = await bundleForNode<{ render: (d: unknown) => string; bare: () => string }>(
    `import { renderToStaticMarkup } from 'react-dom/server';
     import { Page, DeveloperOnly, useDeveloper } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
     const Says = () => <p className="says">{useDeveloper() ? 'developer' : 'everyone'}</p>;
     const body = <><Says /><DeveloperOnly fallback={<p className="plain">It tries again at the next round.</p>}><pre className="log">exit code 1</pre></DeveloperOnly></>;
     export const render = (data) => renderToStaticMarkup(<Page data={data} reload={() => {}}>{body}</Page>);
     export const bare = () => renderToStaticMarkup(body);`,
    { location: { hash: '' }, document: { documentElement: { dataset: {} } } },
  );
  const off = render({ shell: { ...shell, developer: false }, body: {} });
  assert.match(off, /<p class="says">everyone<\/p>/);
  assert.match(off, /<p class="plain">It tries again at the next round\.<\/p>/);
  assert.doesNotMatch(off, /exit code/);
  const on = render({ shell: { ...shell, developer: true }, body: {} });
  assert.match(on, /<p class="says">developer<\/p>/);
  assert.match(on, /<pre class="log">exit code 1<\/pre>/);
  assert.doesNotMatch(on, /class="plain"/);
  const { developer: _, ...older } = shell;
  assert.doesNotMatch(render({ shell: older, body: {} }), /exit code/, "a shell that doesn't say: off");
  assert.doesNotMatch(bare(), /exit code/, 'outside a <Page>: off');
});

test("Settings in tabs: General (the kit's form) first, then the agent's own, the one the address names drawn", async () => {
  const shell = pageShell({ busy: false });
  const { render, inHash } = await bundleForNode<{ render: (d: unknown) => string; inHash: (h: string) => string | null }>(
    `import { renderToStaticMarkup } from 'react-dom/server';
     import { Page, settingsTabInHash } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
     export const inHash = settingsTabInHash;
     export const render = (data) => renderToStaticMarkup(
       <Page data={data} reload={() => {}} settings={<p>Above the form</p>} settingsTabs={[{ id: 'logs', label: 'Logs', content: <p>The logs tab</p> }]}>
         <p>The page</p>
       </Page>);`,
    { location: { hash: '#/settings' }, document: { documentElement: { dataset: {} } } },
  );
  const general = render({ shell, body: {} });
  assert.match(general, /<div class="tabs" role="tablist" aria-label="Settings">/);
  assert.match(general, /<button type="button" role="tab" class="tab" id="settings-tab-general" aria-selected="true" aria-controls="settings-panel-general" tabindex="0">General<\/button>/);
  assert.match(general, /<button type="button" role="tab" class="tab" id="settings-tab-logs" aria-selected="false" aria-controls="settings-panel-logs" tabindex="-1">Logs<\/button>/);
  assert.match(general, /<div class="tab-panel" role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general"><p>Above the form<\/p>/);
  assert.match(general, /data-tour="settings-panel"/, "General holds the kit's Settings form");
  assert.doesNotMatch(general, /The logs tab/, 'only the chosen tab is drawn');

  (globalThis as unknown as { location: { hash: string } }).location.hash = '#/settings/logs';
  const logs = render({ shell, body: {} });
  assert.match(logs, /<div class="tab-panel" role="tabpanel" id="settings-panel-logs" aria-labelledby="settings-tab-logs"><p>The logs tab<\/p><\/div>/);
  assert.doesNotMatch(logs, /data-tour="settings-panel"/);

  (globalThis as unknown as { location: { hash: string } }).location.hash = '#/settings/no-such-tab';
  assert.match(render({ shell, body: {} }), /id="settings-panel-general"/, 'a tab that isn\'t there: General');
  assert.equal(inHash('#/settings/logs'), 'logs');
  assert.equal(inHash('#settings/logs'), 'logs');
  assert.equal(inHash('#/settings'), null);
  assert.equal(inHash('#/settings/a b'), null);
});

test('a long page in tabs (PageTabs): the one the address names shown, the rest drawn but hidden, counts and marks', async () => {
  const { render, inHash } = await bundleForNode<{ render: () => string; inHash: (h: string) => string | null }>(
    `import { renderToStaticMarkup } from 'react-dom/server';
     import { PageTabs, pageTabInHash } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
     export const inHash = pageTabInHash;
     export const render = () => renderToStaticMarkup(
       <PageTabs label="The page" tabs={[
         { id: 'files', label: 'Loose files', count: 34, content: <section data-tour="files">The files</section> },
         { id: 'moves', label: 'Moves', mark: 'One failed', content: <section data-tour="moves">The moves</section> },
       ]} />);`,
    { location: { hash: '#/' }, document: { documentElement: { dataset: {} } } },
  );
  const first = render();
  assert.match(first, /<div class="tabs" role="tablist" aria-label="The page">/);
  assert.match(first, /id="page-tab-files" aria-selected="true" aria-controls="page-panel-files" tabindex="0">Loose files<span class="tab-count">34<\/span><\/button>/);
  assert.match(first, /id="page-tab-moves" aria-selected="false"[^>]*>Moves<span class="tab-mark" title="One failed" aria-label="One failed"><\/span><\/button>/);
  assert.match(first, /<div class="tab-panel" role="tabpanel" id="page-panel-files" aria-labelledby="page-tab-files"><section data-tour="files">/);
  assert.match(first, /<div class="tab-panel" role="tabpanel" id="page-panel-moves" aria-labelledby="page-tab-moves" hidden=""><section data-tour="moves">/, 'drawn while hidden: the tour finds it, and what was typed in it stays');

  (globalThis as unknown as { location: { hash: string } }).location.hash = '#/moves';
  assert.match(render(), /id="page-panel-files" aria-labelledby="page-tab-files" hidden="">.*id="page-panel-moves" aria-labelledby="page-tab-moves">/, 'the tab the address names');
  (globalThis as unknown as { location: { hash: string } }).location.hash = '#/nothing';
  assert.match(render(), /id="page-panel-files" aria-labelledby="page-tab-files">/, "one that isn't there: the first");
  assert.equal(inHash('#/moves'), 'moves');
  assert.equal(inHash('#moves'), 'moves');
  assert.equal(inHash('#/'), null);
  assert.equal(inHash('#/settings'), null, "the kit's own addresses are never a page's tab");
  assert.equal(inHash('#/tour'), null);
  assert.equal(inHash('#/about'), null);
  assert.equal(inHash('#/settings/logs'), null);
  // Drawn where there's no address at all (an agent's tests, rendering its page on the server): the first tab.
  delete (globalThis as { location?: unknown }).location;
  assert.match(render(), /id="page-panel-files" aria-labelledby="page-tab-files">/, 'no location: the first');
});

test("a Section titled as the page tab it's in leaves its title and count to the tab; its right-hand part stays", async () => {
  const { render } = await bundleForNode<{ render: () => string }>(
    `import { renderToStaticMarkup } from 'react-dom/server';
     import { PageTabs, Section } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
     export const render = () => renderToStaticMarkup(
       <>
         <Section title="Findings" count={2}>Outside</Section>
         <PageTabs tabs={[
           { id: 'findings', label: 'Findings', count: 2, content: <><Section title="findings" count={2}>A</Section><Section title="Older" count={5}>B</Section></> },
           { id: 'files', label: 'Loose files', content: <Section title="Loose files" right={<button>Tick all</button>}>C</Section> },
         ]} />
       </>);`,
    { location: { hash: '#/' }, document: { documentElement: { dataset: {} } } },
  );
  const h = render();
  assert.match(h, /^<section class="ui-section ui-gap-md"><div class="ui-section-head"><div class="ui-section-name"><h2>Findings<\/h2><span class="muted ui-count">· 2<\/span>/, 'outside a tab: as ever');
  assert.match(h, /id="page-panel-findings"[^>]*><section class="ui-section ui-gap-md">A<\/section>/, "the tab's own name: no heading row");
  assert.match(h, /<h2>Older<\/h2><span class="muted ui-count">· 5<\/span>/, 'another name: its heading');
  assert.match(h, /id="page-panel-files"[^>]*><section class="ui-section ui-gap-md"><div class="ui-section-head"><div class="ui-section-name"><\/div><div class="ui-section-right"><button>Tick all<\/button><\/div><\/div>C/, 'a right-hand part: the row, without the title');
});

test('showSection (a Glance tile, a link): a part in a hidden page tab has its tab chosen, and is scrolled to once drawn', async () => {
  const { show } = await bundleForNode<{ show: (tour: string) => void }>(
    `import { showSection } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
     export const show = showSection;`,
  );
  const scrolled: string[] = [];
  const sent: unknown[] = [];
  const frames: (() => void)[] = [];
  const panel = { id: 'page-panel-moves', hidden: true };
  const part = (name: string, inPanel: typeof panel | null) => ({ scrollIntoView: () => scrolled.push(name), closest: () => inPanel });
  const parts: Record<string, unknown> = { files: part('files', null), moves: part('moves', panel) };
  const g = globalThis as Record<string, unknown>;
  const was = { document: g.document, window: g.window, requestAnimationFrame: g.requestAnimationFrame };
  g.document = { querySelector: (q: string) => parts[/data-tour="(\w+)"/.exec(q)?.[1] ?? ''] ?? null };
  g.window = { dispatchEvent: (e: CustomEvent) => sent.push([e.type, e.detail]) };
  g.requestAnimationFrame = (f: () => void) => frames.push(f);
  try {
    show('files');
    assert.deepEqual(scrolled, ['files'], 'one in sight: scrolled to at once');
    assert.deepEqual(sent, [], 'no tab chosen');
    show('moves');
    assert.deepEqual(sent, [['kit-show-tab', 'moves']], 'its tab chosen, as the tour chooses it');
    assert.deepEqual(scrolled, ['files'], 'not yet: its tab is still hidden');
    frames.shift()!();
    assert.equal(frames.length, 1, 'still hidden: another frame');
    panel.hidden = false;
    frames.shift()!();
    assert.deepEqual(scrolled, ['files', 'moves'], 'scrolled to once its tab is drawn');
    show('gone');
    assert.deepEqual(scrolled, ['files', 'moves'], 'a part not on the page: nothing');
  } finally {
    Object.assign(g, was);
  }
});
