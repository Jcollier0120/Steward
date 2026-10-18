import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Ran, Runner } from '../src/run.ts';
import type { Employee } from '../src/settings.ts';
import { STAFF as DEFAULT_EMPLOYEES } from './fixtures/staff.ts';
import { exchequerConditions } from '../src/alarms.ts';
import { actedFile } from '../src/strangers.ts';
import { dueAgain, exchequerCommand, exchequerWhy, finishFailed, loadExchequerPending, missedExchequer, type ExchequerPending } from '../src/stages/exchequer.ts';
import { finishPending, releaseOne } from '../src/stages/release.ts';
import { ctxFor, ok, runner, sh } from './helpers.ts';

// By its real path, as git and the work folder spell it (the temporary folder may be on a Dev Drive mounted in a folder).
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'steward-exchequer-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

const MINUTE = 60_000;
const SAYS_STANDS = 'The GitHub release stands; npm run release -- --exchequer finishes it.';
const onlyLine = (id: string, version: string, repo: string) => `Not published to the Exchequer: ${id}-v${version} is in ${repo} only, and Manor looks for it at the Exchequer alone: npm run release -- --exchequer finishes it.`;

/** A Clerk at `version` on its origin's main, as the kit's agents are: its release is npm run release -- --publish. */
function clerkAt(name: string, version: string): { e: Employee; head: string } {
  const origin = path.join(tmp, `${name}-origin.git`);
  const checkout = path.join(tmp, name);
  sh(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '--quiet', origin, checkout);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false' })) sh(checkout, 'config', k, v);
  writeFileSync(path.join(checkout, 'package.json'), `{\n  "name": "clerk",\n  "version": "${version}",\n  "scripts": { "release": "node tools/kit.ts && node src/kit/release.ts" }\n}\n`);
  writeFileSync(path.join(checkout, 'kit.json'), '{\n  "kit": "2.82.4",\n  "parts": ["node", "web", "spec"]\n}\n');
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', `Clerk ${version}`);
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const clerk = DEFAULT_EMPLOYEES.find((x) => x.id === 'clerk')!;
  return { e: { ...clerk, checkout, versionFiles: ['package.json'] }, head: sh(checkout, 'rev-parse', 'HEAD') };
}

/**
 * gh and npm stood in for: GitHub lists `released` (and the new version once the release has run), the release says
 * `publish`, each --exchequer what `finish` hands out next. Each --exchequer is kept with the commit its folder was at.
 */
function fakes(o: { version: string; before: string; publish: Ran; finish: Ran[]; gitHubTakesIt?: boolean }) {
  let made = false;
  const finishes: { cwd: string; head: string }[] = [];
  const gh = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok([...(made && o.gitHubTakesIt !== false ? [{ tagName: `v${o.version}`, isDraft: false }] : []), { tagName: `v${o.before}`, isDraft: false }]) : undefined));
  const run: Runner = async (cmd, args, opts) => {
    if (cmd !== 'npm') return gh.run(cmd, args, opts);
    if (args[0] !== 'run') return ok('');
    if (args.includes('--publish')) {
      made = true;
      return o.publish;
    }
    assert.deepEqual(args, ['run', 'release', '--', '--exchequer']);
    finishes.push({ cwd: String(opts?.cwd), head: sh(String(opts?.cwd), 'rev-parse', 'HEAD') });
    return o.finish.shift() ?? { code: 1, out: '', err: 'no stand-in for another --exchequer' };
  };
  return { run, finishes };
}

