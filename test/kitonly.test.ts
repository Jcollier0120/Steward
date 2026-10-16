import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A version that is a new kit alone (stages/kitonly.ts): held, merged, for the agent's next release of its own, unless
// what the kit changes is what it runs (once a day), or the kit's entry says it is urgent or a fix for it. On fake agents
// and a fake Steward whose kit releases are tags, made with git in a temporary folder.
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'steward-kitonly-')));
process.env.STEWARD_HOME = path.join(tmp, 'home');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { bumpAlone, fixFor, kitOnlyRelease, kitOnlyReleasesFile, noteKitOnlyRelease, ownStart, runsReached, sameDay } = await import('../src/stages/kitonly.ts');
const { releaseOne } = await import('../src/stages/release.ts');
const { APP } = await import('../src/app.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type Employee = import('../src/settings.ts').Employee;

const write = (dir: string, files: Record<string, string>) => {
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), t);
  }
};
const commit = (dir: string, message: string, files: Record<string, string>) => {
  write(dir, files);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '--quiet', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD');
};

// The Steward: kit 1.0.0, then 1.0.1 (the NPU's file), 1.0.2 (the signing's, a fix for the Signer), 1.0.3 (urgent), each
// tagged kit-v<version> on its origin, as a kit release is.
const steward = fakeEmployee(path.join(tmp, 'steward'), { kit: null, files: { 'kit/VERSION': '1.0.0\n', 'kit/node/npu.ts': 'export const npu = 1;\n', 'kit/node/signing.ts': 'export const sign = 1;\n', 'kit/CHANGELOG.md': '# Kit\n\n## 1.0.0\n\n**The first.**\n' } });
const kitTag = (v: string) => {
  sh(steward.checkout, 'tag', `kit-v${v}`);
  sh(steward.checkout, 'push', '--quiet', 'origin', `refs/tags/kit-v${v}`);
};
kitTag('1.0.0');
let changelog = '# Kit\n\n## 1.0.0\n\n**The first.**\n';
const kitRelease = (v: string, entry: string, files: Record<string, string>) => {
  changelog = changelog.replace('# Kit\n\n', `# Kit\n\n## ${v}\n\n${entry}\n\n`);
  commit(steward.checkout, `Kit ${v}`, { 'kit/VERSION': `${v}\n`, 'kit/CHANGELOG.md': changelog, ...files });
  kitTag(v);
};
kitRelease('1.0.1', "**The NPU's note.**", { 'kit/node/npu.ts': 'export const npu = 2;\n' });
kitRelease('1.0.2', '**Fix for Signer, and Crier: their releases sign again.**', { 'kit/node/signing.ts': 'export const sign = 2;\n' });
kitRelease('1.0.3', '**Urgent: a release that signed nothing.**', { 'kit/node/signing.ts': 'export const sign = 3;\n' });
const me = employee(steward.checkout, { id: APP.id, name: 'Steward', usesKit: false });

/** An agent at 0.4.0 with kit 1.0.0, tagged v0.4.0 (its last release); `files` its own besides. */
const agent = (id: string, name: string, files: Record<string, string> = {}): Employee => {
  const f = fakeEmployee(path.join(tmp, id), { files });
  sh(f.checkout, 'tag', 'v0.4.0');
  return employee(f.checkout, { id, name });
};
/** The rollout's bump of `e` to `kit` at version `v`: kit.json's pin, the version files, its changelog's entry. */
const bump = (e: Employee, kit: string, v: string) => {
  const files: Record<string, string> = {};
  for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) files[f] = readFileSync(path.join(e.checkout, f), 'utf8').replace(/0\.4\.\d+/g, v);
  files['kit.json'] = readFileSync(path.join(e.checkout, 'kit.json'), 'utf8').replace(/"kit": "[^"]+"/, `"kit": "${kit}"`);
  files['CHANGELOG.md'] = `# Changelog\n\n## ${v}\n\n**Kit ${kit}.**\n`;
  const sha = commit(e.checkout, `${e.name} ${v}: kit ${kit}`, files);
  sh(e.checkout, 'push', '--quiet', 'origin', 'HEAD:main');
  return sha;
};

const quiet = agent('quiet', 'Quiet');
const npu = agent('npu', 'Npu', { 'src/cli.ts': "import { npu } from './kit/npu.ts';\nconsole.log(npu);\n" });
const signer = agent('signer', 'Signer');

function ctx() {
  const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok([{ tagName: 'v0.4.0', isDraft: false, publishedAt: '2026-10-01T00:00:00Z' }]) : undefined));
  return ctxFor({ employees: [me, quiet, npu, signer], workRoot: path.join(tmp, 'work'), run: r.run, neutralDir: tmp });
}

