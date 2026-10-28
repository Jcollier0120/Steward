import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { findBrowser, openTab, type Tab } from './browser.ts';

// The whole page waits on an action (react/page-busy.ts, kit 2.144.0), in a real browser: a page on the kit's Page with
// every kind of button there is, its fetch answered by the test (each request waits until the test answers it). Each
// press is followed through: the page disabled and the pressed button spinning while it runs, then the page back on
// success, failure, refusal and timeout, focus where it was. What isn't a press (polling, a post() as someone types)
// never holds it; a dialog the action opens can be answered. Every wait is for a condition, with a deadline.
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.STEWARD_ESBUILD = STEWARD;
const { loadEsbuild } = await import('../node/minify.ts');
const browser = findBrowser();
const skip = browser ? false : 'no Chromium browser on this PC (Edge, Chrome or Chromium; KIT_TEST_BROWSER names one)';
const kit = path.join(STEWARD, 'kit/react/index.ts').split(path.sep).join('/');

const TOKEN = 'page-token-0123456789';
const NEW_TOKEN = 'page-token-after-restart-0123';

const shell = {
  app: { id: 'tester', name: 'Tester', role: 'Tries every button', version: '1.0.0' },
  title: 'Tester',
  busy: false,
  refreshSec: 1,
  pill: { kind: 'on', text: 'On duty', title: '' },
  scene: '',
  offDutySince: null,
  manor: null,
  themes: [],
  themeKey: 'tester-theme',
  developer: false,
  work: '',
  dataDir: '',
  onboarding: null,
};

/** The page: the kit's Page, and a button of each kind, each POSTing to its own path. */
const PAGE = `
import { useState } from 'react';
import { BusyArea, BusyButton, Button, Card, confirmDialog, ModalCard, mount, Page, pageHeld, pageWait, post, PostButton, usePageData } from '${kit}';

const pending = [];
let deferGets = false;
const DATA = JSON.parse(document.getElementById('page-data').textContent);
const reply = (status, body, type = 'application/json') => new Response(type === 'application/json' ? JSON.stringify(body) : body, { status, headers: { 'content-type': type } });
window.fetch = (input, init = {}) => {
  const path = String(input);
  const method = init.method || 'GET';
  if (method === 'GET' && !deferGets && path === '/api/page') return Promise.resolve(reply(200, DATA));
  if (method === 'GET' && !deferGets && path === '/api/ping') return Promise.resolve(reply(200, { busy: false }));
  if (method === 'GET' && path !== '/' && !deferGets) return Promise.resolve(reply(404, { error: 'not here' }));
  return new Promise((resolve, reject) => pending.push({ path, method, headers: init.headers || {}, resolve, reject }));
};
const take = (path) => {
  const i = pending.findIndex((p) => p.path === path);
  if (i < 0) throw new Error('nothing waits at ' + path + ': ' + pending.map((p) => p.method + ' ' + p.path).join(', '));
  return pending.splice(i, 1)[0];
};

function App() {
  const { data, reload } = usePageData();
  const [prompt, setPrompt] = useState(null);
  const [editor, setEditor] = useState(false);
  const [cards, setCards] = useState(0);
  return (
    <Page data={data} reload={reload} action={<PostButton title="Run now" path="/api/run" />}>
      <section>
        <BusyButton id="busy" className="mine" onClick={() => post('/api/busy', {})}>Busy</BusyButton>
        <PostButton title="Post" path="/api/post" data={{ 'data-test': 'post' }} />
        <PostButton title="Confirmed" path="/api/confirmed" confirm="Sure?" data={{ 'data-test': 'confirm' }} />
        <Button title="Ask" data={{ 'data-test': 'ask' }} onPress={async () => { if (await confirmDialog('Go on?')) await post('/api/asked', {}); }} />
        <button id="raw" type="button" onClick={() => void post('/api/raw', {}).catch(() => {})}>Raw</button>
        <BusyButton id="sign-in" onClick={() => new Promise((done) => setPrompt(() => done)).then(() => post('/api/signed-in', {}))}>Sign in</BusyButton>
        <button id="open-editor" type="button" onClick={() => setEditor(true)}>Edit</button>
        <input id="field" />
        <a id="link" href="#/elsewhere">Elsewhere</a>
        <Card id="card" onPress={() => setCards((n) => n + 1)}><span id="cards">{cards}</span></Card>
        <BusyArea className="nested-area"><Button title="Nested" data={{ 'data-test': 'nested' }} onPress={() => post('/api/nested', {})} /></BusyArea>
      </section>
      {prompt && (
        <ModalCard visible onClose={() => setPrompt(null)} label="Sign in">
          <button id="prompt-ok" type="button" data-autofocus="" onClick={() => { prompt(); setPrompt(null); }}>Signed in</button>
        </ModalCard>
      )}
      <ModalCard visible={editor} onClose={() => setEditor(false)} label="Editor">
        <input id="editor-field" />
        <Button title="Save" data={{ 'data-test': 'editor-save' }} onPress={() => post('/api/editor', {}).then(() => setEditor(false))} />
      </ModalCard>
    </Page>
  );
}
mount(<App />);

const area = (sel) => document.querySelector(sel).closest('fieldset.ui-page-area');
window.kitTest = {
  pending: () => pending.map((p) => p.method + ' ' + p.path),
  answer: (path, status, body) => take(path).resolve(reply(status, body)),
  answerPage: (path, html) => take(path).resolve(reply(200, html, 'text/html')),
  fail: (path) => take(path).reject(new TypeError('Failed to fetch')),
  sentWith: (path) => (pending.find((p) => p.path === path) || {}).headers,
  deferGets: (on) => { deferGets = on; },
  press: (sel) => { const el = document.querySelector(sel); el.focus(); el.click(); },
  type: (sel, text) => { const el = document.querySelector(sel); el.focus(); el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); },
  post, pageWait, pageHeld,
  state: (sel) => {
    const main = area('main.view');
    const b = sel ? document.querySelector(sel) : null;
    return {
      held: main.disabled,
      ariaBusy: main.getAttribute('aria-busy'),
      actionHeld: area('.titlebar-action').disabled,
      display: getComputedStyle(main).display,
      exists: !!b,
      spins: !!b && (!!b.querySelector('.ui-spinner') || (b.hasAttribute('data-ui-busy') && getComputedStyle(b, '::before').content !== 'none')),
      disabled: !!b && b.matches(':disabled'),
      focused: !!b && document.activeElement === b,
      field: document.querySelector('#field').matches(':disabled'),
      theme: document.querySelector('#theme-btn').disabled,
      dialog: !!document.querySelector('.ui-dialog'),
      hash: location.hash,
      cards: document.querySelector('#cards').textContent,
    };
  },
  until: (look, ms = 5000) => new Promise((ok, no) => {
    const end = performance.now() + ms;
    const again = () => {
      let v;
      try { v = look(); } catch (e) { return no(e); }
      if (v) return ok(v);
      if (performance.now() > end) return no(new Error('timed out waiting for ' + look));
      setTimeout(again, 10);
    };
    again();
  }),
};
`;

