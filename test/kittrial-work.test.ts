import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// A kit PR's trial handed each agent it failed to the Wright as an issue in the agent's repository (before Steward
// 0.36.121, which tries the kit on main instead and files nothing for it). Such an issue still open is closed once the
// kit PR it waited on merged or was closed (work.ts's closeResolved).
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-kittrial-work-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const { closeResolved, workFiledFile } = await import('../src/work.ts');
const { employee, ok, runner } = await import('./helpers.ts');

const steward = employee(path.join(home, 'no-steward'), { id: 'steward', name: 'Steward', repo: 'Jcollier0120/Steward' });
const smith = employee(path.join(home, 'no-smith'), { id: 'smith', name: 'Smith', repo: 'Jcollier0120/Smith' });
const reeve = employee(path.join(home, 'no-reeve'), { id: 'reeve', name: 'Reeve', repo: 'Jcollier0120/Reeve' });
const employees = [steward, smith, reeve];

const entry = (repo: string, n: number) => ({ url: `https://github.com/${repo}/issues/${n}`, number: n, repo, at: '2026-10-13T23:00:00Z', condition: 'waiting:Jcollier0120/Steward#214' });
const filed = () => ({ 'kittrial:smith:2.69.0': entry('Jcollier0120/Smith', 5), 'kittrial:reeve:2.69.0': entry('Jcollier0120/Reeve', 9) });
const kept = () => Object.keys(JSON.parse(readFileSync(workFiledFile(), 'utf8')));

beforeEach(() => rmSync(workFiledFile(), { force: true }));

test("an old kit trial's issue stays while its kit PR is open, and closes once the PR merged", async () => {
  writeFileSync(workFiledFile(), JSON.stringify(filed()));
  let state = 'OPEN';
  const r = runner((args) => (args[0] === 'issue' && args[1] === 'close' ? ok('') : args[0] === 'pr' && args[1] === 'view' ? ok({ state }) : undefined));
  const lines: string[] = [];
  await closeResolved({ items: [], employees, run: r.run, cwd: home, log: (l) => lines.push(l) });
  assert.equal(r.gh.filter((a) => a[1] === 'close').length, 0, 'the PR is open: they stay');
  assert.deepEqual(kept(), ['kittrial:smith:2.69.0', 'kittrial:reeve:2.69.0']);
  assert.deepEqual(r.gh.filter((a) => a[1] === 'view').map((a) => [a[2], a[a.indexOf('--repo') + 1]]), [['214', 'Jcollier0120/Steward'], ['214', 'Jcollier0120/Steward']]);

  state = 'MERGED';
  await closeResolved({ items: [], employees, run: r.run, cwd: home, log: (l) => lines.push(l) });
  assert.deepEqual(r.gh.filter((a) => a[1] === 'close').map((a) => [a[2], a[4]]), [['5', 'Jcollier0120/Smith'], ['9', 'Jcollier0120/Reeve']]);
  assert.deepEqual(lines, [
    'work: closed https://github.com/Jcollier0120/Smith/issues/5: Jcollier0120/Steward#214 has merged (a failing bump to kit 2.69.0 is work of its own, for Smith)',
    'work: closed https://github.com/Jcollier0120/Reeve/issues/9: Jcollier0120/Steward#214 has merged (a failing bump to kit 2.69.0 is work of its own, for Reeve)',
  ]);
  assert.deepEqual(kept(), []);
});

test("an old kit trial's issue closes once its kit PR was closed; one GitHub can't say of, or one this round still names, stays", async () => {
  writeFileSync(workFiledFile(), JSON.stringify(filed()));
  const down = runner((args) => (args[0] === 'pr' && args[1] === 'view' ? { code: 1, out: '', err: 'gh: Bad Gateway' } : undefined));
  await closeResolved({ items: [], employees, run: down.run, cwd: home, log: () => {} });
  assert.equal(down.gh.filter((a) => a[1] === 'close').length, 0);
  assert.equal(kept().length, 2, "GitHub couldn't say: they stay");

  const r = runner((args) => (args[0] === 'issue' && args[1] === 'close' ? ok('') : args[0] === 'pr' && args[1] === 'view' ? ok({ state: 'CLOSED' }) : undefined));
  const lines: string[] = [];
  const named = { id: 'kittrial:reeve:2.69.0' } as Parameters<typeof closeResolved>[0]['items'][number];
  await closeResolved({ items: [named], employees, run: r.run, cwd: home, log: (l) => lines.push(l) });
  assert.deepEqual(lines, ['work: closed https://github.com/Jcollier0120/Smith/issues/5: Jcollier0120/Steward#214 was closed']);
  assert.deepEqual(kept(), ['kittrial:reeve:2.69.0']);
});
