import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A kit PR's vouch tries its kit on the agents, as main's trial will once it's merged (stages/vouch.ts's vouchTrial,
// trial.ts's kitTrialOfClone, Steward 0.36.240): on fake agents made with git in a temporary folder, one whose checks
// pass with the PR's kit and one whose test it breaks.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-vouch-trial-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
// The Assayer's record of checks, never the person's own.
process.env.ASSAYER_HOME = path.join(tmp, 'assayer');
mkdirSync(process.env.ASSAYER_HOME, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

const { APP } = await import('../src/app.ts');
const { trialBranch, trialDirOf } = await import('../src/stages/bump.ts');
const { VOUCH_CONTEXT } = await import('../src/stages/staff.ts');
const { vouch, vouchTrial } = await import('../src/stages/vouch.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const kitTool = readFileSync(new URL('../tools/kit.ts', import.meta.url), 'utf8');
// An agent's test that relies on what the kit says, as Reeve's relied on the kit's manor.localhost: it passes on its
// main as it is (kit 1.0.0) and fails with any other, reported as node --test reports it (a node --test of its own
// would report to this file's test runner instead, and pass).
const PINNED = [
  "import { readFileSync } from 'node:fs';",
  "const held = JSON.parse(readFileSync('kit.json', 'utf8')).kit === '1.0.0';",
  "console.log(held ? 'ok 1 - Back to the manor links its page' : 'not ok 1 - Back to the manor links its page\\n  ---\\n  error: Expected values to be strictly equal\\n  ...');",
  'process.exit(held ? 0 : 1);',
  '',
].join('\n');

// The Steward: main with kit 1.0.0, and a PR's clone of it, as a session's is.
const steward = fakeEmployee(path.join(tmp, 'steward'), { kit: null, files: { 'kit/VERSION': '1.0.0\n', 'kit/CHANGELOG.md': '## 1.0.0\n', 'kit/node/npu.ts': 'export const npu = 1;\n', 'tools/kit.ts': kitTool } });
const me = employee(steward.checkout, { id: APP.id, name: APP.name, repo: 'Jcollier0120/Steward', usesKit: false, fill: '' });
sh(steward.checkout, 'remote', 'set-url', 'origin', 'https://github.com/Jcollier0120/Steward.git');
// Fetches from "GitHub" (the kit's release tags) reach its fake origin, never the network.
sh(steward.checkout, 'config', `url.${steward.origin.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/Jcollier0120/Steward.git');

const good = employee(fakeEmployee(path.join(tmp, 'good'), { files: { 'tools/kit.ts': kitTool } }).checkout, { id: 'good', name: 'Good' });
const badMade = fakeEmployee(path.join(tmp, 'bad'), { files: { 'tools/kit.ts': kitTool, 'pinned.mjs': PINNED } });
const bad = employee(badMade.checkout, { id: 'bad', name: 'Bad', test: ['node pinned.mjs'] });

/** A branch of the Steward's clone from main with `files` committed: its head. */
const branch = (name: string, files: Record<string, string>) => {
  sh(steward.checkout, 'switch', '--quiet', '-C', name, 'origin/main');
  for (const [f, t] of Object.entries(files)) writeFileSync(path.join(steward.checkout, f), t);
  sh(steward.checkout, 'add', '-A');
  sh(steward.checkout, 'commit', '--quiet', '-m', name);
  return sh(steward.checkout, 'rev-parse', 'HEAD');
};

function ctx(head: string) {
  const r = runner((a) => {
    if (a[0] === 'pr' && a[1] === 'view') return ok({ number: 9, state: 'OPEN', headRefOid: head, isCrossRepository: false });
    if (a[0] === 'pr' && a[1] === 'list') return ok([]);
    if (a[0] === 'api') return ok('{}');
  });
  return { c: { ...ctxFor({ employees: [me, good, bad], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp }), retired: new Set<string>() }, r };
}

test("a PR that leaves what the agents take from the kit as main has it (its changelog, kit/VERSION), or another repository's, has no trial", async () => {
  const head = branch('claude/kit-notes', { 'kit/VERSION': '1.0.1\n', 'kit/CHANGELOG.md': '## 1.0.1\n\n## 1.0.0\n' });
  const { c } = ctx(head);
  const said: string[] = [];
  assert.equal(await vouchTrial(c, me, { dir: steward.checkout, head, say: (l) => said.push(l) }), null);
  assert.deepEqual(said, ["no kit trial: what the agents take from the kit is main's"]);
  assert.equal(await vouchTrial(c, good, { dir: good.checkout, head: sh(good.checkout, 'rev-parse', 'HEAD'), say: (l) => said.push(l) }), null, "an agent's own PR");
  assert.equal(said.length, 1);
  assert.deepEqual(c.lines.filter((l) => / trial: /.test(l)), [], 'no agent tried');
});

test("a kit PR's vouch tries its kit on each agent, one at a time, and fails naming the agent and its test the kit breaks; fixed on the agent's main, it passes and says so on GitHub", async () => {
  const head = branch('claude/kit-change', { 'kit/VERSION': '1.0.1\n', 'kit/CHANGELOG.md': '## 1.0.1\n\n## 1.0.0\n', 'kit/node/npu.ts': 'export const npu = 2;\n' });
  const said: string[] = [];
  const failing = ctx(head);
  const v = await vouch(failing.c, { dir: steward.checkout, say: (l) => said.push(l) });
  assert.equal(v.ok, false, `${v.message}\n${said.join('\n')}\n${failing.c.lines.filter((l) => l.startsWith('[bad]')).join('\n')}`);
  assert.match(v.message, /^#9's checks failed at [0-9a-f]{7}: kit 1\.0\.1 fails 1 agent's checks \(Bad\), as main's trial would: Bad: node pinned\.mjs failed \(exit 1\): "Back to the manor links its page" \(Expected values to be strictly equal\)/);
  assert.match(v.message, /Nothing was recorded$/);
  assert.ok(!failing.r.gh.some((a) => a[0] === 'api'), 'no status set');
  // Its own checks first, then each agent in turn, the next only once the one before it is done: Good, then Bad. Where
  // Bad's checks without the kit fail otherwise on this PC (its kit 1.0.0 can't be fetched), it's tried once more,
  // alone, after the rest, as main's trial does.
  const turns = said.filter((l) => /^kit 1\.0\.1 tried on |^(Good|Bad): /.test(l)).map((l) => l.replace(/: .*/s, '').replace(/ \(.*\)$/, ''));
  assert.deepEqual(turns.slice(0, 4), ['kit 1.0.1 tried on Good', 'Good', 'kit 1.0.1 tried on Bad', 'Bad'], said.join('\n'));
  assert.ok(turns.length === 4 || JSON.stringify(turns.slice(4)) === JSON.stringify(['kit 1.0.1 tried on Bad once more, alone', 'Bad']), said.join('\n'));
  assert.ok(said.indexOf("its kit 1.0.1 changes what the agents take from it: tried on each of them, one at a time, as main's trial will try it") > said.findIndex((l) => l.startsWith('node -e process.exit(0): ok')), 'after its own checks pass');
  // Nothing left behind: no trial worktree or branch in the agents' clones, which are as they were.
  for (const e of [good, bad]) {
    assert.ok(!existsSync(trialDirOf(failing.c.settings, e)), `${e.id}'s trial worktree is removed`);
    assert.equal(sh(e.checkout, 'branch', '--list', trialBranch('1.0.1')), '');
    assert.equal(sh(e.checkout, 'status', '--porcelain'), '');
  }

  // Fixed on Bad's own main, so its test passes with the kit and without it: the vouch passes, and says the trial did.
  writeFileSync(path.join(bad.checkout, 'pinned.mjs'), PINNED.replace(".kit === '1.0.0'", ".kit !== ''"));
  sh(bad.checkout, 'commit', '--quiet', '-am', 'Its test holds on any kit');
  sh(bad.checkout, 'push', '--quiet', 'origin', 'main');
  const passing = ctx(head);
  const fixed = await vouch(passing.c, { dir: steward.checkout, say: () => {} });
  assert.equal(fixed.ok, true, fixed.message);
  const status = passing.r.gh.find((a) => a[0] === 'api');
  assert.deepEqual(status?.slice(0, 8), ['api', '-X', 'POST', `repos/Jcollier0120/Steward/statuses/${head}`, '-f', 'state=success', '-f', `context=${VOUCH_CONTEXT}`]);
  assert.equal(status?.[9], `description=node -e process.exit(0) passed at ${head.slice(0, 7)}; kit 1.0.1 passed 2 of 2 agents' checks`);
});

