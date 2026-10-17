import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A repository refreshed after releases (stages/refresh.ts): a site whose `npm run sync` lists every release's notes.
// It runs only after a round that released something; it pushes only what changed, and only once its tests pass; a
// failure is an alarm, never a push. A round merges no one's PRs (Steward 0.36.121): the Exchequer's stays open.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-refresh-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage } = await import('../src/steward.ts');
const { refreshFailedFile, refreshStep, releasedWords, REFRESH_WAIT_MS } = await import('../src/stages/refresh.ts');
const { staffRow } = await import('../src/stages/staff.ts');
const { NO_RELEASE } = await import('../src/stages/release.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const fake = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0' });
const site = fakeEmployee(path.join(home, 'site'), { version: '0.1.0', kit: null, files: { 'notes.txt': 'none yet\n' } });
const exchequer = fakeEmployee(path.join(home, 'exchequer'), { version: '0.5.1', kit: null, files: { 'src/version.ts': "export const VERSION = '0.5.1';\n" } });

// The site's sync copies what "GitHub says" (a file outside it) into notes.txt; its test fails while a flag file exists.
const source = path.join(home, 'releases.txt');
const failFlag = path.join(home, 'site-tests-fail');
writeFileSync(source, 'none yet\n');
const sync = `node -e "require('fs').copyFileSync(process.argv[1],'notes.txt')" ${source}`;
const siteTest = `node -e "process.exit(require('fs').existsSync(process.argv[1])?1:0)" ${failFlag}`;

// Fake's release notes each version it releases, which GitHub then lists.
const releasedFile = path.join(home, 'released.txt');
const releaseCmd = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],JSON.parse(fs.readFileSync('package.json','utf8')).version+'\\n')" ${releasedFile}`;
const released = () => ['0.4.0', ...(existsSync(releasedFile) ? readFileSync(releasedFile, 'utf8').split('\n').filter(Boolean) : [])];

const NOTE = 'Deploys the payment service: its database migrations go first, by hand';
// Developer options on, by the Steward's own switch (there is no Manor here, helpers.ts): its Settings are a developer's
// (SETTINGS_SPEC.developerOnly), and a save is refused with them off.
writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    employees: [
      { id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: fake.checkout, branch: 'main', merges: true, usesKit: false, fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: releaseCmd, install: '', approve: '', installed: '' },
      { id: 'site', name: 'Site', repo: 'Jcollier0120/Site', checkout: site.checkout, branch: 'main', merges: true, usesKit: false, fill: '', test: [siteTest], versionFiles: ['package.json'], release: '', install: '', approve: '', installed: '', refresh: sync },
      { id: 'exchequer', name: 'Exchequer', repo: 'Jcollier0120/Exchequer', checkout: exchequer.checkout, branch: 'main', merges: false, usesKit: false, fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'src/version.ts'], release: '', install: '', approve: '', installed: '', note: NOTE },
    ],
    team: ['Jcollier0120'],
    workRoot: path.join(home, 'work'),
    developerOptions: true,
  }),
);

// The Exchequer has a ready PR of the team's, open the whole time: it is never merged.
const r = runner((args) => {
  if (args[0] === 'pr' && args[1] === 'list') {
    if (!args.includes('Jcollier0120/Exchequer')) return ok([]);
    return ok([{ number: 4, title: 'Exchequer 0.5.2: a payment fix', url: 'https://github.com/Jcollier0120/Exchequer/pull/4', headRefName: 'fix/pay', headRefOid: 'a'.repeat(40), baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [], body: 'A fix.' }]);
  }
  if (args[0] === 'release' && args[1] === 'list') return ok(args.includes('Jcollier0120/Fake') ? released().map((v) => ({ tagName: `v${v}`, isDraft: false })) : []);
  if (args[0] === 'release' && args[1] === 'view') return ok({ targetCommitish: 'b'.repeat(40) });
});
const round = () => runStage('round', {}, { run: r.run });

/** Fake's version raised on its main, pushed, with no release yet. */
function raise(from: string, to: string): void {
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(fake.checkout, file), readFileSync(path.join(fake.checkout, file), 'utf8').replaceAll(from, to));
  sh(fake.checkout, 'commit', '--quiet', '-am', `Fake ${to}`);
  sh(fake.checkout, 'push', '--quiet', 'origin', 'main');
}
const siteHead = () => sh(site.origin, 'rev-parse', 'refs/heads/main');
const siteNotes = () => sh(site.checkout, '--git-dir', site.origin, 'show', 'main:notes.txt');
const refreshes = (out: Awaited<ReturnType<typeof round>>) => out.results.filter((x) => x.message.startsWith('refresh: '));
const alarms = () => JSON.parse(readFileSync(path.join(home, 'alarms.json'), 'utf8')).open.map((a: any) => a.id) as string[];

