import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Urgent fixes between builds (stages/urgent.ts): a ready PR whose changelog entry is marked "**Urgent fix:" builds at
// once, for its repository alone, rather than at the next build time. On a data folder of its own, a fake employee's
// git, and gh standing in.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-urgent-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { addedLines, candidates, marksUrgent, urgentReady } = await import('../src/stages/urgent.ts');
const { boardedUrgent, loadPipeline, savePipeline, urgentKey } = await import('../src/pipeline.ts');
const { runStage } = await import('../src/steward.ts');
const { prFromGraph } = await import('../src/glance.ts');
const { parsePrs } = await import('../src/stages/staff.ts');
const { ctxFor, employee, fakeEmployee, ok, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');
type Runner = import('../src/run.ts').Runner;

const OLD = "# Fake's changelog\n\n## 0.4.0\n\n**Urgent fix: an old one, released long ago.**\n";
const f = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0', files: { 'CHANGELOG.md': OLD } });
const e = employee(f.checkout);

/** A PR from main: a branch with these files, pushed, and its head as GitHub's refs/pull/<n>/head. GraphQL's shape, as the glance reads it. */
function open(number: number, files: Record<string, string>, o: { draft?: boolean } = {}) {
  const head = `claude/pr-${number}`;
  sh(f.checkout, 'switch', '--quiet', '-c', head, 'main');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(f.checkout, file)), { recursive: true });
    writeFileSync(path.join(f.checkout, file), text);
  }
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', `#${number}`);
  sh(f.checkout, 'push', '--quiet', 'origin', head);
  const oid = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.origin, 'update-ref', `refs/pull/${number}/head`, oid);
  sh(f.checkout, 'switch', '--quiet', 'main');
  return {
    oid,
    node: { number, title: `Fake: #${number}`, url: `https://github.com/Jcollier0120/Fake/pull/${number}`, body: '', createdAt: '2026-10-13T08:00:00Z', headRefName: head, headRefOid: oid, baseRefName: 'main', isCrossRepository: false, isDraft: !!o.draft, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', additions: 5, deletions: 0, author: { __typename: 'User', login: 'Jcollier0120' }, labels: { nodes: [] }, files: { nodes: Object.keys(files).map((p) => ({ path: p })) }, commits: { nodes: [] } },
  };
}

const entry = (line: string) => `# Fake's changelog\n\n## 0.4.1\n\n**${line}**\n\n### What changed\n\n- ${line}\n\n${OLD.split('\n').slice(2).join('\n')}`;
const urgentLog = open(41, { 'src/fix.ts': 'export const fix = 1;\n', 'CHANGELOG.md': entry('Urgent fix: updates no longer stop.') });
const urgentFragment = open(42, { 'src/frag.ts': 'export const frag = 1;\n', 'changes/claude-pr-42.md': '**Urgent fix: pages open again.**\n\n### What changed\n\n- Pages open again.\n' });
const plain = open(43, { 'src/pages.ts': 'export const pages = 1;\n', 'CHANGELOG.md': entry('Faster pages.') });
const code = open(44, { 'src/code.ts': 'export const code = 1;\n' });
const draft = open(45, { 'src/draft.ts': 'export const draft = 1;\n', 'CHANGELOG.md': entry('Urgent fix: not ready yet.') }, { draft: true });

/** Every command run, for counting the reads. */
let calls: string[][] = [];
const counting: Runner = async (cmd, args, opts) => (calls.push([cmd, ...args]), realRun(cmd, args, opts));
const diffs = () => calls.filter((c) => c[0] === 'git' && c[1] === 'diff').length;

test('the lines a PR adds to its changelog, and whether one marks it urgent', () => {
  const diff = ['diff --git a/CHANGELOG.md b/CHANGELOG.md', '--- a/CHANGELOG.md', '+++ b/CHANGELOG.md', '@@ -1,0 +2,3 @@', '+## 0.4.1', '+', '+**Urgent fix: updates no longer stop.**', '-**Urgent fix: an old one.**'].join('\r\n');
  assert.deepEqual(addedLines(diff), ['## 0.4.1', '', '**Urgent fix: updates no longer stop.**']);
  assert.equal(marksUrgent(diff), true);
  assert.equal(marksUrgent(diff.replace('+**Urgent fix: updates', '+**Fixes: updates')), false, 'a line it takes away marks nothing');
  assert.equal(marksUrgent('+Mentions **Urgent fix: in passing.'), false, 'the mark starts its line');
});

test('which PRs may board as urgent: the team\'s, ready, to the branch, touching a changelog', () => {
  const prs = parsePrs(JSON.stringify([urgentLog, urgentFragment, plain, code, draft].map((p) => prFromGraph(p.node))), ['Jcollier0120']);
  assert.deepEqual(candidates(e, prs).map((p) => p.number), [41, 42, 43]);
  assert.deepEqual(candidates(e, parsePrs(JSON.stringify([prFromGraph({ ...urgentLog.node, author: { __typename: 'User', login: 'someone' } })]), ['Jcollier0120'])), [], "a stranger's is never one");
  assert.deepEqual(candidates(e, parsePrs(JSON.stringify([prFromGraph({ ...urgentLog.node, baseRefName: 'other' })]), ['Jcollier0120'])), [], 'nor one to another branch');
});

