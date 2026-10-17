import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Steward's own releases in a round (stages/self.ts): what to release, as pure decisions; then releases from a
// fake Steward repository (a bare origin and a clone, its scripts standing in for the real ones, which only note what
// they were asked). The kit is tried on the agents at main first (stages/trial.ts: here, none), and the Steward's version
// waits for main's head to be tested or vouched for (stages/mainbuild.ts: here, gh says the team vouched). Nothing
// reaches GitHub, the live ~/.steward or the real checkout.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-self-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { planSelf, releaseSelf, loadSelfFailures, selfFailedFile, SELF_COMMANDS, trialAhead } = await import('../src/stages/self.ts');
const { kitTrialsFile, mainKeyOf, TRIAL_NO_ROOM } = await import('../src/stages/trial.ts');
const { VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { APP } = await import('../src/app.ts');
const { writeJson } = await import('../src/kit/store.ts');
const { readGlance, glanceQuery, stewardMainFrom } = await import('../src/glance.ts');
const { roundConditions } = await import('../src/alarms.ts');
const { releasedSomething, runStage } = await import('../src/steward.ts');
const { DEFAULT_SETTINGS, normalizeSettings } = await import('../src/settings.ts');
const { ctxFor, ok, runner, sh } = await import('./helpers.ts');

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const main = (kit: string | null, version: string | null, head: string | null = H1) => ({ head, kit, version });

test('a kit version and a Steward version on main with no release are released, the kit first; nothing when both are', () => {
  const both = planSelf({ on: true, main: main('2.9.1', '0.8.1'), tags: ['v0.8.0', 'kit-v2.9.0'], failed: {} });
  assert.deepEqual(both.steps, [
    { what: 'kit', tag: 'kit-v2.9.1', version: '2.9.1', commit: H1 },
    { what: 'steward', tag: 'v0.8.1', version: '0.8.1', commit: H1 },
  ]);
  assert.deepEqual(planSelf({ on: true, main: main('2.9.0', '0.8.1'), tags: ['v0.8.0', 'kit-v2.9.0'], failed: {} }).steps.map((s) => s.tag), ['v0.8.1'], 'the kit is released already');
  assert.deepEqual(planSelf({ on: true, main: main('2.9.0', '0.8.0'), tags: ['v0.8.0', 'kit-v2.9.0'], failed: {} }), { steps: [], notes: [] }, 'nothing new');
  assert.deepEqual(planSelf({ on: false, main: main('2.9.1', '0.8.1'), tags: [], failed: {} }), { steps: [], notes: [] }, 'off');
  assert.equal(normalizeSettings({}).settings.releaseSelf, true, 'on by default');
});

test('never a version at or below the newest release; a Steward version waits for its kit; one that failed waits for a new commit', () => {
  const below = planSelf({ on: true, main: main('2.8.9', '0.7.9'), tags: ['v0.8.0', 'kit-v2.9.0'], failed: {} });
  assert.deepEqual(below.steps, []);
  assert.deepEqual(below.notes, ['kit/VERSION on main is 2.8.9, not above kit-v2.9.0, the newest release: left to you', 'v0.7.9 waits for kit-v2.8.9 to be released first']);
  const failed = { 'kit-v2.9.1': { commit: H1, message: 'node tools/kit-release.ts --publish failed (exit 1)', at: '' } };
  const held = planSelf({ on: true, main: main('2.9.1', '0.8.1'), tags: ['v0.8.0', 'kit-v2.9.0'], failed });
  assert.deepEqual(held.steps, []);
  assert.match(held.notes[0], /^kit-v2\.9\.1 failed to release at aaaaaaa .*until a new commit lands on main$/);
  assert.equal(held.notes[1], 'v0.8.1 waits for kit-v2.9.1 to be released first');
  assert.deepEqual(planSelf({ on: true, main: main('2.9.1', '0.8.1', H2), tags: ['v0.8.0', 'kit-v2.9.0'], failed }).steps.length, 2, 'a new commit: tried again');
  assert.deepEqual(planSelf({ on: true, main: null, tags: ['v0.8.0'], failed: {} }).steps, [], "main couldn't be read");
});

test("the glance reads the Steward's main with its releases: head, kit/VERSION, package.json's version", () => {
  assert.match(glanceQuery([], 'Jcollier0120/Steward'), /steward: repository\(owner: "Jcollier0120", name: "Steward"\) \{ releases\(.*\) \{ nodes \{ tagName isDraft publishedAt \} \} main: ref\(qualifiedName: "refs\/heads\/main"\) \{ target \{ oid \} \} kitVersion: object\(expression: "main:kit\/VERSION"\) \{ \.\.\. on Blob \{ text \} \} packageJson: object\(expression: "main:package\.json"\)/);
  const g = { at: '', stewardReleases: null, repos: {}, errors: {} };
  readGlance([], JSON.stringify({ data: { steward: { releases: { nodes: [{ tagName: 'v0.8.0', isDraft: false }] }, main: { target: { oid: H1 } }, kitVersion: { text: '2.9.1\r\n' }, packageJson: { text: '{ "name": "steward", "version": "0.8.1" }' } } } }), 'Jcollier0120/Steward', g);
  assert.deepEqual((g as any).stewardMain, main('2.9.1', '0.8.1'));
  assert.deepEqual(stewardMainFrom({ main: null, kitVersion: null, packageJson: { text: 'not json' } }), main(null, null, null));
});

test("one of the Steward's own releases that failed is an alarm at once; none with the setting off", () => {
  const round = { stage: 'round' as const, started: '', finished: '', kit: null, asked: {}, results: [], log: [] };
  const failedSelf = { 'v0.8.1': { commit: H1, message: 'npm run release -- --publish failed (exit 1), so v0.8.1 wasn\'t released' } };
  const settings = structuredClone(DEFAULT_SETTINGS);
  const c = roundConditions({ round, failedReleases: {}, failedSelf, employees: [], settings });
  assert.deepEqual(c.map((x) => [x.id, x.who, x.afterMs]), [['self:v0.8.1:aaaaaaa', 'steward', 0]]);
  assert.match(c[0].title, /couldn't release v0\.8\.1 at aaaaaaa/);
  assert.deepEqual(roundConditions({ round, failedReleases: {}, failedSelf, employees: [], settings: { ...settings, releaseSelf: false } }), []);
});

// A fake Steward: its origin a bare repository GitHub's URL stands for (git's insteadOf), and its scripts noting what ran.
const dir = path.join(home, 'steward');
const origin = path.join(dir, 'origin.git');
const checkout = path.join(dir, 'Steward');
const ran = path.join(home, 'ran.txt');
const failKit = path.join(home, 'fail-kit');
const strayFlag = path.join(home, 'stray');
const URL = 'https://github.com/Jcollier0120/Steward.git';
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
sh(dir, 'init', '--quiet', '-b', 'main', checkout);
for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false', [`url.${origin.replace(/\\/g, '/')}.insteadOf`]: URL })) sh(checkout, 'config', k, v);
sh(checkout, 'remote', 'add', 'origin', URL);
const note = (what: string, fail?: string, stray?: boolean) =>
  `const fs = require('fs');\nfs.appendFileSync(${JSON.stringify(ran)}, ${JSON.stringify(what)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n${stray ? `if (fs.existsSync(${JSON.stringify(strayFlag)})) fs.writeFileSync('stray.txt', 'x');\n` : ''}${fail ? `if (fs.existsSync(${JSON.stringify(fail)})) process.exit(1);\n` : ''}`;
const files: Record<string, string> = {
  '.gitignore': 'node_modules/\nartifacts/\nsrc/kit/\n',
  'kit/VERSION': '1.1.0\n',
  'package.json': JSON.stringify({ name: 'steward', version: '0.9.0', type: 'commonjs', scripts: { release: 'node tools/release.js' } }, null, 2),
  'tools/kit.ts': note('fill', undefined, true),
  'tools/kit-release.ts': note('kit-release', failKit),
  'tools/release.js': note('release'),
};
for (const [f, t] of Object.entries(files)) {
  mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true });
  writeFileSync(path.join(checkout, f), t);
}
sh(checkout, 'add', '-A');
sh(checkout, 'commit', '--quiet', '-m', 'Steward 0.9.0, kit 1.1.0');
sh(checkout, 'push', '--quiet', 'origin', 'main');
const head = () => sh(origin, 'rev-parse', 'main');

/** A commit's statuses on GitHub: the team's vouch on each (stages/vouch.ts), so main's head isn't tested again before the Steward's release. */
const statuses = (a: string[]) => a[0] === 'api' && /\/statuses\b/.test(a[1] ?? '');
const VOUCHED = [{ context: VOUCH_CONTEXT, state: 'success', creator: { login: 'Jcollier0120' } }];
const r = runner((a) => (statuses(a) ? ok(VOUCHED) : undefined));
const ctx = ctxFor({ employees: [], workRoot: path.join(home, 'work'), run: r.run, neutralDir: home });
const lines = () => (existsSync(ran) ? readFileSync(ran, 'utf8').trim().split('\n') : []);
const facts = (tags: string[]) => ({ checkout, main: main('1.1.0', '0.9.0', head()), tags });

test("main's new versions are released from a clean worktree of it, kit first, with the repository's own scripts", async () => {
  const out = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(out.map((x) => [x.id, x.outcome, x.message.replace(/\(.{7}\)/, '(…)')]), [
    ['steward', 'done', 'self: released kit-v1.1.0 from origin/main (…)'],
    ['steward', 'done', 'self: released v0.9.0 from origin/main (…)'],
  ]);
  assert.deepEqual(lines(), ['fill --from kit', 'kit-release --publish', 'release --publish']);
  assert.deepEqual(SELF_COMMANDS.kit, ['node tools/kit.ts --from kit', 'node tools/kit-release.ts --publish']);
  assert.ok(out.some(releasedSomething), "the Steward's release tells Manor, as an employee's does");
  assert.equal(sh(checkout, 'status', '--porcelain'), '', 'the checkout untouched');
  assert.ok(!existsSync(path.join(home, 'work', '_steward-release')), 'the worktree removed');
  // The kit tried on the agents at that commit first (none here), and the Steward's version released on the team's vouch.
  assert.equal(JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[mainKeyOf(head())].passed, 0);
  assert.ok(r.gh.some((a) => statuses(a) && a[1].includes(`/commits/${head()}/statuses`)), "the vouch on main's head asked of GitHub");
  assert.match(ctx.lines.join('\n'), /\[steward\] Jcollier0120 vouched for .{7}: not tested again before its release/);

  unlinkSync(ran);
  assert.deepEqual(await releaseSelf(ctx, facts(['v0.9.0', 'kit-v1.1.0'])), [], 'released already: nothing');
  assert.deepEqual(lines(), []);
});

test('a release that fails is held until a new commit on main, and the Steward version waits for its kit', async () => {
  writeFileSync(failKit, '');
  const out = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(out.map((x) => [x.outcome, x.message]), [
    ['failed', "self: node tools/kit-release.ts --publish failed (exit 1), so kit-v1.1.0 wasn't released"],
    ['skipped', "self: v0.9.0 waits for kit-v1.1.0's release"],
  ]);
  assert.deepEqual(Object.keys(loadSelfFailures()), ['kit-v1.1.0']);
  assert.equal(loadSelfFailures()['kit-v1.1.0'].commit, head());

  unlinkSync(ran);
  assert.deepEqual(await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0'])), [], 'not tried again at that commit');
  assert.deepEqual(lines(), []);

  unlinkSync(failKit);
  writeFileSync(path.join(checkout, 'NOTES.md'), 'a fix\n');
  sh(checkout, 'add', 'NOTES.md');
  sh(checkout, 'commit', '--quiet', '-m', 'a fix');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const again = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(again.map((x) => x.outcome), ['done', 'done'], 'a new commit: tried again');
  assert.deepEqual(loadSelfFailures(), {});
});

test("main's kit is released only once tried on every agent at that commit: one it fails holds the kit and the Steward's version behind it; one still going holds the round's", async () => {
  const at = head();
  writeJson(kitTrialsFile(), { [mainKeyOf(at)]: { kit: '1.1.0', failed: [{ id: 'bad', name: 'Bad', message: 'node check.mjs failed (exit 1)' }], passed: 3, at: new Date().toISOString(), commit: at, steward: APP.version } });
  if (existsSync(ran)) unlinkSync(ran);
  const held = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(held.map((x) => [x.outcome, x.message]), [
    ['skipped', "self: kit-v1.1.0 isn't released: kit 1.1.0 fails 1 agent's checks here (Bad), so it isn't released: fix the kit on main, or the agents on theirs"],
    ['skipped', "self: v0.9.0 waits for kit-v1.1.0's release"],
  ]);
  assert.deepEqual(lines(), [], 'nothing released');
  assert.deepEqual(loadSelfFailures(), {}, "no release failed: the trial's alarm is its own");

  // Still being tried (here, waiting for room): the kit waits, and the round's kit with it.
  writeJson(kitTrialsFile(), { [mainKeyOf(at)]: { kit: '1.1.0', failed: [], passed: 0, at: new Date().toISOString(), commit: at, pending: ['gone'] } });
  const going = await releaseSelf({ ...ctx, memoryInUse: () => 0.9 }, facts(['v0.8.0', 'kit-v1.0.0']));
  assert.deepEqual(going.map((x) => [x.outcome, x.message, x.kitWaits]), [['skipped', `self: kit-v1.1.0 waits: ${TRIAL_NO_ROOM}`, '1.1.0']]);
  assert.deepEqual(lines(), []);
  rmSync(kitTrialsFile(), { force: true });
});

test("main's new kit tried ahead of the next build: nothing once it is released, or with no checkout; else what its trial came to", async () => {
  rmSync(kitTrialsFile(), { force: true });
  assert.equal(await trialAhead(ctx, facts(['v0.9.0', 'kit-v1.1.0'])), null, 'released already');
  assert.equal(await trialAhead(ctx, { ...facts(['v0.8.0', 'kit-v1.0.0']), checkout: path.join(home, 'nowhere') }), null, 'no checkout');
  assert.equal(await trialAhead(ctx, facts(['v0.8.0', 'kit-v1.0.0'])), 'kit 1.1.0 on main passed its trial on the agents: the next build releases it');
  const at = head();
  writeJson(kitTrialsFile(), { [mainKeyOf(at)]: { kit: '1.1.0', failed: [{ id: 'bad', name: 'Bad', message: 'x' }], passed: 3, at: new Date().toISOString(), commit: at, steward: APP.version } });
  assert.equal(await trialAhead(ctx, facts(['v0.8.0', 'kit-v1.0.0'])), "kit-v1.1.0: kit 1.1.0 fails 1 agent's checks here (Bad), so it isn't released: fix the kit on main, or the agents on theirs");
  rmSync(kitTrialsFile(), { force: true });
});

test("without a vouch, the Steward's version waits for main's head to be tested here: one whose checks fail isn't released", async () => {
  const bare = ctxFor({ employees: [], workRoot: path.join(home, 'work'), run: runner().run, neutralDir: home });
  if (existsSync(ran)) unlinkSync(ran);
  const out = await releaseSelf(bare, facts(['v0.8.0', 'kit-v1.1.0']));
  assert.deepEqual(out.map((x) => x.outcome), ['failed'], bare.lines.join('\n'));
  assert.match(out[0].message, /^self: v0\.9\.0 wasn't released: its checks failed/);
  assert.deepEqual(lines(), [], 'nothing released');
  assert.ok(bare.lines.some((l) => l.startsWith(`[steward] testing main at ${head().slice(0, 7)} before its release`)), bare.lines.join('\n'));
  rmSync(selfFailedFile(), { force: true });
});

test('never from a tree with anything uncommitted in it, and never from a checkout whose origin is another repository', async () => {
  if (existsSync(ran)) unlinkSync(ran);
  writeFileSync(strayFlag, '');
  const dirty = await releaseSelf(ctx, facts(['v0.8.0', 'kit-v1.0.0']));
  unlinkSync(strayFlag);
  assert.equal(dirty[0].outcome, 'failed');
  assert.match(dirty[0].message, /^self: the worktree at .{7} isn't clean \(\?\? stray\.txt\), so kit-v1\.1\.0 wasn't released$/);
  assert.deepEqual(lines(), ['fill --from kit'], 'nothing published');

  const other = { ...ctx, settings: { ...ctx.settings, stewardRepo: 'Someone/Else' } };
  const refused = await releaseSelf(other, { ...facts(['v0.8.0', 'kit-v1.0.0']), main: main('1.1.0', '0.9.0', 'c'.repeat(40)) });
  assert.deepEqual(refused.map((x) => [x.outcome, x.message]), [['refused', `self: kit-v1.1.0 and v0.9.0 not released: ${checkout}'s origin is Jcollier0120/Steward, not Someone/Else`]]);
});

test("under node --test a round leaves the Steward's own releases alone unless a test names the checkout", async () => {
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ employees: [], team: ['Jcollier0120'], workRoot: path.join(home, 'work'), stewardCheckout: checkout }));
  const gh = runner((a) => a[0] === 'pr' && a[1] === 'list' ? { code: 0, out: '[]', err: '' } : statuses(a) ? ok(VOUCHED) : a[0] === 'release' && a[1] === 'list' ? ok([]) : ({ code: 0, out: JSON.stringify({ data: { steward: { releases: { nodes: [] }, main: { target: { oid: head() } }, kitVersion: { text: '1.1.0' }, packageJson: { text: '{"version":"0.9.0"}' } } } }), err: '' }));
  if (existsSync(ran)) unlinkSync(ran);
  const out = await runStage('round', {}, { run: gh.run });
  assert.deepEqual(out.results, []);
  assert.deepEqual(lines(), []);
  // Named: the round releases what its glance says main carries, unreleased (a new commit, since the dirty one failed).
  writeFileSync(path.join(checkout, 'NOTES.md'), 'another fix\n');
  sh(checkout, 'commit', '--quiet', '-am', 'another fix');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const named = await runStage('round', {}, { run: gh.run, self: { checkout } });
  assert.deepEqual(named.results.filter((x) => x.id !== 'steward' || x.outcome !== 'skipped').map((x) => [x.outcome, x.message.replace(/\(.{7}\)/, '(…)')]), [
    ['done', 'self: released kit-v1.1.0 from origin/main (…)'],
    ['done', 'self: released v0.9.0 from origin/main (…)'],
  ]);
  assert.deepEqual(lines(), ['fill --from kit', 'kit-release --publish', 'release --publish']);
});