test("on a PC with no agents to try a kit on, its vouch says it wasn't tried, and that main's trial tries it: never that it passed", async () => {
  const head = branch('claude/kit-change-here', { 'kit/VERSION': '1.0.2\n', 'kit/CHANGELOG.md': '## 1.0.2\n\n## 1.0.0\n', 'kit/node/npu.ts': 'export const npu = 3;\n' });
  // This PC's Steward looks after none of the agents on the kit: itself alone, as on a PC that doesn't release Castellan.
  const alone = () => {
    const { c, r } = ctx(head);
    c.settings.employees = [me];
    return { c, r };
  };
  const said: string[] = [];
  const { c } = alone();
  assert.deepEqual(await vouchTrial(c, me, { dir: steward.checkout, head, say: (l) => said.push(l) }), { untried: "kit 1.0.2 not tried: no agents on this PC; main's trial tries them" });
  assert.ok(said.includes("kit 1.0.2 isn't tried here: this PC has no agents to try it on (none main's trial tries has a clone here). Main's trial on the PC that releases Castellan tries them once it's merged"), said.join('\n'));
  assert.ok(!said.some((l) => /passed \d+ of \d+/.test(l)), said.join('\n'));

  // The vouch passes on its own checks, and its description on GitHub says the kit wasn't tried.
  const v = alone();
  const vouched = await vouch(v.c, { dir: steward.checkout, say: () => {} });
  assert.equal(vouched.ok, true, vouched.message);
  const status = v.r.gh.find((a) => a[0] === 'api');
  assert.equal(status?.[9], `description=node -e process.exit(0) passed at ${head.slice(0, 7)}; kit 1.0.2 not tried: no agents on this PC; main's trial tries them`);
});