test('Settings keep a repository\'s refresh and note as the page saves them, and leave them out when empty', async () => {
  const { normalizeSettings, SETTINGS_SPEC } = await import('../src/settings.ts');
  const { saveSettingsReply } = await import('../src/kit/settings-kit.ts');
  const records = [
    { id: 'site', name: 'Site', repo: 'Jcollier0120/Site', checkout: site.checkout, branch: 'main', merges: true, usesKit: false, fill: '', test: ['npm test', 'npm run build'], versionFiles: ['package.json'], release: '', install: '', approve: '', installed: '', refresh: 'npm run sync' },
    { id: 'exchequer', name: 'Exchequer', repo: 'Jcollier0120/Exchequer', checkout: exchequer.checkout, branch: 'main', merges: false, usesKit: false, fill: '', test: ['npm test'], versionFiles: ['package.json', 'src/version.ts'], release: '', install: '', approve: '', installed: '', note: NOTE, refresh: '' },
  ];
  // Saved as the page saves them (POST /api/settings), into a file of its own; a repository with no kit to fill is fine.
  const file = path.join(home, 'saved-settings.json');
  const saved = (await saveSettingsReply({ ...SETTINGS_SPEC, file: () => file }, { values: { employees: records } })).json as any;
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const [s, x] = normalizeSettings(JSON.parse(readFileSync(file, 'utf8'))).settings.employees;
  assert.equal(s.refresh, 'npm run sync');
  assert.equal(s.note, undefined);
  assert.equal(x.note, NOTE);
  assert.equal('refresh' in x, false, 'an empty one is left out');
});

test('what was released, in words for the commit', () => {
  assert.equal(releasedWords([{ name: 'Porter', version: '0.4.2' }]), 'Porter 0.4.2');
  assert.equal(releasedWords([{ name: 'Porter', version: '0.4.2' }, { name: 'Steward', version: '0.20.0' }]), 'Porter 0.4.2 and Steward 0.20.0');
  assert.equal(releasedWords(['A', 'B', 'C', 'D', 'E'].map((name) => ({ name, version: '1.0.0' }))), 'A 1.0.0, B 1.0.0, C 1.0.0 and 2 more');
});

test('a round that released nothing runs no refresh', async () => {
  writeFileSync(source, 'Fake 0.4.0\n');
  const before = siteHead();
  const out = await round();
  assert.equal(out.error, undefined);
  assert.deepEqual(refreshes(out), []);
  assert.equal(siteHead(), before, 'nothing pushed');
  assert.ok(!out.log.some((l) => /refresh/.test(l)), out.log.join('\n'));
});

test("after a round releases something, the site's refresh runs, its tests pass, and the change is pushed to its main", async () => {
  raise('0.4.0', '0.4.1');
  writeFileSync(source, 'Fake 0.4.1\nFake 0.4.0\n');
  const before = siteHead();
  const out = await round();
  assert.ok(out.results.some((x) => x.outcome === 'done' && /^release: released v0\.4\.1/.test(x.message)), JSON.stringify(out.results));
  const [refresh] = refreshes(out);
  assert.equal(refresh?.outcome, 'done', JSON.stringify(out.results));
  assert.match(refresh.message, /^refresh: pushed [0-9a-f]{7} to main: Release notes and downloads after Fake 0\.4\.1 \(notes\.txt\)$/);
  const head = siteHead();
  assert.notEqual(head, before);
  assert.equal(sh(site.checkout, '--git-dir', site.origin, 'log', '-1', '--format=%s', 'main'), 'Release notes and downloads after Fake 0.4.1');
  assert.equal(sh(site.checkout, '--git-dir', site.origin, 'rev-parse', 'main^'), before, 'one commit on top of what was there, never forced');
  assert.equal(siteNotes(), 'Fake 0.4.1\nFake 0.4.0');
  assert.ok(existsSync(path.join(home, 'work', 'site-refresh')), 'its worktree is kept for the next refresh');
  assert.ok(sh(site.checkout, 'worktree', 'list').includes('site-refresh'));
});

