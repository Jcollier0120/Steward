import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

// The kit's search (search.ts, kit 2.87.0): BM25 over the fields an agent names. The Clerk's tests (rolls: OCR text,
// caption and file name) and the Chamberlain's (documents and mail: text, sender and title, and its kind), each on the
// kit's index set up as that agent sets it up.
const { NAME_WEIGHT, SearchIndex, snippet, tokenize } = await import('./fixture/src/kit/search.ts');

// ---------------------------------------------------------------- the Clerk's rolls

interface Roll {
  path: string;
  text: string;
  caption?: string;
  mtimeMs: number;
}
const roll = (p: string, text: string, extra: Partial<Roll> = {}): Roll => ({ path: p, text, mtimeMs: 1_700_000_000_000, ...extra });
const nameOf = (p: string) => path.basename(p, path.extname(p));
const rolls = (list: Roll[]) =>
  new SearchIndex(list, {
    fields: [{ text: (r) => r.text }, { text: (r) => r.caption }, { text: (r) => nameOf(r.path), weight: NAME_WEIGHT }],
    passages: [
      { from: 'text', text: (r) => r.text },
      { from: 'caption', text: (r) => r.caption },
    ],
    newest: (r) => r.mtimeMs,
  });

test('BM25 ranks the screenshot with the rare word first, and finds codes inside words', () => {
  const idx = rolls([
    roll('C:\\shots\\a.png', 'Settings > Printers. The printer is ready. Print a test page.'),
    roll('C:\\shots\\b.png', 'Installer failed. Error 25006: the service could not start. Error details below.'),
    roll('C:\\shots\\c.png', 'Error 1603 during setup. Error error error. Contact support.'),
    roll('C:\\shots\\d.png', 'Exception 0x25006 in module host.dll'),
    roll('C:\\shots\\Screenshot router lights.png', 'nothing useful here'),
  ]);
  const hits = idx.search('error 25006');
  assert.equal(hits[0].doc.path, 'C:\\shots\\b.png', 'both words beat one word repeated');
  assert.ok(hits.some((h) => h.doc.path === 'C:\\shots\\d.png'), '"25006" finds "0x25006"');
  assert.ok(hits.findIndex((h) => h.doc.path.endsWith('c.png')) > 0, 'the common word alone still matches, lower');
  assert.deepEqual(idx.search('print').map((h) => h.doc.path), ['C:\\shots\\a.png'], '"print" finds "printer"');
  assert.equal(idx.search('router')[0].doc.path, 'C:\\shots\\Screenshot router lights.png', 'file names are searched');
  assert.deepEqual(idx.search('zebra'), []);
  assert.deepEqual(rolls([]).search('error'), []);
  assert.deepEqual(tokenize('Err0x25006 a OK'), ['err0x25006', 'err', '25006', 'ok']);
});

test('a caption makes a picture with no text findable, and its passage says it is the caption', () => {
  const idx = rolls([roll('C:\\shots\\p.png', '', { caption: 'A wifi router with blinking lights on a shelf.' }), roll('C:\\shots\\q.png', 'shelf life')]);
  const hits = idx.search('router lights');
  assert.equal(hits[0].doc.path, 'C:\\shots\\p.png');
  assert.match(hits[0].snippet, /<mark>router<\/mark>/);
  assert.equal(hits[0].from, 'caption', 'shown as the unverified caption, not as text read from the picture');
  assert.equal(rolls([roll('C:\\shots\\m.png', 'Living room', { caption: 'A router on a shelf.' })]).search('router')[0].from, 'caption');
  assert.equal(rolls([roll('C:\\shots\\m.png', 'router setup', { caption: 'A router.' })]).search('router')[0].from, 'text');
  assert.equal(rolls([roll('C:\\shots\\router.png', 'Living room')]).search('router')[0].from, 'text', 'no caption: the text, though only the name matched');
});

test('equal scores: the newest first', () => {
  const idx = rolls([roll('C:\\a.png', 'boiler', { mtimeMs: 1 }), roll('C:\\b.png', 'boiler', { mtimeMs: 3 }), roll('C:\\c.png', 'boiler', { mtimeMs: 2 })]);
  assert.deepEqual(idx.search('boiler').map((h) => h.doc.path), ['C:\\b.png', 'C:\\c.png', 'C:\\a.png']);
  const unordered = new SearchIndex([{ t: 'boiler' }, { t: 'boiler' }], { fields: [{ text: (d) => d.t }] });
  assert.deepEqual(unordered.search('boiler').map((h) => h.doc === unordered.docs[0]), [true, false], 'no time: in the records\' order');
  assert.equal(unordered.search('boiler')[0].from, 'text', 'the first field is the passage when none is named');
});

