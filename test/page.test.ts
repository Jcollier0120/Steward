import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { freePort } from '../kit/test/free-port.ts';

// The Steward's page, on a port and data folder of its own, with no employees and gh standing in: it
// pings as Manor expects, renders, and starts a stage only for a POST with the page's token from its own
// origin.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-page-'));
process.env.STEWARD_HOME = home;
process.env.STEWARD_PORT = String(await freePort());
writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ employees: [], stewardRepo: 'octocat/steward' }));
// A Manor of its own, with Developer options on, as a developer's: the ping then says its pid (the kit's 2.40.0).
const manor = path.join(home, 'manor');
mkdirSync(path.join(manor, 'app'), { recursive: true });
writeFileSync(path.join(manor, 'settings.json'), JSON.stringify({ developerOptions: true }));
process.env.MANOR_HOME = manor;

const { APP, port } = await import('../src/app.ts');
const { serveSteward, askOf } = await import('../src/agent.ts');
const { runner } = await import('./helpers.ts');
const { bundleForNode, importPath } = await import('../kit/test/react-render.ts');

const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? { code: 0, out: JSON.stringify([{ tagName: 'kit-v1.0.0', isDraft: false }]), err: '' } : undefined));
let served: Awaited<ReturnType<typeof serveSteward>>;
/** While a test holds it, every command waits: a stage stays running until it lets go. */
let hold: Promise<void> = Promise.resolve();
before(async () => {
  served = await serveSteward({ run: async (cmd, args, opts) => (await hold, r.run(cmd, args, opts)) });
  await served.idle();
});
after(async () => {
  await served.idle();
  await served.close();
  rmSync(home, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${port}`;

/**
 * The page's body (src/web/steward.tsx) and its About as <Page> draws them (About in #about-view), or Run now, as HTML
 * from /api/page's body: what the browser draws.
 */
const renderStewardBody = async (name: 'StewardBody' | 'RunNow' = 'StewardBody') => {
  const m = await bundleForNode<{ render: (body: unknown) => string }>(
    name === 'RunNow'
      ? `import { renderToStaticMarkup } from 'react-dom/server';
     import { RunNow } from '${importPath('src/web/steward.tsx')}';
     export const render = (v) => renderToStaticMarkup(<RunNow v={v} />);`
      : `import { renderToStaticMarkup } from 'react-dom/server';
     import { StewardAbout, StewardBody } from '${importPath('src/web/steward.tsx')}';
     export const render = (v) => renderToStaticMarkup(<><StewardBody v={v} /><section id="about-view"><StewardAbout v={v} /></section></>);`,
  );
  return m.render;
};
/** The page and its About, split where <Page> splits them. */
const split = (html: string) => {
  const [page, about] = html.split('<section id="about-view">');
  return { page, about };
};
const post = (route: string, headers: Record<string, string>, body: unknown = { employees: [], kit: '1.0.0' }) =>
  fetch(`${base()}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('it pings as the Steward, on duty and idle', async () => {
  const ping = await (await fetch(`${base()}/api/ping`)).json();
  assert.equal(ping.app, APP.id);
  assert.equal(ping.name, 'Steward');
  assert.equal(ping.version, APP.version);
  assert.equal(ping.running, true);
  assert.equal(ping.busy, false);
  assert.equal(typeof ping.pid, 'number');
  assert.equal((await fetch(`${base()}/favicon.svg`)).headers.get('content-type'), 'image/svg+xml');
});

test("it pings busy while its build is open, between the build's rounds too: Manor puts no update in mid-build", async () => {
  const { pipelineFile } = await import('../src/pipeline.ts');
  await served.idle();
  const now = new Date().toISOString();
  writeFileSync(pipelineFile(), JSON.stringify({ open: { due: now, by: 'schedule', started: now, rounds: 1, merged: [], released: [], failed: [] }, builds: [] }));
  try {
    const ping = await (await fetch(`${base()}/api/ping`)).json();
    assert.deepEqual([ping.busy, ping.stage], [true, 'build']);
  } finally {
    rmSync(pipelineFile(), { force: true });
  }
  const idle = await (await fetch(`${base()}/api/ping`)).json();
  assert.deepEqual([idle.busy, idle.stage], [false, null], 'idle again once it closed');
});

test('the page is drawn in the browser: its shell carries the token, its first data and the bundle', async () => {
  const html = await (await fetch(`${base()}/`)).text();
  assert.match(html, /<meta name="page-token" content="[0-9a-f]{48}">/);
  assert.match(html, /<div id="root">/);
  assert.match(html, /<script type="module" src="\/page\.js"><\/script>/);
  const first = JSON.parse(html.match(/<script type="application\/json" id="page-data">([^<]*)<\/script>/)![1]);
  const page = await (await fetch(`${base()}/api/page`)).json();
  assert.equal(first.body.staff?.kit ?? null, page.body.staff?.kit ?? null, 'the first data is /api/page');
  assert.equal(page.shell.app.name, 'Steward');
  assert.equal(page.shell.pill.kind, 'on');
  const js = await fetch(`${base()}/page.js`);
  assert.equal(js.status, 200, 'a checkout builds its bundle');
  assert.match(js.headers.get('content-type') ?? '', /javascript/);
});

test('the page shows the kit, the stages, its rounds and Run now', async () => {
  const { body } = await (await fetch(`${base()}/api/page`)).json();
  const html = (await renderStewardBody())(body);
  // No repositories here: the kit is the one it keeps to run on, its rounds keep the staff's pages up, and no stages.
  assert.equal(body.round.repos, false);
  assert.match(html, /The kit the Steward manages: <strong>1\.0\.0<\/strong>/);
  assert.match(html, /No repositories yet\. Pick the ones to look after from those Reeve found/, 'no repositories: how to add one');
  assert.match(html, /No repositories to look after on this PC, so a round every 10 minutes while on duty reopens, through Manor, any on-duty agent(?:'|&#x27;)s page that stops answering/);
  assert.doesNotMatch(html, /data-post="\/api\/stage\//, 'no stages, with no one to run them for');
  // With an employee: the kit it hands out, the stages and the whole round (the same data, drawn as if it had one).
  const rows = [{ id: 'fake', name: 'Fake', repo: 'octocat/fake', parts: ['node'], usesKit: true, branch: 'main', checkout: { path: home, exists: true, branch: 'main', changes: 0 }, main: null, release: null, releaseNeeded: false, prs: [], prepared: null, notes: [] }];
  const withOne = (await renderStewardBody())({ ...body, staff: { ...body.staff, rows }, round: { ...body.round, repos: true } });
  assert.match(withOne, /The kit the Steward hands out: <strong>1\.0\.0<\/strong>/);
  for (const stage of ['bump', 'push', 'release']) assert.match(withOne, new RegExp(`data-post="/api/stage/${stage}"[^>]*>`));
  // The Steward merges no one's PRs (Steward 0.36.124): no Merge stage, nor Merge the team's PRs, even once Settings
  // name a team.
  const withTeam = (await renderStewardBody())({ ...body, staff: { ...body.staff, rows }, round: { ...body.round, repos: true }, team: ['someone'], teamNote: null });
  for (const h of [withOne, withTeam]) assert.doesNotMatch(h, /data-post="\/api\/stage\/merge|>Merge the team/);
  assert.match(withOne, /The Steward merges only its own kit PRs, in the build that rolls them out/);
  // By itself (Settings' default): it builds at the schedule's times (drawn above, on the Release tab), a build releasing
  // each repository's main, its rounds only looking between builds but for an urgent fix; and Run now, in the title bar.
  assert.match(withOne, /At each build time on the schedule, a build releases each employee whose branch carries something new \(everyone merges their own PRs\)/);
  assert.match(withOne, /Between builds, a round every 10 minutes releases nothing, except for an urgent fix/);
  // A vendor's screen saver putting the PC to sleep (the kit's sleep-cause.ts): its line, after the rest; none under
  // node --test, where nothing of the PC is read.
  assert.equal(body.round.asleep, null);
  assert.doesNotMatch(withOne, /went to sleep/);
  const asleep = "This PC went to sleep 3 times since Wednesday at 16:54, the last today at 11:10, each about 30 seconds after ASUS's OLED Care screen saver came on. The staff stop while it sleeps: to keep them working while you're away, turn off Pixel Refresh in MyASUS → OLED Care.";
  const sleeping = (await renderStewardBody())({ ...body, staff: { ...body.staff, rows }, round: { ...body.round, repos: true, asleep } });
  // Its rounds' words beside the stages, a sentence a bullet: the sleep line after the rest.
  assert.match(sleeping, /<li>Between builds, a round every 10 minutes releases nothing, except for an urgent fix[^<]*<\/li>/);
  assert.match(sleeping, /<li>This PC went to sleep 3 times since Wednesday at 16:54[^<]*<\/li><li>The staff stop while it sleeps: [^<]*turn off Pixel Refresh in MyASUS → OLED Care\.<\/li><\/ul>/);
  // Run now, in the title bar, only while it doesn't build and release by itself: by itself its rounds come anyway.
  assert.equal(body.round.on, true);
  assert.equal((await renderStewardBody('RunNow'))(body), '');
  assert.match((await renderStewardBody('RunNow'))({ ...body, round: { ...body.round, on: false } }), /data-post="\/api\/run"[^>]*>Run now</);
  // No turn taken yet: nothing said of release PCs.
  assert.equal(body.turns, null);
  assert.doesNotMatch(html, /Released from/);
  // Who has each repository: another PC (with Do it here and Keep it on this PC), this PC kept here (Unpin), and one
  // whose remote this PC can't reach; and a claim another PC made too.
  const row = (o: object) => ({ id: 'clerk', name: 'Clerk', repo: 'octocat/clerk', status: 'elsewhere', holder: 'DESKTOP-ABC', pinned: false, quiet: false, until: '2026-10-08T12:30:00Z', note: null, ...o });
  const turns = {
    at: null,
    rows: [row({}), row({ id: 'porter', name: 'Porter', repo: 'octocat/porter', status: 'here', holder: 'this PC', pinned: true }), row({ id: 'away', name: 'Away', repo: 'octocat/away', status: 'unreachable', holder: '', note: 'releasing Away waits until this PC can reach its remote' })],
  };
  const withTurns = (await renderStewardBody())({ ...body, turns, claimClashes: ['octocat/clerk 0.4.13 was claimed on another PC too'] });
  assert.match(withTurns, /Releasing for Clerk: done by <strong>DESKTOP-ABC<\/strong>/);
  assert.match(withTurns, /data-post="\/api\/turns\/take"[^>]*>Do it here</);
  assert.match(withTurns, /data-post="\/api\/turns\/take"[^>]*>Keep it on this PC</);
  assert.match(withTurns, /Releasing for Porter: this PC \(kept there\)/);
  assert.match(withTurns, />Unpin</);
  assert.match(withTurns, /Releasing Away waits until this PC can reach its remote\./);
  assert.match(withTurns, /octocat\/clerk 0\.4\.13 was claimed on another PC too\./);
  // With the staff's cards, each one's release PC is in its card, not a section of its own.
  const clerk = { ...rows[0], id: 'clerk', name: 'Clerk', repo: 'octocat/clerk' };
  const inCards = (await renderStewardBody())({ ...body, staff: { ...body.staff, rows: [clerk] }, round: { ...body.round, repos: true }, turns });
  assert.match(inCards, /<div class="card sw-repo">.*<div class="turn-cell"><div class="sw-line"><span>Released from <strong>DESKTOP-ABC<\/strong><\/span><span class="row turn-buttons">.*>Do it here</);
  assert.doesNotMatch(inCards, /Releasing for Clerk/, 'a card says it there');
  assert.match(inCards, /Releasing for Porter: this PC \(kept there\)/, 'a turn with no card, in the status card');
  assert.ok(inCards.indexOf('class="card sw-status"') < inCards.indexOf('class="card sw-repo"'), 'above the cards, not buried under them');
  assert.ok(inCards.indexOf('Releasing for Porter') < inCards.indexOf('class="card sw-repo"'));
  assert.doesNotMatch(html, /<h2[^>]*>Release PC/);
  // The Steward's own repository: a card, with its release PC in it, and no stage ticks it.
  const self = { ...rows[0], id: 'steward', name: 'Steward', repo: 'octocat/steward', self: true };
  const selfTurn = row({ id: 'steward', name: 'Steward', repo: 'octocat/steward', status: 'here', holder: 'this PC' });
  const withSelf = (await renderStewardBody())({ ...body, staff: { ...body.staff, rows: [rows[0], self] }, round: { ...body.round, repos: true }, turns: { at: null, rows: [selfTurn] } });
  assert.match(withSelf, /href="https:\/\/github\.com\/octocat\/steward"/);
  assert.match(withSelf, /Released from this PC/);
  assert.doesNotMatch(withSelf, /Releasing for Steward/, 'said in its card, not under the cards');
  assert.match(withSelf, /name="employees"[^>]*value="fake"/);
  assert.doesNotMatch(withSelf, /name="employees"[^>]*value="steward"/, 'its builds release it');
  // One box ticks every repository, or none: the Steward's own card isn't counted.
  assert.match(withSelf, /<label class="pick pick-all"><input type="checkbox"[^>]*aria-label="Tick every repository"[^>]*\/> All \(1 of 1\)<\/label>/);
  // Cards and lists, no tables: open PRs are a list in their repository's card, under a small heading; notes only once
  // a card has one.
  assert.doesNotMatch(withOne, /<table|<th>/);
  assert.doesNotMatch(withOne, /couldn/);
  const pr = { number: 7, title: 'Fix the thing', url: 'https://github.com/octocat/fake/pull/7', head: 'claude/fix', base: 'main', author: 'octocat', whose: 'team', headOid: 'abc', after: null, afterError: null, afterText: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'passing', labels: [], changed: 3, files: [] };
  const withPr = (await renderStewardBody())({ ...body, staff: { ...body.staff, rows: [{ ...rows[0], prs: [pr], notes: ["couldn't list its releases: offline"] }] }, round: { ...body.round, repos: true } });
  assert.match(withPr, /<ul class="notes"><li>couldn(&#x27;|')t list its releases: offline<\/li><\/ul>/);
  assert.match(withPr, /<div class="sw-head-small">Pull requests<\/div><ul class="sw-list"><li class="sw-pr"><div class="sw-line"><a href="https:\/\/github\.com\/octocat\/fake\/pull\/7"[^>]*>#7<\/a><span class="sw-pr-title">Fix the thing<\/span>.*claude\/fix, octocat(&#x27;|')s/);
  assert.match(withPr, /title="Opened by octocat: whoever opened it merges it once it is vouched"/, 'a team PR is merged by whoever opened it');
  // What the next build brings (Steward 0.36.135): in the card, folded, above its open PRs, a merged PR by its number
  // and title and a commit pushed without one by its own, linked on GitHub, with a compare of them all.
  const nextBuild = { tag: 'v0.4.0', commit: 'c'.repeat(40), commits: [{ sha: 'aaaaaaa', pr: 12, title: 'Fix the thing' }, { sha: 'bbbbbbb', pr: null, title: 'Changelog: a line' }], count: 12 };
  const withNext = (await renderStewardBody())({ ...body, staff: { ...body.staff, rows: [{ ...rows[0], releases: true, nextBuild, prs: [pr] }] }, round: { ...body.round, repos: true } });
  assert.match(withNext, /<details class="sw-part sw-next"><summary>Next build brings 12 commits since v0\.4\.0 \(<a href="https:\/\/github\.com\/octocat\/fake\/compare\/c{40}\.\.\.main"[^>]*>compare<\/a>\)<\/summary><ul class="sw-list sw-commits">/);
  assert.match(withNext, /href="https:\/\/github\.com\/octocat\/fake\/pull\/12"[^>]*>#12<\/a> Fix the thing<\/li>/);
  assert.match(withNext, /href="https:\/\/github\.com\/octocat\/fake\/commit\/bbbbbbb"[^>]*><code>bbbbbbb<\/code><\/a> Changelog: a line<\/li>/);
  assert.match(withNext, /and 10 more/);
  assert.ok(withNext.indexOf('Next build brings') < withNext.indexOf('sw-head-small">Pull requests<'), 'above its open PRs');
  // One the Steward doesn't release says so; over plain git, nothing is linked; with nothing new, nothing is said.
  const notReleased = (await renderStewardBody())({ ...body, staff: { ...body.staff, rows: [{ ...rows[0], releases: false, nextBuild }] }, round: { ...body.round, repos: true } });
  assert.match(notReleased, /Not released by the Steward: 12 commits since v0\.4\.0/);
  const plain = (await renderStewardBody())({ ...body, staff: { ...body.staff, rows: [{ ...rows[0], host: 'git', nextBuild: { ...nextBuild, commits: nextBuild.commits.slice(0, 1), count: 1 } }] }, round: { ...body.round, repos: true } });
  assert.match(plain, /Next build brings 1 commit since v0\.4\.0<\/summary>/);
  assert.match(plain, /<li>#12 Fix the thing<\/li>/);
  assert.doesNotMatch(plain, /\/compare\/|and \d+ more/);
  const nothing = (await renderStewardBody())({ ...body, staff: { ...body.staff, rows: [{ ...rows[0], nextBuild: { ...nextBuild, commits: [], count: 0 } }] }, round: { ...body.round, repos: true } });
  assert.doesNotMatch(nothing, /Next build brings|class="sw-part sw-next"/);
  // No Merge conflicts card any more: the Steward catches no PR up (Steward 0.36.124).
  assert.doesNotMatch(withPr, /Merge conflicts|<table class="conflicts">/);
  // The page at a glance, then its tabs: the staff, the last stage beside its log, and the stages beside its rounds.
  // Read now and then, in About: the kit. About carries no tour names: the tour shows the page.
  for (const h of [withPr, withOne]) {
    const { page, about } = split(h);
    assert.ok(about.includes('The kit the Steward hands out') && !page.includes('The kit the Steward hands out'));
    assert.ok(!about.includes('Last stage') && page.includes('Last stage'));
    assert.deepEqual([...page.matchAll(/role="tab"[^>]*>([^<]+)/g)].map((m) => m[1]), ['Staff', 'Last stage', 'Roll out the kit', 'Found on this PC'], 'Found on this PC: not looked yet');
    assert.ok(page.indexOf('class="ui-glance"') < page.indexOf('role="tablist"'), 'the tiles above the tabs');
    assert.doesNotMatch(about, /data-tour/);
  }
  const tiles = (h: string) => [...h.matchAll(/<span class="ui-tile-label">([^<]+)<\/span><span class="ui-tile-value">([^<]*)<\/span>(?:<span class="ui-tile-note">([^<]*)<\/span>)?/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(tiles(withPr).filter(([label]) => label === 'Staff' || label === 'Pull requests'), [['Staff', '1', '0 on kit 1.0.0'], ['Pull requests', '1', 'none failing']]);
  assert.equal(tiles(withNext).find(([label]) => label === 'Next build')?.[2], '12 commits in 1 repository');
  // What waits to be released, in updates: one for each repository whose version isn't released yet.
  const waits = (n: number) => ({ ...rows[0], id: `w${n}`, releaseNeeded: true, main: { version: '0.4.1', kit: null } });
  const unreleased = (await renderStewardBody())({ ...body, staff: { ...body.staff, rows: [waits(1), waits(2)] }, round: { ...body.round, repos: true } });
  assert.equal(tiles(unreleased).find(([label]) => label === 'Staff')?.[2], '2 updates not yet released');
  const one = (await renderStewardBody())({ ...body, staff: { ...body.staff, rows: [waits(1), rows[0]] }, round: { ...body.round, repos: true } });
  assert.equal(tiles(one).find(([label]) => label === 'Staff')?.[2], '1 update not yet released');
  const ping = await (await fetch(`${base()}/api/ping`)).json();
  assert.deepEqual(ping.rounds.map((r: { name: string }) => r.name), ['round'], 'Manor sees its rounds');
  assert.equal(typeof ping.nextRunAt, 'string');
});

test('a stage needs the token, from its own origin or none: without it nothing starts', async () => {
  const token = readFileSync(path.join(home, 'server.json'), 'utf8').match(/"token": "([0-9a-f]+)"/)![1];
  assert.equal((await post('/api/stage/release', {})).status, 403);
  assert.equal((await post('/api/stage/bump', { 'x-token': 'nope' })).status, 403);
  assert.equal((await post('/api/stage/release', { 'x-token': token, origin: 'http://evil.example' })).status, 403);
  assert.throws(() => readFileSync(path.join(home, 'last-stage.json')), /ENOENT/, 'no stage ran');
  const page = { 'x-token': token, origin: `http://steward.localhost:${port}` };
  const ok = await post('/api/stage/release', page);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { started: true });
  await served.idle();
  const last = JSON.parse(readFileSync(path.join(home, 'last-stage.json'), 'utf8'));
  assert.equal(last.stage, 'release');
  assert.deepEqual(last.asked, { employees: [], kit: '1.0.0' }, 'the ticked employees (none) and the kit, as the page posts them');
  assert.deepEqual(last.results, []);
  // Merge and Merge the team's PRs are gone (Steward 0.36.124: whoever wrote a PR merges it), even with the token.
  for (const gone of ['/api/stage/merge', '/api/stage/merge-team']) assert.equal((await post(gone, page)).status, 404, gone);
  // Run now: a round, with the same token. With no employees it does nothing, and leaves no trace.
  assert.equal((await post('/api/run', {})).status, 403);
  const round = await post('/api/run', page);
  assert.deepEqual(await round.json(), { started: true });
  await served.idle();
  assert.equal(JSON.parse(readFileSync(path.join(home, 'last-stage.json'), 'utf8')).stage, 'release', 'a round with nothing done is not recorded');
});

test("Manor's ask after an install: the jobs approved now, with the token as the CLI sends it; while every slot is taken, once one is free", async () => {
  const html = await (await fetch(`${base()}/`)).text();
  const token = /<meta name="page-token" content="([0-9a-f]{48})">/.exec(html)![1];
  await served.idle();
  assert.equal((await post('/api/jobs/approve', {}, { ids: ['reeve'] })).status, 403);
  // No Origin: Manor posts as the Steward's own CLI does, with the token from its server.json.
  const now = await post('/api/jobs/approve', { 'x-token': token }, { ids: ['reeve'] });
  assert.deepEqual(await now.json(), { started: true });
  await served.idle();
  // During a round, with one stage at a time: queued, and approved once it ends, nothing left running after. The round
  // has a repository to look at (a clone here), so it asks GitHub, and waits while the commands are held.
  const settingsFile = path.join(home, 'settings.json');
  const was = readFileSync(settingsFile, 'utf8');
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(was), stagesAtOnce: 1, employees: [{ id: 'fake', name: 'Fake', repo: 'octocat/fake', checkout: home }] }));
  let letGo = () => {};
  hold = new Promise((done) => (letGo = done));
  const round = await post('/api/run', { 'x-token': token, origin: `http://steward.localhost:${port}` });
  assert.deepEqual(await round.json(), { started: true });
  const queued = await (await post('/api/jobs/approve', { 'x-token': token }, { ids: ['reeve', '../x', 7] })).json();
  assert.equal(queued.queued, true);
  assert.match(queued.message, /round is running; the jobs are approved once one ends/);
  letGo();
  hold = Promise.resolve();
  await served.idle();
  writeFileSync(settingsFile, was);
  const ping = await (await fetch(`${base()}/api/ping`)).json();
  assert.equal(ping.busy, false);
});

test("an older vouch's ask for a round: the Steward merges no PRs; while it builds by itself, a round now that looks for an urgent fix; while a round runs, once it can; none when it doesn't build by itself", async () => {
  const html = await (await fetch(`${base()}/`)).text();
  const token = /<meta name="page-token" content="([0-9a-f]{48})">/.exec(html)![1];
  await served.idle();
  assert.equal((await post('/api/round/soon', {}, {})).status, 403, 'the token, as ever');
  const settingsFile = path.join(home, 'settings.json');
  const was = readFileSync(settingsFile, 'utf8');
  const merge = 'The Steward merges no PRs: merge it yourself once vouched, and the next build releases main';
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(was), byItself: false }));
  const no = await (await post('/api/round/soon', { 'x-token': token }, {})).json();
  assert.deepEqual([no.started, no.queued, no.message], [false, undefined, `${merge}.`]);

  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(was), byItself: true, employees: [{ id: 'fake', name: 'Fake', repo: 'octocat/fake', checkout: home }] }));
  // A round looks at GitHub first: its glance (asked again when the stand-in has no answer).
  const glances = () => r.gh.filter((a) => a[0] === 'api' && a[1] === 'graphql').length;
  const before = glances();
  const now = await (await post('/api/round/soon', { 'x-token': token }, {})).json();
  assert.deepEqual([now.started, now.message], [true, `${merge}: a round looks for an urgent fix now.`]);
  await served.idle();
  const each = glances() - before;
  assert.ok(each > 0, 'a round ran');

  // While a round runs: queued, and another round once it ends.
  let letGo = () => {};
  hold = new Promise((done) => (letGo = done));
  assert.deepEqual(await (await post('/api/run', { 'x-token': token, origin: `http://steward.localhost:${port}` })).json(), { started: true });
  const queued = await (await post('/api/round/soon', { 'x-token': token }, {})).json();
  assert.deepEqual([queued.started, queued.queued, queued.message], [false, true, `${merge}: a round looks for an urgent fix as soon as it can.`]);
  letGo();
  hold = Promise.resolve();
  await served.idle();
  assert.equal(glances(), before + 3 * each, 'Run now, then the round asked for');
  writeFileSync(settingsFile, was);
  assert.equal((await (await fetch(`${base()}/api/ping`)).json()).busy, false);
});

test("Manor's ask to look at the alarms again: with the page's token, answered once done, and no round run", async () => {
  const html = await (await fetch(`${base()}/`)).text();
  const token = /<meta name="page-token" content="([0-9a-f]{48})">/.exec(html)![1];
  await served.idle();
  assert.equal((await post('/api/alarms/recheck', {}, {})).status, 403, 'the token, as ever');
  const asked = r.gh.length;
  const answer = await post('/api/alarms/recheck', { 'x-token': token }, {});
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { ok: true });
  assert.deepEqual(r.gh.slice(asked), [], 'no open alarm for GitHub to settle: not asked');
  assert.equal((await (await fetch(`${base()}/api/ping`)).json()).busy, false);
});

test("the pipeline says whether this PC releases any repository it looks after, so Manor offers Build now only there", async () => {
  const settingsFile = path.join(home, 'settings.json');
  const turnsFile = path.join(home, 'turns.json');
  const was = readFileSync(settingsFile, 'utf8');
  const pipeline = async () => (await (await fetch(`${base()}/api/pipeline`)).json()) as { releasesHere?: unknown; times?: unknown };
  const turn = (repo: string, status: string) => ({ repo, status, at: '2026-10-30T12:00:00Z', ...(status === 'elsewhere' ? { record: { pc: 'other', name: 'DESKTOP-ABC', until: '2099-01-01T00:00:00Z', since: '2026-10-30T12:00:00Z', pinned: false } } : {}) });
  try {
    writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(was), employees: [{ id: 'fake', name: 'Fake', repo: 'octocat/fake', checkout: home }] }));
    const v = await pipeline();
    assert.ok(Array.isArray(v.times), 'the pipeline as before');
    assert.equal(v.releasesHere, true, 'no turn taken yet: no other PC holds it, so this one releases it');
    // The Steward's own repository too, where Settings name it: every turn another PC's.
    writeFileSync(turnsFile, JSON.stringify({ at: null, device: null, repos: { 'octocat/fake': turn('octocat/fake', 'elsewhere'), 'octocat/steward': turn('octocat/steward', 'elsewhere') } }));
    assert.equal((await pipeline()).releasesHere, false, "every repository's turn is another PC's");
    writeFileSync(turnsFile, JSON.stringify({ at: null, device: null, repos: { 'octocat/fake': turn('octocat/fake', 'here'), 'octocat/steward': turn('octocat/steward', 'elsewhere') } }));
    assert.equal((await pipeline()).releasesHere, true, "this PC holds one's turn");
    writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(was), employees: [], stewardRepo: '' }));
    assert.equal((await pipeline()).releasesHere, false, 'nothing looked after: nothing released here');
  } finally {
    writeFileSync(settingsFile, was);
    rmSync(turnsFile, { force: true });
  }
});

