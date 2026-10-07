import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { bumpBranch } from '../src/stages/common.ts';
import { bumpOne, kitBumpEntry, repin } from '../src/stages/bump.ts';
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
  // The commit: exactly kit.json, the three version files and the changelog, started with the new version's entry.
  assert.deepEqual(sh(s.checkout, 'diff', '--name-only', 'origin/main', branch).split('\n').sort(), ['CHANGELOG.md', 'kit.json', 'package-lock.json', 'package.json', 'src/app.ts']);
  const log = sh(s.checkout, 'show', `${branch}:CHANGELOG.md`).replace(/\r\n/g, '\n');
  assert.match(log, /^# Fake's changelog\n/);
  assert.match(log, /\n## 0\.4\.1\n\n\*\*It carries the Steward's kit 1\.0\.1: /);
  assert.match(log, /### What changed\n\n- The Steward's kit 1\.0\.1, after 1\.0\.0: see its changelog/);
  assert.match(log, /### Before you update\n\nNothing: it updates itself as usual\.$/);
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
  assert.match(res.message, /exit 3\), twice; the worktree is left at .*, the failed step's whole output in .*fake\.log$/);
  assert.equal(sh(s.checkout, 'rev-list', '--count', 'origin/main..steward/kit-1.0.1'), '0');
  assert.ok(existsSync(path.join(s.work, 'kit.json')));
  assert.match(readFileSync(`${s.work}.log`, 'utf8'), /^node -e process\.exit\(3\) \(exit 3\)/);
});

// A test runner's TAP: the failed test is far above the last lines a log keeps.
const tap = [
  'TAP version 13',
  '# Subtest: the first',
  'ok 1 - the first',
  '# Subtest: each request came after its warm-up',
  'not ok 2 - each request came after its warm-up',
  '  ---',
  "  failureType: 'testCodeFailure'",
  '  error: |-',
  '    each request came after its warm-up',
  '    ',
  '    5 !== 8',
  '    ',
  "  code: 'ERR_ASSERTION'",
  '  ...',
  ...Array.from({ length: 40 }, (_, i) => `ok ${i + 3} - later ${i}`),
  '# fail 1',
].join('\n');

test("a failure's message names the failed tests and their errors; a test that fails once and then passes doesn't stop the bump", async () => {
  const failing = setup({ files: { 'tap.mjs': `console.log(${JSON.stringify(tap)}); process.exit(1);\n` } }, { test: ['node tap.mjs'] });
  const res = await bumpOne(failing.ctx, failing.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'failed');
  assert.match(res.message, /^node tap\.mjs failed \(exit 1\): "each request came after its warm-up" \(each request came after its warm-up: 5 !== 8\), twice;/);
  assert.ok(failing.ctx.lines.some((l) => l.endsWith('failed: each request came after its warm-up (each request came after its warm-up: 5 !== 8)')));

  // Fails the first time it's run in this worktree, then passes.
  const flaky = `import { existsSync, writeFileSync } from 'node:fs';\nif (!existsSync('.ran')) { writeFileSync('.ran', ''); console.log(${JSON.stringify(tap)}); process.exit(1); }\n`;
  const s = setup({ files: { 'flaky.mjs': flaky } }, { test: ['node flaky.mjs'] });
  const ok2 = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(ok2.outcome, 'done', ok2.message);
  assert.match(ok2.message, /checks passed on a second try \(the first: node flaky\.mjs failed \(exit 1\): "each request came after its warm-up"/);
  assert.match(sh(s.checkout, 'log', '-1', '--format=%b', 'steward/kit-1.0.1'), /Its checks passed on a second try; the first failed: node flaky\.mjs/);
  assert.ok(existsSync(`${s.work}.log`), "the first try's output stays");
  // Bumped again from scratch: the old output goes with the old worktree.
  const s2 = await bumpOne(s.ctx, { ...s.e, test: ['node -e 0'] }, { kit: '1.0.1', kitFrom });
  assert.equal(s2.outcome, 'done', s2.message);
  assert.ok(!existsSync(`${s.work}.log`));
});

test('already on the kit: skipped; not taking the kit: skipped; no kit.json: refused', async () => {
  const on = setup({ kit: '1.0.1' });
  assert.deepEqual([(await bumpOne(on.ctx, on.e, { kit: '1.0.1' })).outcome], ['skipped']);
  const reeve = setup({}, { usesKit: false });
  const r = await bumpOne(reeve.ctx, reeve.e, { kit: '1.0.1' });
  assert.equal(r.outcome, 'skipped');
  assert.equal(r.message, 'not using the kit yet');
  const none = setup({ kit: null });
  assert.match((await bumpOne(none.ctx, none.e, { kit: '1.0.1' })).message, /has no kit\.json/);
  // Every hire took the kit long ago: the old kit's files are never looked for, in a hire or anyone else.
  const own = setup({ kit: null, files: { 'src/npu.ts': 'export {}', 'tools/release.ts': '' } }, { id: 'porter', name: 'Porter' });
  const o = await bumpOne(own.ctx, own.e, { kit: '1.0.1' });
  assert.deepEqual([o.outcome, o.message], ['refused', 'origin/main has no kit.json']);
});

test("Reeve's own files at the old kit's paths don't stop its bump", async () => {
  const own = ['src/accelerators.ts', 'src/duty.ts', 'src/install.ts', 'tools/release.ts', 'test/accelerators.test.ts', 'test/install.test.ts'];
  const s = setup(
    { version: '0.3.0', files: { ...Object.fromEntries(own.map((p) => [p, `// Reeve's own ${p}\n`])), 'src/mcp.ts': "export const SERVER = { name: 'reeve', version: '0.3.0' };\n" } },
    { id: 'reeve', name: 'Reeve', versionFiles: ['package.json', 'package-lock.json', 'src/mcp.ts'] },
  );
  const res = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'done', `${res.message}\n${s.ctx.lines.join('\n')}`);
  assert.equal(res.version, '0.3.1');
  assert.deepEqual(sh(s.checkout, 'diff', '--name-only', 'origin/main', 'steward/kit-1.0.1').split('\n').sort(), ['CHANGELOG.md', 'kit.json', 'package-lock.json', 'package.json', 'src/mcp.ts']);
  for (const p of own) assert.equal(sh(s.checkout, 'show', `steward/kit-1.0.1:${p}`), `// Reeve's own ${p}`, `${p} is still there`);
});

test("tools/kit.ts rides with the pin: an agent's old one is replaced with the Steward's before its kit is filled, and committed", async () => {
  // An old tools/kit.ts that can't fill anything: the bump must not run it.
  const s = setup({ files: { 'tools/kit.ts': "console.error('the old tool'); process.exit(9);\n" } });
  const res = await bumpOne(s.ctx, s.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'done', `${res.message}\n${s.ctx.lines.join('\n')}`);
  assert.match(res.message, /tools\/kit\.ts updated/);
  const branch = 'steward/kit-1.0.1';
  assert.deepEqual(sh(s.checkout, 'diff', '--name-only', 'origin/main', branch).split('\n').sort(), ['CHANGELOG.md', 'kit.json', 'package-lock.json', 'package.json', 'src/app.ts', 'tools/kit.ts']);
  assert.equal(sh(s.checkout, 'show', `${branch}:tools/kit.ts`), kitTool.replace(/\r\n/g, '\n').trimEnd(), "the Steward's own, byte for byte (LF)");
  assert.match(sh(s.checkout, 'log', '-1', '--format=%b', branch), /tools\/kit\.ts is the Steward's\./);
  assert.equal(readFileSync(path.join(s.work, 'src', 'kit', 'VERSION'), 'utf8').trim(), '1.0.1', 'the new tool filled the kit');
  // push says so in the PR.
  const r = runner((args) => (args[1] === 'list' ? ok([]) : args[1] === 'create' ? ok('https://github.com/Jcollier0120/Fake/pull/8\n') : undefined));
  assert.equal((await pushOne({ ...s.ctx, run: r.run }, s.e, { kit: '1.0.1', changelog: null })).outcome, 'done');
  const create = r.gh.find((a) => a[1] === 'create')!;
  const body = create[create.indexOf('--body') + 1];
  assert.match(body, /the version is 0\.4\.1 in package\.json, package-lock\.json, src\/app\.ts\. tools\/kit\.ts is the Steward's/);
});

test("an agent that doesn't fill with tools/kit.ts gets none; with no tools/kit.ts to hand out, a Node agent is refused", async () => {
  const other = setup({}, { fill: 'node -e process.exit(0)' });
  const res = await bumpOne(other.ctx, other.e, { kit: '1.0.1', kitFrom });
  assert.equal(res.outcome, 'done', res.message);
  assert.doesNotMatch(res.message, /tools\/kit\.ts/);
  const none = setup();
  const r = await bumpOne(none.ctx, none.e, { kit: '1.0.1', kitFrom, tool: path.join(tmp, 'no-such-kit.ts') });
  assert.equal(r.outcome, 'refused');
  assert.match(r.message, /has no tools\/kit\.ts to hand out/);
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

test("a bump's changelog entry: each kit version's headline since the one it pinned, and their Before you update", () => {
  const kitLog = [
    '## 1.0.3',
    '',
    '**Pages use the whole window.** More.',
    '',
    '## 1.0.2',
    '',
    '**Offline is waited out.** More.',
    '',
    '### Before you update',
    '',
    '- Close its page first.',
    '',
    '## 1.0.1',
    '',
    '**Already had.**',
    '',
  ].join('\n');
  const e = kitBumpEntry({ version: '0.4.7', from: '1.0.1', kit: '1.0.3', changelog: kitLog });
  assert.equal(
    e,
    [
      '## 0.4.7',
      '',
      "**It carries the Steward's kit 1.0.3: the parts every agent of the manor shares.**",
      '',
      '### What changed',
      '',
      "- The Steward's kit 1.0.3: Pages use the whole window.",
      "- The Steward's kit 1.0.2: Offline is waited out.",
      '',
      '### Before you update',
      '',
      '- Close its page first.',
    ].join('\n'),
  );
  // A kit entry whose Before you update is "Nothing" adds nothing to it.
  assert.match(kitBumpEntry({ version: '0.4.7', from: '1.0.2', kit: '1.0.3', changelog: kitLog.replace('**Pages use the whole window.** More.', '**Pages.**\n\n### Before you update\n\nNothing: it updates itself as usual.') }), /### Before you update\n\nNothing: it updates itself as usual\.$/);
  assert.match(kitBumpEntry({ version: '0.4.7', from: '1.0.3', kit: '1.0.1', changelog: kitLog }), /a step back[\s\S]*- A step back to the Steward's kit 1\.0\.1, from 1\.0\.3\./);
});
