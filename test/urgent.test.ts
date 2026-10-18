import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Urgent fixes between builds (stages/urgent.ts): main's newest commit, when the lines it adds to its changelog since the
// newest release mark it "**Urgent fix:", builds at once, for its repository alone, rather than at the next build time;
// once at that head. On a data folder of its own, a fake employee's git, and gh standing in.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-urgent-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { addedLines, marksUrgent, urgentLookedFile, urgentReady } = await import('../src/stages/urgent.ts');
const { boardedUrgent, loadPipeline, savePipeline, urgentKey } = await import('../src/pipeline.ts');
const { runStage } = await import('../src/steward.ts');
const { VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { ctxFor, employee, fakeEmployee, ok, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');
type Runner = import('../src/run.ts').Runner;

const OLD = "# Fake's changelog\n\n## 0.4.0\n\n**Urgent fix: an old one, released long ago.**\n";
const f = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0', files: { 'CHANGELOG.md': OLD } });
const e = employee(f.checkout);
// v0.4.0 is released: its tag on origin.
sh(f.checkout, 'tag', 'v0.4.0');
sh(f.checkout, 'push', '--quiet', 'origin', 'v0.4.0');

/** A commit of these files on `branch` (made from `from` when new), pushed to origin's main when asked: its sha. */
function commit(branch: string, files: Record<string, string>, o: { from?: string; push?: boolean } = {}): string {
  sh(f.checkout, 'switch', '--quiet', ...(o.from ? ['-c', branch, o.from] : [branch]));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(f.checkout, file)), { recursive: true });
    writeFileSync(path.join(f.checkout, file), text);
  }
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', `${branch}: ${Object.keys(files).join(', ')}`);
  const sha = sh(f.checkout, 'rev-parse', 'HEAD');
  if (o.push) sh(f.checkout, 'push', '--quiet', 'origin', `${sha}:refs/heads/main`);
  sh(f.checkout, 'switch', '--quiet', 'main');
  return sha;
}

/** CHANGELOG.md with a 0.4.1 entry on top of the released one. */
const entry = (...lines: string[]) => `# Fake's changelog\n\n## 0.4.1\n\n**${lines[0]}**\n\n### What changed\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\n${OLD.split('\n').slice(2).join('\n')}`;

/** Every command run, for counting the reads. */
let calls: string[][] = [];
const counting: Runner = async (cmd, args, opts) => (calls.push([cmd, ...args]), realRun(cmd, args, opts));
const diffs = () => calls.filter((c) => c[0] === 'git' && c[1] === 'diff').length;

test('the lines main adds to its changelog, and whether one marks it urgent', () => {
  const diff = ['diff --git a/CHANGELOG.md b/CHANGELOG.md', '--- a/CHANGELOG.md', '+++ b/CHANGELOG.md', '@@ -1,0 +2,3 @@', '+## 0.4.1', '+', '+**Urgent fix: updates no longer stop.**', '-**Urgent fix: an old one.**'].join('\r\n');
  assert.deepEqual(addedLines(diff), ['## 0.4.1', '', '**Urgent fix: updates no longer stop.**']);
  assert.equal(marksUrgent(diff), true);
  assert.equal(marksUrgent(diff.replace('+**Urgent fix: updates', '+**Fixes: updates')), false, 'a line it takes away marks nothing');
  assert.equal(marksUrgent('+Mentions **Urgent fix: in passing.'), false, 'the mark starts its line');
});