test('a Steward that is also its own employee still releases itself when the rounds take turns', async () => {
  // takeTurns keeps one entry per id, so the employee comes back in place of the Steward's own entry.
  const own = { id: 'steward', name: 'Steward', repo: 'Jcollier0120/Steward', checkout, merges: true };
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ employees: [own], team: ['Jcollier0120'], workRoot: path.join(home, 'work'), stewardCheckout: checkout }));
  const gh = runner((a) => a[0] === 'pr' && a[1] === 'list' ? { code: 0, out: '[]', err: '' } : statuses(a) ? ok(VOUCHED) : a[0] === 'release' && a[1] === 'list' ? ok([]) : ({ code: 0, out: JSON.stringify({ data: { steward: { releases: { nodes: [] }, main: { target: { oid: head() } }, kitVersion: { text: '1.1.0' }, packageJson: { text: '{"version":"0.9.0"}' } } } }), err: '' }));
  if (existsSync(ran)) unlinkSync(ran);
  const out = await runStage('round', {}, { run: gh.run, self: { checkout }, turns: { remote: async () => null } });
  assert.deepEqual(out.results.filter((x) => x.message.startsWith('self: ')).map((x) => [x.outcome, x.message.replace(/\(.{7}\)/, '(…)')]), [
    ['done', 'self: released kit-v1.1.0 from origin/main (…)'],
    ['done', 'self: released v0.9.0 from origin/main (…)'],
  ], JSON.stringify(out.results));
});
