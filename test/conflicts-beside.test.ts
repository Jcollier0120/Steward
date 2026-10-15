import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The look at the conflicts beside the rounds (steward.ts's conflictsNow, merge.ts's mergeOne conflictsOnly): a ready
// PR that conflicts with its branch is caught up at once, nothing is merged, and one tried at the same heads, or a
// repository with none in conflict, is asked nothing more than the glance. A data folder of its own, a fake employee's
// git, and gh standing in.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-conflicts-beside-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { conflictsNow } = await import('../src/steward.ts');
const { conflictsToCatch } = await import('../src/stages/merge.ts');
const { kitTrialsFile } = await import('../src/stages/trial.ts');
const { writeJson } = await import('../src/kit/store.ts');
const { employee, fakeEmployee, ok, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;

const f = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0' });
const write = (file: string, t: string) => writeFileSync(path.join(f.checkout, file), t);
const read = (file: string) => readFileSync(path.join(f.checkout, file), 'utf8');
const bump = (to: string) => {
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) write(file, read(file).split('0.4.0').join(to));
};
// The PR: 0.4.1 and a feature. main since: someone else's 0.4.1, released, its lock beside a licence: the two conflict
// in the lock's version lines, which a catch-up resolves.
sh(f.checkout, 'switch', '--quiet', '-c', 'claude/feature');
bump('0.4.1');
write('src/feature.ts', 'export const feature = 1;\n');
sh(f.checkout, 'add', '-A');
sh(f.checkout, 'commit', '--quiet', '-m', 'Fake 0.4.1: a feature');
const headOid = sh(f.checkout, 'rev-parse', 'HEAD');
sh(f.checkout, 'switch', '--quiet', 'main');
bump('0.4.1');
write('package-lock.json', read('package-lock.json').replace('      "version": "0.4.1"\n', '      "version": "0.4.1",\n      "license": "UNLICENSED"\n'));
sh(f.checkout, 'commit', '--quiet', '-am', 'Fake 0.4.1: all rights reserved');
sh(f.checkout, 'push', '--quiet', 'origin', 'claude/feature', 'main');

writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    employees: [{ id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: f.checkout, branch: 'main', merges: true, usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: '', install: '', approve: '' }],
    team: ['Jcollier0120'],
    workRoot: path.join(home, 'work'),
    byItself: true,
    catchUp: true,
  }),
);

/** The PR as GitHub's glance says it: conflicting with main, at the head the PR was opened at. */
const node = (o: { mergeable?: string; state?: string } = {}) => ({ number: 21, title: 'Fake 0.4.1: a feature', url: 'https://github.com/Jcollier0120/Fake/pull/21', body: '', headRefName: 'claude/feature', headRefOid: headOid, baseRefName: 'main', isCrossRepository: false, isDraft: false, mergeable: o.mergeable ?? 'CONFLICTING', mergeStateStatus: o.state ?? 'DIRTY', additions: 5, deletions: 5, author: { __typename: 'User', login: 'Jcollier0120' }, labels: { nodes: [] }, files: { nodes: [] }, commits: { nodes: [] } });
let prs: any[] = [node()];
const graph = () => ({
  data: {
    steward: { releases: { nodes: [{ tagName: 'kit-v1.0.0', isDraft: false }] } },
    e0: {
      ref: { target: { oid: sh(f.origin, 'rev-parse', 'main') } },
      pullRequests: { nodes: prs },
      releases: { nodes: ['0.4.1', '0.4.0'].map((v) => ({ tagName: `v${v}`, isDraft: false, publishedAt: null, tagCommit: { oid: sh(f.origin, 'rev-parse', 'main') } })) },
    },
  },
});
let calls: string[][] = [];
const run = async (cmd: string, args: string[], opts?: any) => {
  calls.push([cmd, ...args]);
  if (cmd === 'gh') return args[0] === 'api' && args[1] === 'graphql' ? ok(graph()) : ok('');
  return realRun(cmd, args, opts);
};
const look = () => {
  calls = [];
  return conflictsNow({ run });
};
const gh = () => calls.filter((c) => c[0] === 'gh').map((c) => c.slice(1, 3).join(' '));

