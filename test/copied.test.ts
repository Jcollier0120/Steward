import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Tests that copied a kit value (stages/copied.ts, Steward 0.36.180): recognised from node's own TAP output against the
// kit's diff, and brought up to the kit. Each failure here is a real node --test run's, in a temporary folder.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-copied-'));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { applyFixes, copiedKitValues, copiedPairs, fixedText, fixesLine, kitChanges, kitChangesFor, tapFailures, textsOf } = await import('../src/stages/copied.ts');
const { trialProfileEnv } = await import('../src/stages/trialprofile.ts');
const { ctxFor, fakeEmployee, runner, sh } = await import('./helpers.ts');

/** The kit's diff as git gives it: the label reworded, its template too, with a comment and a short id beside them. */
const PATCH = [
  'diff --git a/kit/node/label.ts b/kit/node/label.ts',
  'index 1111111..2222222 100644',
  '--- a/kit/node/label.ts',
  '+++ b/kit/node/label.ts',
  '@@ -1,4 +1,3 @@',
  "-export const LABEL = 'note from the NPU, unverified';",
  "+export const LABEL = 'note from the NPU';",
  "-// the old words: 'a comment of the kit'",
  '-export const said = (who: string) => `note from ${who}, unverified`;',
  '+export const said = (who: string) => `note from ${who}`;',
  "-export const ID = 'short';",
  '',
].join('\n');
const kit = kitChanges(PATCH);

let n = 0;
/** A test file run by node --test in a folder of its own, as an agent's would be: its folder, file and whole output. */
function run(body: string, reporter?: string) {
  const dir = path.join(tmp, `case-${++n}`);
  mkdirSync(path.join(dir, 'test'), { recursive: true });
  const file = path.join(dir, 'test', 'label.test.ts');
  writeFileSync(file, ["import assert from 'node:assert/strict';", "import { test } from 'node:test';", "const LABEL = 'note from the NPU';", body, ''].join('\n'));
  const again = () => {
    // Run as the Steward runs an agent's tests: not from inside this test file's own run.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
    const r = spawnSync(process.execPath, ['--test', ...(reporter ? [`--test-reporter=${reporter}`] : []), 'test/label.test.ts'], { cwd: dir, env, encoding: 'utf8', windowsHide: true });
    return { code: r.status, output: `${r.stdout}\n${r.stderr}` };
  };
  return { dir, file, ...again(), again };
}

test("the texts a kit line writes: its strings, and a template's own parts around what it fills in", () => {
  assert.deepEqual(textsOf("export const LABEL = 'note from the NPU, unverified';"), [{ text: 'note from the NPU, unverified' }]);
  assert.deepEqual(textsOf('const a = "say \\"it\\" twice", b = \'it\\\'s here\';'), [{ text: 'say "it" twice' }, { text: "it's here" }]);
  assert.deepEqual(textsOf("const id = 'short';"), [], 'too short to be the kit’s');
  const [t] = textsOf('const s = `note from ${who.trim() || `nobody`}, unverified`;');
  assert.ok('re' in t);
  assert.ok(t.re.test('note from the NPU, unverified'));
  assert.ok(t.re.test('note from Reeve, unverified'));
  assert.ok(!t.re.test('note from the NPU'));
  assert.deepEqual(textsOf('const s = `a ${b}`;'), [], "a template whose own parts are too short");
});

test("what the kit's diff takes out and puts in, its comments and git's headers left out", () => {
  const texts = (ks: typeof kit.removed) => ks.map((k) => ('text' in k ? k.text : k.re.source));
  assert.deepEqual(texts(kit.removed), ['note from the NPU, unverified', '^note from [\\s\\S]*?, unverified$']);
  assert.deepEqual(texts(kit.added), ['note from the NPU', '^note from [\\s\\S]*?$']);
});

test("node's TAP output read: what each failed test expected and got, leaf by leaf, and where its assertion is", () => {
  const r = run(
    [
      "test('a string', () => assert.equal(LABEL, 'note from the NPU, unverified'));",
      "test('a value', () => assert.deepEqual({ model: 'qwen-npu-old', at: { n: 1, label: LABEL } }, { model: 'qwen-npu-old', at: { n: 1, label: 'note from the NPU, unverified' } }));",
      "test('passes', () => assert.ok(true));",
    ].join('\n'),
    'tap',
  );
  assert.equal(r.code, 1, r.output);
  const failures = tapFailures(r.output);
  assert.deepEqual(failures.map((f) => f.name), ['a string', 'a value']);
  const [a, b] = failures;
  assert.equal(a.kind, 'testCodeFailure');
  assert.deepEqual([...a.expected!], [['', "'note from the NPU, unverified'"]]);
  assert.deepEqual([...a.actual!], [['', "'note from the NPU'"]]);
  assert.equal(path.relative(r.dir, a.at!.file), path.join('test', 'label.test.ts'));
  assert.deepEqual([a.at!.line, a.at!.column], [4, 31], 'the line of the assertion, at its method');
  assert.equal(b.expected!.get('at.label'), "'note from the NPU, unverified'");
  assert.equal(b.actual!.get('at.label'), "'note from the NPU'");
  assert.equal(b.actual!.get('at.n'), '1');
  assert.deepEqual(copiedPairs(a, kit), [{ from: 'note from the NPU, unverified', to: 'note from the NPU' }]);
  assert.deepEqual(copiedPairs(b, kit), [{ from: 'note from the NPU, unverified', to: 'note from the NPU' }], 'only the leaves that differ');
});

