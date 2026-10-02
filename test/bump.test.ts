import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { bumpBranch } from '../src/stages/common.ts';
import { bumpOne, repin } from '../src/stages/bump.ts';
import { prBody, pushOne } from '../src/stages/push.ts';
import { ctxFor, employee, fakeEmployee, ok, runner, sh } from './helpers.ts';

// The bump stage on a fake employee made with git in a temporary folder: a worktree of origin's main,
// kit.json and the version changed there, its kit filled and its checks run, then a commit; and push,
// with gh standing in.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-bump-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const kitTool = readFileSync(new URL('../tools/kit.ts', import.meta.url), 'utf8');

/** A kit tree at 1.0.1, as a kit release would hold it. */
const kitFrom = path.join(tmp, 'kit-1.0.1');
mkdirSync(path.join(kitFrom, 'node'), { recursive: true });
writeFileSync(path.join(kitFrom, 'node', 'npu.ts'), 'export const npu = 1;\n');
writeFileSync(path.join(kitFrom, 'VERSION'), '1.0.1\n');

let n = 0;
function setup(o: Parameters<typeof fakeEmployee>[1] = {}, more: Parameters<typeof employee>[1] = {}) {
  const dir = path.join(tmp, `case-${++n}`);
  const f = fakeEmployee(dir, { ...o, files: { 'tools/kit.ts': kitTool, ...o.files } });
  const r = runner();
  const e = employee(f.checkout, more);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, released: ['1.0.1'], neutralDir: dir });
  return { ...f, e, ctx, r, dir, work: path.join(dir, 'work', 'fake') };
}

test('a bump: a worktree of origin/main on steward/kit-<version>, kit.json and the version changed, the kit filled, checks run, committed', async () => {
  const s = setup();
  const res = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'done', `${res.message}\n${s.ctx.lines.join('\n')}`);
  assert.equal(res.version, '0.4.1');
  const branch = bumpBranch('1.0.1');
  assert.equal(branch, 'steward/kit-1.0.1');
  // The commit: exactly kit.json and the three version files.
  assert.deepEqual(sh(s.checkout, 'diff', '--name-only', 'origin/main', branch).split('\n').sort(), ['kit.json', 'package-lock.json', 'package.json', 'src/app.ts']);
  assert.equal(sh(s.checkout, 'show', `${branch}:kit.json`), '{\n  "kit": "1.0.1",\n  "parts": ["node"]\n}');
  assert.match(sh(s.checkout, 'show', `${branch}:src/app.ts`), /version: '0\.4\.1'/);
  assert.equal(JSON.parse(sh(s.checkout, 'show', `${branch}:package-lock.json`)).packages[''].version, '0.4.1');
  assert.equal(sh(s.checkout, 'log', '-1', '--format=%s', branch), "Fake 0.4.1: the Steward's kit 1.0.1");
  // The worktree has the kit it was checked with; the person's checkout is as it was.
  assert.equal(readFileSync(path.join(s.work, 'src', 'kit', 'VERSION'), 'utf8').trim(), '1.0.1');
  assert.equal(sh(s.checkout, 'branch', '--show-current'), 'main');
  assert.equal(sh(s.checkout, 'status', '--porcelain'), '');
  assert.equal(readFileSync(path.join(s.checkout, 'kit.json'), 'utf8').includes('1.0.0'), true);
  // Again, before it's pushed: made afresh, not stacked.
  const again = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(again.outcome, 'done', again.message);
  assert.equal(sh(s.checkout, 'rev-list', '--count', `origin/main..${branch}`), '1');
});