test('a release the Exchequer timed out for is released on GitHub, and the rounds publish it there from the released commit as it comes back', async () => {
  const { e, head } = clerkAt('Clerk-timeout', '0.3.4');
  const timedOut = `Not published to the Exchequer: couldn't reach https://api.castellan-software.com: fetch failed (UND_ERR_CONNECT_TIMEOUT). ${SAYS_STANDS}`;
  const f = fakes({
    version: '0.3.4',
    before: '0.3.3',
    publish: { code: 1, out: 'Clerk 0.3.4 (abc1234, kit 2.82.4): artifacts\\clerk\\Clerk-0.3.4.zip\nhttps://github.com/Jcollier0120/Clerk/releases/tag/v0.3.4\n', err: `${timedOut}\n${onlyLine('clerk', '0.3.4', 'Jcollier0120/Clerk')}\n` },
    finish: [
      { code: 1, out: '', err: `Not published to the Exchequer: couldn't reach https://api.castellan-software.com: it timed out. ${SAYS_STANDS}\n` },
      { code: 0, out: 'Published to the Exchequer: clerk-v0.3.4 (Clerk-0.3.4.zip, SHA256SUMS.txt, manor-agent.json).\n', err: '' },
    ],
  });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-timeout'), run: f.run, neutralDir: tmp });

  // Released on GitHub: this Steward's release, never a failure nor a stranger's.
  const released = await releaseOne(ctx, e, { kit: '2.82.4' });
  assert.equal(released.outcome, 'done', `${released.message}\n${ctx.lines.join('\n')}`);
  assert.ok(released.message.endsWith("; on GitHub only for now: the Exchequer couldn't be reached (couldn't reach https://api.castellan-software.com: fetch failed (UND_ERR_CONNECT_TIMEOUT)), so the rounds publish it there"), released.message);
  assert.equal(released.commit, head.slice(0, 7));
  const acted = JSON.parse(readFileSync(actedFile(), 'utf8')) as { released: Record<string, string> };
  assert.ok(acted.released['clerk:v0.3.4'], 'noted as this Steward\'s release, so no "another Steward" alarm');
  const p = loadExchequerPending().clerk;
  assert.deepEqual({ version: p.version, commit: p.commit, passing: p.passing, tries: p.tries }, { version: '0.3.4', commit: head, passing: true, tries: 0 });
  const t0 = Date.parse(p.last);

  // The next round, minutes later, leaves it: not due yet.
  assert.deepEqual(await finishPending(ctx, [e], new Date(t0 + 5 * MINUTE)), []);
  assert.equal(f.finishes.length, 0);

  // Due: the agent's own --exchequer, in a worktree of the commit released. The Exchequer times out again: it waits, no failure.
  const again = await finishPending(ctx, [e], new Date(t0 + 16 * MINUTE));
  assert.equal(again.length, 1);
  assert.equal(again[0].outcome, 'skipped', again[0].message);
  assert.equal(again[0].message, "v0.3.4 is on GitHub only still: the Exchequer couldn't be reached again (couldn't reach https://api.castellan-software.com: it timed out), so the rounds try again");
  assert.deepEqual(f.finishes, [{ cwd: path.join(tmp, 'work-timeout', 'clerk-release'), head }]);
  assert.equal(loadExchequerPending().clerk.tries, 1);
  // Its alarm only once it has waited Settings' waiting hours.
  const [waits] = exchequerConditions(loadExchequerPending(), [e], ctx.settings);
  assert.equal(waits.id, 'exchequer:clerk:0.3.4:waits');
  assert.equal(waits.afterMs, 24 * 60 * MINUTE);

  // Fifteen minutes after that try: published, and nothing waits any more.
  assert.deepEqual(await finishPending(ctx, [e], new Date(t0 + 20 * MINUTE)), []);
  const done = await finishPending(ctx, [e], new Date(t0 + 32 * MINUTE));
  assert.equal(done[0]?.outcome, 'done', done[0]?.message);
  assert.equal(done[0].message, "published v0.3.4 to the Exchequer from its release on GitHub, which hadn't reached it (couldn't reach https://api.castellan-software.com: it timed out)");
  assert.equal(f.finishes.length, 2);
  assert.equal(loadExchequerPending().clerk, undefined);
  assert.deepEqual(exchequerConditions(loadExchequerPending(), [e], ctx.settings), []);
  assert.deepEqual(await finishPending(ctx, [e], new Date(t0 + 10 * 60 * MINUTE)), []);
});