test('stages side by side: a release beside a round, a third refused while both slots are taken, one round at a time', async () => {
  const html = await (await fetch(`${base()}/`)).text();
  const token = /<meta name="page-token" content="([0-9a-f]{48})">/.exec(html)![1];
  await served.idle();
  const settingsFile = path.join(home, 'settings.json');
  const was = readFileSync(settingsFile, 'utf8');
  // Stages at once left as it comes: 2.
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(was), employees: [{ id: 'fake', name: 'Fake', repo: 'octocat/fake', checkout: home }] }));
  const page = { 'x-token': token, origin: `http://steward.localhost:${port}` };
  let letGo = () => {};
  hold = new Promise((done) => (letGo = done));
  try {
    assert.deepEqual(await (await post('/api/run', page)).json(), { started: true });
    assert.deepEqual(await (await post('/api/stage/release', page, { employees: ['fake'] })).json(), { started: true }, 'a release beside the round');
    const both = await (await fetch(`${base()}/api/page`)).json();
    assert.deepEqual(both.body.runs.map((r: { stage: string }) => r.stage), ['round', 'release']);
    assert.equal(both.body.full, true);
    assert.equal(both.body.running.stage, 'round', 'the first, for a page from before');
    assert.equal((await (await fetch(`${base()}/api/ping`)).json()).stage, 'round, release');
    // Its work status, for Manor's Work page: the stages' slots, and each stage a task.
    const work = await (await fetch(`${base()}/api/peer/work`)).json();
    assert.deepEqual(work.slots, [{ kind: 'stage', name: 'Stages at once', of: 2, used: 2 }]);
    assert.deepEqual(work.running.filter((t: { kind: string }) => t.kind === 'stage').map((t: { what: string }) => t.what), ['round', 'release']);
    assert.ok(Array.isArray(work.blocked) && Array.isArray(work.lines), 'what holds the version queues, and the PC\'s lines');
    const third = await (await post('/api/stage/bump', page, { employees: ['fake'], kit: '1.0.0' })).json();
    assert.deepEqual(third, { started: false, message: 'round and release are running, as many stages as Settings allow at once (Stages at once); wait for one to finish.' });
    assert.deepEqual(await (await post('/api/run', page)).json(), { started: false, message: 'A round is running; wait for it to finish.' });
    // The page: a Working card for each.
    const drawn = (await renderStewardBody())(both.body);
    assert.equal(drawn.match(/Working/g)?.length, 2);
    assert.match(drawn, /<span>round, started just now\./);
    assert.match(drawn, /<span>release, started just now\./);
  } finally {
    letGo();
    hold = Promise.resolve();
    await served.idle();
    writeFileSync(settingsFile, was);
  }
  const done = await (await fetch(`${base()}/api/page`)).json();
  assert.deepEqual([done.body.runs, done.body.full, done.body.running], [[], false, null]);
  const idle = await (await fetch(`${base()}/api/peer/work`)).json();
  assert.deepEqual([idle.slots[0].used, idle.running.filter((t: { kind: string }) => t.kind === 'stage')], [0, []], 'each stage ended with it');
});