test('a kit bump alone: the pin, the versions, its changelog and tools/kit.ts; anything else is a change of its own', () => {
  const patches: Record<string, string> = {
    'kit.json': '@@ -2 +2 @@\n-  "kit": "2.77.6",\n+  "kit": "2.78.0",',
    'package.json': '@@ -3 +3 @@\n-  "version": "0.4.0",\n+  "version": "0.4.1",',
    'src/app.ts': "@@ -5 +5 @@\n-  version: '0.4.0',\n+  version: '0.4.1',",
  };
  const of = (f: string) => patches[f] ?? null;
  const files = ['package.json', 'src/app.ts'];
  assert.equal(bumpAlone(['kit.json', 'package.json', 'src/app.ts', 'CHANGELOG.md', 'tools/kit.ts'], files, of), true);
  assert.equal(bumpAlone(['package.json', 'src/app.ts', 'CHANGELOG.md'], files, of), false, 'no new kit: a version of its own');
  assert.equal(bumpAlone(['kit.json', 'package.json', 'README.md'], files, of), false);
  assert.equal(bumpAlone(['kit.json'], files, () => '@@ -2 +2,2 @@\n-  "kit": "2.77.6",\n+  "kit": "2.78.0",\n+  "parts": ["node"]'), false, 'its parts changed too');
  assert.equal(bumpAlone(['kit.json', 'src/app.ts'], files, (f) => (f === 'src/app.ts' ? "@@ -9 +9 @@\n-  role: 'a',\n+  role: 'b'," : of(f))), false);
});

test("a kit's entry names a fix for an agent by its name or id, among others; the version whose entry it is", () => {
  const entries = "## 1.0.3\n\n**Urgent: a release that signed nothing.**\n\n## 1.0.2\n\n**Fix for Signer, and Crier's: their releases sign again.**\n\n## 1.0.1\n\n**Fixes for reeve and the-wright:** the NPU.\n";
  assert.equal(fixFor(entries, { id: 'signer', name: 'Signer' }), '1.0.2');
  assert.equal(fixFor(entries, { id: 'crier', name: 'Crier' }), '1.0.2');
  assert.equal(fixFor(entries, { id: 'reeve', name: 'Reeve' }), '1.0.1');
  assert.equal(fixFor(entries, { id: 'the-wright', name: 'The Wright' }), '1.0.1');
  assert.equal(fixFor(entries, { id: 'smith', name: 'Smith' }), null);
  assert.equal(fixFor('## 1.0.4\n\nA fix for Smith, in passing.\n', { id: 'smith', name: 'Smith' }), null, 'only a bold line that starts with it');
});

test('what an agent runs: its own code but tests and its kit, and what that imports, names or reads', async () => {
  assert.deepEqual(['src/cli.ts', 'src/web/page.html', 'src/kit/npu.ts', 'src/x.test.ts', 'test/a.test.ts', 'package.json', 'src/notes.md'].filter(ownStart), ['src/cli.ts', 'src/web/page.html']);
  const texts: Record<string, string> = {
    'src/cli.ts': "import { serve } from './server.ts';\nspawn(process.execPath, [kitFile('npu-server.ts')]);\nserve();\n",
    'src/server.ts': "export const serve = () => readdirSync(new URL('./web/', import.meta.url));\n",
    'src/web/page.html': '<script src="app.js"></script>\n',
    'src/kit/npu-server.ts': "import { vendors } from './npu-vendors.ts';\n",
    'src/kit/npu-vendors.ts': 'export const vendors = [];\n',
    'src/kit/signing.ts': 'export const sign = 1;\n',
    'src/kit/my-npu-server.ts.bak': '',
  };
  const known = new Set(Object.keys(texts));
  let asked = 0;
  const read = async (files: string[]) => {
    asked++;
    return new Map(files.map((f) => [f, texts[f] ?? '']));
  };
  const reached = await runsReached(['src/cli.ts'], known, read);
  assert.deepEqual([...reached].sort(), ['src/cli.ts', 'src/kit/npu-server.ts', 'src/kit/npu-vendors.ts', 'src/server.ts', 'src/web/page.html']);
  assert.ok(asked <= 4, `a level of files read at once (${asked} reads)`);
});

