import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Claim } from '../src/claims.ts';

// The switch to the build pipeline (Steward 0.36.248) on a fake employee made with git. The kit PR that puts it on the
// pipeline (bump.ts pipelineWay) sets no version, so a PR opened before the switch, which set its version itself, and one
// opened after, which writes its entry in changes/, both merge cleanly beside it, in either order; the build's stamp
// (stamp.ts) waits for the old-way PR next in line, then gives every entry one version. One on the newest kit already is
// put on the pipeline by a PR of the Steward's own (onpipeline.ts). gh stands in for GitHub; a person's PRs are merged
// with git, as GitHub merges them.
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'steward-switch-over-')));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { CHANGES_README, changesReadme, fragmentFor } = await import('../src/entries.ts');
const { bumpOne } = await import('../src/stages/bump.ts');
const { oldWayFirst, stampMain } = await import('../src/stages/stamp.ts');
const { onPipeline } = await import('../src/stages/onpipeline.ts');
const { planRollout } = await import('../src/stages/rollout.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const REPO = 'Jcollier0120/Fake';
const ENTRY = (line: string) => `**${line}**\n\n### What changed\n\n- ${line}\n\n### Before you update\n\n- Nothing: it updates itself as usual.\n`;
const headings = (text: string) => text.split(/\r?\n/).filter((l) => l.startsWith('## '));
const kitTool = readFileSync(new URL('../tools/kit.ts', import.meta.url), 'utf8');

/** A kit tree at 1.0.1, as a kit release would hold it. */
const kitFrom = path.join(tmp, 'kit-1.0.1');
mkdirSync(path.join(kitFrom, 'node'), { recursive: true });
writeFileSync(path.join(kitFrom, 'node', 'npu.ts'), 'export const npu = 1;\n');
writeFileSync(path.join(kitFrom, 'VERSION'), '1.0.1\n');

/** A PR made the old way, before the switch: its version set to `v` everywhere, its own entry in CHANGELOG.md. */
const toVersion = (v: string) => (t: string) => t.replace(/"version": "0\.4\.0"/g, `"version": "${v}"`).replace(/version: '0\.4\.0'/, `version: '${v}'`);
const OLD_WAY = {
  'package.json': toVersion('0.4.1'),
  'package-lock.json': toVersion('0.4.1'),
  'src/app.ts': toVersion('0.4.1'),
  'CHANGELOG.md': (t: string) => t.replace(/^(# .*\n\n)/, `$1## 0.4.1\n\n${ENTRY('Before the switch.')}\n`),
  'src/before.ts': () => 'export const before = 1;\n',
};
/** A PR made after it: its entry in changes/, named by its branch, and no version file nor CHANGELOG.md touched. */
const NEW_WAY = { [fragmentFor('claude/after')]: () => ENTRY('After the switch.'), 'src/after.ts': () => 'export const after = 1;\n' };

/**
 * Fake at 0.4.0 (released) on kit 1.0.0, not on the build pipeline yet, with a person's clone beside it (`author`) to
 * open PRs from and merge them as GitHub does. GitHub stands in for the Steward's own PRs: opened as #20, #21…, listed
 * while open (with any `prs` a test adds), merged by moving main to their head; no commit vouched for.
 */
function repo(name: string) {
  const dir = path.join(tmp, name);
  const f = fakeEmployee(dir, { files: { 'tools/kit.ts': kitTool, 'CHANGELOG.md': "# Fake's changelog\n\n## 0.4.0\n\n**First.**\n" } });
  const author = path.join(dir, 'author');
  // Its files as committed, whatever this PC's git does with line ends: else its first commit would rewrite every one.
  sh(dir, 'clone', '--quiet', '-c', 'core.autocrlf=false', f.origin, author);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid' })) sh(author, 'config', k, v);
  const prs: { number: number; branch: string; open: boolean }[] = [];
  const url = (n: number) => `https://github.com/${REPO}/pull/${n}`;
  const r = runner((a) => {
    if (a[0] === 'api' && /\/statuses\?per_page=100$/.test(a[1] ?? '')) return ok([]);
    if (a[0] === 'release' && a[1] === 'list') return ok([]);
    if (a[0] === 'pr' && a[1] === 'create') {
      const branch = a[a.indexOf('--head') + 1];
      const number = 20 + prs.length;
      prs.push({ number, branch, open: true });
      return ok(`${url(number)}\n`);
    }
    if (a[0] === 'pr' && a[1] === 'list') return ok(prs.filter((p) => p.open).map((p) => ({ number: p.number, headRefName: p.branch, headRefOid: sh(f.origin, 'rev-parse', `refs/heads/${p.branch}`), url: url(p.number) })));
    if (a[0] === 'pr' && a[1] === 'merge') {
      const p = prs.find((x) => x.number === Number(a[2]))!;
      const at = sh(f.origin, 'rev-parse', `refs/heads/${p.branch}`);
      if (a[a.indexOf('--match-head-commit') + 1] !== at) return { code: 1, out: '', err: 'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)' };
      sh(f.origin, 'update-ref', 'refs/heads/main', at);
      if (a.includes('--delete-branch')) sh(f.origin, 'update-ref', '-d', `refs/heads/${p.branch}`);
      p.open = false;
      return ok('');
    }
  });
  const e = employee(f.checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, released: ['1.0.1'], neutralDir: dir });
  /** A PR's branch from origin's main as it is now, each file of `files` written from what it was: its head. */
  const open = (branch: string, files: Record<string, (was: string) => string>) => {
    sh(author, 'fetch', '--quiet', 'origin');
    sh(author, 'checkout', '--quiet', '-B', branch, 'origin/main');
    for (const [file, edit] of Object.entries(files)) {
      const p = path.join(author, file);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, edit(existsSync(p) ? readFileSync(p, 'utf8') : ''));
    }
    sh(author, 'add', '-A');
    sh(author, 'commit', '--quiet', '-m', branch);
    sh(author, 'push', '--quiet', 'origin', branch);
    return sh(author, 'rev-parse', 'HEAD');
  };
  /** The PR from `branch` merged as GitHub merges one, a merge commit on main: null, or why git couldn't. */
  const land = (branch: string) => {
    sh(author, 'fetch', '--quiet', 'origin');
    sh(author, 'checkout', '--quiet', '-B', 'main', 'origin/main');
    try {
      sh(author, 'merge', '--quiet', '--no-ff', '--no-edit', `origin/${branch}`);
    } catch (err) {
      const why = `${(err as Error).message}\n${(err as { stdout?: string }).stdout ?? ''}`.trim();
      sh(author, 'merge', '--abort');
      return why;
    }
    sh(author, 'push', '--quiet', 'origin', 'main');
    return null;
  };
  /** The Steward's kit PR for kit 1.0.1, bumped from origin's main as it is now and pushed. */
  const kitPr = async () => {
    const b = await bumpOne(ctx, e, { kit: '1.0.1', kitFrom });
    assert.equal(b.outcome, 'done', `${b.message}\n${ctx.lines.join('\n')}`);
    assert.equal(b.version, undefined, 'no version of its own');
    sh(f.checkout, 'push', '--quiet', 'origin', 'steward/kit-1.0.1');
    return 'steward/kit-1.0.1';
  };
  const at = (rev: string, file: string) => sh(f.origin, 'show', `${rev}:${file}`);
  return { ...f, author, e, ctx, r, prs, open, land, kitPr, at, main: () => sh(f.origin, 'rev-parse', 'refs/heads/main') };
}

/** The old-way PR's claim of v0.4.1, as passover.ts marks one next in line on its repository (or passed over). */
function inLine(head: string, more: Partial<Claim> = {}): Claim {
  return { repo: REPO, version: '0.4.1', branch: 'claude/before', by: 'claude', for: 'Before the switch', at: '2026-10-26T09:00:00Z', line: { pr: 12, since: '2026-10-26T09:30:00Z', head, kind: 'pending', why: 'its checks are running' }, ...more };
}

/** Main stamped once every PR is in: v0.4.1 (the old-way PR's, not released yet) with every entry in its own entry. */
function stampedTogether(p: ReturnType<typeof repo>) {
  const main = p.main();
  assert.deepEqual([JSON.parse(p.at(main, 'package.json')).version, JSON.parse(p.at(main, 'package-lock.json')).packages[''].version], ['0.4.1', '0.4.1']);
  assert.match(p.at(main, 'src/app.ts'), /version: '0\.4\.1'/);
  const changelog = p.at(main, 'CHANGELOG.md');
  assert.deepEqual(headings(changelog), ['## 0.4.1', '## 0.4.0'], 'one entry for the one version');
  assert.match(changelog, /## 0\.4\.1\n\n\*\*Brings 3 changes: Before the switch; /);
  for (const line of ['- Before the switch.', '- After the switch.', "- The Steward's kit 1.0.1, after 1.0.0"]) assert.ok(changelog.includes(line), `${line} in\n${changelog}`);
  assert.equal(sh(p.origin, 'ls-tree', '-r', '--name-only', main, 'changes/'), CHANGES_README, 'the entries gone, the README kept');
  for (const file of ['src/before.ts', 'src/after.ts']) assert.ok(p.at(main, file));
  assert.equal(JSON.parse(p.at(main, 'kit.json')).kit, '1.0.1');
}

test("the switch-over, the kit PR first: a PR from before it (its version set) and one from after (its entry in changes/) both merge cleanly; the stamp waits for the old-way PR next in line, then gives them its version", async () => {
  const p = repo('kit-first');
  // Opened before the switch: v0.4.1 claimed and set, its entry in CHANGELOG.md.
  const before = p.open('claude/before', OLD_WAY);
  // The kit PR puts Fake on the build pipeline, and merges.
  assert.equal(p.land(await p.kitPr()), null);
  assert.deepEqual(sh(p.origin, 'ls-tree', '-r', '--name-only', p.main(), 'changes/').split('\n'), [CHANGES_README, 'changes/steward-kit-1-0-1.md']);
  // Opened after it: an entry in changes/, named by its branch. It merges.
  p.open('claude/after', NEW_WAY);
  assert.equal(p.land('claude/after'), null);

  // A build now: the old-way PR is next in line, above main's version, so main's entries wait for it rather than take
  // the version lines it changes too. Nothing is pushed or opened.
  const waiting = p.main();
  const claims = [inLine(before)];
  const w = await stampMain(p.ctx, p.e, { released: ['0.4.0'], taken: ['0.4.1'], inLine: claims });
  assert.equal(w?.done, false);
  assert.equal(w?.skipped, true);
  assert.match(w!.note, new RegExp(`^its changes/ entries on main at ${waiting.slice(0, 7)} wait for #12 \\(v0\\.4\\.1\\), which sets its version itself and is next in line: merged first, it takes them into its release`));
  assert.ok(!p.r.gh.some((a) => a[1] === 'create'), 'no stamp opened');
  assert.equal(p.main(), waiting);

  // It merges cleanly, beside both: neither touched a version line nor CHANGELOG.md.
  assert.equal(p.land('claude/before'), null);
  // The next build: main carries v0.4.1 now, so nothing is waited for, and the entries join its release.
  const s = await stampMain(p.ctx, p.e, { released: ['0.4.0'], taken: ['0.4.1'], inLine: claims });
  assert.equal(s?.done, true, `${s?.note}\n${p.ctx.lines.join('\n')}`);
  assert.equal(s?.version, '0.4.1');
  stampedTogether(p);
});

test('the switch-over, the old-way PR first: it merges, then the kit PR made before it merges cleanly on top, and the PR after it; one stamp gives them all v0.4.1', async () => {
  const p = repo('old-way-first');
  const before = p.open('claude/before', OLD_WAY);
  const kit = await p.kitPr();
  assert.equal(p.land('claude/before'), null);
  // Made from v0.4.0's main, it changes kit.json and changes/ alone: no line the old-way PR changed.
  assert.equal(p.land(kit), null);
  p.open('claude/after', NEW_WAY);
  assert.equal(p.land('claude/after'), null);
  const s = await stampMain(p.ctx, p.e, { released: ['0.4.0'], taken: ['0.4.1'], inLine: [inLine(before)] });
  assert.equal(s?.done, true, `${s?.note}\n${p.ctx.lines.join('\n')}`);
  assert.equal(s?.version, '0.4.1');
  stampedTogether(p);
});

test('oldWayFirst: main waits only for an old-way PR next in line, above its version, unreleased and not passed over, and only while it has entries', async () => {
  const p = repo('waits');
  sh(p.checkout, 'fetch', '--quiet', 'origin');
  const head = p.main();
  const files = [CHANGES_README, fragmentFor('claude/after')];
  const ask = (inLine: Claim[], o: { released?: string[]; files?: string[] } = {}) => oldWayFirst(p.ctx, p.e, { head, files: o.files ?? files, inLine, released: o.released ?? ['0.4.0'] });

  assert.match((await ask([inLine('a'.repeat(40))]))!, /^#12 \(v0\.4\.1\), which sets its version itself and is next in line/);
  // Stuck there an hour, it was passed over (passover.ts): main goes ahead, and passover re-versions it once main passes it.
  const passed = { pr: 12, url: `https://github.com/${REPO}/pull/12`, since: '2026-10-26T09:30:00Z', at: '2026-10-26T10:30:00Z', head: 'a'.repeat(40), from: '0.4.1', kind: 'failing' as const, why: 'its checks failed' };
  assert.equal(await ask([inLine('a'.repeat(40), { passed })]), null);
  // Its version released already, or at or below main's: it merged, or main has gone past it.
  assert.equal(await ask([inLine('a'.repeat(40))], { released: ['0.4.0', '0.4.1'] }), null);
  assert.equal(await ask([inLine('a'.repeat(40), { version: '0.4.0' })]), null);
  // Claimed, but not next in line: nothing to wait for.
  assert.equal(await ask([{ ...inLine('a'.repeat(40)), line: undefined }]), null);
  // Main carries no entries: nothing to stamp, nothing waits.
  assert.equal(await ask([inLine('a'.repeat(40))], { files: [CHANGES_README] }), null);
});

test("onPipeline: one worked with plain git is left on the old way; a pipeline PR an earlier build left open is merged, not another opened; then it's on the pipeline already", async () => {
  const p = repo('on-pipeline');
  const git = await onPipeline({ ...p.ctx, host: () => 'git' as const }, p.e);
  assert.deepEqual([git.outcome, git.message], ['skipped', 'it is worked with plain git, where the Steward opens no PRs, so it keeps setting its version in each change']);
  assert.deepEqual(p.r.gh, []);

  // An earlier build pushed and opened #19, but GitHub wouldn't merge it then.
  p.open('steward/pipeline-0123456', { [CHANGES_README]: () => changesReadme('Fake') });
  p.prs.push({ number: 19, branch: 'steward/pipeline-0123456', open: true });
  const r = await onPipeline(p.ctx, p.e);
  assert.deepEqual([r.outcome, r.message, r.url], ['done', 'merged its PR #19 onto the build pipeline, left open by an earlier build', `https://github.com/${REPO}/pull/19`]);
  assert.ok(!p.r.gh.some((a) => a[1] === 'create'), 'none opened beside it');
  assert.equal(p.at(p.main(), CHANGES_README), changesReadme('Fake').trimEnd());

  const again = await onPipeline(p.ctx, p.e);
  assert.deepEqual([again.outcome, again.message], ['skipped', 'on the build pipeline already (changes/README.md on main)']);
});

test("planRollout: one on the kit already and not on the build pipeline is put on it; one on it already, retired, or behind the kit (whose bump carries the file) isn't; nothing while the rollout can't run", () => {
  const at = (id: string) => employee(path.join(tmp, 'plan', id), { id, name: id });
  const [toPipeline, onIt, retired, behind] = ['to-pipeline', 'on-it', 'retired', 'behind'].map(at);
  const head = 'b'.repeat(40);
  const facts = {
    'to-pipeline': { checkout: true, head, pin: '1.0.1', kitPrs: [], toPipeline: true },
    'on-it': { checkout: true, head, pin: '1.0.1', kitPrs: [] },
    retired: { checkout: true, head, pin: '1.0.1', kitPrs: [], toPipeline: true },
    behind: { checkout: true, head, pin: '1.0.0', kitPrs: [] },
  };
  const o = { on: true, kit: '1.0.1', ownKit: '1.0.1', employees: [toPipeline, onIt, retired, behind], facts, failed: {}, retired: new Set(['retired']) };
  const plan = planRollout(o);
  assert.deepEqual(plan.pipeline?.map((x) => [x.employee.id, x.head]), [['to-pipeline', head]]);
  assert.deepEqual(plan.bump.map((x) => x.employee.id), ['behind']);
  assert.deepEqual(plan.skip.map((x) => [x.employee.id, x.why]).filter(([id]) => id !== 'retired'), [['to-pipeline', 'on kit 1.0.1 already'], ['on-it', 'on kit 1.0.1 already']]);
  assert.equal(planRollout({ ...o, on: false }).pipeline, undefined, 'the rollout off: nothing');
});
