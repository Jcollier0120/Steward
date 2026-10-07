import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// Another Steward at work on this one's repositories (strangers.ts): what the round's glance shows, judged against what
// this Steward did itself; the 2026-10-07 timeline replayed; then whole rounds on a fake Porter, with gh standing in.
// Nothing reaches GitHub, the live ~/.steward or the real checkouts.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-strangers-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const S = await import('../src/strangers.ts');
const { runStage } = await import('../src/steward.ts');
const { employee, fakeEmployee, ok, sh, ctxFor } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');
type Glance = import('../src/glance.ts').Glance;

const porter = employee('C:\\nowhere\\Porter', { id: 'porter', name: 'Porter', repo: 'Jcollier0120/Porter' });
const clerk = employee('C:\\nowhere\\Clerk', { id: 'clerk', name: 'Clerk', repo: 'Jcollier0120/Clerk' });
const employees = [porter, clerk];
const H65 = '6'.repeat(40);
const H58 = '5'.repeat(40);

const kitPr = (repo: string, n: number, head: string) => ({ number: n, url: `https://github.com/${repo}/pull/${n}`, headRefName: 'steward/kit-2.34.0', headRefOid: head, isCrossRepository: false });
const rel = (...tags: string[]) => tags.map((tagName) => ({ tagName, isDraft: false, publishedAt: null, commit: null }));
const glance = (at: string, repos: Glance['repos']): Glance => ({ at, stewardReleases: null, repos, errors: {} });
const t = (hms: string) => new Date(`2026-10-07T${hms}Z`);

/** A probe that says merged for the heads given, and records what it was asked. */
function probe(merged: string[]) {
  const asked: string[] = [];
  return { asked, fn: async (_e: unknown, head: string) => (asked.push(head), merged.includes(head)) };
}

beforeEach(() => rmSync(S.actedFile(), { force: true }));