type State = { held: boolean; ariaBusy: string | null; actionHeld: boolean; display: string; exists: boolean; spins: boolean; disabled: boolean; focused: boolean; field: boolean; theme: boolean; dialog: boolean; hash: string; cards: string };

let server: http.Server | undefined;
let tab: Tab | undefined;
const t = () => tab!;
const state = (sel = '') => t().run<State>(`kitTest.state(${JSON.stringify(sel)})`);
/** Waits in the page until `cond` (an expression over `s`, the state of `sel`) holds; then that state. */
const until = (sel: string, cond: string, ms = 5000) => t().run<State>(`kitTest.until(() => { const s = kitTest.state(${JSON.stringify(sel)}); return (${cond}) && s; }, ${ms})`);
const waits = (what: string, ms = 5000) => t().run(`kitTest.until(() => kitTest.pending().includes(${JSON.stringify(what)}), ${ms})`);
const run = <T = unknown>(js: string) => t().run<T>(js);
/** Focus back on what was pressed: a frame or two after the page lets go, once the button is drawn enabled again. */
const focusBack = (sel: string) =>
  until(sel, 's.focused', 2000).catch(async (e: Error) => {
    throw new Error(`${e.message}; focus is on ${await run(`document.activeElement.outerHTML.slice(0, 120)`)}`);
  });

