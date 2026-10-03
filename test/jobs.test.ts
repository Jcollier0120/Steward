import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// An employee's jobs, approved by the round when the installed script is the one merged on its branch: on a fake
// employee's git, an installed copy laid out beside it as a release's is, and an approve command that notes what
// it was asked. The Steward's data folder is one of its own.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-jobs-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { approveMerged, noteApproved } = await import('../src/stages/jobs.ts');
const { ctxFor, employee, fakeEmployee, runner, sh } = await import('./helpers.ts');

const MANIFEST = JSON.stringify({ jobs: [{ name: 'fast-forward', script: 'fast-forward.ps1', every: '1h' }, { name: 'repo-sync', script: 'repo-sync.ps1', every: '1h' }, { name: 'sneaky', script: '../evil.ps1' }] });
const f = fakeEmployee(path.join(tmp, 'reeve'), { files: { 'jobs/jobs.json': MANIFEST, 'jobs/fast-forward.ps1': "'fast-forward 1'\n", 'jobs/repo-sync.ps1': "'repo-sync 1'\n" } });
const app = path.join(tmp, 'app');

/** The installed copy, as a release of `commit` lays it out (its scripts with CRLF, as Windows checks them out). */
function install(commit: string, o: { dirty?: boolean; scripts?: Record<string, string> } = {}) {
  mkdirSync(path.join(app, 'jobs'), { recursive: true });
  writeFileSync(path.join(app, 'release.json'), JSON.stringify({ id: 'reeve', version: '0.4.1', commit: commit.slice(0, 7), dirty: o.dirty ?? false }));
  writeFileSync(path.join(app, 'jobs', 'jobs.json'), MANIFEST);
  for (const s of ['fast-forward.ps1', 'repo-sync.ps1']) writeFileSync(path.join(app, 'jobs', s), (o.scripts?.[s] ?? sh(f.checkout, 'show', `${commit}:jobs/${s}`) + '\n').replace(/\n/g, '\r\n'));
}
/** A merged change to a script on main: its commit. */
function merge(script: string, text: string): string {
  writeFileSync(path.join(f.checkout, 'jobs', script), text);
  sh(f.checkout, 'commit', '--quiet', '-am', `${script} changed`);
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  return sh(f.checkout, 'rev-parse', 'HEAD');
}

// The approve command: notes each job it approves with its script as it is then, and, as Reeve does, says "already
// approved" for a script it approved already.
const asked = path.join(tmp, 'approved.txt');
const approver = path.join(tmp, 'approve.cjs');
writeFileSync(
  approver,
  `const fs = require('fs');
const [file, name, dir] = process.argv.slice(2);
const key = name + '=' + fs.readFileSync(dir + '/' + name + '.ps1', 'utf8').trim();
const had = fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\\n').includes(key);
fs.appendFileSync(file, key + '\\n');
console.log(had ? name + ' already approved' : name + ' approved');
`,
);
const approve = `node ${approver} ${asked} {job} ${path.join(app, 'jobs')}`;
const e = employee(f.checkout, { id: 'reeve', name: 'Reeve', approve, installed: app });
const look = () => approveMerged(ctxFor({ employees: [e], workRoot: tmp, run: runner().run, neutralDir: tmp }), e);
/** The jobs it was asked to approve, in order. */
const approvals = () => (existsSync(asked) ? readFileSync(asked, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')[0]) : []);

test('jobs whose installed scripts are the ones merged on main are approved, once; a path out of jobs\\ is never a job', async () => {
  const first = sh(f.checkout, 'rev-parse', 'HEAD');
  install(first);
  const r = await look();
  assert.equal(r?.outcome, 'done');
  assert.equal(r?.message, `approved fast-forward, repo-sync: their installed scripts are the ones merged on main at ${first.slice(0, 7)}`);
  assert.deepEqual(approvals(), ['fast-forward', 'repo-sync'], 'line endings aside; not "sneaky"');
  assert.equal(await look(), null, 'nothing new: nothing said, nothing run');
  assert.deepEqual(approvals(), ['fast-forward', 'repo-sync']);
});

test("an installed script that isn't the merged one is not approved, and said once; a merged update is approved", async () => {
  const at = sh(f.checkout, 'rev-parse', 'HEAD');
  install(at, { scripts: { 'repo-sync.ps1': "'repo-sync, edited by hand'\n" } });
  const r = await look();
  assert.equal(r?.outcome, 'failed');
  assert.equal(r?.message, `repo-sync: the installed script isn't the one merged at ${at.slice(0, 7)}, so not approved: yours to look at`);
  assert.equal(await look(), null, 'said once');
  const update = merge('repo-sync.ps1', "'repo-sync 2'\n");
  install(update);
  assert.equal((await look())?.message, `approved repo-sync: its installed script is the one merged on main at ${update.slice(0, 7)}`);
  assert.deepEqual(approvals(), ['fast-forward', 'repo-sync', 'repo-sync']);
});

test("a development build, a release from a commit that isn't merged, or no approve command: nothing approved", async () => {
  const update = merge('fast-forward.ps1', "'fast-forward 2'\n");
  install(update, { dirty: true });
  assert.equal(await look(), null, 'a development build');
  // A commit on a branch of its own, pushed but not merged.
  sh(f.checkout, 'switch', '--quiet', '-c', 'feat/unmerged');
  const unmerged = merge('fast-forward.ps1', "'fast-forward, not merged'\n").valueOf();
  sh(f.checkout, 'push', '--quiet', 'origin', 'feat/unmerged');
  sh(f.checkout, 'switch', '--quiet', 'main');
  install(unmerged);
  assert.equal(await look(), null, 'not merged on main');
  assert.equal(await approveMerged(ctxFor({ employees: [e], workRoot: tmp, run: runner().run, neutralDir: tmp }), { ...e, approve: '' }), null);
  assert.deepEqual(approvals(), ['fast-forward', 'repo-sync', 'repo-sync'], 'none of these was approved');
});

test('a job you approved already is quiet; one a PR\'s approve-jobs approved is not approved again', async () => {
  const at = merge('fast-forward.ps1', "'fast-forward 3'\n");
  install(at);
  // You approved it yourself, as it is now.
  writeFileSync(asked, readFileSync(asked, 'utf8') + "fast-forward='fast-forward 3'\n");
  assert.equal(await look(), null, "Reeve says it's approved already: nothing to say");
  const next = merge('repo-sync.ps1', "'repo-sync 3'\n");
  install(next);
  noteApproved(e, 'repo-sync');
  assert.equal(await look(), null);
  assert.equal(approvals().filter((n) => n === 'repo-sync').length, 2, 'not asked again');
});