test("an urgent PR is found from its head: the entry it adds, in CHANGELOG.md or changes/, not one main had; once per head; not again once it boarded", async () => {
  const ctx = ctxFor({ employees: [e], workRoot: path.join(home, 'work'), run: counting, neutralDir: home });
  ctx.glance = { at: new Date().toISOString(), stewardReleases: null, repos: { fake: { head: sh(f.origin, 'rev-parse', 'main'), prs: [urgentLog, urgentFragment, plain, code, draft].map((p) => prFromGraph(p.node)), releases: [] } }, errors: {} };
  calls = [];
  const found = await urgentReady(ctx, [e], new Set());
  assert.deepEqual(found, [{ id: 'fake', number: 41, head: urgentLog.oid }, { id: 'fake', number: 42, head: urgentFragment.oid }]);
  assert.equal(diffs(), 3, 'the three that touch a changelog read, the others not');

  calls = [];
  assert.deepEqual(await urgentReady(ctx, [e], new Set([urgentKey(found[0])])), [found[1]], 'one that boarded at its head is left out');
  assert.equal(diffs(), 0, 'nothing read again at the same heads');

  // An employee GitHub's glance said nothing of: nothing read, nothing found.
  assert.deepEqual(await urgentReady(ctx, [{ ...e, id: 'other' }], new Set()), []);
});

/** The world as GitHub would say it in a round's glance: the fake origin's main, and the PRs below. */
let prs: any[] = [];
const graph = () => ({
  data: {
    steward: { releases: { nodes: [{ tagName: 'kit-v1.0.0', isDraft: false }] } },
    e0: {
      ref: { target: { oid: sh(f.origin, 'rev-parse', 'main') } },
      pullRequests: { nodes: prs },
      releases: { nodes: [{ tagName: 'v0.4.0', isDraft: false, publishedAt: null, tagCommit: { oid: sh(f.origin, 'rev-parse', 'main') } }] },
    },
  },
});
const roundRun: Runner = async (cmd, args, opts) => {
  if (cmd === 'gh') return args[0] === 'api' && args[1] === 'graphql' ? ok(graph()) : { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
  return realRun(cmd, args, opts);
};

test('a round between builds: an urgent fix begins a build of its own, for its repository alone and without the kit; without one, it only looks', async () => {
  writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({
      employees: [{ id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: f.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: 'node -e process.exit(0)', install: '', approve: '' }],
      team: ['Jcollier0120'],
      workRoot: path.join(home, 'work'),
      afterRelease: [],
      // Saved while there was a switch, off: it builds at its times all the same.
      buildPipeline: { on: false, times: ['00:00', '06:00', '12:00', '18:00'], days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], kit: 'every', windowMinutes: 120 },
    }),
  );
  const now = new Date(2026, 9, 13, 10, 0);
  // The 06:00 build has been and gone.
  const six = new Date(2026, 9, 13, 6, 0).toISOString();
  savePipeline({ open: null, builds: [{ due: six, by: 'schedule', started: six, finished: new Date(2026, 9, 13, 6, 40).toISOString(), rounds: 2, merged: [], released: [], failed: [] }] });
  const round = () => runStage('round', {}, { run: roundRun, now: () => now, pipeline: true, tell: async () => ({ ok: true, said: 'HTTP 200' }) });

  prs = [plain.node, code.node];
  const quiet = await round();
  assert.equal(quiet.error, undefined);
  assert.deepEqual(quiet.build, { between: true, next: new Date(2026, 9, 13, 12, 0).toISOString() });
  assert.match(quiet.log.join('\n'), /between builds: ready PRs wait for the next build, at 12:00/);
  assert.equal(loadPipeline().open, null);

  prs = [urgentLog.node, plain.node];
  const urgent = await round();
  const log = urgent.log.join('\n');
  assert.match(log, /an urgent fix is ready \(fake #41\): it builds at once, for its repository alone/);
  assert.match(log, /the urgent fix's build \(fake #41\) begins for fake/);
  assert.match(log, /the newest kit waits for the next build: this one is for an urgent fix/);
  assert.equal(urgent.build?.by, 'urgent');
  const state = loadPipeline();
  const run = state.open ?? state.builds.at(-1)!;
  assert.deepEqual([run.by, run.employees, run.urgent], ['urgent', ['fake'], [urgentKey({ id: 'fake', number: 41, head: urgentLog.oid })]]);
  assert.equal(boardedUrgent(state).has(urgentKey({ id: 'fake', number: 41, head: urgentLog.oid })), true, 'it boards once at that head');
});