before(async () => {
  if (!browser) return;
  const esbuild = await loadEsbuild(STEWARD);
  if ('error' in esbuild) throw new Error(esbuild.error);
  const built = await esbuild.build({ stdin: { contents: PAGE, resolveDir: STEWARD, loader: 'tsx', sourcefile: 'busy-page.tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const js = built.outputFiles![0].text;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="page-token" content="${TOKEN}"><title>Tester</title></head><body><div id="root"></div><script type="application/json" id="page-data">${JSON.stringify({ shell, body: {} })}</script><script type="module" src="/page.js"></script></body></html>`;
  server = http.createServer((req, res) => {
    const page = req.url === '/page.js';
    res.writeHead(200, { 'content-type': page ? 'text/javascript' : 'text/html' });
    res.end(page ? js : html);
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  tab = await openTab(browser, `http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
});

after(async () => {
  await tab?.close();
  server?.close();
});

test('the page lays out as it did (its areas have no box of their own), and polling never holds it', { skip }, async () => {
  let s = await state();
  assert.equal(s.display, 'contents');
  assert.equal(s.held, false);
  await run('kitTest.deferGets(true)');
  await waits('GET /api/page', 5000);
  s = await state();
  assert.equal(s.held, false, 'a look for news while it is out: the page goes on');
  assert.equal(s.field, false);
  await run(`kitTest.deferGets(false); for (const p of kitTest.pending()) kitTest.answer(p.split(' ')[1], 200, ${JSON.stringify({ shell, body: {} })})`);
});

test('BusyButton: the whole page waits, the button spins; the title bar\'s Theme does not; focus comes back', { skip }, async () => {
  await run(`kitTest.press('#busy')`);
  await waits('POST /api/busy');
  let s = await until('#busy', 's.held');
  assert.equal(s.ariaBusy, 'true');
  assert.equal(s.actionHeld, true, "the title bar's Run now waits too");
  assert.equal(s.spins, true);
  assert.equal(s.disabled, true);
  assert.equal(s.field, true, 'every control on the page');
  assert.equal(s.theme, false, "the title bar's Theme is not an action");
  await run(`kitTest.answer('/api/busy', 200, {})`);
  s = await until('#busy', '!s.held && !s.spins');
  assert.equal(s.ariaBusy, null);
  assert.equal(s.actionHeld, false);
  assert.equal(s.field, false);
  await focusBack('#busy');
});

test('PostButton: the page waits while it posts and looks for news, then says a failure in its own dialog', { skip }, async () => {
  await run(`kitTest.press('[data-test=post]')`);
  await waits('POST /api/post');
  let s = await until('[data-test=post]', 's.held && s.spins');
  await run(`kitTest.answer('/api/post', 200, {})`);
  s = await until('[data-test=post]', '!s.held && !s.spins');
  await focusBack('[data-test=post]');

  await run(`kitTest.press('[data-test=post]')`);
  await waits('POST /api/post');
  await until('[data-test=post]', 's.held');
  await run(`kitTest.answer('/api/post', 500, { error: 'It broke' })`);
  s = await until('[data-test=post]', '!s.held && s.dialog');
  assert.match(await run<string>(`document.querySelector('.ui-dialog').textContent`), /It broke/);
  await run(`document.querySelector('.ui-dialog button').click()`);
  s = await until('[data-test=post]', '!s.dialog');
  assert.equal(s.held, false);
});

test("a page's own <button> that awaits post(): the page waits and it spins, then comes back on success, failure, refusal and timeout", { skip }, async () => {
  const press = async () => {
    await run(`kitTest.press('#raw')`);
    await waits('POST /api/raw');
    const s = await until('#raw', 's.held');
    assert.equal(s.spins, true, 'the button pressed spins: the ring before its words');
    assert.equal(s.disabled, true);
    assert.equal(s.ariaBusy, 'true');
    return s;
  };
  const back = async () => {
    const s = await until('#raw', '!s.held && !s.spins');
    await focusBack('#raw');
    assert.equal(s.field, false);
  };

  await press();
  await run(`kitTest.answer('/api/raw', 200, {})`);
  await back();

  await press();
  await run(`kitTest.answer('/api/raw', 500, { error: 'no' })`);
  await back();

  await press();
  await run(`kitTest.fail('/api/raw')`);
  await back();

  // Refused for its token (its agent restarted): the new token read from the page and the POST sent again, all one wait.
  await press();
  await run(`kitTest.answer('/api/raw', 403, { error: 'forbidden' })`);
  await waits('GET /');
  assert.equal((await state('#raw')).held, true, 'still waiting while the new token is read');
  await run(`kitTest.answerPage('/', '<meta name="page-token" content="${NEW_TOKEN}">')`);
  await waits('POST /api/raw');
  assert.equal((await run<Record<string, string>>(`kitTest.sentWith('/api/raw')`))['x-token'], NEW_TOKEN);
  assert.equal((await state('#raw')).held, true, 'and while it is sent again');
  await run(`kitTest.answer('/api/raw', 200, {})`);
  await back();

  // No answer: the page lets go after its longest wait, while the button still spins for the request.
  await run('kitTest.pageWait(1500)');
  try {
    await press();
    let s = await until('#raw', '!s.held');
    assert.equal(s.spins, true, 'its request is still out');
    assert.equal(s.field, false);
    await run(`kitTest.answer('/api/raw', 200, {})`);
    s = await until('#raw', '!s.spins');
  } finally {
    await run('kitTest.pageWait(0)');
  }
});

test('a post() no press started (an auto-save as someone types) never holds the page', { skip }, async () => {
  await run(`kitTest.type('#field', 'abc')`);
  await run(`void kitTest.post('/api/auto', {})`);
  await waits('POST /api/auto');
  const s = await state('#field');
  assert.equal(s.held, false);
  assert.equal(s.field, false, 'the field typed in stays usable');
  assert.equal(s.focused, true);
  await run(`kitTest.answer('/api/auto', 200, {})`);
});

test('a dialog the action opens can be answered while the page waits; one open before the action waits with it', { skip }, async () => {
  // Asked inside the work (a Button whose onPress asks, then posts): the confirm is usable, the post holds the page.
  await run(`kitTest.press('[data-test=ask]')`);
  let s = await until('[data-test=ask]', 's.dialog && !s.held');
  assert.equal(s.held, false, 'the question the work asks is answerable');
  assert.equal(await run(`document.querySelector('.ui-dialog button').disabled`), false);
  await run(`document.querySelector('.ui-dialog button').click()`);
  await waits('POST /api/asked');
  s = await until('[data-test=ask]', 's.held');
  assert.equal(s.spins, true);
  await run(`kitTest.answer('/api/asked', 200, {})`);
  await until('[data-test=ask]', '!s.held && !s.spins');

  // PostButton's own confirm, then its POST.
  await run(`kitTest.press('[data-test=confirm]')`);
  await until('[data-test=confirm]', 's.dialog && !s.held');
  await run(`document.querySelector('.ui-dialog button').click()`);
  await waits('POST /api/confirmed');
  s = await until('[data-test=confirm]', 's.held && s.spins');
  await run(`kitTest.answer('/api/confirmed', 200, {})`);
  s = await until('[data-test=confirm]', '!s.held && !s.spins');
  await focusBack('[data-test=confirm]');

  // A dialog of the page's own, opened by the work while it runs (a sign-in it needs): inside the page, and usable.
  await run(`kitTest.press('#sign-in')`);
  s = await until('#prompt-ok', 's.exists && !s.held');
  assert.equal(s.held, false);
  assert.equal(s.disabled, false, "the dialog's button takes presses");
  assert.equal(s.focused, true, 'focus moved into it');
  await run(`kitTest.press('#prompt-ok')`);
  await waits('POST /api/signed-in');
  s = await until('#sign-in', 's.held && s.spins');
  await run(`kitTest.answer('/api/signed-in', 200, {})`);
  await until('#sign-in', '!s.held && !s.spins');

  // A dialog open before the work, the work started in it: it waits with the page.
  await run(`kitTest.press('#open-editor')`);
  await until('#editor-field', 's.exists');
  await run(`kitTest.press('[data-test=editor-save]')`);
  await waits('POST /api/editor');
  s = await until('[data-test=editor-save]', 's.held');
  assert.equal(s.spins, true);
  assert.equal((await state('#editor-field')).disabled, true, "the dialog's field waits too");
  await run(`kitTest.answer('/api/editor', 200, {})`);
  s = await until('#editor-field', '!s.held && !s.exists');
});

test("a BusyArea in the page still works; links and pressable cards wait with the page; the title bar's way out doesn't", { skip }, async () => {
  await run(`kitTest.press('[data-test=nested]')`);
  await waits('POST /api/nested');
  let s = await until('[data-test=nested]', 's.held && s.spins');
  assert.equal(await run(`document.querySelector('.nested-area').disabled && document.querySelector('.nested-area').getAttribute('aria-busy')`), 'true');
  await run(`document.querySelector('#link').click(); document.querySelector('#card').click()`);
  s = await state();
  assert.equal(s.hash, '', "a link in the page doesn't go while it waits");
  assert.equal(s.cards, '0', "nor a pressable card's press");
  await run(`document.querySelector('#settings-link').click()`);
  s = await until('', `s.hash === '#/settings'`);
  assert.equal(s.held, true, 'Settings opens; the page still waits');
  await run(`location.hash = '#/'`);
  await run(`kitTest.answer('/api/nested', 200, {})`);
  s = await until('[data-test=nested]', '!s.held && !s.spins');
  assert.equal(await run(`document.querySelector('.nested-area').disabled`), false);
  await run(`document.querySelector('#card').click()`);
  assert.equal((await state()).cards, '1', 'and presses again once it is done');
});