test("a refresh that changes nothing pushes nothing; the worktree kept from the last one is reset first", async () => {
  // What a refresh cut short (the PC turned off mid-run) could leave: a tracked file changed, an untracked one made.
  const kept = path.join(home, 'work', 'site-refresh');
  writeFileSync(path.join(kept, 'notes.txt'), 'half written\n');
  writeFileSync(path.join(kept, 'stray.txt'), 'left behind\n');
  raise('0.4.1', '0.4.2');
  const before = siteHead();
  const out = await round();
  const [refresh] = refreshes(out);
  assert.equal(refresh?.outcome, 'skipped', JSON.stringify(out.results));
  assert.match(refresh.message, /changed nothing .*: nothing to push/);
  assert.equal(siteHead(), before);
  assert.ok(out.log.some((l) => l.includes('(kept from the last refresh)')), out.log.join('\n'));
  assert.ok(!existsSync(path.join(kept, 'stray.txt')), 'what the last one left untracked is gone');

  // One no longer registered with git (pruned by hand): made afresh.
  sh(site.checkout, 'worktree', 'remove', '--force', kept);
  mkdirSync(kept, { recursive: true });
  writeFileSync(path.join(kept, '.git'), 'gitdir: nowhere\n');
  raise('0.4.2', '0.4.3');
  const again = await round();
  assert.equal(refreshes(again)[0]?.outcome, 'skipped', JSON.stringify(again.results));
  assert.ok(!again.log.some((l) => l.includes('(kept from the last refresh)')));
});

test('releases wait for the round that comes sooner, and one refresh covers them all; never longer than an hour', () => {
  const t0 = Date.parse('2026-10-13T08:00:00Z');
  const porter = { id: 'porter', name: 'Porter', version: '0.5.48' };
  const clerk = { id: 'clerk', name: 'Clerk', version: '0.5.41' };
  const first = refreshStep({ released: [porter], pending: null, soon: true, now: t0 });
  assert.deepEqual(first, { wait: { since: new Date(t0).toISOString(), released: [porter] } });
  const pending = 'wait' in first ? first.wait : null;
  assert.deepEqual(refreshStep({ released: [clerk, porter], pending, soon: false, now: t0 + 600_000 }), { run: [porter, clerk] }, 'the next round: both, once');
  assert.deepEqual(refreshStep({ released: [], pending, soon: true, now: t0 + REFRESH_WAIT_MS }), { run: [porter] }, 'an hour on: it goes');
  assert.deepEqual(refreshStep({ released: [], pending: null, soon: false, now: t0 }), { run: [] });
});

test("a refresh whose tests fail pushes nothing, and is an alarm until a later one goes through", async () => {
  raise('0.4.3', '0.4.4');
  writeFileSync(source, 'Fake 0.4.4\n');
  writeFileSync(failFlag, '');
  const before = siteHead();
  const out = await round();
  const [refresh] = refreshes(out);
  assert.equal(refresh?.outcome, 'failed');
  assert.match(refresh.message, /changed notes\.txt, but .* failed \(exit 1\), so nothing was pushed/);
  assert.equal(siteHead(), before, 'a failing tree is never pushed');
  const held = JSON.parse(readFileSync(refreshFailedFile(), 'utf8'));
  assert.deepEqual(Object.keys(held), ['site']);
  assert.equal(held.site.after, 'Fake 0.4.4');
  assert.ok(alarms().some((id) => id.startsWith('refresh:site:')), alarms().join(', '));

  rmSync(failFlag);
  raise('0.4.4', '0.4.5');
  writeFileSync(source, 'Fake 0.4.5\nFake 0.4.4\n');
  const next = await round();
  assert.equal(refreshes(next)[0]?.outcome, 'done', JSON.stringify(next.results));
  assert.equal(siteNotes(), 'Fake 0.4.5\nFake 0.4.4');
  assert.deepEqual(JSON.parse(readFileSync(refreshFailedFile(), 'utf8')), {});
  assert.ok(!alarms().some((id) => id.startsWith('refresh:')), 'cleared');
});

test("a round merges no one's PRs: the Exchequer's ready PR, open the whole time, is left to whoever wrote it", async () => {
  const out = await round();
  assert.equal(out.error, undefined);
  assert.deepEqual(r.gh.filter((a) => a[0] === 'pr' && a[1] === 'merge'), [], 'not by this round, nor by any before it');
  // It has no Release it: the round only looks at its release, and leaves it.
  const row = out.results.find((x) => x.id === 'exchequer');
  assert.equal(row?.outcome, 'skipped');
  assert.equal(row!.message, `release: ${NO_RELEASE}`);
});

test("a repository's note leads its row on the page, and its VERSION constant is read as its version", async () => {
  const ctx = ctxFor({ employees: [], workRoot: path.join(home, 'work'), run: r.run, neutralDir: home });
  const e = employee(exchequer.checkout, { id: 'exchequer', name: 'Exchequer', repo: 'Jcollier0120/Exchequer', usesKit: false, merges: false, release: '', versionFiles: ['package.json', 'src/version.ts'], note: NOTE });
  const row = await staffRow(ctx, e, { fetch: false, kit: null });
  assert.equal(row.notes[0], NOTE);
  assert.equal(row.main?.version, '0.5.1');
  assert.equal(row.merges, false);
});