test("a stage's POST takes the ticked employees and a well-formed kit only", () => {
  assert.deepEqual(askOf({ employees: ['porter', 'pinder'], kit: '1.0.1' }), { employees: ['porter', 'pinder'], kit: '1.0.1' });
  assert.deepEqual(askOf({ employees: 'porter', kit: '1.0.1; rm' }), { employees: [], kit: null });
});

test('the build schedule: the 12 hours around its times when they fit in 12, else the whole day; its days in words; the next build', async () => {
  const m = await bundleForNode<{ scheduleWindow: (t: string[]) => { start: number; hours: number }; daysWords: (d: string[]) => string; nextBuild: (t: string[], d: string[], now: number) => { at: number; time: string } | null }>(
    `export { daysWords, nextBuild, scheduleWindow } from '${importPath('src/web/steward.tsx')}';`,
  );
  // 10:00 to 19:00 spans 9 hours: 08:00 to 20:00, centred on the hour. 10:00 to 21:00: 09:00 to 21:00.
  assert.deepEqual(m.scheduleWindow(['13:00', '10:00', '16:30', '19:00']), { start: 8 * 60, hours: 12 });
  assert.deepEqual(m.scheduleWindow(['10:00', '13:00', '16:30', '19:00', '21:00']), { start: 9 * 60, hours: 12 });
  // Round midnight: 22:00 and 02:00 are 4 hours apart, shown 18:00 to 06:00.
  assert.deepEqual(m.scheduleWindow(['02:00', '22:00']), { start: 18 * 60, hours: 12 });
  // The default four, 18 hours from first to last: the whole day. One time: the 12 hours around it.
  assert.deepEqual(m.scheduleWindow(['00:00', '06:00', '12:00', '18:00']), { start: 0, hours: 24 });
  assert.deepEqual(m.scheduleWindow(['09:30']), { start: 3 * 60, hours: 12 });
  assert.equal(m.daysWords(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), 'every day');
  assert.equal(m.daysWords(['fri', 'mon', 'tue', 'wed', 'thu']), 'on weekdays');
  assert.equal(m.daysWords(['sat', 'sun']), 'at weekends');
  assert.equal(m.daysWords(['mon', 'wed']), 'on Mon, Wed');
  // Monday 2 Nov 2026, 11:00 local: today's 13:00; after the last, the next build day's first.
  const monday = (h: number) => new Date(2026, 10, 2, h, 0).getTime();
  assert.equal(m.nextBuild(['10:00', '13:00'], ['mon', 'wed'], monday(11))?.time, '13:00');
  const wed = m.nextBuild(['10:00', '13:00'], ['mon', 'wed'], monday(14))!;
  assert.equal(new Date(wed.at).getDay(), 3);
  assert.equal(wed.time, '10:00');
  assert.equal(m.nextBuild(['10:00'], [], monday(9)), null);
});

