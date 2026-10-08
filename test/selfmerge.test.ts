import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Steward's own repository, merged as an employee's: the team's PR to it tested here first (no CI runs on it),
// then merged; never a kit rollout, never a release from the merge stage (its own round's, stages/self.ts).
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-selfmerge-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { stewardEmployee } = await import('../src/stages/selfmerge.ts');
const { mergeOne } = await import('../src/stages/merge.ts');
const { ctxFor, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

test("its own repository as the merge stage sees an employee's: no kit, its own checks, its version files, no release", () => {
  const ctx = ctxFor({ employees: [], workRoot: path.join(home, 'work'), run: runner().run, neutralDir: home });
  const e = stewardEmployee(ctx.settings);
  assert.equal(e.id, 'steward');
  assert.equal(e.repo, 'Jcollier0120/Steward');
  assert.equal(e.checkout, ctx.settings.stewardCheckout);
  assert.equal(e.usesKit, false, 'a rollout passes it over');
  assert.deepEqual([e.fill, ...e.test], ['npm run kit', 'npm run typecheck', 'npm test']);
  assert.deepEqual([e.release, e.install], ['', '']);
});

test("a round merges the team's ready PR to the Steward once its checks pass here", async () => {
  const dir = path.join(home, 'steward');
  const { checkout } = fakeEmployee(dir, { version: '0.8.13', kit: null });
  // The PR: 0.8.14 on a branch of its own.
  sh(checkout, 'switch', '--quiet', '-c', 'claude/a-fix');
  for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(checkout, f), readFileSync(path.join(checkout, f), 'utf8').split('0.8.13').join('0.8.14'));
  sh(checkout, 'commit', '--quiet', '-am', 'Steward 0.8.14: a fix');
  sh(checkout, 'push', '--quiet', 'origin', 'claude/a-fix', 'HEAD:refs/pull/47/head');
  const headOid = sh(checkout, 'rev-parse', 'HEAD');
  sh(checkout, 'switch', '--quiet', 'main');
  const listed = [{ number: 47, title: 'Steward 0.8.14: a fix', url: 'https://github.com/Jcollier0120/Steward/pull/47', body: '', headRefName: 'claude/a-fix', headRefOid: headOid, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [], labels: [], additions: 3, deletions: 3, files: [] }];
  const npm: string[] = [];
  const r = runner((a) => {
    if (a[0] === 'pr' && a[1] === 'list') return ok(listed);
    if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.8.13', isDraft: false, publishedAt: '2026-10-05T00:00:00Z' }, { tagName: 'kit-v2.13.0', isDraft: false, publishedAt: '2026-10-05T00:00:00Z' }]);
    return ok('');
  });
  // npm stands in: its packages "installed", the kit filled, the checks passing.
  const run: import('../src/run.ts').Runner = async (cmd, args, opts) => {
    if (cmd === 'npm') {
      npm.push(args.join(' '));
      mkdirSync(path.join(opts!.cwd!, 'node_modules'), { recursive: true });
      return ok('');
    }
    return r.run(cmd, args, opts);
  };
  const ctx = ctxFor({ employees: [], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const out = await mergeOne(ctx, stewardEmployee(ctx.settings, checkout), { yes: true, team: true });
  assert.equal(out.outcome, 'done', `${out.message}\n${ctx.lines.join('\n')}`);
  assert.deepEqual(out.merged.map((p) => p.number), [47]);
  assert.match(out.message, /merged #47 \(checks passed here at .{7}\)/);
  assert.ok(npm.includes('run kit') && npm.includes('run typecheck') && npm.includes('test'), npm.join('; '));
  const merge = r.gh.find((a) => a[0] === 'pr' && a[1] === 'merge')!;
  assert.deepEqual(merge.slice(0, 5), ['pr', 'merge', '47', '--repo', 'Jcollier0120/Steward']);
  assert.ok(!merge.includes('--delete-branch'), "a team member's branch stays");
});

test("a PR that raises the kit merges first, ahead of a lower version that doesn't", async () => {
  const dir = path.join(home, 'steward-kit-first');
  const { checkout } = fakeEmployee(dir, { version: '0.8.13', kit: null });
  // Two PRs: #48 sets 0.8.14 and leaves the kit alone; #49 sets 0.8.15 and raises the kit.
  const pr = (n: number, branch: string, version: string, kit: boolean) => {
    sh(checkout, 'switch', '--quiet', '-c', branch, 'main');
    for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(checkout, f), readFileSync(path.join(checkout, f), 'utf8').split('0.8.13').join(version));
    if (kit) {
      mkdirSync(path.join(checkout, 'kit'), { recursive: true });
      writeFileSync(path.join(checkout, 'kit', 'VERSION'), '2.14.0\n');
      sh(checkout, 'add', 'kit/VERSION');
    }
    sh(checkout, 'commit', '--quiet', '-am', `Steward ${version}`);
    sh(checkout, 'push', '--quiet', 'origin', branch, `HEAD:refs/pull/${n}/head`);
    const headOid = sh(checkout, 'rev-parse', 'HEAD');
    sh(checkout, 'switch', '--quiet', 'main');
    const files = ['package.json', 'package-lock.json', 'src/app.ts', ...(kit ? ['kit/VERSION'] : [])];
    return { number: n, title: `Steward ${version}${kit ? ', kit 2.14.0' : ''}: a change`, url: `https://github.com/Jcollier0120/Steward/pull/${n}`, body: '', headRefName: branch, headRefOid: headOid, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [], labels: [], additions: 3, deletions: 3, files: files.map((path) => ({ path })) };
  };
  const listed = [pr(48, 'claude/plain', '0.8.14', false), pr(49, 'claude/kit', '0.8.15', true)];
  const r = runner((a) => {
    if (a[0] === 'pr' && a[1] === 'list') return ok(listed);
    if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.8.13', isDraft: false, publishedAt: '2026-10-05T00:00:00Z' }, { tagName: 'kit-v2.13.0', isDraft: false, publishedAt: '2026-10-05T00:00:00Z' }]);
    return ok('');
  });
  const run: import('../src/run.ts').Runner = async (cmd, args, opts) => {
    if (cmd === 'npm') {
      mkdirSync(path.join(opts!.cwd!, 'node_modules'), { recursive: true });
      return ok('');
    }
    return r.run(cmd, args, opts);
  };
  const ctx = ctxFor({ employees: [], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const out = await mergeOne(ctx, stewardEmployee(ctx.settings, checkout), { yes: true, team: true });
  assert.equal(out.outcome, 'done', `${out.message}\n${ctx.lines.join('\n')}`);
  assert.deepEqual(r.gh.filter((a) => a[0] === 'pr' && a[1] === 'merge').map((a) => a[2]), ['49', '48'], 'the kit first, though its version is the higher');
});
