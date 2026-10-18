import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Steward's own release that reached GitHub but not the Exchequer (stages/self.ts, stages/exchequer.ts): from a fake
// Steward repository (a bare origin GitHub's URL stands for, and a clone), whose release script says what the kit's
// release.ts would and notes what it was asked. gh stands in for GitHub: it has a release once the script made it.
// Nothing reaches GitHub, the Exchequer, the live ~/.steward or the real checkout.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-self-exchequer-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { releaseSelf, loadSelfFailures, selfToFinish } = await import('../src/stages/self.ts');
const { stewardEmployee } = await import('../src/stages/selfmerge.ts');
const { askAgain, loadExchequerPending } = await import('../src/stages/exchequer.ts');
const { finishPending } = await import('../src/stages/release.ts');
const { exchequerConditions } = await import('../src/alarms.ts');
const { VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { APP } = await import('../src/app.ts');
const { ctxFor, ok, runner, sh } = await import('./helpers.ts');

const MINUTE = 60_000;
const URL = 'https://github.com/Jcollier0120/Steward.git';
const dir = path.join(home, 'steward');
const origin = path.join(dir, 'origin.git');
const checkout = path.join(dir, 'Steward');
/** What the release script was asked, a line each; how its publish to the Exchequer goes; the tags GitHub has. */
const ran = path.join(home, 'ran.txt');
const mode = path.join(home, 'mode.txt');
const exchequerDown = path.join(home, 'exchequer-down');
const gitHubHas = path.join(home, 'github-has.txt');

// As the kit's release.ts says it (kit 2.36.0's publishTo, exchequer.ts): GitHub's release made, then the Exchequer's line.
const RELEASE = `const fs = require('fs');
const { execSync } = require('child_process');
const args = process.argv.slice(2);
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
fs.appendFileSync(${JSON.stringify(ran)}, 'release ' + args.join(' ') + ' at ' + head + '\\n');
const stands = 'The GitHub release stands; npm run release -- --exchequer finishes it.';
if (args.includes('--publish')) {
  fs.appendFileSync(${JSON.stringify(gitHubHas)}, 'v' + version + '\\n');
  const why = fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim() === 'refused'
    ? 'the draft of steward-v' + version + ' was refused: This key may not publish steward. (403 forbidden)'
    : "couldn't reach https://api.castellan-software.com: fetch failed (UND_ERR_CONNECT_TIMEOUT)";
  console.error('Not published to the Exchequer: ' + why + '. ' + stands);
  console.error('Not published to the Exchequer: steward-v' + version + ' is in Jcollier0120/Steward only, and Manor looks for it at the Exchequer alone: npm run release -- --exchequer finishes it.');
  process.exit(1);
}
if (fs.existsSync(${JSON.stringify(exchequerDown)})) {
  console.error("Not published to the Exchequer: couldn't reach https://api.castellan-software.com: it timed out. " + stands);
  process.exit(1);
}
console.log('Published to the Exchequer: steward-v' + version + ' (Steward-' + version + '.zip, SHA256SUMS.txt, manor-agent.json).');
`;

mkdirSync(dir, { recursive: true });
sh(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
sh(dir, 'init', '--quiet', '-b', 'main', checkout);
for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false', [`url.${origin.replace(/\\/g, '/')}.insteadOf`]: URL })) sh(checkout, 'config', k, v);
sh(checkout, 'remote', 'add', 'origin', URL);
const commitVersion = (version: string) => {
  const files: Record<string, string> = {
    '.gitignore': 'node_modules/\nartifacts/\nsrc/kit/\n',
    'kit/VERSION': '1.1.0\n',
    'package.json': JSON.stringify({ name: 'steward', version, type: 'commonjs', scripts: { release: 'node tools/release.js' } }, null, 2),
    'tools/release.js': RELEASE,
  };
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true });
    writeFileSync(path.join(checkout, f), t);
  }
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', `Steward ${version}`);
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  return sh(origin, 'rev-parse', 'main');
};

/** main's head vouched for by the team (stages/vouch.ts), so it isn't tested again; GitHub's releases as the script made them. */
const VOUCHED = [{ context: VOUCH_CONTEXT, state: 'success', creator: { login: 'Jcollier0120' } }];
const has = (tag: string) => existsSync(gitHubHas) && readFileSync(gitHubHas, 'utf8').split('\n').includes(tag);
const r = runner((a) => {
  if (a[0] === 'api' && /\/statuses\b/.test(a[1] ?? '')) return ok(VOUCHED);
  if (a[0] === 'release' && a[1] === 'view') return has(a[2]) ? ok({ tagName: a[2] }) : { code: 1, out: '', err: 'release not found' };
  return undefined;
});
const ctx = ctxFor({ employees: [], workRoot: path.join(home, 'work'), run: r.run, neutralDir: home });
const lines = () => (existsSync(ran) ? readFileSync(ran, 'utf8').trim().split('\n') : []);
/** The Steward as the round hands it to finishPending (steward.ts). */
const self = () => selfToFinish(stewardEmployee(ctx.settings, checkout));