test('the Release tab draws the schedule, and saving it there writes Settings\' build times and days, checked as Settings would', async () => {
  const token = readFileSync(path.join(home, 'server.json'), 'utf8').match(/"token": "([0-9a-f]+)"/)![1];
  const page = { 'x-token': token, origin: `http://steward.localhost:${port}` };
  const body = (await (await fetch(`${base()}/api/page`)).json()).body;
  const rows = [{ id: 'fake', name: 'Fake', repo: 'octocat/fake', parts: [], usesKit: false, branch: 'main', checkout: { path: home, exists: true, branch: 'main', changes: 0 }, main: null, release: null, releaseNeeded: false, prs: [], prepared: null, notes: [] }];
  const html = (await renderStewardBody())({ ...body, castellan: false, staff: { ...body.staff, rows }, round: { ...body.round, castellan: false, repos: true, build: { ...body.round.build, times: ['10:00', '13:00'], days: ['mon', 'tue', 'wed', 'thu', 'fri'] } } });
  assert.match(html, /data-tour="schedule"/);
  assert.match(html, /2 builds a day, on weekdays/);
  assert.match(html, /class="sw-sched-build[^"]*"[^>]*><span>10:00<\/span>/);
  assert.match(html, /aria-label="Remove 13:00"/);
  assert.match(html, /At each build time on the schedule, a build releases each new version/);
  assert.doesNotMatch(html, /An urgent kit goes out/, "a customer's PC carries no kit");
  assert.doesNotMatch(html, /Settings: Build pipeline/);
  // Saved: the times and days, the rest of the pipeline as it was; a time that isn't one refused, the file untouched.
  const saved = await post('/api/schedule', page, { times: ['07:30', '19:00'], days: ['sat', 'sun'] });
  assert.equal(saved.status, 200, await saved.clone().text());
  const file = JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8'));
  // The days kept in Settings' own order.
  assert.deepEqual([file.buildPipeline.times, [...file.buildPipeline.days].sort()], [['07:30', '19:00'], ['sat', 'sun']]);
  assert.equal(typeof file.buildPipeline.windowMinutes, 'number');
  const bad = await post('/api/schedule', page, { times: ['25:00'] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /time/i);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'settings.json'), 'utf8')).buildPipeline.times, ['07:30', '19:00']);
  assert.equal((await post('/api/schedule', page, {})).status, 400);
  assert.deepEqual([...(await (await fetch(`${base()}/api/page`)).json()).body.round.build.days].sort(), ['sat', 'sun']);
  // Settings no longer draw it: the schedule is on the page.
  const s = await (await fetch(`${base()}/api/settings`)).json();
  assert.equal(s.schema.find((f: { key: string }) => f.key === 'buildPipeline')?.hidden, true);
});
