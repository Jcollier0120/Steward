import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A PR that holds its version queue, moved past the others (move-past.ts): what its author is told, how the merges
// take it after, and the queue alarm's button.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-move-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { movedComment } = await import('../src/move-past.ts');
const { movedPast, mergeOne } = await import('../src/stages/merge.ts');
const { claimsFile } = await import('../src/claims.ts');
const { queueAlarmOf, reconcile, roundConditions } = await import('../src/alarms.ts');
const { DEFAULT_SETTINGS } = await import('../src/settings.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;

const VERSION_FILES = ['package.json', 'package-lock.json', 'src/app.ts'];
const green = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const T = '2026-10-15T08:00:00.000Z';

test("the moved PR's comment: where it stood, its new version, and who sets it", () => {
  const ours = movedComment({ name: 'Steward', branch: 'main', from: '0.36.41', to: '0.36.45', behind: [266, 268], caughtUp: true, files: VERSION_FILES });
  assert.match(ours, /^\*\*Moved past the others by the Steward:\*\* this PR held Steward's version queue\./);
  assert.match(ours, /#266 and #268 were ready and waited behind its v0\.36\.41\. It was moved past them: v0\.36\.45 is claimed for this branch now/);
  assert.match(ours, /Nothing was pushed here\. Once it's ready, the Steward catches it up with `main` and sets v0\.36\.45 itself/);
  const fork = movedComment({ name: 'Steward', branch: 'main', from: '0.36.41', to: '0.36.45', behind: [266], caughtUp: false, files: VERSION_FILES });
  assert.match(fork, /#266 was ready and waited/);
  assert.match(fork, /Before it's marked ready, set its version to v0\.36\.45 \(package\.json, package-lock\.json, src\/app\.ts\), with its changelog entry/);
});

test('which PRs are moved: those whose branch claims a higher version for them, by number', () => {
  const pr = (number: number, head: string) => ({ number, head }) as PrInfo;
  const claims = [
    { repo: 'Jcollier0120/Fake', version: '0.4.8', branch: 'claude/40', by: 'steward', for: '', at: T, moved: 40 },
    { repo: 'Jcollier0120/Fake', version: '0.4.9', branch: 'claude/41', by: 'claude', for: '', at: T },
    { repo: 'Jcollier0120/Fake', version: '0.4.5', branch: 'claude/43', by: 'steward', for: '', at: T, moved: 43 },
  ];
  const pending = new Map([[40, '0.4.5'], [41, '0.4.6'], [43, '0.4.6']]);
  assert.deepEqual([...movedPast(claims, [pr(40, 'claude/40'), pr(41, 'claude/41'), pr(42, 'claude/42'), pr(43, 'claude/43')], pending)], [[40, '0.4.8']], 'a plain claim, or one its files have passed, moves nothing');
  assert.deepEqual([...movedPast(claims, [pr(40, 'someone/claude/40')], pending)], [], 'another branch: not the one moved');
});

test("moved, a draft gives up its turn and the PRs above it merge; marked ready, it waits its turn at its new version", async () => {
  const f = fakeEmployee(path.join(tmp, 'queue'), { version: '0.4.0' });
  const base = sh(f.checkout, 'rev-parse', 'HEAD');
  const make = (n: number, version: string) => {
    sh(f.checkout, 'switch', '--quiet', '--detach', base);
    for (const file of VERSION_FILES) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replaceAll('0.4.0', version));
    mkdirSync(f.checkout, { recursive: true });
    writeFileSync(path.join(f.checkout, `change-${n}.txt`), `#${n}\n`);
    sh(f.checkout, 'add', '-A');
    sh(f.checkout, 'commit', '--quiet', '-m', `#${n}`);
    const sha = sh(f.checkout, 'rev-parse', 'HEAD');
    sh(f.checkout, 'push', '--quiet', '--force', 'origin', `${sha}:refs/pull/${n}/head`);
    sh(f.checkout, 'switch', '--quiet', 'main');
    return sha;
  };
  const listed = (n: number, sha: string, o: Record<string, unknown> = {}) => ({ number: n, title: `#${n}`, url: `https://github.com/Jcollier0120/Fake/pull/${n}`, headRefName: `claude/${n}`, headRefOid: sha, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: green, body: '', ...o });
  const shas = { 40: make(40, '0.4.5'), 41: make(41, '0.4.6'), 42: make(42, '0.4.7') };
  const e = employee(f.checkout, { fill: '' });
  let prs = [listed(40, shas[40], { isDraft: true }), listed(41, shas[41]), listed(42, shas[42])];
  const merged: number[] = [];
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok(prs.filter((p) => !merged.includes(p.number)));
    if (args[0] === 'release' && args[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
    if (args[0] === 'pr' && args[1] === 'merge') {
      merged.push(Number(args[2]));
      return ok('');
    }
  });
  const round = () => mergeOne(ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp }), e, { yes: true, team: true });

  // A draft keeps its place (the owner's rule): the PRs above it wait.
  const first = await round();
  assert.deepEqual(first.merged, [], first.message);
  assert.match(first.message, /#41 .* waits: its turn comes after #40 \(v0\.4\.5\)/);

  // Moved past the others (its branch's claim, as move-past.ts makes it): it gives up its turn, and the lowest merges.
  mkdirSync(path.dirname(claimsFile()), { recursive: true });
  writeFileSync(claimsFile(), JSON.stringify([{ repo: 'Jcollier0120/Fake', version: '0.4.8', branch: 'claude/40', by: 'steward', for: '#40 moved past the others', at: new Date().toISOString(), moved: 40 }]));
  const second = await round();
  assert.deepEqual(second.merged.map((p) => p.number), [41], second.message);
  assert.match(second.held.find((h) => h.number === 40)!.why, /^a draft; moved past the others to v0\.4\.8: it gives up its turn/);
  assert.match(second.message, /#42 .* waits: its turn comes after #41 \(v0\.4\.6\)/);

  // Marked ready before #42 merged: it waits its turn at v0.4.8, behind #42, rather than merge first at v0.4.5.
  prs = [listed(40, shas[40]), listed(42, shas[42])];
  const third = await round();
  assert.deepEqual(third.merged.map((p) => p.number), [42], third.message);
  assert.match(third.message, /#40 .* waits: its turn comes after #42 \(v0\.4\.7\)/);
});

test("the queue alarm's button: Move it past the others, with the drafts behind it named, asked first; reconciled with the alarm", () => {
  assert.deepEqual(queueAlarmOf('queue:Jcollier0120/Steward#233'), { repo: 'Jcollier0120/Steward', number: 233 });
  assert.equal(queueAlarmOf('waiting:Jcollier0120/Steward#233'), null);
  assert.equal(queueAlarmOf('queue:Steward#233'), null);
  const round = { stage: 'round' as const, started: T, finished: T, kit: null, asked: {}, results: [], log: [] };
  const hold = { number: 233, title: 'A draft', url: 'https://github.com/Jcollier0120/Steward/pull/233', version: '0.36.41', why: 'a draft', draft: true, behind: [266, 268], since: T, drafts: [240] };
  const c = roundConditions({ round, held: [], failedReleases: {}, queueHolds: [{ id: 'steward', name: 'Steward', repo: 'Jcollier0120/Steward', branch: 'main', hold }], employees: [], settings: structuredClone(DEFAULT_SETTINGS) }).filter((x) => x.id.startsWith('queue:'));
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].action, { label: 'Move it past the others', confirm: "Give #233 and #240 versions above the rest of Steward's queue, so #266, #268 can merge? Their authors are told on GitHub; nothing is pushed to their branches." });
  assert.ok(c[0].detail.includes('#240, a draft, would hold it next: they are moved with it.'), c[0].detail.join('\n'));
  assert.ok(c[0].detail.some((d) => /or move it past the others: the Steward gives #233 and #240 a version above the rest/.test(d)), c[0].detail.join('\n'));
  const raised = reconcile({ at: null, watching: {}, open: [], cleared: [] }, c, new Date(Date.parse(T) + 2 * 3_600_000));
  assert.deepEqual(raised.state.open[0].action, c[0].action, 'the open alarm carries it, for the page and Manor');
});