test('a release the Exchequer refused reaches a person at once; the rounds leave it, and their Release publishes it', async () => {
  const { e, head } = clerkAt('Clerk-refused', '0.3.5');
  const refused = `Not published to the Exchequer: the draft of clerk-v0.3.5 was refused: This key may not publish clerk. (403 forbidden). ${SAYS_STANDS}`;
  const f = fakes({
    version: '0.3.5',
    before: '0.3.4',
    publish: { code: 1, out: '', err: `${refused}\n${onlyLine('clerk', '0.3.5', 'Jcollier0120/Clerk')}\n` },
    finish: [{ code: 0, out: 'Published to the Exchequer: clerk-v0.3.5 (Clerk-0.3.5.zip, SHA256SUMS.txt, manor-agent.json).\n', err: '' }],
  });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-refused'), run: f.run, neutralDir: tmp });

  const released = await releaseOne(ctx, e, { kit: '2.82.4' });
  assert.equal(released.outcome, 'failed', released.message);
  assert.match(released.message, /^released v0\.3\.5 from origin\/main \(\w{7}\), with kit 2\.82\.4; on GitHub only: the Exchequer refused it \(the draft of clerk-v0\.3\.5 was refused: This key may not publish clerk\. \(403 forbidden\)\), so no one is offered it: fix that, then press Publish it now on its alarm \(or Release Clerk\)/);
  // Released, so no failed release stands for the rounds, and nothing is filed for the Wright: the alarm is the person's.
  assert.equal(released.released, true);
  assert.equal(released.commit, undefined);
  const p = loadExchequerPending().clerk;
  assert.equal(p.passing, false);
  const [alarm] = exchequerConditions(loadExchequerPending(), [e], ctx.settings);
  assert.deepEqual({ id: alarm.id, afterMs: alarm.afterMs, title: alarm.title }, { id: 'exchequer:clerk:0.3.5:refused', afterMs: 0, title: 'Clerk v0.3.5 is released on GitHub, but the Exchequer refused it' });

  // The rounds never try it again.
  assert.deepEqual(await finishPending(ctx, [e], new Date(Date.parse(p.last) + 10 * 60 * MINUTE)), []);
  assert.equal(f.finishes.length, 0);

  // A person's Release, once it's fixed: published from the commit released, and nothing else to say.
  const fixed = await releaseOne(ctx, e, { kit: null });
  assert.equal(fixed.outcome, 'done', `${fixed.message}\n${ctx.lines.join('\n')}`);
  assert.equal(fixed.message, "published v0.3.5 to the Exchequer from its release on GitHub, which hadn't reached it (the draft of clerk-v0.3.5 was refused: This key may not publish clerk. (403 forbidden))");
  assert.deepEqual(f.finishes.map((x) => x.head), [head]);
  assert.equal(loadExchequerPending().clerk, undefined);
});

test('a release whose GitHub release was never made, for all the kit says, failed as before: nothing waits for the Exchequer', async () => {
  const { e } = clerkAt('Clerk-nogithub', '0.3.6');
  const f = fakes({
    version: '0.3.6',
    before: '0.3.5',
    gitHubTakesIt: false,
    publish: { code: 1, out: '', err: `Not published to the Exchequer: couldn't reach https://api.castellan-software.com: fetch failed (ENOTFOUND). ${SAYS_STANDS}\n${onlyLine('clerk', '0.3.6', 'Jcollier0120/Clerk')}\n` },
    finish: [],
  });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-nogithub'), run: f.run, neutralDir: tmp });
  const failed = await releaseOne(ctx, e, { kit: '2.82.4' });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.message, 'npm run release -- --publish failed (exit 1)');
  assert.equal(loadExchequerPending().clerk, undefined);
});

