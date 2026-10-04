import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A round asks GitHub once (glance.ts), and looks again only at an employee with something new since the last round
// that went well for it (stages/changes.ts): on a data folder of its own, a fake employee's git, and gh standing in.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-changes-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage, staffFile } = await import('../src/steward.ts');
const { afterRound, FULL_EVERY_MS, heldBefore, loadSeen, planRound } = await import('../src/stages/changes.ts');
const { roundSig } = await import('../src/glance.ts');
const { loadSettings } = await import('../src/settings.ts');
const { fakeEmployee, ok, sh, employee } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');

const f = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0' });
const attempts = path.join(home, 'attempts.txt');
const releaseCmd = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],JSON.parse(fs.readFileSync('package.json','utf8')).version+'\\n')" ${attempts}`;
writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    employees: [{ id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: f.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: releaseCmd, install: '', approve: '' }],
    team: ['Jcollier0120'],
    workRoot: path.join(home, 'work'),
    afterRelease: ['http://127.0.0.1:1/api/updates/check'],
  }),
);

/** The world as GitHub would say it: the fake origin's main, the PRs below, and the versions released. */
let prs: any[] = [];
const released = () => ['0.4.0', ...(existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean) : [])];
const graph = () => ({
  data: {
    steward: { releases: { nodes: [{ tagName: 'kit-v1.0.0', isDraft: false }] } },
    e0: {
      ref: { target: { oid: sh(f.origin, 'rev-parse', 'main') } },
      pullRequests: { nodes: prs },
      releases: { nodes: released().map((v) => ({ tagName: `v${v}`, isDraft: false, publishedAt: null, tagCommit: { oid: sh(f.origin, 'rev-parse', 'main') } })) },
    },
  },
});

/** Every command a round runs, by its first word. */
let calls: string[][] = [];
const run = async (cmd: string, args: string[], opts?: any) => {
  calls.push([cmd, ...args]);
  if (cmd === 'gh') return args[0] === 'api' && args[1] === 'graphql' ? ok(graph()) : { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
  return realRun(cmd, args, opts);
};
const told: string[] = [];
const tell = async (u: string) => (told.push(u), { ok: true, said: 'HTTP 200' });
const round = (more: { full?: boolean; now?: Date } = {}) => {
  calls = [];
  return runStage('round', more.full ? { full: true } : {}, { run, tell, now: more.now ? () => more.now! : undefined });
};
const git = () => calls.filter((c) => c[0] === 'git');
const gh = () => calls.filter((c) => c[0] === 'gh');

/** A version raised on origin's main, as a push straight to the branch would. */
function raise(from: string, to: string) {
  sh(f.checkout, 'pull', '--quiet', '--ff-only', 'origin', 'main');
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replaceAll(from, to));
  sh(f.checkout, 'commit', '--quiet', '-am', `Fake ${to}`);
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
}

test('the first round looks at everyone; the next, with nothing new, asks GitHub once and runs no git at all', async () => {
  const first = await round();
  assert.equal(first.error, undefined);
  assert.ok(git().length > 0, 'the first round looked');
  assert.deepEqual(gh().map((c) => c.slice(1, 3)), [['api', 'graphql']], 'GitHub asked once, for everything');
  assert.ok(existsSync(staffFile()), "and the staff's table made from that glance");
  const seen = loadSeen();
  assert.equal(seen.ok, true);
  assert.ok(seen.repos.fake?.sig);

  const quiet = await round();
  assert.deepEqual(gh().map((c) => c.slice(1, 3)), [['api', 'graphql']]);
  assert.deepEqual(git(), [], 'nothing fetched, shown or listed');
  assert.deepEqual(quiet.results.map((r) => [r.outcome, r.message]), [['skipped', 'nothing new on GitHub since the last round']]);
  assert.match(quiet.log.join('\n'), /nothing new on GitHub since the last round for Fake/);
  const staff = JSON.parse(readFileSync(staffFile(), 'utf8'));
  assert.notEqual(staff.checked, staff.at, "the table is only marked as checked: GitHub said nothing new");
});

test('a version pushed to the branch is new: that round looks, releases it, and tells the pages that want to know', async () => {
  raise('0.4.0', '0.4.1');
  const out = await round();
  assert.deepEqual(out.results.filter((r) => r.outcome !== 'skipped').map((r) => r.message.replace(/\(.{7}\)/, '(…)')), ['release: released v0.4.1 from origin/main (…), with kit 1.0.0']);
  assert.deepEqual(told, ['http://127.0.0.1:1/api/updates/check']);
  // The release itself is something new on GitHub: the next round looks once more, finds nothing to do; then quiet.
  await round();
  assert.ok(git().length > 0);
  await round();
  assert.deepEqual(git(), []);
  assert.deepEqual(told.length, 1, 'told once, for the one release');
});

