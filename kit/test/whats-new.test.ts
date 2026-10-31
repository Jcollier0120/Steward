import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { freePort } from './free-port.ts';

// What's new on About (whats-new.ts, kit 2.143.0): the record of each version the agent started at, the entries chosen
// from it, the changelog a release carries, and the section the page draws. A copy runs on its own port and data folder.
const id: string = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8')).name;
const ENV = id.toUpperCase().replace(/-/g, '_');
const home = mkdtempSync(path.join(os.tmpdir(), `${id}-whats-new-test-`));
process.env[`${ENV}_HOME`] = path.join(home, 'data');
process.env[`${ENV}_PORT`] = String(await freePort());
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'no-manor');
process.env.REEVE_HOME = path.join(home, 'reeve');
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.STEWARD_ESBUILD = STEWARD;
after(() => rmSync(home, { recursive: true, force: true }));

const { APP, port } = await import('./fixture/src/app.ts');
const W = await import('./fixture/src/kit/whats-new.ts');
const { entriesOf, releaseChangelog, RELEASE_ENTRIES } = await import('./fixture/src/kit/notes.ts');
const { serve } = await import('./fixture/src/kit/server.ts');
const { pageShell } = await import('./fixture/src/kit/react-page.ts');
const { bundleForNode, importPath } = await import('./react-render.ts');

const DAY = 86_400_000;
const NOW = new Date('2026-10-27T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

/** A changelog with an entry for each version, newest first, as spec/RELEASE-NOTES.md has them. */
const changelog = (versions: string[]) =>
  [
    "# Fixture's changelog",
    '',
    'Each version of Fixture, newest first.',
    '',
    ...versions.flatMap((v) => [`## ${v}`, '', `**What ${v} is about.**`, '', '### What changed', '', `- A point of ${v}.`, '', '### Before you update', '', '- Nothing: it updates itself as usual.', '']),
  ].join('\n');
/** 0.4.1 to 0.4.<n>, newest first. */
const line = (n: number) => Array.from({ length: n }, (_, i) => `0.4.${n - i}`);
const shown = (list: { version: string }[]) => list.map((x) => x.version);

let files = 0;
const recordFile = () => path.join(home, 'records', `versions-${++files}.json`);
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

test('the record: each version first started at, oldest first, written only when the version changed', () => {
  const file = recordFile();
  const none = () => null;
  assert.deepEqual(W.noteVersion({ file, version: '0.4.28', now: new Date(ago(10)), before: none }), [{ version: '0.4.28', since: ago(10) }]);
  assert.deepEqual(read(file), { versions: [{ version: '0.4.28', since: ago(10) }] }, 'versions.json as written');
  const was = readFileSync(file, 'utf8');
  W.noteVersion({ file, version: '0.4.28', now: NOW, before: none });
  assert.equal(readFileSync(file, 'utf8'), was, 'started again at the same version: as it was, its date the first start');
  W.noteVersion({ file, version: '0.4.31', now: NOW, before: none });
  assert.deepEqual(read(file).versions, [{ version: '0.4.28', since: ago(10) }, { version: '0.4.31', since: NOW.toISOString() }]);
  // A step back is a start at that version too.
  W.noteVersion({ file, version: '0.4.30', now: NOW, before: none });
  assert.deepEqual(shown(read(file).versions), ['0.4.28', '0.4.31', '0.4.30']);

  // At most MAX_KEPT: the oldest go.
  const many = recordFile();
  for (const v of line(40).reverse()) W.noteVersion({ file: many, version: v, now: NOW, before: none });
  const kept = read(many).versions;
  assert.equal(kept.length, W.MAX_KEPT);
  assert.equal(kept.at(-1).version, '0.4.40');
  assert.equal(kept[0].version, `0.4.${40 - W.MAX_KEPT + 1}`);
});

test("a record started from nothing begins with app.prev's version, when older: its date isn't known", () => {
  let asked = 0;
  const prev = (v: string | null) => () => (asked++, v);
  const file = recordFile();
  assert.deepEqual(W.noteVersion({ file, version: '0.4.31', now: NOW, before: prev('0.4.28') }), [{ version: '0.4.28', since: null }, { version: '0.4.31', since: NOW.toISOString() }]);
  W.noteVersion({ file, version: '0.4.32', now: NOW, before: prev('0.4.31') });
  assert.equal(asked, 1, 'asked only when there is no record');
  assert.deepEqual(shown(W.noteVersion({ file: recordFile(), version: '0.4.31', now: NOW, before: prev('0.4.33') })), ['0.4.31'], 'a newer one is no version before');
  assert.deepEqual(shown(W.noteVersion({ file: recordFile(), version: '0.4.31', now: NOW, before: prev(null) })), ['0.4.31']);
});

test('an odd record is read for what it holds, or started again; one that cannot be written never stops the page', () => {
  const file = recordFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'not json');
  assert.deepEqual(W.readVersions(file), []);
  writeFileSync(file, JSON.stringify({ versions: [{ version: 5 }, 'x', null, { version: '1.2.3', since: 'never' }, { version: '1.2.4', since: ago(1) }] }));
  assert.deepEqual(W.readVersions(file), [{ version: '1.2.3', since: null }, { version: '1.2.4', since: ago(1) }]);
  writeFileSync(file, JSON.stringify([1, 2]));
  assert.deepEqual(W.readVersions(file), []);
  assert.deepEqual(W.readVersions(path.join(home, 'missing.json')), []);
  // Its place is a folder: nothing is written, and the page starts all the same.
  const folder = recordFile();
  mkdirSync(folder, { recursive: true });
  assert.deepEqual(W.noteVersion({ file: folder, version: '0.4.31', now: NOW, before: () => null }), [{ version: '0.4.31', since: null }]);
});