test("the kit's lines: why the Exchequer didn't take a release, and whether that passes", () => {
  const timeout = `Not published to the Exchequer: couldn't reach https://api.castellan-software.com: fetch failed (UND_ERR_CONNECT_TIMEOUT). ${SAYS_STANDS}`;
  assert.deepEqual(missedExchequer(`built\n${timeout}\r\n${onlyLine('bridgeward', '0.2.26', 'Jcollier0120/Bridgeward')}\r\n`), { why: "couldn't reach https://api.castellan-software.com: fetch failed (UND_ERR_CONNECT_TIMEOUT)", passing: true });
  // Its own failing, in the kit's why() words, passes too.
  assert.equal(missedExchequer(`Not published to the Exchequer: couldn't ask https://x which agents it sells: The Exchequer's database didn't answer. (503 unavailable). ${SAYS_STANDS}\n${onlyLine('a', '1.0.0', 'o/A')}`)?.passing, true);
  assert.equal(missedExchequer(`Not published to the Exchequer: uploading A-1.0.0.zip failed: R2 said no (500 internal). ${SAYS_STANDS}\n${onlyLine('a', '1.0.0', 'o/A')}`)?.passing, true);
  // One it doesn't sell, or turned down, doesn't.
  assert.deepEqual(missedExchequer(`The Exchequer: crier isn't one of the agents it sells, so crier-v0.2.36 is on GitHub alone.\n${onlyLine('crier', '0.2.36', 'o/Crier')}`), { why: "crier isn't one of the agents it sells", passing: false });
  assert.equal(missedExchequer(`Not published to the Exchequer: https://x/api/v1/publish/a/1.0.0 refused the draft: HTTP 409. ${SAYS_STANDS}\n${onlyLine('a', '1.0.0', 'o/A')}`)?.passing, false);
  // Published, or not the kit's line for a release on GitHub alone: nothing missed.
  assert.equal(missedExchequer('Published to the Exchequer: porter-v0.4.26 (Porter-0.4.26.zip).'), null);
  assert.equal(missedExchequer(timeout), null);
  assert.equal(exchequerWhy('nothing of the sort'), null);
  // A try with --exchequer that GitHub failed: its network line, else its last.
  assert.deepEqual(finishFailed("Couldn't ask GitHub about v1.0.0 in o/A: error connecting to api.github.com\n"), { why: "Couldn't ask GitHub about v1.0.0 in o/A: error connecting to api.github.com", passing: true });
  assert.deepEqual(finishFailed('o/A has no v1.0.0: publish it with npm run release -- --publish.\n'), { why: 'o/A has no v1.0.0: publish it with npm run release -- --publish.', passing: false });
});

test("the agent's command for the Exchequer, and when a round tries again", () => {
  assert.equal(exchequerCommand('npm run release -- --publish'), 'npm run release -- --exchequer');
  assert.equal(exchequerCommand('npm run release -- --publish --urgent'), 'npm run release -- --exchequer');
  assert.equal(exchequerCommand('node src/kit/release.ts --publish'), 'node src/kit/release.ts --exchequer');
  assert.equal(exchequerCommand('npm run release -- --install'), null);
  const at = Date.parse('2026-10-17T21:40:00Z');
  const p = (tries: number, passing = true): ExchequerPending => ({ version: '0.2.26', commit: 'c'.repeat(40), why: 'it timed out', passing, since: new Date(at).toISOString(), last: new Date(at).toISOString(), tries });
  const due = (q: ExchequerPending, minutes: number) => dueAgain(q, new Date(at + minutes * MINUTE));
  assert.deepEqual([due(p(0), 14), due(p(0), 15), due(p(1), 15), due(p(2), 29), due(p(2), 30), due(p(3), 60), due(p(9), 179), due(p(9), 180)], [false, true, true, false, true, true, false, true]);
  assert.equal(due(p(0, false), 10_000), false, 'one the Exchequer refused is a person\'s');
});
