import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A kit's trial tried only as far as the kit changes each agent (stages/kitreach.ts), a few agents each round
// (stages/trial.ts's slices): on fake employees made with git in a temporary folder.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-kitreach-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { kitReach, landsAt, partsTaken } = await import('../src/stages/kitreach.ts');
const { affectedSteps } = await import('../src/stages/bump.ts');
const { kitTrialHold, kitTrialsFile, TRIAL_GOING } = await import('../src/stages/trial.ts');
const { waitsBriefly } = await import('../src/stages/merge.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;

const kitTool = readFileSync(new URL('../tools/kit.ts', import.meta.url), 'utf8');

// The Steward: kit 1.0.0 released (the tag kit-v1.0.0), then a PR whose kit 1.0.1 changes only web\.
const steward = fakeEmployee(path.join(tmp, 'steward'), { kit: null, files: { 'kit/VERSION': '1.0.0\n', 'kit/CHANGELOG.md': '# Kit\n', 'kit/node/npu.ts': 'export const npu = 1;\n', 'kit/web/x.js': 'export const x = 1;\n', 'tools/kit.ts': kitTool } });
sh(steward.checkout, 'tag', 'kit-v1.0.0');
sh(steward.checkout, 'push', '--quiet', 'origin', 'kit-v1.0.0');
writeFileSync(path.join(steward.checkout, 'kit', 'VERSION'), '1.0.1\n');
writeFileSync(path.join(steward.checkout, 'kit', 'CHANGELOG.md'), '# Kit\n\n## 1.0.1\n\n**Web.**\n');
writeFileSync(path.join(steward.checkout, 'kit', 'web', 'x.js'), 'export const x = 2;\n');
sh(steward.checkout, 'commit', '--quiet', '-am', 'kit 1.0.1');
sh(steward.checkout, 'push', '--quiet', 'origin', 'HEAD:refs/pull/9/head');
const head = sh(steward.checkout, 'rev-parse', 'HEAD');
const me = employee(steward.checkout, { id: 'steward', name: 'Steward', repo: 'Jcollier0120/Steward', usesKit: false });

/** An agent on kit 1.0.0 taking `parts`, with the Steward's tools/kit.ts. */
const agent = (id: string, parts: string[]) => {
  const f = fakeEmployee(path.join(tmp, id), { files: { 'tools/kit.ts': kitTool, 'kit.json': JSON.stringify({ kit: '1.0.0', parts }) } });
  return employee(f.checkout, { id, name: id[0].toUpperCase() + id.slice(1) });
};

const pr = (): PrInfo => ({ number: 9, title: 'Steward 0.11.1, kit 1.0.1', url: 'https://github.com/Jcollier0120/Steward/pull/9', head: 'claude/web', base: 'main', author: 'Jcollier0120', whose: 'team', headOid: head, after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'none', labels: [], changed: 3, files: ['kit/VERSION', 'kit/web/x.js', 'kit/CHANGELOG.md'] });

function ctx(employees: ReturnType<typeof employee>[]) {
  const r = runner((args) => (args[0] === 'pr' && args[1] === 'comment' ? ok('') : args[0] === 'pr' && args[1] === 'list' ? ok([]) : undefined));
  return ctxFor({ employees: [me, ...employees], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
}

test('the parts an agent takes, and where each kit file lands in it', () => {
  assert.deepEqual(partsTaken(['node']), ['node', 'core', 'spec']);
  assert.deepEqual(partsTaken(null), ['node', 'web', 'spec', 'core'], "a Node agent's three when kit.json names none");
  assert.deepEqual(partsTaken(['react']), ['react', 'node', 'web', 'core', 'spec']);
  const node = partsTaken(['node']);
  assert.equal(landsAt('node/npu.ts', node), 'src/kit/npu.ts');
  assert.equal(landsAt('spec/rules.json', node), 'src/kit/spec/rules.json');
  assert.equal(landsAt('core/x.ts', node), 'src/kit/core/x.ts');
  assert.equal(landsAt('LICENSE', node), 'src/kit/LICENSE');
  assert.equal(landsAt('web/x.js', node), null, 'a part it does not take');
  for (const f of ['VERSION', 'CHANGELOG.md', 'test/a.test.ts', 'test/fixture/src/app.ts']) assert.equal(landsAt(f, node), null, f);
});

test("what a kit changes for an agent: nothing it takes, the files it takes that change, or everything when it can't tell", async () => {
  const c = ctx([]);
  const reach = (pin: { kit: string; parts: string[] | null }, toolChanged = false) => kitReach(c, { repo: steward.checkout, head, pin, toolChanged });
  assert.deepEqual(await reach({ kit: '1.0.0', parts: ['node'] }), { none: 'nothing it takes from the kit (node, core, spec) changes from 1.0.0' });
  assert.deepEqual(await reach({ kit: '1.0.0', parts: ['node', 'web'] }), { files: [{ status: 'M', path: 'src/kit/web/x.js' }], why: "1 of the kit's files it takes change from 1.0.0" });
  assert.deepEqual(await reach({ kit: '1.0.0', parts: ['node'] }, true), { all: 'its tools/kit.ts changes too' });
  assert.deepEqual(await reach({ kit: '0.9.0', parts: ['node'] }), { all: "kit 0.9.0's release couldn't be read" });
});

test('the given change picks the tests: only those that reach a changed kit file run', async () => {
  const dir = path.join(tmp, 'affected');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ scripts: { test: 'node --test "test/*.test.mjs"' } }),
    'src/kit/web/x.js': 'export const x = 2;\n',
    'src/kit/npu.ts': 'export const npu = 1;\n',
    'test/web.test.mjs': "import { x } from '../src/kit/web/x.js';\n",
    'test/npu.test.mjs': "import { npu } from '../src/kit/npu.ts';\n",
  };
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), t);
  }
  const scope: import('../src/stages/bump.ts').AffectedScope = { base: 'unused', changed: [{ status: 'M', path: 'src/kit/web/x.js' }] };
  const steps = await affectedSteps(ctx([]), dir, scope, () => {});
  assert.equal(steps.length, 1);
  assert.match(steps[0], /--test "test\/web\.test\.mjs"$/);
  assert.equal(scope.chose, 'affected: 1 of 2 test files');
});

test('a trial goes on over several rounds, a few agents each, and skips the agents the kit changes nothing for', async () => {
  rmSync(kitTrialsFile(), { force: true });
  const agents = [agent('plain', ['node']), agent('webone', ['node', 'web']), agent('webtwo', ['node', 'web'])];
  const holds: (string | null)[] = [];
  let going = 0;
  for (let round = 0; round < 3; round++) {
    const c = ctx(agents);
    c.settings.parallel = 1;
    holds.push(await kitTrialHold(c, me, pr(), { sliceMs: 0, going: () => going++ }));
  }
  assert.equal(holds[0], `${TRIAL_GOING}: 1 of 3 so far; the rounds go on meanwhile`);
  assert.equal(holds[1], `${TRIAL_GOING}: 2 of 3 so far; the rounds go on meanwhile`);
  assert.equal(holds[2], null, 'all tried: it merges');
  assert.equal(going, 2, 'the next round was asked to look again while it went on');
  assert.ok(waitsBriefly(holds[0]!), 'and to come sooner');

  const kept = JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[`9@${head}`];
  assert.equal(kept.pending, undefined);
  assert.deepEqual([kept.passed, kept.untouched, kept.failed.length], [2, 1, 0]);
  assert.deepEqual(Object.keys(kept.mains).sort(), ['webone', 'webtwo'], 'tried with all their checks (theirs are no npm test): kept for the rollout');
});