test('2026-10-07 replayed: Porter#65 opened by this round at 18:59:20, merged by someone else at 18:59:39 and released: one alarm', async () => {
  // The 18:51 round: its glance (taken at 18:51) learns each employee's releases; nothing raised on a first look.
  let a = await S.judge({ acted: S.loadActed(), glance: glance('2026-10-07T18:51:00Z', { porter: { head: 'a', prs: [], releases: rel('v0.5.12') }, clerk: { head: 'b', prs: [kitPr(clerk.repo, 58, H58)], releases: rel('v0.5.7') } }), employees, merged: probe([]).fn, now: t('18:51:05') });
  assert.deepEqual(a.strangers, []);
  writeFileSync(S.actedFile(), JSON.stringify(a));
  // Later in the same round, the rollout opens Porter's kit PR (stages/push.ts notes it).
  S.noteOpened(porter, 'https://github.com/Jcollier0120/Porter/pull/65', H65, t('18:59:20'));
  // At 18:59:39 something else merges it, and releases v0.5.13 at 18:59:58; Clerk#58 and v0.5.8 at 19:02.
  // The 19:14 round: neither PR is open, and the releases are there. No round here merged or released them.
  const p = probe([H65, H58]);
  a = await S.judge({ acted: S.loadActed(), glance: glance('2026-10-07T19:14:00Z', { porter: { head: 'c', prs: [], releases: rel('v0.5.13', 'v0.5.12') }, clerk: { head: 'd', prs: [], releases: rel('v0.5.8', 'v0.5.7') } }), employees, merged: p.fn, now: t('19:14:30') });
  assert.deepEqual(p.asked.sort(), [H58, H65].sort(), 'each PR no longer open, asked once whether it was merged');
  assert.deepEqual(a.strangers.map((s) => `${s.kind} ${s.name} ${s.ref}`), ['merge Porter #65', 'release Porter v0.5.13', 'merge Clerk #58', 'release Clerk v0.5.8']);
  assert.deepEqual(a.watching, {}, 'no longer watched once judged');

  const [c, ...more] = S.strangerConditions(a, t('19:14:30'));
  assert.equal(more.length, 0, 'one alarm');
  assert.equal(c.id, 'strangers:2026-10-07T19:14:30.000Z');
  assert.equal(c.who, 'steward');
  assert.equal(c.afterMs, 0, 'at once');
  assert.equal(c.title, 'Another Steward or person seems to be merging and releasing Porter and Clerk: no round here did');
  assert.equal(c.detail[0], "The Steward's PRs merged without it: Porter #65, Clerk #58.");
  assert.equal(c.detail[1], 'Released without it: Porter v0.5.13, Clerk v0.5.8.');
  assert.match(c.detail[2], /another PC runs a Steward signed in to gh as the same GitHub account/);
  assert.match(c.detail[3], /Dismiss this.*node src\\cli\.ts mine porter #65/);

  // The next round sees nothing new: the same alarm, not a second.
  writeFileSync(S.actedFile(), JSON.stringify(a));
  const next = await S.judge({ acted: S.loadActed(), glance: glance('2026-10-07T19:22:00Z', { porter: { head: 'c', prs: [], releases: rel('v0.5.13', 'v0.5.12') }, clerk: { head: 'd', prs: [], releases: rel('v0.5.8', 'v0.5.7') } }), employees, merged: probe([]).fn, now: t('19:22:10') });
  assert.equal(next.strangers.length, 4);
  assert.equal(S.strangerConditions(next, t('19:22:10'))[0].id, c.id);
});

test("this Steward's own merges and releases are never counted, nor asked about", async () => {
  let a = await S.judge({ acted: S.loadActed(), glance: glance('2026-10-07T18:51:00Z', { porter: { head: 'a', prs: [kitPr(porter.repo, 65, H65)], releases: rel('v0.5.12') } }), employees: [porter], merged: probe([]).fn, now: t('18:51:05') });
  writeFileSync(S.actedFile(), JSON.stringify(a));
  // The round merges it and releases the version (stages/merge.ts and stages/release.ts note them).
  S.noteMerged(porter, 65, t('18:52:00'));
  S.noteReleased(porter, '0.5.13', t('18:53:00'));
  const p = probe([H65]);
  a = await S.judge({ acted: S.loadActed(), glance: glance('2026-10-07T19:14:00Z', { porter: { head: 'c', prs: [], releases: rel('v0.5.13', 'v0.5.12') } }), employees: [porter], merged: p.fn, now: t('19:14:30') });
  assert.deepEqual(p.asked, [], 'its own merge needs no look');
  assert.deepEqual(a.strangers, []);
  assert.deepEqual(S.strangerConditions(a, t('19:14:30')), []);
});

test('an update raises nothing: the first look only learns the releases there, and watches the open PRs', async () => {
  const a = await S.judge({ acted: S.emptyActed(), glance: glance('2026-10-07T18:51:00Z', { porter: { head: 'a', prs: [kitPr(porter.repo, 65, H65)], releases: rel('v0.5.13', 'v0.5.12', 'v0.5.11') } }), employees: [porter], merged: probe([]).fn, now: t('18:51:05') });
  assert.deepEqual(a.strangers, []);
  assert.deepEqual(a.known, { porter: ['v0.5.13', 'v0.5.12', 'v0.5.11'] });
  assert.deepEqual(Object.keys(a.watching), ['Jcollier0120/Porter#65']);
});

test("a PR closed without merging is let go; one opened during the round waits for the next glance; one that can't be told waits", async () => {
  writeFileSync(S.actedFile(), JSON.stringify({ ...S.emptyActed(), known: { porter: [] }, watching: { 'Jcollier0120/Porter#64': { id: 'porter', head: 'x'.repeat(40), url: 'u64', seen: '2026-10-07T18:00:00Z' }, 'Jcollier0120/Porter#65': { id: 'porter', head: H65, url: 'u65', seen: '2026-10-07T19:14:10Z' }, 'Jcollier0120/Porter#66': { id: 'porter', head: 'y'.repeat(40), url: 'u66', seen: '2026-10-07T18:00:00Z' } } }));
  const asked: string[] = [];
  const a = await S.judge({ acted: S.loadActed(), glance: glance('2026-10-07T19:14:00Z', { porter: { head: 'c', prs: [], releases: [] } }), employees: [porter], merged: async (_e, head) => (asked.push(head), head.startsWith('y') ? null : false), now: t('19:14:30') });
  assert.deepEqual(asked.sort(), ['x'.repeat(40), 'y'.repeat(40)], '#65 was opened after the glance was taken');
  assert.deepEqual(a.strangers, []);
  assert.deepEqual(Object.keys(a.watching).sort(), ['Jcollier0120/Porter#65', 'Jcollier0120/Porter#66'], '#64 closed and let go; #66 asked again next round');
});

test('marked as a person\'s, before or after: never counted, and the alarm drops it', async () => {
  writeFileSync(S.actedFile(), JSON.stringify({ ...S.emptyActed(), known: { porter: ['v0.5.12'] } }));
  assert.deepEqual(S.markMine(porter, 'v0.5.13', t('19:00:00')), { key: 'porter:v0.5.13' });
  assert.match((S.markMine(porter, 'latest') as { error: string }).error, /neither a PR \(#65\) nor a release/);
  let a = await S.judge({ acted: S.loadActed(), glance: glance('2026-10-07T19:14:00Z', { porter: { head: 'c', prs: [], releases: rel('v0.5.14', 'v0.5.13', 'v0.5.12') } }), employees: [porter], merged: probe([]).fn, now: t('19:14:30') });
  assert.deepEqual(a.strangers.map((s) => s.ref), ['v0.5.14'], 'v0.5.13 was marked before');
  assert.equal(S.strangerConditions(a, t('19:14:30')).length, 1);
  writeFileSync(S.actedFile(), JSON.stringify(a));
  S.markMine(porter, '0.5.14', t('19:20:00'));
  a = S.loadActed();
  assert.deepEqual(S.strangerConditions(a, t('19:20:00')), [], 'marked after: the alarm clears');
});

test('dismissed: what it named is taken as known, and a new one raises a new alarm; it clears a day after the last', async () => {
  const s = (ref: string, seen: string) => ({ kind: 'release' as const, id: 'porter', name: 'Porter', repo: porter.repo, ref, url: `u${ref}`, seen });
  let a: import('../src/strangers.ts').Acted = { ...S.emptyActed(), strangers: [s('v0.5.13', '2026-10-07T19:14:30.000Z')] };
  const [c] = S.strangerConditions(a, t('19:15:00'));
  a = S.withAck(a, { open: [{ id: c.id, who: 'steward', title: c.title, detail: c.detail, since: c.since!, raisedAt: c.since!, dismissedAt: '2026-10-07T19:30:00.000Z' }] });
  assert.equal(a.ackedAt, '2026-10-07T19:30:00.000Z');
  assert.deepEqual(S.strangerConditions(a, t('19:31:00')), []);
  a.strangers.push(s('v0.5.14', '2026-10-07T20:00:00.000Z'));
  const [again] = S.strangerConditions(a, t('20:00:00'));
  assert.equal(again.id, 'strangers:2026-10-07T20:00:00.000Z');
  assert.equal(again.title, 'Another Steward or person seems to be releasing Porter: no round here did');
  // One run of them while each comes within a day of the one before; a day after the last, it clears.
  a.strangers.push(s('v0.5.15', '2026-10-08T15:00:00.000Z'));
  assert.equal(S.strangerConditions(a, new Date('2026-10-08T19:00:00Z'))[0].id, again.id);
  assert.deepEqual(S.strangerConditions(a, new Date('2026-10-09T15:00:00Z')), []);
});

test("an employee the Steward never publishes: its releases are a person's, never counted", async () => {
  const site = employee('C:\\nowhere\\Site', { id: 'site', name: 'Site', repo: 'Jcollier0120/Site', release: '' });
  const wright = employee('C:\\nowhere\\Wright', { id: 'wright', name: 'Wright', repo: 'Jcollier0120/Wright', release: 'npm run release -- --install' });
  const look = (at: string, tags: string[]) => glance(at, { site: { head: 'a', prs: [], releases: rel(...tags) }, wright: { head: 'b', prs: [], releases: rel(...tags) } });
  let a = await S.judge({ acted: S.emptyActed(), glance: look('2026-10-07T18:51:00Z', ['v1.0.0']), employees: [site, wright], merged: probe([]).fn, now: t('18:51:05') });
  a = await S.judge({ acted: a, glance: look('2026-10-07T19:14:00Z', ['v1.0.1', 'v1.0.0']), employees: [site, wright], merged: probe([]).fn, now: t('19:14:30') });
  assert.deepEqual(a.strangers, []);
});

test("a PC that doesn't release Castellan looks for nothing, and keeps nothing", async () => {
  const ctx = ctxFor({ employees: [porter], workRoot: path.join(home, 'w'), run: realRun, neutralDir: home });
  ctx.settings = { ...ctx.settings, releasesCastellan: false };
  const out = await S.lookForStrangers({ ctx, glance: glance('2026-10-07T19:14:00Z', { porter: { head: 'c', prs: [], releases: rel('v0.5.13') } }), alarms: { open: [] } });
  assert.deepEqual(out, []);
  assert.equal(existsSync(S.actedFile()), false);
});

test('the git probe: a PR head in the branch is merged; one that never reached it is not', async () => {
  const f = fakeEmployee(path.join(home, 'probe'));
  const e = employee(f.checkout, { id: 'porter', name: 'Porter', repo: 'Jcollier0120/Porter' });
  sh(f.checkout, 'switch', '--quiet', '-c', 'steward/kit-2.34.0');
  writeFileSync(path.join(f.checkout, 'kit.txt'), 'x\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'kit');
  const merged = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', `${merged}:refs/heads/main`);
  sh(f.checkout, 'commit', '--quiet', '--allow-empty', '-m', 'never merged');
  const closed = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'switch', '--quiet', 'main');
  const ctx = ctxFor({ employees: [e], workRoot: path.join(home, 'w'), run: realRun, neutralDir: home });
  const p = S.gitProbe(ctx);
  assert.equal(await p(e, merged), true, 'fetched, and in origin/main');
  assert.equal(await p(e, closed), false);
  assert.equal(await p(e, 'f'.repeat(40)), false, 'a commit never fetched here');
  assert.equal(await p({ ...e, checkout: path.join(home, 'no-such-checkout') }, merged), null, 'no checkout: not told');
});

// Whole rounds: a fake Porter on kit 1.0.0, rolled out to new kits by this Steward, its PRs merged by it, or by someone else.
test('whole rounds: no alarm for what the rounds merged and released; one when someone else merged and released', async () => {
  const f = fakeEmployee(path.join(home, 'porter'), { version: '0.5.12', kit: '1.0.0' });
  const attempts = path.join(home, 'released.txt');
  const releaseCmd = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],JSON.parse(fs.readFileSync('package.json','utf8')).version+'\\n')" ${attempts}`;
  writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({
      employees: [{ id: 'porter', name: 'Porter', repo: 'Jcollier0120/Porter', checkout: f.checkout, branch: 'main', merges: true, usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: releaseCmd, install: '', approve: '' }],
      team: ['Jcollier0120'],
      workRoot: path.join(home, 'work'),
      afterRelease: [],
      stewardRepo: 'octocat/steward',
      releasesCastellan: true,
      alarms: { manorUrl: '', surveyorUrl: '', toast: false },
    }),
  );
  let kits = ['1.0.0'];
  let prs: any[] = [];
  let prNumber = 64;
  /** Released by someone else: on GitHub, but never by a round here. */
  const theirs: string[] = [];
  const released = () => ['0.5.12', ...theirs, ...(existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean) : [])];
  const graph = () => ({
    data: {
      steward: { releases: { nodes: kits.map((k) => ({ tagName: `kit-v${k}`, isDraft: false })) } },
      e0: { ref: { target: { oid: sh(f.origin, 'rev-parse', 'main') } }, pullRequests: { nodes: prs }, releases: { nodes: released().map((v) => ({ tagName: `v${v}`, isDraft: false, publishedAt: null, tagCommit: null })) } },
    },
  });
  const run = async (cmd: string, args: string[], opts?: any) => {
    if (cmd !== 'gh') return realRun(cmd, args, opts);
    if (args[0] === 'api' && args[1] === 'graphql') return ok(graph());
    if (args[0] === 'release' && args[1] === 'list') return ok((args.includes('octocat/steward') ? kits.map((k) => `kit-v${k}`) : released().map((v) => `v${v}`)).map((tagName) => ({ tagName, isDraft: false })));
    if (args[0] === 'pr' && args[1] === 'list') {
      const head = args[args.indexOf('--head') + 1];
      return ok(prs.filter((p) => !args.includes('--head') || p.headRefName === head).map((p) => ({ ...p, author: { login: p.author.login }, labels: [], files: [], statusCheckRollup: [] })));
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      const head = args[args.indexOf('--head') + 1];
      const n = ++prNumber;
      prs.push({ number: n, title: args[args.indexOf('--title') + 1], url: `https://github.com/Jcollier0120/Porter/pull/${n}`, body: '', headRefName: head, headRefOid: sh(f.origin, 'rev-parse', head), baseRefName: 'main', isCrossRepository: false, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', additions: 8, deletions: 8, author: { __typename: 'User', login: 'Jcollier0120' }, labels: { nodes: [] }, files: { nodes: [] }, commits: { nodes: [] } });
      return ok(`https://github.com/Jcollier0120/Porter/pull/${n}\n`);
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      mergeBy(prs.find((p) => String(p.number) === args[2])!);
      return ok('');
    }
    return { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
  };
  /** A PR merged on GitHub, its branch deleted, as a Steward's merge does: this one's, or another's. */
  function mergeBy(pr: any) {
    sh(f.origin, 'update-ref', 'refs/heads/main', pr.headRefOid);
    sh(f.origin, 'update-ref', '-d', `refs/heads/${pr.headRefName}`);
    prs = prs.filter((p) => p !== pr);
  }
  const round = () => runStage('round', {}, { run, ownKit: '9.9.9' });
  const alarms = () => JSON.parse(readFileSync(path.join(home, 'alarms.json'), 'utf8')).open as { id: string; title: string; detail: string[] }[];

  await round();
  // A new kit: this round opens Porter's kit PR; the next merges and releases it; the one after sees only its own work.
  kits = ['1.0.1', '1.0.0'];
  const opened = await round();
  assert.match(opened.results.find((x) => x.message.startsWith('rollout: '))?.message ?? '', /opened "Porter 0\.5\.13: the Steward's kit 1\.0\.1"$/, opened.log.join('\n'));
  const merged = await round();
  assert.deepEqual(merged.results.filter((x) => x.outcome === 'done').map((x) => x.message.replace(/\(.{7}\)/, '(…)')), ['merged #65', 'release: released v0.5.13 from origin/main (…), with kit 1.0.1']);
  await round();
  assert.deepEqual(alarms().filter((a) => a.id.startsWith('strangers:')), [], 'its own merge and release raise nothing');
  assert.deepEqual(S.loadActed().strangers, []);

  // The next kit's PR is opened here, then merged and released by someone else before the next round.
  kits = ['1.0.2', ...kits];
  await round();
  const pr = prs.find((p) => p.number === 66);
  assert.ok(pr, 'Porter #66 opened');
  mergeBy(pr);
  theirs.push('0.5.14');
  const seen = await round();
  assert.equal(seen.error, undefined, seen.log.join('\n'));
  const open = alarms().filter((a) => a.id.startsWith('strangers:'));
  assert.equal(open.length, 1, JSON.stringify(alarms()));
  assert.equal(open[0].title, 'Another Steward or person seems to be merging and releasing Porter: no round here did');
  assert.equal(open[0].detail[0], "The Steward's PRs merged without it: Porter #66.");
  assert.equal(open[0].detail[1], 'Released without it: Porter v0.5.14.');
  assert.match(seen.log.join('\n'), /alarm: Another Steward or person seems to be merging and releasing Porter/);
});

test("what the PC whose turn it is merges and releases is never a stranger's; taken back, judged from then on", async () => {
  let a = await S.judge({ acted: S.loadActed(), glance: glance('2026-10-07T18:51:00Z', { porter: { head: 'a', prs: [kitPr(porter.repo, 65, H65)], releases: rel('v0.5.12') } }), employees: [porter], merged: probe([]).fn, now: t('18:51:05') });
  writeFileSync(S.actedFile(), JSON.stringify(a));
  // Another PC of the licence has Porter's turn (lease.ts): it merges #65 and releases v0.5.13.
  const p = probe([H65]);
  a = await S.judge({ acted: S.loadActed(), glance: glance('2026-10-07T19:14:00Z', { porter: { head: 'c', prs: [], releases: rel('v0.5.13', 'v0.5.12') } }), employees: [porter], merged: p.fn, now: t('19:14:30'), elsewhere: new Set(['porter']) });
  assert.deepEqual(a.strangers, []);
  assert.deepEqual(p.asked, [], 'nothing asked of a repository another PC looks after');
  assert.deepEqual(a.known.porter, ['v0.5.13', 'v0.5.12'], 'its releases learnt');
  writeFileSync(S.actedFile(), JSON.stringify(a));
  // The turn back here: a release no one here made counts again.
  a = await S.judge({ acted: S.loadActed(), glance: glance('2026-10-07T20:00:00Z', { porter: { head: 'd', prs: [], releases: rel('v0.5.14', 'v0.5.13', 'v0.5.12') } }), employees: [porter], merged: probe([]).fn, now: t('20:00:30') });
  assert.deepEqual(a.strangers.map((s) => `${s.kind} ${s.ref}`), ['release v0.5.14']);
});