test('a ready PR that conflicts with its branch is caught up beside the rounds, in a slot of its own; nothing is merged', async () => {
  const began: string[] = [];
  calls = [];
  const out = await conflictsNow({ run, begin: () => (began.push('conflicts'), () => began.push('ended')) });
  assert.deepEqual(out.map((r) => [r.id, r.outcome]), [['fake', 'done']], JSON.stringify(out));
  assert.match(out[0].message, /#21 caught up: merged main into it, its version lines resolved; v0\.4\.2/);
  assert.deepEqual(began, ['conflicts', 'ended'], 'told when it took a slot, and when it gave it back');
  assert.ok(!gh().includes('pr merge'), "nothing merged: that is the round's");
  sh(f.checkout, 'fetch', '--quiet', 'origin');
  assert.equal(JSON.parse(sh(f.checkout, 'show', 'origin/claude/feature:package.json')).version, '0.4.2');
  assert.equal(sh(f.checkout, 'merge-base', '--is-ancestor', 'origin/main', 'origin/claude/feature'), '', 'main merged into it');
});

test('tried at the same heads, or with none in conflict, a look asks GitHub for its glance and nothing more, and takes no slot', async () => {
  // GitHub still says it conflicts at the head it had (the glance a moment before the push, say): left alone.
  const began: string[] = [];
  calls = [];
  assert.deepEqual(await conflictsNow({ run, begin: () => (began.push('conflicts'), () => {}) }), []);
  assert.deepEqual(began, []);
  assert.deepEqual(gh(), ['api graphql']);
  // Merely behind its branch: the round's to catch up, when its turn comes.
  prs = [node({ mergeable: 'MERGEABLE', state: 'BEHIND' })];
  assert.deepEqual(await look(), []);
  assert.deepEqual(gh(), ['api graphql']);
  assert.deepEqual(calls.filter((c) => c[0] === 'git'), [], 'no clone touched');
  // None open at all.
  prs = [];
  assert.deepEqual(await look(), []);
  assert.deepEqual(gh(), ['api graphql']);
});

test('only a ready PR in conflict is caught up beside the rounds: not one merely behind, a draft, a fork, one to another branch, nor a kit PR whose trial is going', () => {
  const e = employee(f.checkout);
  const pr = (more: Partial<PrInfo>): PrInfo => ({ number: 30, title: 'Fake 0.4.2: more', url: 'https://github.com/Jcollier0120/Fake/pull/30', head: 'claude/more', base: 'main', author: 'Jcollier0120', whose: 'team', headOid: 'a'.repeat(40), after: { steps: [] } as any, afterError: null, mergeable: 'CONFLICTING', mergeState: 'DIRTY', draft: false, checks: 'none', labels: [], changed: 2, files: [], fork: false, ...more });
  writeJson(kitTrialsFile(), { [`31@${'b'.repeat(40)}`]: { kit: '9.9.9', failed: [], passed: 0, at: new Date().toISOString(), pending: ['fake'] } });
  const prs = [
    pr({}),
    pr({ number: 31, headOid: 'b'.repeat(40), files: ['kit/VERSION'] }),
    pr({ number: 32, mergeable: 'MERGEABLE', mergeState: 'BEHIND' }),
    pr({ number: 33, draft: true }),
    pr({ number: 34, fork: true }),
    pr({ number: 35, base: 'release' }),
    pr({ number: 36, headOid: 'c'.repeat(40), files: ['kit/VERSION'] }),
  ];
  assert.deepEqual(conflictsToCatch(e, prs, 'd'.repeat(40)).map((p) => p.number), [30, 36], "a kit PR with no trial going at its head is caught up like any other");
});