test("a new kit alone, none of whose changes the agent runs, waits for its next release of its own; one it runs goes, once a day", async () => {
  rmSync(kitOnlyReleasesFile(), { force: true });
  const c = ctx();
  const held = await kitOnlyRelease(c, quiet, { repo: quiet.checkout, commit: bump(quiet, '1.0.1', '0.4.1'), version: '0.4.1', since: '0.4.0' });
  assert.deepEqual(held, { kitOnly: true, release: false, why: "waits: a new kit alone (kit 1.0.0 → 1.0.1), and none of the 1 kit file it takes that change is one it runs: it goes out with Quiet's next release of its own" });

  const at = bump(npu, '1.0.1', '0.4.1');
  const goes = await kitOnlyRelease(c, npu, { repo: npu.checkout, commit: at, version: '0.4.1', since: '0.4.0' });
  assert.deepEqual(goes, { kitOnly: true, release: true, why: 'a new kit alone (kit 1.0.0 → 1.0.1), released: it changes what Npu runs (src/kit/npu.ts)', daily: true });
  // Released at 09:00: the next kit-only version that day waits for the next day's first build.
  const nine = new Date(2026, 9, 16, 9, 0).getTime();
  noteKitOnlyRelease('npu', '0.4.1', nine);
  const later = await kitOnlyRelease(c, npu, { repo: npu.checkout, commit: at, version: '0.4.2', since: '0.4.0', now: nine + 4 * 3600_000 });
  assert.equal(later.kitOnly && !later.release && later.why, "waits: a new kit alone (kit 1.0.0 → 1.0.1) that changes what it runs (src/kit/npu.ts), but its kit-only release for today went at 09:00 (v0.4.1): it goes with the first build tomorrow, or sooner with a release of its own");
  const tomorrow = await kitOnlyRelease(c, npu, { repo: npu.checkout, commit: at, version: '0.4.2', since: '0.4.0', now: nine + 24 * 3600_000 });
  assert.ok(tomorrow.kitOnly && tomorrow.release, JSON.stringify(tomorrow));
  assert.ok(sameDay(nine, nine + 4 * 3600_000) && !sameDay(nine, nine + 24 * 3600_000));
  // The same version asked again (a round that released it, asking once more) isn't held by its own release.
  const again = await kitOnlyRelease(c, npu, { repo: npu.checkout, commit: at, version: '0.4.1', since: '0.4.0', now: nine + 3600_000 });
  assert.ok(again.kitOnly && again.release, JSON.stringify(again));
});

test("a kit whose entry names a fix for the agent, or says it is urgent, goes at once, and isn't the day's one", async () => {
  const c = ctx();
  const fixed = await kitOnlyRelease(c, signer, { repo: signer.checkout, commit: bump(signer, '1.0.2', '0.4.1'), version: '0.4.1', since: '0.4.0' });
  assert.deepEqual(fixed, { kitOnly: true, release: true, why: "a new kit alone, released: kit 1.0.2's entry names a fix for Signer", daily: false });
  const urgent = await kitOnlyRelease(c, quiet, { repo: quiet.checkout, commit: bump(quiet, '1.0.3', '0.4.2'), version: '0.4.2', since: '0.4.0' });
  assert.deepEqual(urgent, { kitOnly: true, release: true, why: "a new kit alone, released: kit 1.0.3's entry says it is urgent", daily: false });
});

test('a version with a change of its own, or no release before it, is released as ever', async () => {
  const c = ctx();
  bump(quiet, '1.0.1', '0.4.3');
  const own = commit(quiet.checkout, 'Quiet: a README', { 'README.md': 'Quiet\n' });
  assert.deepEqual(await kitOnlyRelease(c, quiet, { repo: quiet.checkout, commit: own, version: '0.4.3', since: '0.4.0' }), { kitOnly: false });
  assert.deepEqual(await kitOnlyRelease(c, quiet, { repo: quiet.checkout, commit: own, version: '0.4.3', since: null }), { kitOnly: false });
  assert.deepEqual(await kitOnlyRelease(c, quiet, { repo: quiet.checkout, commit: own, version: '0.4.3', since: '0.3.9' }), { kitOnly: false }, 'no tag for the release before');
});

test("a round's release of a kit alone that changes nothing the agent runs is skipped, saying why; nothing is built", async () => {
  const fresh = agent('idle', 'Idle');
  const c = ctx();
  c.settings.employees.push(fresh);
  bump(fresh, '1.0.1', '0.4.1');
  const r = await releaseOne(c, fresh, { kit: null, kitOnly: true });
  assert.equal(r.outcome, 'skipped', r.message);
  assert.match(r.message, /^v0\.4\.1 waits: a new kit alone \(kit 1\.0\.0 → 1\.0\.1\), and none of the 1 kit file it takes that change is one it runs/);
  assert.equal(r.version, '0.4.1');
});
