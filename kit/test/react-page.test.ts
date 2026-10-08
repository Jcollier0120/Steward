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
  for (const s of [null, 'x', '2026-10-05T11:59:30Z', '2026-10-05T11:59:00Z', '2026-10-05T11:30:00Z', '2026-10-05T10:59:00Z', '2026-10-05T09:00:00Z', '2026-10-04T12:00:00Z', '2026-09-20T12:00:00Z']) {
    assert.equal(browserAgo(s, now), serverAgo(s, now), String(s));
  }
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
       <Page data={data} reload={() => {}} action={<PostButton title="Run now" variant="secondary" path="/api/run" confirm="Now?" />} tour={<p>Step one</p>}>
         <Card className="empty" tour="mine"><Text variant="muted">quiet</Text> <Badge label="fine" tone="success" /></Card>
       </Page>);`,
    { location: { hash: '' }, document: { documentElement: { dataset: {} } } },
  );
  const html = render({ shell, body: {} });
  assert.match(html, /<header class="titlebar busy" data-agent="[a-z-]+" data-tour="titlebar">/);
  assert.match(html, /<a class="manor-back" href="http:\/\/manor\.localhost:18585\/" title="Back to Weasel Manor">/);
  assert.match(html, /<span class="status-pill busy" title="A round is under way/);
  assert.match(html, /<a class="tool-link" id="settings-link" href="#\/settings"/);
  assert.match(html, /Weasel Manor chooses the theme, for every page in the manor/);
  assert.match(html, /<span class="titlebar-action" data-tour="action"><button type="button" class="quiet" data-post="\/api\/run">Run now<\/button><\/span>/);
  assert.match(html, /<div class="banner-note offduty" role="status"><span><strong>Off duty<\/strong> since 3 minutes ago/);
  assert.match(html, /<div class="card empty" data-tour="mine"><span class="muted">quiet<\/span> <span class="badge tone-success">fine<\/span><\/div>/);
  assert.match(html, /<section id="settings-view"><a class="back-link" href="#\/">Back to /);
  assert.match(html, /<div class="card sf-panel" data-tour="settings-panel"><p class="muted">Loading the settings…<\/p><\/div>/, "the kit's React Settings form, loading");
  assert.match(html, /Where its work runs/);
  assert.match(html, /<footer>[^<]+ · this PC only<\/footer>/, 'Developer options off (no Manor, no switch of its own): no data folder');
  const dev = render({ shell: { ...shell, developer: true, dataDir: 'D:\\agent-data' }, body: {} });
  assert.match(dev, /<footer>[^<]+ · this PC only · its files are in <code>D:\\agent-data<\/code><\/footer>/);
  // Room for the onboarding tour: every part of the frame named, and the tour drawn over the page only at #/tour.
  for (const name of ['titlebar', 'status', 'settings', 'theme', 'action', 'settings-panel', 'work']) assert.match(html, new RegExp(`data-tour="${name}"`), name);
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