test("main's head is urgent when the entry it adds since the newest release, in CHANGELOG.md or changes/, says so; once per head; not again once it built", async () => {
  const ctx = ctxFor({ employees: [e], workRoot: path.join(home, 'work'), run: counting, neutralDir: home });
  // An entry that isn't urgent (the urgent line under 0.4.0 was released long ago); then one that is, on top of it.
  const plain = commit('plain', { 'src/pages.ts': 'export const pages = 1;\n', 'CHANGELOG.md': entry('Faster pages.') }, { from: 'main' });
  const urgent = commit('urgent', { 'src/fix.ts': 'export const fix = 1;\n', 'CHANGELOG.md': entry('Urgent fix: updates no longer stop.', 'Faster pages.') }, { from: 'plain' });
  // A fragment in changes/ marked urgent; and a commit that touches no changelog.
  const fragment = commit('fragment', { 'src/frag.ts': 'export const frag = 1;\n', 'changes/claude-frag.md': '**Urgent fix: pages open again.**\n\n### What changed\n\n- Pages open again.\n' }, { from: 'main' });
  const code = commit('code', { 'src/code.ts': 'export const code = 1;\n' }, { from: 'main' });
  const at = (head: string, tags = ['v0.4.0']) => ({ fake: { head, tags } });

  calls = [];
  assert.deepEqual(await urgentReady(ctx, [e], new Set(), at(plain)), [], 'a plain entry boards nothing');
  assert.deepEqual(await urgentReady(ctx, [e], new Set(), at(code)), [], 'nor a commit with no entry');
  assert.deepEqual(await urgentReady(ctx, [e], new Set(), at(urgent)), [{ id: 'fake', head: urgent }]);
  assert.deepEqual(await urgentReady(ctx, [e], new Set(), at(fragment)), [{ id: 'fake', head: fragment }], 'an urgent fragment in changes/ too');
  assert.equal(diffs(), 4, 'each head read once');

  calls = [];
  assert.deepEqual(await urgentReady(ctx, [e], new Set(), at(urgent)), [{ id: 'fake', head: urgent }]);
  assert.equal(diffs(), 0, 'nothing read again at the same head');
  assert.deepEqual(await urgentReady(ctx, [e], new Set([urgentKey({ id: 'fake', head: urgent })]), at(urgent)), [], 'a head that built already is left out');
  assert.deepEqual(await urgentReady(ctx, [e], new Set(), at(urgent, [])), [], 'never released: its first release is no urgent fix');

  // From the round's glance at GitHub: main's head and its releases.
  ctx.glance = { at: new Date().toISOString(), stewardReleases: null, repos: { fake: { head: urgent, prs: [], releases: [{ tagName: 'v0.4.0', isDraft: false, publishedAt: null, commit: null }] } }, errors: {} };
  assert.deepEqual(await urgentReady(ctx, [e], new Set()), [{ id: 'fake', head: urgent }]);
  // An employee GitHub's glance said nothing of: nothing read, nothing found.
  calls = [];
  assert.deepEqual(await urgentReady(ctx, [{ ...e, id: 'other' }], new Set()), []);
  assert.equal(calls.length, 0);
});

test("main at its newest release's commit is read not at all; what a head said is kept for after a restart", async () => {
  const ctx = ctxFor({ employees: [e], workRoot: path.join(home, 'work'), run: counting, neutralDir: home });
  const released = sh(f.checkout, 'rev-parse', 'v0.4.0');
  ctx.glance = { at: new Date().toISOString(), stewardReleases: null, repos: { fake: { head: released, prs: [], releases: [{ tagName: 'v0.4.0', isDraft: false, publishedAt: null, commit: released }] } }, errors: {} };
  calls = [];
  assert.deepEqual(await urgentReady(ctx, [e], new Set()), []);
  assert.equal(calls.length, 0, 'no git: nothing on main since its release');
  // A head read before (the first test's urgent one) is in the data folder, by repository, head and release.
  const kept = JSON.parse(readFileSync(urgentLookedFile(), 'utf8')) as Record<string, boolean>;
  assert.ok(Object.entries(kept).some(([k, v]) => k.startsWith(`${e.repo}@`) && k.endsWith('..v0.4.0') && v === true));
});

