import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A kit trial and a rollout's bump of an agent whose test copied the kit's words (stages/copied.ts, Steward 0.36.180),
// as kits 2.97.1 to 2.100.0 were held: the Steward's kit rewords its note label from 1.0.0 to 1.0.1, and the agent's
// test expects the old words. Its tests run in a scratch profile of their own (stages/trialprofile.ts).
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-trial-copied-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { kitTrialAtMain, kitTrialsFile, mainKeyOf } = await import('../src/stages/trial.ts');
const { bumpOne, trialDirOf } = await import('../src/stages/bump.ts');
const { trialProfileOf } = await import('../src/stages/trialprofile.ts');
const { claimsFile } = await import('../src/claims.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

const kitTool = readFileSync(new URL('../tools/kit.ts', import.meta.url), 'utf8');
const OLD = 'note from the NPU, unverified';
const NEW = 'note from the NPU';

// The Steward: kit 1.0.0 released (its tag on origin) with the old label, and main at 1.0.1 with the new one.
const steward = fakeEmployee(path.join(tmp, 'steward'), { kit: null, files: { 'kit/VERSION': '1.0.0\n', 'kit/node/label.ts': `export const LABEL = '${OLD}';\n`, 'tools/kit.ts': kitTool } });
sh(steward.checkout, 'tag', 'kit-v1.0.0');
sh(steward.checkout, 'push', '--quiet', 'origin', 'refs/tags/kit-v1.0.0');
writeFileSync(path.join(steward.checkout, 'kit', 'VERSION'), '1.0.1\n');
writeFileSync(path.join(steward.checkout, 'kit', 'node', 'label.ts'), `export const LABEL = '${NEW}';\n`);
sh(steward.checkout, 'commit', '--quiet', '-am', 'kit 1.0.1: the label reworded');
const head = sh(steward.checkout, 'rev-parse', 'HEAD');
const me = employee(steward.checkout, { id: 'steward', name: 'Steward', repo: 'Jcollier0120/Steward', usesKit: false });

/** An agent's test of the label (`expect`: how it writes what it expects), and of the scratch profile a trial's tests run in. */
const labelTest = (expect: string, profile: boolean) =>
  [
    "import assert from 'node:assert/strict';",
    "import os from 'node:os';",
    "import { test } from 'node:test';",
    "import { LABEL } from '../src/kit/label.ts';",
    '',
    "test('the note says where it came from', () => {",
    `  assert.equal(LABEL, ${expect});`,
    '});',
    '',
    `test('its tests run in a profile of their own', { skip: ${!profile} }, () => {`,
    '  assert.match(os.homedir(), /\\.profile$/);',
    "  assert.ok(process.env.LOCALAPPDATA?.startsWith(os.homedir()), 'its LOCALAPPDATA in it');",
    "  assert.ok(!process.env.npm_config_cache?.startsWith(os.homedir()), 'npm’s cache where it is');",
    '});',
    '',
  ].join('\n');

let n = 0;
function agent(expect: string, profile = false) {
  const dir = path.join(tmp, `agent-${++n}`);
  rmSync(claimsFile(), { force: true });
  const f = fakeEmployee(dir, { files: { 'tools/kit.ts': kitTool, 'test/label.test.ts': labelTest(expect, profile) } });
  const e = employee(f.checkout, { id: `copier${n}`, name: `Copier ${n}`, test: ['node --test test/label.test.ts'] });
  const r = runner((a) => (a[0] === 'release' && a[1] === 'list' ? ok([]) : a[0] === 'pr' && a[1] === 'list' ? ok([]) : undefined));
  // Its tests' own node --test, not taken for one of this test's (which it would be with NODE_TEST_CONTEXT, running nothing).
  const run: typeof r.run = (cmd, args, opts = {}) => r.run(cmd, args, { ...opts, env: { ...opts.env, NODE_TEST_CONTEXT: undefined } });
  const c = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, released: ['1.0.1'], neutralDir: dir });
  c.settings.stewardCheckout = steward.checkout;
  return { ...f, e, c };
}

test("a trial: the test that expected the kit's old words is brought up to the new ones, passes, and the kit isn't held", async () => {
  rmSync(kitTrialsFile(), { force: true });
  const a = agent(`'${OLD}'`, true);
  const t = await kitTrialAtMain(a.c, me, { commit: head, kit: '1.0.1' });
  assert.equal(t.state, 'passed', a.c.lines.join('\n'));
  const line = a.c.lines.find((l) => l.startsWith(`[${a.e.id}] kit 1.0.1 trial: done`));
  assert.equal(line, `[${a.e.id}] kit 1.0.1 trial: done: kit 1.0.0 → 1.0.1: checks passed once its tests were brought up to the kit (test/label.test.ts:7: '${OLD}' → '${NEW}')`, a.c.lines.join('\n'));
  // Not kept as a pass of its main: its rollout's bump runs its checks, and brings its test up again.
  const k = JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[mainKeyOf(head)];
  assert.equal(k.passed, 1);
  assert.deepEqual(k.mains ?? {}, {});
  // Its own checkout as it was, its trial and its scratch profile gone.
  assert.match(readFileSync(path.join(a.checkout, 'test', 'label.test.ts'), 'utf8'), new RegExp(`'${OLD}'`));
  assert.equal(existsSync(trialProfileOf(trialDirOf(a.c.settings, a.e))), false);
});

test("a rollout's bump brings the test up too, and its commit carries it with a note", async () => {
  const a = agent(`'${OLD}'`);
  const res = await bumpOne(a.c, a.e, { kit: '1.0.1', kitFrom: path.join(steward.checkout, 'kit') });
  assert.equal(res.outcome, 'done', `${res.message}\n${a.c.lines.join('\n')}`);
  assert.match(res.message, /checks passed once its tests were brought up to the kit \(test\/label\.test\.ts:7: /);
  const branch = 'steward/kit-1.0.1';
  assert.deepEqual(sh(a.checkout, 'diff', '--name-only', 'origin/main', branch).split('\n').sort(), ['changes/README.md', 'changes/steward-kit-1-0-1.md', 'kit.json', 'test/label.test.ts']);
  assert.match(sh(a.checkout, 'show', `${branch}:test/label.test.ts`), new RegExp(`assert\\.equal\\(LABEL, '${NEW}'\\);`));
  assert.match(sh(a.checkout, 'log', '-1', '--format=%b', branch), new RegExp(`Its tests expected what kit 1\\.0\\.0 said, which kit 1\\.0\\.1 changed, and are brought up to it: test/label\\.test\\.ts:7: '${OLD}' → '${NEW}'\\. Its checks passed with them\\.`));
});

test('a copied text the bump can’t bring up (its test builds it elsewhere) holds the kit as before, named in the failure', async () => {
  const a = agent(`['note from the NPU', 'unverified'].join(', ')`);
  const res = await bumpOne(a.c, a.e, { kit: '1.0.1', kitFrom: path.join(steward.checkout, 'kit'), trial: true, base: 'origin/main' });
  assert.equal(res.outcome, 'failed', `${res.message}\n${a.c.lines.join('\n')}`);
  assert.ok(res.message.includes(`its tests expect what kit 1.0.0 said, which kit 1.0.1 changed: test/label.test.ts:7: '${OLD}' → '${NEW}'`), res.message);
});
