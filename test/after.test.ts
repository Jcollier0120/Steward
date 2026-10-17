import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// What a PR asks for after merging (its steward block, after.ts): read, and kept with the PR (staff.ts' parsePrs). The
// Steward merges no one's PRs since 0.36.124, so nothing runs it after a merge of its own; a build releases main. And
// what a release decides, and that a repository removed from this PC isn't released back onto it. The Steward's data
// folder is one of its own.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-after-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { afterWords, readAfter } = await import('../src/after.ts');
const { releaseDecision, releaseOne } = await import('../src/stages/release.ts');
const { parsePrs } = await import('../src/stages/staff.ts');
const { ctxFor, employee, runner } = await import('./helpers.ts');

const block = (json: string) => `Adds a job.\r\n\r\n## After merging (for the Steward)\r\n\r\n\`\`\`steward\r\n${json}\r\n\`\`\`\r\n\r\nMore words.`;
const REEVE13 = '{"after": ["release", "install", "approve-jobs"], "jobs": ["aletaster-orders"]}';

test("a PR's steward block: what it asks for, in the Steward's order; anything it can't do or read is an error, never ignored", () => {
  assert.deepEqual(readAfter('No block here, though it says ```steward in passing.'), { after: null });
  assert.deepEqual(readAfter(undefined), { after: null });
  assert.deepEqual(readAfter(block(REEVE13)), { after: { steps: ['release', 'install', 'approve-jobs'], jobs: ['aletaster-orders'] } });
  assert.deepEqual(readAfter(block('{"after": ["install", "release"]}')), { after: { steps: ['release', 'install'], jobs: [] } });
  const error = (json: string) => (readAfter(block(json)) as { error: string }).error;
  assert.match(error('{"after": ["release", "deploy"]}'), /asks for "deploy", which the Steward doesn't do \(it does release, install, approve-jobs\)/);
  assert.match(error('{"after": ["release"], "run": "rm -rf"}'), /has "run", which the Steward doesn't read/);
  assert.match(error('{"after": ["release",]}'), /isn't JSON/);
  assert.match(error('["release"]'), /isn't a JSON object/);
  assert.match(error('{"after": []}'), /"after" isn't a list of steps/);
  assert.match(error('{"after": ["approve-jobs"]}'), /asks for approve-jobs, but names no jobs/);
  assert.match(error('{"after": ["release"], "jobs": ["x"]}'), /names jobs, but doesn't ask for approve-jobs/);
  assert.match(error('{"after": ["approve-jobs"], "jobs": ["../evil"]}'), /"jobs" isn't a list of job names/);
  assert.match(error('{"after": ["release", "approve-jobs"], "jobs": ["x"]}'), /asks for approve-jobs without install: the scripts approved are the installed copy's/);
  assert.match((readAfter(block(REEVE13) + '\n' + block(REEVE13)) as { error: string }).error, /more than one steward block/);
  assert.equal(afterWords({ steps: ['release', 'install', 'approve-jobs'], jobs: ['aletaster-orders'] }), 'release, install, approve-jobs (aletaster-orders)');
});

const listed = (o: Record<string, unknown>) => ({
  number: 7,
  title: 'Jobs: aletaster-orders',
  url: 'https://github.com/Jcollier0120/Fake/pull/7',
  headRefName: 'feat/aletaster-orders',
  baseRefName: 'main',
  isCrossRepository: false,
  author: { login: 'Jcollier0120', is_bot: false },
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  isDraft: false,
  statusCheckRollup: [],
  body: block(REEVE13),
  ...o,
});

test("parsePrs keeps a PR's steward block, or why it can't be read", () => {
  const [good, bad, none] = parsePrs(JSON.stringify([listed({ number: 7 }), listed({ number: 8, body: block('{"after": ["deploy"]}') }), listed({ number: 9, body: 'No block.' })]), ['Jcollier0120']);
  assert.deepEqual(good.after, { steps: ['release', 'install', 'approve-jobs'], jobs: ['aletaster-orders'] });
  assert.equal(good.afterError, null);
  assert.equal(bad.after, null);
  assert.match(bad.afterError!, /asks for "deploy"/);
  assert.deepEqual([none.after, none.afterError], [null, null]);
});

test("a release carries whatever kit its branch pins, on the kit or not; the rollout's still needs the kit; a version below the newest release isn't released", () => {
  const c = { usesKit: false, kit: null, version: '0.3.2', released: ['0.3.1'] };
  assert.deepEqual(releaseDecision(c, null), { release: true });
  assert.deepEqual(releaseDecision({ ...c, released: ['0.3.2'] }, null), { release: false, why: 'v0.3.2 is already released' });
  assert.deepEqual(releaseDecision(c, '1.2.1'), { release: false, why: 'not using the kit yet' });
  // PRs merged out of order by their authors: main's version below one released already.
  assert.deepEqual(releaseDecision({ ...c, released: ['0.3.1', '0.3.3'] }, null), { release: false, why: 'v0.3.2 on its branch is below v0.3.3, released already: a version above it (claim-version) releases what is merged' });
});

test("a repository removed from this PC (its install folder gone) isn't released back onto it by a release built here: only Manor's Hire does", async () => {
  const gone = employee(path.join(tmp, 'nowhere'), { installed: path.join(tmp, 'fired', 'app'), release: 'npm run release -- --install' });
  const quiet = ctxFor({ employees: [gone], workRoot: path.join(tmp, 'work-fired'), neutralDir: tmp, run: runner(() => { throw new Error('nothing asked of git or gh'); }).run });
  const r = await releaseOne(quiet, gone, { kit: null });
  assert.equal(r.outcome, 'skipped');
  assert.match(r.message, /^Fake isn't installed on this PC \(no .*fired.app\), and the Steward doesn't install it again by itself: hire it in Manor to have it back$/);
});