/** The world as GitHub would say it in a round's glance: the fake origin's main, and v0.4.0 released. */
const graph = () => ({
  data: {
    steward: { releases: { nodes: [{ tagName: 'kit-v1.0.0', isDraft: false }] } },
    e0: {
      ref: { target: { oid: sh(f.origin, 'rev-parse', 'main') } },
      pullRequests: { nodes: [] },
      releases: { nodes: [{ tagName: 'v0.4.0', isDraft: false, publishedAt: null, tagCommit: { oid: sh(f.origin, 'rev-parse', 'v0.4.0') } }] },
    },
  },
});
// The release command notes each version it's asked to release, and fails: the urgent head's release doesn't come out.
const attempts = path.join(home, 'attempts.txt');
const releaseCmd = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],JSON.parse(fs.readFileSync('package.json','utf8')).version+'\\n');process.exit(1)" ${attempts}`;
const tried = () => (existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean) : []);
const roundRun: Runner = async (cmd, args, opts) => {
  if (cmd !== 'gh') return realRun(cmd, args, opts);
  if (args[0] === 'api' && args[1] === 'graphql') return ok(graph());
  if (args[0] === 'release' && args[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
  // A team member vouched for each head: the build doesn't test it again.
  if (args[0] === 'api' && /^repos\/Jcollier0120\/Fake\/commits\/[0-9a-f]{40}\/statuses/.test(args[1])) return ok([{ context: VOUCH_CONTEXT, state: 'success', creator: { login: 'Jcollier0120' } }]);
  return { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
};

test('a round between builds: an urgent fix on main begins a build of its own, for its repository alone, once at its head; a plain one only waits', async () => {
  writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({
      employees: [{ id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: f.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: releaseCmd, install: '', approve: '' }],
      team: ['Jcollier0120'],
      workRoot: path.join(home, 'work'),
      afterRelease: [],
      // Saved while there was a switch, off: it builds at its times all the same.
      buildPipeline: { on: false, times: ['00:00', '06:00', '12:00', '18:00'], days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], kit: 'every', windowMinutes: 120 },
    }),
  );
  let now = new Date(2026, 9, 13, 10, 0);
  // The 06:00 build has been and gone.
  const six = new Date(2026, 9, 13, 6, 0).toISOString();
  savePipeline({ open: null, builds: [{ due: six, by: 'schedule', started: six, finished: new Date(2026, 9, 13, 6, 40).toISOString(), rounds: 2, merged: [], released: [], failed: [] }] });
  const round = () => runStage('round', {}, { run: roundRun, now: () => now, pipeline: true, alarms: { manorUrl: 'http://127.0.0.1:9' }, tell: async () => ({ ok: true, said: 'HTTP 200' }) });
  const bump = (v: string) => Object.fromEntries(['package.json', 'package-lock.json', 'src/app.ts'].map((file) => [file, readFileSync(path.join(f.checkout, file), 'utf8').replaceAll('0.4.0', v)]));

  // Main moves on with a plain entry: the round only looks, and nothing builds before 12:00.
  commit('main', { ...bump('0.4.1'), 'CHANGELOG.md': entry('Faster pages.') }, { push: true });
  const quiet = await round();
  assert.equal(quiet.error, undefined);
  assert.deepEqual(quiet.build, { between: true, next: new Date(2026, 9, 13, 12, 0).toISOString() });
  assert.match(quiet.log.join('\n'), /between builds: PRs are merged by whoever wrote them once vouched, and the next build, at 12:00,? releases each repository's main/);
  assert.doesNotMatch(quiet.log.join('\n'), /urgent fix/);
  assert.equal(loadPipeline().open, null);
  assert.deepEqual(tried(), [], 'nothing released between builds');

  // An urgent fix lands on main: a build of its own, for its repository, at once.
  const head = commit('main', { 'src/fix.ts': 'export const fix = 1;\n', 'CHANGELOG.md': entry('Urgent fix: updates no longer stop.', 'Faster pages.') }, { push: true });
  now = new Date(2026, 9, 13, 10, 10);
  const urgent = await round();
  const log = urgent.log.join('\n');
  assert.match(log, new RegExp(`an urgent fix is on main \\(fake at ${head.slice(0, 7)}\\): it builds at once, for its repository alone`));
  assert.match(log, new RegExp(`the urgent fix's build \\(fake ${head.slice(0, 7)}\\) begins for fake`));
  assert.match(log, /the newest kit waits for the next build: this one is for an urgent fix/);
  assert.equal(urgent.build?.by, 'urgent');
  assert.deepEqual(tried(), ['0.4.1'], "main's head released (its release failing here)");
  let state = loadPipeline();
  const run = state.open ?? state.builds.at(-1)!;
  assert.deepEqual([run.by, run.employees, run.urgent], ['urgent', ['fake'], [urgentKey({ id: 'fake', head })]]);
  assert.equal(boardedUrgent(state).has(urgentKey({ id: 'fake', head })), true);
  const builds = state.builds.length;

  // Its release failed, and main is still at that head: no second build for it. It waits for a new commit or 12:00.
  now = new Date(2026, 9, 13, 10, 20);
  const again = await round();
  assert.equal(again.build?.between, true);
  assert.doesNotMatch(again.log.join('\n'), /urgent fix/);
  state = loadPipeline();
  assert.deepEqual([state.open, state.builds.length], [null, builds], 'built once at its head');
  assert.deepEqual(tried(), ['0.4.1']);

  // A new commit on main, the urgent entry still unreleased: that head builds once too.
  const next = commit('main', { 'src/fix.ts': 'export const fix = 2;\n' }, { push: true });
  now = new Date(2026, 9, 13, 10, 30);
  const second = await round();
  assert.equal(second.build?.by, 'urgent');
  state = loadPipeline();
  assert.deepEqual((state.open ?? state.builds.at(-1)!).urgent, [urgentKey({ id: 'fake', head: next })]);
});