test("About shows the versions since the one before the latest update, and those of the last 30 days' updates, newest first", () => {
  const entries = entriesOf(changelog(line(31)));
  const rec = (...r: [string, string | null][]) => r.map(([version, since]) => ({ version, since }));
  // Updated from 0.4.28 to 0.4.31 two months ago: those three, however old the update; 0.4.28's own was seen before.
  const latest = W.chooseVersions(entries, rec(['0.4.20', ago(90)], ['0.4.28', ago(70)], ['0.4.31', ago(60)]), '0.4.31', NOW);
  assert.deepEqual(shown(latest), ['0.4.31', '0.4.30', '0.4.29']);
  assert.deepEqual(latest.map((x) => x.since), [ago(60), null, null], 'the day it started at a version; none for one passed through');
  assert.match(latest[0].entry, /^\*\*What 0\.4\.31 is about\.\*\*\n\n### What changed\n\n- A point of 0\.4\.31\.\n\n### Before you update/);

  // And the other updates of the last 30 days: to 0.4.27 (20 days ago, from 0.4.25) and to 0.4.29 (10 days ago), not
  // the one to 0.4.25 (40 days ago). They brought 0.4.26 to 0.4.31: the newest 5 are shown, and 0.4.26 is left out.
  const month = rec(['0.4.20', ago(90)], ['0.4.25', ago(40)], ['0.4.27', ago(20)], ['0.4.29', ago(10)], ['0.4.31', ago(1)]);
  assert.deepEqual(shown(W.chooseVersions(entries, month, '0.4.31', NOW)), ['0.4.31', '0.4.30', '0.4.29', '0.4.28', '0.4.27']);
  assert.equal(W.chooseWhatsNew(entries, month, '0.4.31', NOW).older, 1);
  // All of them within the 30 days: from 0.4.20 on, but at most MAX_SHOWN.
  const busy = rec(['0.4.20', ago(29)], ['0.4.25', ago(20)], ['0.4.31', ago(1)]);
  assert.deepEqual(shown(W.chooseVersions(entries, busy, '0.4.31', NOW)), line(31).slice(0, W.MAX_SHOWN));
  // From app.prev's version, with no date: since it.
  assert.deepEqual(shown(W.chooseVersions(entries, rec(['0.4.29', null], ['0.4.31', NOW.toISOString()]), '0.4.31', NOW)), ['0.4.31', '0.4.30']);
  // Gone back and forth within the month: from the lowest it came from.
  const back = rec(['0.4.26', ago(50)], ['0.4.30', ago(9)], ['0.4.27', ago(8)], ['0.4.29', ago(2)]);
  assert.deepEqual(shown(W.chooseVersions(entries, back, '0.4.29', NOW)), ['0.4.29', '0.4.28', '0.4.27']);
  // A version with no entry is passed over; one newer than the version running (a checkout's next) isn't its news.
  const gaps = entriesOf(changelog(['0.4.33', '0.4.31', '0.4.29', '0.4.28']));
  assert.deepEqual(shown(W.chooseVersions(gaps, rec(['0.4.28', ago(40)], ['0.4.31', ago(1)]), '0.4.31', NOW)), ['0.4.31', '0.4.29']);
});

test('About carries only the newest 5 versions, and says how many older ones the same updates brought', () => {
  assert.equal(W.MAX_SHOWN, 5);
  const entries = entriesOf(changelog(line(31)));
  const rec = (...r: [string, string | null][]) => r.map(([version, since]) => ({ version, since }));
  // Updated from 0.4.23 to 0.4.31 today, as Watchman was from 0.2.1 to 0.3.5: 8 versions came, the newest 5 go to the
  // page, each whole, and the 3 older are only counted.
  const eight = W.chooseWhatsNew(entries, rec(['0.4.23', ago(40)], ['0.4.31', ago(0)]), '0.4.31', NOW);
  assert.deepEqual(shown(eight.versions), ['0.4.31', '0.4.30', '0.4.29', '0.4.28', '0.4.27']);
  assert.equal(eight.older, 3);
  assert.deepEqual(eight.versions.map((x) => x.since), [ago(0), null, null, null, null]);
  assert.match(eight.versions[4].entry, /^\*\*What 0\.4\.27 is about\.\*\*/);
  assert.doesNotMatch(JSON.stringify(eight), /0\.4\.2[4-6]/, "the left-out versions' entries aren't carried at all");
  // Exactly 5, or fewer: all of them, nothing left out.
  assert.deepEqual(W.chooseWhatsNew(entries, rec(['0.4.26', ago(40)], ['0.4.31', ago(0)]), '0.4.31', NOW).older, 0);
  assert.equal(W.chooseWhatsNew(entries, rec(['0.4.26', ago(40)], ['0.4.31', ago(0)]), '0.4.31', NOW).versions.length, 5);
  assert.deepEqual(W.chooseWhatsNew(entries, rec(['0.4.29', ago(40)], ['0.4.31', ago(0)]), '0.4.31', NOW), {
    versions: [
      { version: '0.4.31', since: ago(0), entry: entries[0].entry },
      { version: '0.4.30', since: null, entry: entries[1].entry },
    ],
    older: 0,
  });
  // Only a version's own entry: nothing older to count. No changelog: nothing at all.
  assert.deepEqual(W.chooseWhatsNew(entries, rec(['0.4.31', ago(1)]), '0.4.31', NOW).older, 0);
  assert.deepEqual(W.chooseWhatsNew([], rec(['0.4.20', ago(9)], ['0.4.31', ago(1)]), '0.4.31', NOW), { versions: [], older: 0 });
  // A version with no entry isn't counted among the older either.
  const gaps = entriesOf(changelog(['0.4.31', '0.4.30', '0.4.29', '0.4.28', '0.4.27', '0.4.25', '0.4.21']));
  assert.equal(W.chooseWhatsNew(gaps, rec(['0.4.20', ago(40)], ['0.4.31', ago(1)]), '0.4.31', NOW).older, 2);
});

test("a fresh install, a step back, or a record that doesn't end at the version running: that version's own entry", () => {
  const entries = entriesOf(changelog(line(31)));
  const rec = (...r: [string, string | null][]) => r.map(([version, since]) => ({ version, since }));
  assert.deepEqual(shown(W.chooseVersions(entries, rec(['0.4.31', ago(1)]), '0.4.31', NOW)), ['0.4.31'], 'a fresh install');
  assert.deepEqual(shown(W.chooseVersions(entries, [], '0.4.31', NOW)), ['0.4.31'], 'no record');
  assert.deepEqual(shown(W.chooseVersions(entries, rec(['0.4.31', ago(9)], ['0.4.30', ago(1)]), '0.4.30', NOW)), ['0.4.30'], 'a step back');
  assert.deepEqual(shown(W.chooseVersions(entries, rec(['0.4.20', ago(9)], ['0.4.29', ago(1)]), '0.4.31', NOW)), ['0.4.31'], 'a record that never got this version');
  assert.deepEqual(W.chooseVersions(entries, rec(['0.5.0', ago(1)]), '0.5.0', NOW), [], 'no entry for it: nothing');
  assert.deepEqual(shown(W.chooseVersions(entries, rec(['0.4.29', ago(9)], ['0.5.0', ago(1)]), '0.5.0', NOW)), ['0.4.31', '0.4.30'], "none for it, but for those it brought: theirs");
  assert.deepEqual(W.chooseVersions([], rec(['0.4.20', ago(9)], ['0.4.31', ago(1)]), '0.4.31', NOW), [], 'no changelog');
});

test('entriesOf reads every entry in one pass; a release carries the opening and the newest 20', () => {
  const text = `${changelog(['0.4.3', '0.4.2'])}\n## Not a version\n\nwords\n\n## 0.4.1\n\n## 0.4.2\n\nagain\n`;
  assert.deepEqual(shown(entriesOf(text)), ['0.4.3', '0.4.2'], 'a heading with no version, or nothing under it, gives none; a version twice, its first');
  assert.deepEqual(shown(entriesOf(text.replace(/\n/g, '\r\n'))), ['0.4.3', '0.4.2']);

  const whole = changelog(line(50));
  const carried = releaseChangelog(whole);
  assert.equal(RELEASE_ENTRIES, 20);
  assert.ok(RELEASE_ENTRIES > W.MAX_SHOWN, 'more than About shows, so it can count the older versions it leaves out');
  assert.deepEqual(shown(entriesOf(carried)), line(50).slice(0, RELEASE_ENTRIES));
  assert.ok(carried.startsWith("# Fixture's changelog\n\nEach version of Fixture, newest first.\n\n## 0.4.50\n"), 'its opening, then the newest');
  assert.equal(entriesOf(carried)[RELEASE_ENTRIES - 1].entry, entriesOf(whole)[RELEASE_ENTRIES - 1].entry, 'the last kept whole');
  const short = changelog(line(5));
  assert.equal(releaseChangelog(short), short, 'one with fewer: as it is');
});

test('serve() notes the version as the page starts, and /api/whats-new answers with nothing to show without a changelog', async () => {
  const { close } = await serve({ port, icon: '<svg/>' });
  try {
    const record = read(path.join(process.env[`${ENV}_HOME`]!, W.VERSIONS_FILE));
    assert.deepEqual(shown(record.versions), [APP.version]);
    const r = await fetch(`http://127.0.0.1:${port}/api/whats-new`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { versions: [], older: 0 }, "the fixture has no CHANGELOG.md: nothing, and no error");
    assert.deepEqual(W.whatsNewAnswer(), { versions: [], older: 0 }, 'what the route answers');
    assert.deepEqual(W.whatsNew(), []);
    assert.equal(pageShell().whatsNew, false, 'nor a What\'s new for About');
  } finally {
    await close();
  }
});

/** The section and the frame, rendered as the page draws them. */
const { list, page, versionsOf, olderOf } = await bundleForNode<{
  list: (v: unknown[], older?: number) => string;
  page: (d: unknown) => string;
  versionsOf: (j: unknown) => unknown[];
  olderOf: (j: unknown) => number;
}>(
  `import { renderToStaticMarkup } from 'react-dom/server';
   import { WhatsNewList, versionsOf, olderOf } from '${importPath(path.join(STEWARD, 'kit/react/whats-new.tsx'))}';
   import { Page } from '${importPath(path.join(STEWARD, 'kit/react/index.ts'))}';
   export { versionsOf, olderOf };
   export const list = (versions, older) => renderToStaticMarkup(<WhatsNewList versions={versions} name="Fixture" older={older} />);
   export const page = (data) => renderToStaticMarkup(<Page data={data} reload={() => {}}><p>page</p></Page>);`,
  { location: { hash: '' }, document: { documentElement: { dataset: {} } } },
);

test("the section: each version under its own, newest open and the older folded, drawn as text, never as HTML", () => {
  const entry = (v: string) => `**What ${v} is about.**\nOn two lines.\n\n### What's new\n\n- A **bold** point with \`code\`,\n  and more of it.\n- See [the notes](https://example.com/x) <script>alert(1)</script>\n\n### Before you update\n\n- Nothing: it updates itself as usual.`;
  const html = list([
    { version: '0.4.31', since: '2026-10-25T10:00:00Z', entry: entry('0.4.31') },
    { version: '0.4.30', since: null, entry: entry('0.4.30') },
    { version: '0.4.29', since: null, entry: entry('0.4.29') },
  ]);
  assert.match(html, /^<section class="whats-new" aria-labelledby="whats-new-title"><h3 id="whats-new-title">What&#x27;s new<\/h3><p class="muted whats-new-note">3 versions came with Fixture&#x27;s latest updates, newest first\.<\/p>/);
  assert.equal(html.match(/<details class="release-entry"/g)?.length, 3);
  assert.equal(html.match(/<details class="release-entry" open="">/g)?.length, 1, 'only the newest open');
  assert.match(html, /<details class="release-entry" open=""><summary><span class="release-version">Version 0\.4\.31<\/span><span class="muted release-when"> · updated [^<]+<\/span><\/summary>/);
  assert.match(html, /<summary><span class="release-version">Version 0\.4\.30<\/span><\/summary>/, 'passed through: no day');
  assert.match(html, /<p><strong>What 0\.4\.31 is about\.<\/strong> On two lines\.<\/p><h4>What&#x27;s new<\/h4><ul><li>A <strong>bold<\/strong> point with <code>code<\/code>, and more of it\.<\/li><li>See the notes &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/li><\/ul><h4>Before you update<\/h4>/);
  assert.doesNotMatch(html, /<script|<a /, 'no markup of its own, no link');

  const one = list([{ version: '0.4.31', since: null, entry: entry('0.4.31') }]);
  assert.match(one, /^<section class="whats-new" aria-labelledby="whats-new-title"><h3 id="whats-new-title">What&#x27;s new<\/h3><div class="release-entry"><p class="release-head"><span class="release-version">Version 0\.4\.31<\/span><\/p><p><strong>/);
  assert.doesNotMatch(one, /<details|whats-new-note/, 'one version: nothing folded, nothing to say about it');
  assert.equal(list([]), '');
  for (const word of [/\bagents?\b/i]) assert.doesNotMatch(html + one, word, 'the staff, in the page\'s words');

  assert.deepEqual(versionsOf({ versions: [{ version: '1.2.3', since: 5, entry: 'x' }, { version: '1.2.4', entry: ' ' }, null, { version: 1, entry: 'y' }] }), [{ version: '1.2.3', since: null, entry: 'x' }]);
  assert.deepEqual(versionsOf({ error: 'not found' }), []);
  assert.deepEqual(versionsOf(null), []);
});

test('the section says when older versions are left out: the count line names the newest it shows, and a line under them how many more', () => {
  const v = (n: number) => ({ version: `0.3.${n}`, since: null, entry: `**What 0.3.${n} is about.**` });
  const five = [5, 4, 3, 2, 1].map(v);
  const html = list(five, 3);
  assert.match(html, /<h3 id="whats-new-title">What&#x27;s new<\/h3><p class="muted whats-new-note">The newest 5 versions that came with Fixture&#x27;s latest updates, newest first\.<\/p>/);
  assert.equal(html.match(/<details class="release-entry"/g)?.length, 5);
  assert.match(html, /<\/details><p class="muted whats-new-note whats-new-older">3 older versions aren&#x27;t shown here\.<\/p><\/section>$/, 'under the versions, last');
  assert.match(list(five, 1), /<p class="muted whats-new-note whats-new-older">1 older version isn&#x27;t shown here\.<\/p><\/section>$/);
  // Nothing left out (0, or from an older page server, no count at all): as before, and no line under them.
  for (const none of [list(five, 0), list(five)]) {
    assert.match(none, /<p class="muted whats-new-note">5 versions came with Fixture&#x27;s latest updates, newest first\.<\/p>/);
    assert.doesNotMatch(none, /whats-new-older|older version/);
  }
  // One version shown with older ones left out: its own card, and the line.
  assert.match(list([v(5)], 2), /<div class="release-entry">.*<\/div><p class="muted whats-new-note whats-new-older">2 older versions aren&#x27;t shown here\.<\/p><\/section>$/);
  assert.equal(list([], 3), '', 'no versions: no section');

  assert.equal(olderOf({ versions: [], older: 3 }), 3);
  for (const odd of [{ older: 0 }, { older: -2 }, { older: 1.5 }, { older: '3' }, {}, null, 'x']) assert.equal(olderOf(odd), 0, JSON.stringify(odd));
});

test("About is there whenever it has a What's new, with nothing else to say; the section waits for the page's ask", () => {
  const shell = pageShell();
  const bare = { ...shell, work: '' };
  assert.doesNotMatch(page({ shell: { ...bare, whatsNew: false }, body: {} }), /about-link|about-view/);
  assert.doesNotMatch(page({ shell: { ...bare, whatsNew: undefined }, body: {} }), /about-link|about-view/, 'from an older page server: as before');
  const html = page({ shell: { ...bare, whatsNew: true }, body: {} });
  assert.match(html, /id="about-link" href="#\/about"/);
  assert.match(html, /<section id="about-view"><a class="back-link" href="#\/">Back to [^<]+<\/a><h2>About [^<]+<\/h2><div data-tour="work"/, 'the section asks once About opens: nothing drawn before');
});