test('the snippet shows the passage with the query words, escaped and highlighted', () => {
  const long = `${'filler words '.repeat(60)}\nInstaller: Error 25006 <script>alert(1)</script> the service could not start\n${'more text '.repeat(60)}`;
  const s = snippet(long, ['25006', 'error', 'service']);
  assert.match(s.html, /<mark>Error<\/mark> <mark>25006<\/mark>/);
  assert.match(s.html, /<mark>service<\/mark>/);
  assert.ok(s.html.includes('&lt;script&gt;') && !s.html.includes('<script>'), 'escaped');
  assert.ok(s.html.startsWith('… ') && s.html.endsWith(' …'), 'cut from a long text, with ellipses');
  assert.ok(s.text.length <= 230);
  assert.match(snippet('line one\nline two', ['two']).html, /^line one · line <mark>two<\/mark>$/);
  assert.deepEqual(snippet('   ', ['x']), { html: '', text: '' });
});

test('search over a few thousand records answers in well under 200 ms', () => {
  const words = 'the a printer error code service install update window settings network driver failed open file save account user login'.split(' ');
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const list = Array.from({ length: 3000 }, (_, i) =>
    roll(`C:\\shots\\shot-${i}.png`, Array.from({ length: 180 }, () => (rnd() < 0.05 ? String(Math.floor(rnd() * 20000)) : words[Math.floor(rnd() * words.length)])).join(' ')),
  );
  list[1234].text += ' Error 25006 on install';
  const idx = rolls(list);
  // The search's own work: the processor time this process spends on it, the median of five.
  const cpuMs = (fn: () => void) => {
    const t0 = process.cpuUsage();
    fn();
    const t = process.cpuUsage(t0);
    return (t.user + t.system) / 1000;
  };
  for (const q of ['error 25006', 'printer driver failed', 'netw', 'install update settings user']) {
    let hits: ReturnType<typeof idx.search> = [];
    const runs = Array.from({ length: 5 }, () => cpuMs(() => (hits = idx.search(q, 50)))).sort((a, b) => a - b);
    assert.ok(runs[2] < 200, `"${q}" took ${runs[2].toFixed(1)} ms of processor time (runs: ${runs.map((ms) => ms.toFixed(1)).join(', ')})`);
    assert.ok(hits.length > 0);
  }
  assert.equal(idx.search('error 25006')[0].doc.path, 'C:\\shots\\shot-1234.png');
});

// ---------------------------------------------------------------- the Chamberlain's documents and mail

interface Item {
  kind: 'doc' | 'mail';
  title: string;
  text: string;
  at: number;
  from?: string;
  to?: string;
}
const doc = (p: string, text: string, at = 1_790_000_000_000): Item => ({ kind: 'doc', title: path.basename(p), text, at });
const msg = (subject: string, text: string, at = 1_790_000_000_000, from = 'Bob <bob@example.com>'): Item => ({ kind: 'mail', title: subject, text, at, from, to: 'me@example.com' });
const items = (list: Item[]) =>
  new SearchIndex(list, {
    fields: [{ text: (r) => r.text }, { text: (r) => `${r.from ?? ''} ${r.to ?? ''}` }, { text: (r) => r.title.replace(/.[a-z0-9]{1,5}$/i, ''), weight: NAME_WEIGHT }],
    newest: (r) => r.at,
  });
const kind = (k: 'all' | 'doc' | 'mail') => ({ filter: k === 'all' ? undefined : (i: Item) => i.kind === k });

test('search: documents and mail together or apart, the title and sender counting, snippets escaped', () => {
  const idx = items([
    doc('C:\\Docs\\boiler-quote.txt', 'The boiler service costs 185 pounds. <script>x</script>'),
    doc('C:\\Docs\\holiday.md', 'Flights to Lisbon on the 12th.'),
    msg('Boiler appointment', 'The engineer comes on Tuesday.', 1_790_000_100_000),
    msg('Lunch?', 'Shall we meet at noon', 1_790_000_200_000, 'Lisbon Travel <trips@example.com>'),
  ]);
  assert.deepEqual(idx.search('boiler').map((h) => h.doc.title).sort(), ['Boiler appointment', 'boiler-quote.txt']);
  assert.deepEqual(idx.search('boiler', 10, kind('mail')).map((h) => h.doc.kind), ['mail']);
  assert.deepEqual(idx.search('boiler', 10, kind('doc')).map((h) => h.doc.kind), ['doc']);
  assert.deepEqual(idx.search('lisbon').map((h) => h.doc.title), ['holiday.md', 'Lunch?'], "a message's sender is searched too");
  const s = idx.search('service')[0].snippet;
  assert.match(s, /<mark>service<\/mark>/);
  assert.ok(s.includes('&lt;script&gt;'));
});

test("a filter leaves records out of the answer, not out of how rare a word is; a passage's width is the caller's", () => {
  const list = [doc('C:\\a.txt', 'boiler boiler'), ...Array.from({ length: 5 }, (_, i) => msg(`m${i}`, 'boiler'))];
  const all = items(list).search('boiler');
  const docs = items(list).search('boiler', 10, kind('doc'));
  assert.equal(docs[0].score, all.find((h) => h.doc.kind === 'doc')!.score, 'the same score: idf over every record');
  const long = items([doc('C:\\long.txt', `${'word '.repeat(100)}boiler ${'word '.repeat(100)}`)]);
  assert.ok(long.search('boiler', 1, { width: 40 })[0].passage.length <= 40);
  assert.ok(long.search('boiler', 1)[0].passage.length > 150, '220 characters unless given');
});
