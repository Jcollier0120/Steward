import assert from 'node:assert/strict';
import { test } from 'node:test';

// The page's vocabulary (html.ts), as an agent imports it: from page.ts. html.ts has no imports, so nothing is set up.
const html = await import('./fixture/src/kit/html.ts');
const page = await import('./fixture/src/kit/page.ts');

test('page.ts exports the vocabulary html.ts writes once', () => {
  for (const name of ['esc', 'badge', 'muted', 'card', 'postButton'] as const) assert.equal(page[name], html[name], `page.ts's ${name} is html.ts's`);
});

test('a badge: its colour, its text and its tooltip, escaped; no colour is a plain pill', () => {
  assert.equal(html.badge('ok', 'kit 2.20.0'), '<span class="badge ok">kit 2.20.0</span>');
  assert.equal(html.badge('', 'team'), '<span class="badge">team</span>');
  assert.equal(html.badge('alert', '<b>', 'say "no" & go'), '<span class="badge alert" title="say &quot;no&quot; &amp; go">&lt;b&gt;</span>');
});

test('muted text is escaped, in a span or a paragraph', () => {
  assert.equal(html.muted("Porter's <main>"), '<span class="muted">Porter&#39;s &lt;main&gt;</span>');
  assert.equal(html.muted('Nothing needs you.', 'p'), '<p class="muted">Nothing needs you.</p>');
});

test('a card holds markup as it is, with any classes after card', () => {
  assert.equal(html.card('<p>x</p>'), '<div class="card"><p>x</p></div>');
  assert.equal(html.card('Nothing yet.', 'empty'), '<div class="card empty">Nothing yet.</div>');
});

test("a POST button: the page script's attributes, in the order it reads them, each escaped", () => {
  assert.equal(html.postButton('Run now', '/api/run'), '<button data-post="/api/run">Run now</button>');
  assert.equal(
    html.postButton("Merge the team's PRs", '/api/stage/merge-team', { form: '#stage-form', confirm: 'Merge "all" of it?', disabled: true, title: 'No team' }),
    '<button data-post="/api/stage/merge-team" data-form="#stage-form" data-confirm="Merge &quot;all&quot; of it?" disabled title="No team">Merge the team&#39;s PRs</button>',
  );
  // data-body is JSON the script parses from the attribute, which the browser has unescaped.
  assert.equal(html.postButton('Back on duty', '/api/duty', { quiet: true, body: { onDuty: true } }), '<button class="quiet" data-post="/api/duty" data-body="{&quot;onDuty&quot;:true}">Back on duty</button>');
});