test("the Steward's own release the Exchequer timed out for is released on GitHub, and the rounds publish it there from the released commit", async () => {
  writeFileSync(mode, 'timeout');
  const head = commitVersion('0.9.0');
  const out = await releaseSelf(ctx, { checkout, main: { head, kit: '1.1.0', version: '0.9.0' }, tags: ['v0.8.0', 'kit-v1.1.0'] });
  assert.deepEqual(
    out.map((x) => [x.outcome, x.message.replace(/\(\w{7}\)/, '(…)')]),
    [['done', "self: released v0.9.0 from origin/main (…); on GitHub only for now: the Exchequer couldn't be reached (couldn't reach https://api.castellan-software.com: fetch failed (UND_ERR_CONNECT_TIMEOUT)), so the rounds publish it there"]],
    ctx.lines.join('\n'),
  );
  // Not a failure the rounds hold, and kept for the Exchequer.
  assert.deepEqual(loadSelfFailures(), {});
  const p = loadExchequerPending()[APP.id];
  assert.deepEqual({ version: p.version, commit: p.commit, passing: p.passing }, { version: '0.9.0', commit: head, passing: true });
  const t0 = Date.parse(p.last);

  // Its alarm names the Steward, after the waiting hours, with a button.
  const [waits] = exchequerConditions(loadExchequerPending(), [], ctx.settings);
  assert.deepEqual({ id: waits.id, who: waits.who, afterMs: waits.afterMs, action: waits.action?.label }, { id: 'exchequer:steward:0.9.0:waits', who: 'steward', afterMs: 24 * 60 * MINUTE, action: 'Publish it now' });
  assert.match(waits.title, /^Steward v0\.9\.0 is released on GitHub, but the Exchequer couldn't be reached/);

  // Not due yet; then due, from a worktree of the commit released: the Exchequer still down, so it waits.
  writeFileSync(exchequerDown, '');
  unlinkSync(ran);
  assert.deepEqual(await finishPending(ctx, [self()], new Date(t0 + 5 * MINUTE)), []);
  const again = await finishPending(ctx, [self()], new Date(t0 + 16 * MINUTE));
  assert.deepEqual(again.map((x) => [x.id, x.outcome]), [['steward', 'skipped']], again[0]?.message);
  assert.deepEqual(lines(), [`release --exchequer at ${head}`]);

  // Back up: a person's "Publish it now" has the very next round try it, though its next try isn't due for a while.
  unlinkSync(exchequerDown);
  assert.equal(askAgain('exchequer:steward:0.8.9:waits'), false, 'not the version that waits');
  assert.equal(askAgain('exchequer:steward:0.9.0:waits'), true);
  const done = await finishPending(ctx, [self()], new Date(t0 + 18 * MINUTE));
  assert.equal(done[0]?.outcome, 'done', done[0]?.message);
  assert.equal(done[0].message, "published v0.9.0 to the Exchequer from its release on GitHub, which hadn't reached it (couldn't reach https://api.castellan-software.com: it timed out)");
  assert.deepEqual(lines(), [`release --exchequer at ${head}`, `release --exchequer at ${head}`]);
  assert.equal(loadExchequerPending()[APP.id], undefined);
  assert.equal(sh(checkout, 'status', '--porcelain'), '', 'the checkout untouched');
  assert.ok(!existsSync(path.join(home, 'work', 'steward-release')), 'the worktree removed');
});

test("the Steward's own release the Exchequer refused isn't held as failed: its alarm says so at once, and its button has a round publish it", async () => {
  writeFileSync(mode, 'refused');
  if (existsSync(ran)) unlinkSync(ran);
  const head = commitVersion('0.9.1');
  const out = await releaseSelf(ctx, { checkout, main: { head, kit: '1.1.0', version: '0.9.1' }, tags: ['v0.9.0', 'kit-v1.1.0'] });
  assert.equal(out[0]?.outcome, 'failed', ctx.lines.join('\n'));
  assert.match(out[0].message, /^self: released v0\.9\.1 from origin\/main \(\w{7}\); on GitHub only: the Exchequer refused it \(the draft of steward-v0\.9\.1 was refused: This key may not publish steward\. \(403 forbidden\)\), so no Manor is offered it: fix that, then press Publish it now on its alarm$/);
  assert.deepEqual(loadSelfFailures(), {}, "not the self-release alarm, whose advice (publish it by hand) GitHub's tag would refuse");
  const [alarm] = exchequerConditions(loadExchequerPending(), [], ctx.settings);
  assert.deepEqual({ id: alarm.id, afterMs: alarm.afterMs, action: alarm.action?.label }, { id: 'exchequer:steward:0.9.1:refused', afterMs: 0, action: 'Publish it now' });

  // The rounds leave it, however long; the button has the next one publish it.
  const t0 = Date.parse(loadExchequerPending()[APP.id].last);
  unlinkSync(ran);
  assert.deepEqual(await finishPending(ctx, [self()], new Date(t0 + 10 * 60 * MINUTE)), []);
  assert.deepEqual(lines(), []);
  assert.equal(askAgain(alarm.id), true);
  const done = await finishPending(ctx, [self()], new Date(t0 + 10 * 60 * MINUTE));
  assert.equal(done[0]?.outcome, 'done', done[0]?.message);
  assert.deepEqual(lines(), [`release --exchequer at ${head}`]);
  assert.equal(loadExchequerPending()[APP.id], undefined);
});

test("a try a person asked for is answered: the ask goes once it's tried, and the rounds' own spacing holds again", async () => {
  writeFileSync(mode, 'timeout');
  writeFileSync(exchequerDown, '');
  const head = commitVersion('0.9.2');
  await releaseSelf(ctx, { checkout, main: { head, kit: '1.1.0', version: '0.9.2' }, tags: ['v0.9.1', 'kit-v1.1.0'] });
  const t0 = Date.parse(loadExchequerPending()[APP.id].last);
  assert.equal(askAgain('exchequer:steward:0.9.2:waits'), true);
  assert.deepEqual((await finishPending(ctx, [self()], new Date(t0 + MINUTE))).map((x) => x.outcome), ['skipped']);
  assert.equal(loadExchequerPending()[APP.id].asked, undefined);
  assert.deepEqual(await finishPending(ctx, [self()], new Date(t0 + 2 * MINUTE)), [], 'not due again yet');
  unlinkSync(exchequerDown);
});