test('push: the branch goes to origin (never forced) and a PR is opened with the title and the changelog', async () => {
  const s = setup();
  assert.equal((await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom })).outcome, 'done');
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok([]);
    if (args[0] === 'pr' && args[1] === 'create') return ok('https://github.com/Jcollier0120/Fake/pull/7\n');
  });
  const ctx = { ...s.ctx, run: r.run };
  const changelog = '## 1.0.1\n\n- the fix\n\n## 1.0.0\n\n- the first\n';
  const res = await pushOne(ctx, s.e, { kit: '1.0.1', changelog });
  assert.equal(res.outcome, 'done', res.message);
  assert.equal(res.url, 'https://github.com/Jcollier0120/Fake/pull/7');
  assert.equal(sh(s.origin, 'rev-parse', 'refs/heads/steward/kit-1.0.1'), sh(s.checkout, 'rev-parse', 'steward/kit-1.0.1'));
  const create = r.gh.find((a) => a[1] === 'create')!;
  assert.equal(create[create.indexOf('--title') + 1], "Fake 0.4.1: the Steward's kit 1.0.1");
  assert.equal(create[create.indexOf('--base') + 1], 'main');
  const body = create[create.indexOf('--body') + 1];
  assert.match(body, /## 1\.0\.1\n\n- the fix/);
  assert.doesNotMatch(body, /the first/, 'only the entries after the kit it had');
  // Pushed again with nothing new: no second PR.
  const r2 = runner((args) => (args[1] === 'list' ? ok([{ number: 7, url: 'https://github.com/Jcollier0120/Fake/pull/7' }]) : undefined));
  const again = await pushOne({ ...s.ctx, run: r2.run }, s.e, { kit: '1.0.1', changelog });
  assert.match(again.message, /#7 was already open/);
  assert.ok(!r2.gh.some((a) => a[1] === 'create'));
});

test('a branch already on origin is never bumped again: its PR comes first', async () => {
  const s = setup();
  assert.equal((await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom })).outcome, 'done');
  sh(s.checkout, 'push', '--quiet', 'origin', 'steward/kit-1.0.1');
  const res = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'refused');
  assert.match(res.message, /already on origin/);
});

test('failing checks leave the worktree for a look, and commit nothing', async () => {
  const s = setup({}, { test: ['node -e process.exit(3)'] });
  const res = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'failed');
  assert.match(res.message, /exit 3/);
  assert.equal(sh(s.checkout, 'rev-list', '--count', 'origin/main..steward/kit-1.0.1'), '0');
  assert.ok(existsSync(path.join(s.work, 'kit.json')));
});

test('already on the kit: skipped; not taking the kit: skipped; still carrying the old kit: refused', async () => {
  const on = setup({ kit: '1.0.1' });
  assert.deepEqual([(await bumpOne(on.ctx, on.e, { kit: '1.0.1' })).outcome], ['skipped']);
  const reeve = setup({}, { usesKit: false });
  const r = await bumpOne(reeve.ctx, reeve.e, { kit: '1.0.1' });
  assert.equal(r.outcome, 'skipped');
  assert.equal(r.message, 'not using the kit yet');
  const old = setup({ kit: null, files: { 'src/npu.ts': 'export {}', 'tools/release.ts': '' } });
  const o = await bumpOne(old.ctx, old.e, { kit: '1.0.1' });
  assert.equal(o.outcome, 'refused');
  assert.match(o.message, /still carries the old kit \(2 files, src\/npu\.ts …\): convert it/);
  const none = setup({ kit: null });
  assert.match((await bumpOne(none.ctx, none.e, { kit: '1.0.1' })).message, /has no kit\.json/);
});

test("version files that disagree stop a bump before anything is run", async () => {
  const s = setup({ files: { 'src/app.ts': "export const APP = { version: '0.3.9' };\n" } });
  const res = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'failed');
  assert.match(res.message, /disagree/);
});

test('kit.json keeps its parts and anything else when its pin moves; the PR body says where the kit comes from', () => {
  assert.equal(repin('{"kit":"1.0.0","parts":["node","spec"],"note":"x"}', '1.1.0'), '{\n  "kit": "1.1.0",\n  "parts": ["node", "spec"],\n  "note": "x"\n}\n');
  const body = prBody({ kit: '1.1.0', from: '1.0.0', version: '0.4.2', changelog: null, files: ['kit.json', 'package.json'], fill: 'node tools/kit.ts' });
  assert.match(body, /`node tools\/kit\.ts` fills it from the kit release kit-v1\.1\.0/);
  assert.match(body, /See the Steward's kit\/CHANGELOG\.md for 1\.1\.0/);
});
