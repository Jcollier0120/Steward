import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Each repository's version queue, for Manor (version-queue.ts): an employee's and a non-employee project's, on fake
// repositories made with git in a temporary folder, with gh standing in for GitHub.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-vq-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { keepVersionQueues, loadVersionQueues } = await import('../src/version-queue.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const VERSION_FILES = ['package.json', 'package-lock.json', 'src/app.ts'];
const green = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const red = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }];

/** A fake repository at 0.4.0, and PRs made on it, each pushed as refs/pull/<n>/head. */
function repoWithPrs(name: string, files = VERSION_FILES) {
  const f = fakeEmployee(path.join(tmp, name), { version: '0.4.0' });
  const base = sh(f.checkout, 'rev-parse', 'HEAD');
  const make = (n: number, version?: string) => {
    sh(f.checkout, 'switch', '--quiet', '--detach', base);
    if (version) for (const file of files) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replaceAll('0.4.0', version));
    writeFileSync(path.join(f.checkout, `change-${n}.txt`), `#${n}\n`);
    sh(f.checkout, 'add', '-A');
    sh(f.checkout, 'commit', '--quiet', '-m', `#${n}`);
    const sha = sh(f.checkout, 'rev-parse', 'HEAD');
    sh(f.checkout, 'push', '--quiet', '--force', 'origin', `${sha}:refs/pull/${n}/head`);
    sh(f.checkout, 'switch', '--quiet', 'main');
    return sha;
  };
  return { ...f, make };
}

const listed = (repo: string, n: number, sha: string, o: Record<string, unknown> = {}) => ({
  number: n,
  title: `#${n}`,
  url: `https://github.com/${repo}/pull/${n}`,
  headRefName: `feat/${n}`,
  headRefOid: sha,
  baseRefName: 'main',
  isCrossRepository: false,
  author: { login: 'someone' },
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  isDraft: false,
  statusCheckRollup: green,
  body: '',
  ...o,
});

test("each repository's version, and the PR versions above it lowest first: an employee's and a project's", async () => {
  const a = repoWithPrs('agent');
  const shas = { 7: a.make(7, '0.4.2'), 8: a.make(8, '0.4.1'), 9: a.make(9, '0.4.3'), 10: a.make(10), 11: a.make(11, '0.3.9') };
  const agentPrs = [listed('Jcollier0120/Fake', 7, shas[7]), listed('Jcollier0120/Fake', 8, shas[8], { statusCheckRollup: red }), listed('Jcollier0120/Fake', 9, shas[9], { isDraft: true }), listed('Jcollier0120/Fake', 10, shas[10]), listed('Jcollier0120/Fake', 11, shas[11])];
  // A project names no version files: its package.json is found.
  const p = repoWithPrs('project', ['package.json']);
  const three = p.make(3, '0.5.0');
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok(args[3] === 'someone/Side' ? [listed('someone/Side', 3, three)] : agentPrs);
  });
  const e = employee(a.checkout, { id: 'fake', name: 'Fake' });
  const project = { name: 'Side Car', checkout: p.checkout, repo: 'someone/Side', branch: 'main', test: null, versionFiles: [], cleanBranches: true };
  const ctx = () => ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });

  const q = await keepVersionQueues(ctx(), { projects: [project] });
  const [agent, side] = q.repos;
  assert.equal(agent.id, 'fake');
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.version, '0.4.0');
  assert.deepEqual(agent.queue.map((x) => [x.number, x.version, x.ready]), [[8, '0.4.1', false], [7, '0.4.2', true]], 'lowest first; a draft, one that sets no version and one below the branch are left out');
  assert.equal(agent.queue[0].why, 'checks failing');
  assert.equal(agent.working, '0.4.1');
  assert.equal(agent.latest, '0.4.2');
  assert.equal(side.id, 'project:side-car');
  assert.equal(side.kind, 'project');
  assert.deepEqual(side.files, ['package.json']);
  assert.equal(side.version, '0.4.0');
  assert.deepEqual(side.queue.map((x) => [x.number, x.version]), [[3, '0.5.0']]);
  assert.deepEqual(loadVersionQueues(), q, 'kept for /api/version-queues');

  // #8 merged: its branch is at 0.4.1, and the queue moves on to #7.
  sh(a.checkout, 'push', '--quiet', 'origin', `${shas[8]}:refs/heads/main`);
  agentPrs.splice(1, 1);
  const next = await keepVersionQueues(ctx(), { projects: [project] });
  assert.equal(next.repos[0].version, '0.4.1');
  assert.deepEqual(next.repos[0].queue.map((x) => x.number), [7]);
  assert.equal(next.repos[0].working, '0.4.2');
});

test('a repository that can\'t be read says why, and a project that is one of the employees\' checkouts is not listed twice', async () => {
  const a = repoWithPrs('agent2');
  const r = runner((args) => (args[0] === 'pr' && args[1] === 'list' ? ok([]) : undefined));
  const e = employee(a.checkout, { id: 'fake2', name: 'Fake2' });
  const gone = { name: 'Gone', checkout: path.join(tmp, 'nowhere'), repo: null, branch: 'main', test: null, versionFiles: [], cleanBranches: true };
  const twin = { name: 'Twin', checkout: a.checkout, repo: null, branch: 'main', test: null, versionFiles: [], cleanBranches: true };
  const q = await keepVersionQueues(ctxFor({ employees: [e], workRoot: path.join(tmp, 'work2'), run: r.run, neutralDir: tmp }), { projects: [gone, twin] });
  assert.deepEqual(q.repos.map((x) => x.id), ['fake2', 'project:gone']);
  assert.equal(q.repos[0].version, '0.4.0');
  assert.deepEqual(q.repos[0].queue, []);
  assert.equal(q.repos[0].working, null);
  assert.match(q.repos[1].note ?? '', /^no checkout at /);
});