test('a test that expected what the kit said before is brought up to it, in the same kind of string, and passes', () => {
  const r = run(
    [
      "test('the label', () => {",
      '  assert.equal(',
      '    LABEL,',
      '    "note from the NPU, unverified", // what the note says',
      '  );',
      '});',
      "test('by whom', () => assert.deepEqual({ label: `note from the NPU` }, { label: `note from the NPU, unverified` }));",
    ].join('\n'),
  );
  assert.equal(r.code, 1, r.output);
  const found = copiedKitValues(r.output, kit, r.dir);
  assert.deepEqual(found.seen, [
    { from: 'note from the NPU, unverified', to: 'note from the NPU', file: 'test/label.test.ts', line: 5 },
    { from: 'note from the NPU, unverified', to: 'note from the NPU', file: 'test/label.test.ts', line: 10 },
  ]);
  assert.equal(found.fixes?.length, 2);
  assert.deepEqual(applyFixes(r.dir, found.fixes!), ['test/label.test.ts']);
  const text = readFileSync(r.file, 'utf8');
  assert.match(text, /\n {4}"note from the NPU", \/\/ what the note says\n/);
  assert.match(text, /\{ label: `note from the NPU` \}\)\);/);
  assert.doesNotMatch(text, /unverified`|unverified"/);
  assert.equal(r.again().code, 0, 'its tests pass, brought up to the kit');
  assert.equal(fixesLine(found.fixes!), "test/label.test.ts:5: 'note from the NPU, unverified' → 'note from the NPU'; test/label.test.ts:10: 'note from the NPU, unverified' → 'note from the NPU'");
});

test("named, but not brought up: a text the test builds elsewhere, one written twice, or another failure beside it", () => {
  const elsewhere = run("const want = 'note from the NPU, unverified';\ntest('the label', () => assert.equal(LABEL, want));");
  const one = copiedKitValues(elsewhere.output, kit, elsewhere.dir);
  assert.deepEqual([one.seen.length, one.fixes], [1, null]);
  const twice = run("test('the label', () => assert.equal(LABEL, 'note from the NPU, unverified', 'note from the NPU, unverified'));");
  assert.equal(copiedKitValues(twice.output, kit, twice.dir).fixes, null);
  const beside = run("test('the label', () => assert.equal(LABEL, 'note from the NPU, unverified'));\ntest('the sum', () => assert.equal(1 + 1, 3));");
  const both = copiedKitValues(beside.output, kit, beside.dir);
  assert.deepEqual([both.seen.length, both.fixes], [1, null]);
  // Not the kit's text at all, or not an equality: nothing seen.
  const other = run("test('the label', () => assert.equal(LABEL, 'a note of its own'));");
  assert.deepEqual(copiedKitValues(other.output, kit, other.dir), { seen: [], fixes: null });
  const match = run("test('the label', () => assert.match(LABEL, /unverified/));");
  assert.deepEqual(copiedKitValues(match.output, kit, match.dir), { seen: [], fixes: null });
  // A test of the kit's own, filled into src/kit: not the agent's to change.
  const filled = run("test('the label', () => assert.equal(LABEL, 'note from the NPU, unverified'));");
  mkdirSync(path.join(filled.dir, 'src', 'kit'), { recursive: true });
  const moved = filled.output.replaceAll('test/label.test.ts', 'src/kit/label.test.ts');
  writeFileSync(path.join(filled.dir, 'src', 'kit', 'label.test.ts'), readFileSync(filled.file, 'utf8'));
  assert.equal(copiedKitValues(moved, kit, filled.dir).fixes, null);
});

test('a fix writes the one place its assertion writes the text, in its kind of string; never two, never outside it', () => {
  const fix = { line: 1, column: 8, from: "it's old", to: 'it\'s "new"' };
  assert.equal(fixedText("assert.equal(x, 'it\\'s old');", fix), "assert.equal(x, 'it\\'s \"new\"');");
  assert.equal(fixedText('assert.equal(x, "it\'s old");', fix), 'assert.equal(x, "it\'s \\"new\\"");');
  assert.equal(fixedText("assert.equal(x, 'it\\'s old', 'it\\'s old');", fix), null);
  assert.equal(fixedText("assert.equal(x, y);\nconst z = 'it\\'s old';", fix), null, 'after the call closes');
  assert.equal(fixedText("assert.equal(f(')'), 'it\\'s old');", fix), "assert.equal(f(')'), 'it\\'s \"new\"');", 'a parenthesis in a string');
});

test('a trial\'s scratch profile: the four profile folders there, the tools\' own caches and settings where they are', () => {
  const real = { USERPROFILE: 'C:\\Users\\pat', LOCALAPPDATA: 'C:\\Users\\pat\\AppData\\Local', APPDATA: 'C:\\Users\\pat\\AppData\\Roaming', PATH: 'C:\\bin', npm_config_cache: 'D:\\npm' };
  const env = trialProfileEnv('E:\\work\\reeve-trial.profile', real, 'win32');
  assert.equal(env.USERPROFILE, 'E:\\work\\reeve-trial.profile');
  assert.equal(env.HOME, 'E:\\work\\reeve-trial.profile');
  assert.equal(env.LOCALAPPDATA, path.join('E:\\work\\reeve-trial.profile', 'AppData', 'Local'));
  assert.equal(env.APPDATA, path.join('E:\\work\\reeve-trial.profile', 'AppData', 'Roaming'));
  assert.deepEqual([env.HOMEDRIVE, env.HOMEPATH], ['E:', '\\work\\reeve-trial.profile']);
  assert.equal(env.npm_config_cache, undefined, 'one the run sets is left as it is');
  assert.equal(env.CARGO_HOME, path.join('C:\\Users\\pat', '.cargo'));
  assert.equal(env.RUSTUP_HOME, path.join('C:\\Users\\pat', '.rustup'));
  assert.equal(env.NUGET_PACKAGES, path.join('C:\\Users\\pat', '.nuget', 'packages'));
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, path.join('C:\\Users\\pat\\AppData\\Local', 'ms-playwright'));
  assert.equal(env.PYTHONUSERBASE, path.join('C:\\Users\\pat\\AppData\\Roaming', 'Python'));
  assert.equal(env.PATH, undefined, 'PATH and the rest are the run’s own');
});

test("the kit's diff from the agent's pin: to a release, or to the kit tree a trial fills from as it is", async () => {
  const steward = fakeEmployee(path.join(tmp, 'steward'), { kit: null, files: { 'kit/VERSION': '1.0.0\n', 'kit/node/label.ts': "export const LABEL = 'note from the NPU, unverified';\n", 'kit/test/label.test.ts': "const t = 'a test of the kit, left out';\n" } });
  const tag = (v: string) => {
    sh(steward.checkout, 'tag', `kit-v${v}`);
    sh(steward.checkout, 'push', '--quiet', 'origin', `refs/tags/kit-v${v}`);
    sh(steward.checkout, 'tag', '-d', `kit-v${v}`);
  };
  tag('1.0.0');
  writeFileSync(path.join(steward.checkout, 'kit', 'VERSION'), '1.0.1\n');
  writeFileSync(path.join(steward.checkout, 'kit', 'node', 'label.ts'), "export const LABEL = 'note from the NPU';\n");
  writeFileSync(path.join(steward.checkout, 'kit', 'test', 'label.test.ts'), "const t = 'a test of the kit, changed';\n");
  sh(steward.checkout, 'commit', '--quiet', '-am', 'kit 1.0.1');
  tag('1.0.1');
  const c = ctxFor({ employees: [], workRoot: path.join(tmp, 'work'), run: runner(() => undefined).run, neutralDir: tmp });
  c.settings.stewardCheckout = steward.checkout;
  const released = await kitChangesFor(c, { from: '1.0.0', kit: '1.0.1' });
  assert.deepEqual(released, { removed: [{ text: 'note from the NPU, unverified' }], added: [{ text: 'note from the NPU' }] }, "each tag fetched; the kit's tests left out");
  writeFileSync(path.join(steward.checkout, 'kit', 'node', 'label.ts'), "export const LABEL = 'a note, not committed';\n");
  const tree = await kitChangesFor(c, { from: '1.0.0', kit: '1.0.2', kitFrom: path.join(steward.checkout, 'kit') });
  assert.deepEqual(tree?.added, [{ text: 'a note, not committed' }]);
  assert.equal(await kitChangesFor(c, { from: '0.9.0', kit: '1.0.1' }), null, 'a release that was never made');
});