test("a PR that waits is new once; after that its employee is quiet, and the alarms still count the PR's hours", async () => {
  prs = [{ number: 9, title: 'Fake: a draft', url: 'https://github.com/Jcollier0120/Fake/pull/9', body: '', headRefName: 'draft/x', headRefOid: 'e'.repeat(40), baseRefName: 'main', isCrossRepository: false, isDraft: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', additions: 1, deletions: 0, author: { __typename: 'User', login: 'Jcollier0120' }, labels: { nodes: [] }, files: { nodes: [] }, commits: { nodes: [] } }];
  const looked = await round();
  assert.match(looked.results[0].message, /#9 .* waits: a draft/);
  assert.deepEqual(loadSeen().repos.fake.held.map((h) => [h.number, h.why]), [[9, 'a draft']]);
  await round();
  assert.deepEqual(git(), []);
  const alarms = JSON.parse(readFileSync(path.join(home, 'alarms.json'), 'utf8'));
  assert.ok('waiting:Jcollier0120/Fake#9' in alarms.watching, 'still watched while the employee is quiet');
});

test('Run now looks at everyone, whatever changed; and so does the round an hour after the last full one', async () => {
  await round({ full: true });
  assert.ok(git().length > 0, 'asked for');
  await round();
  assert.deepEqual(git(), []);
  await round({ now: new Date(Date.now() + FULL_EVERY_MS + 60_000) });
  assert.ok(git().length > 0, 'an hour on');
});

test('which employees a round looks at, and what it keeps for the next', () => {
  const settings = loadSettings();
  const e = employee(f.checkout);
  const other = employee(f.checkout, { id: 'other', name: 'Other' });
  const repo = { head: 'a'.repeat(40), prs: [], releases: [] };
  const glance = { at: '', stewardReleases: [], repos: { fake: repo, other: repo }, errors: {} };
  const now = new Date('2026-10-04T12:00:00Z');
  const none = { full: null, ok: false, repos: {} };
  assert.equal(planRound({ employees: [e, other], glance, seen: none, settings, now }).why, 'no round before');
  const good = { full: now.toISOString(), ok: true, repos: { fake: { sig: roundSig(e, repo, settings), held: [] }, other: { sig: roundSig(other, repo, settings), held: [] } } };
  const quiet = planRound({ employees: [e, other], glance, seen: good, settings, now });
  assert.deepEqual([quiet.full, quiet.look.length, quiet.quiet.length], [false, 0, 2]);
  // A new commit on one branch, Settings changed for the other.
  const moved = planRound({ employees: [e, { ...other, test: ['npm test'] }], glance: { ...glance, repos: { ...glance.repos, fake: { ...repo, head: 'b'.repeat(40) } } }, seen: good, settings, now });
  assert.deepEqual(moved.look.map((x) => x.id), ['fake', 'other']);
  assert.deepEqual(planRound({ employees: [e, other], glance, seen: good, settings: { ...settings, team: ['someone'] }, now }).look.length, 2, "the team is part of every employee's round");
  // GitHub gave no answer for one: it is looked at, the old way.
  assert.deepEqual(planRound({ employees: [e, other], glance: { ...glance, repos: { fake: repo }, errors: { other: 'NOT_FOUND' } }, seen: good, settings, now }).look.map((x) => x.id), ['other']);
  assert.equal(planRound({ employees: [e], glance: null, seen: good, settings, now }).why, "GitHub couldn't be asked at once");
  assert.equal(planRound({ employees: [e], glance, seen: { ...good, ok: false }, settings, now }).why, 'the last round failed');
  assert.equal(planRound({ employees: [e], glance, seen: good, settings, force: true, now }).why, 'asked for');

  // What it keeps: one that failed is looked at again next time; one that went well, with its PRs that waited.
  const plan = planRound({ employees: [e, other], glance, seen: none, settings, now });
  const held = [{ employee: other, prs: [{ number: 3, url: 'u', title: 't', why: 'a draft', draft: true }] }];
  const kept = afterRound(none, { plan, results: [{ id: 'fake', name: 'Fake', outcome: 'failed', message: 'release: npm ci failed' }], held, now });
  assert.deepEqual(Object.keys(kept.repos), ['other']);
  assert.deepEqual(heldBefore(kept, [other]).map((h) => h.prs[0].number), [3]);
  assert.equal(kept.full, now.toISOString());
  const failed = afterRound(none, { plan, results: [], held: [], error: 'gh: not signed in', now });
  assert.deepEqual([failed.ok, failed.full, Object.keys(failed.repos)], [false, null, []], 'a round that failed keeps nothing: the next looks at everyone');
});
