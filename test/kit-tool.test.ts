import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// tools/kit.ts, the one file every agent carries: it fills src/kit from a kit tree, a sibling Steward
// checkout, the cache, or a kit release (here a local server stands in for GitHub).
const TOOL = fileURLToPath(new URL('../tools/kit.ts', import.meta.url));
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-kit-tool-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** A kit tree at `version`: VERSION and a file in each part; from 2.0.0 the core and dotnet parts too; from 2.43.4 its LICENSE. */
function kitTree(dir: string, version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  if (major * 1e6 + minor * 1e3 + patch >= 2_043_004) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'LICENSE'), 'MIT License\n');
  }
  const parts = [['node', 'a.ts', `export const v = '${version}';\n`], ['web', 'b.js', '// web\n'], ['spec', 'c.md', '# spec\n']];
  if (Number(version.split('.')[0]) >= 2) parts.push(['core', 'd.js', 'export const d = 1;\n'], ['dotnet', 'E.cs', '// dotnet\n']);
  for (const [p, f, t] of parts) {
    mkdirSync(path.join(dir, p), { recursive: true });
    writeFileSync(path.join(dir, p, f), t);
  }
  writeFileSync(path.join(dir, 'VERSION'), `${version}\n`);
  writeFileSync(path.join(dir, 'CHANGELOG.md'), `## ${version}\n\n- a change\n`);
  return dir;
}
/** A hire that pins `pin` (and `parts`), in its own case folder. */
function hire(pin: string, parts?: string[]): { root: string; caseDir: string } {
  const caseDir = path.join(tmp, `case-${++n}`);
  const root = path.join(caseDir, 'hire');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'kit.json'), JSON.stringify({ kit: pin, ...(parts ? { parts } : {}) }));
  return { root, caseDir };
}
function tool(root: string, args: string[] = [], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(process.execPath, [TOOL, '--root', root, ...args], { env: { ...process.env, STEWARD_KIT: '', STEWARD_KITS: path.join(tmp, 'no-cache'), ...env } }, (e: any, so, se) =>
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: `${so}${se}` }),
    ),
  );
}
const has = (root: string, rel: string) => existsSync(path.join(root, 'src', 'kit', rel));
const read = (root: string, rel: string) => readFileSync(path.join(root, 'src', 'kit', rel), 'utf8');

test('--from fills the parts kit.json names: node in src/kit, web and spec beside it, and says which version', async () => {
  const { root } = hire('1.0.0');
  const r = await tool(root, ['--from', kitTree(path.join(tmp, 'tree-a'), '1.0.0')]);
  assert.equal(r.code, 0, r.out);
  assert.ok(has(root, 'a.ts') && has(root, 'web/b.js') && has(root, 'spec/c.md'));
  assert.ok(!has(root, 'CHANGELOG.md') && !has(root, 'node'), 'only the parts, the node part flat');
  assert.equal(read(root, 'VERSION').trim(), '1.0.0');
  assert.equal(read(root, 'PARTS').trim(), 'node web spec', 'the parts kit.json pins');
  assert.ok(!has(root, 'core'), 'the node part needs the core, but a kit from before 2.0.0 has none');
  assert.ok(!has(root, 'LICENSE'), 'a kit tree without a LICENSE fills as before');
});

test("the kit's MIT license comes beside its VERSION, as src/kit/LICENSE, so an agent's release carries it", async () => {
  const { root } = hire('2.43.4');
  const r = await tool(root, ['--from', kitTree(path.join(tmp, 'tree-license'), '2.43.4')]);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(root, 'LICENSE'), 'MIT License\n');
  assert.equal(read(root, 'VERSION').trim(), '2.43.4');
});

test('a part brings the parts it needs: node the core, the core the spec, dotnet the core; none brings web', async () => {
  const tree = kitTree(path.join(tmp, 'tree-two'), '2.0.0');
  const node = hire('2.0.0', ['node']);
  assert.equal((await tool(node.root, ['--from', tree])).code, 0);
  assert.ok(has(node.root, 'a.ts') && has(node.root, 'core/d.js') && has(node.root, 'spec/c.md'));
  assert.ok(!has(node.root, 'web') && !has(node.root, 'dotnet'));
  assert.equal(read(node.root, 'PARTS').trim(), 'node', 'PARTS says what kit.json pins');
  assert.match((await tool(node.root, ['--from', tree])).out, /\(node, core, spec\)/, 'the log says what came');
  const dotnet = hire('2.0.0', ['dotnet']);
  assert.equal((await tool(dotnet.root, ['--from', tree])).code, 0);
  assert.ok(has(dotnet.root, 'dotnet/E.cs') && has(dotnet.root, 'core/d.js') && has(dotnet.root, 'spec/c.md'));
  assert.ok(!has(dotnet.root, 'a.ts'));
  const web = hire('2.0.0', ['web']);
  assert.equal((await tool(web.root, ['--from', tree])).code, 0);
  assert.equal(read(web.root, 'PARTS').trim(), 'web');
  // A part pinned by name must be there, even one another part would bring.
  const pinnedCore = hire('1.0.0', ['spec', 'core']);
  const r = await tool(pinnedCore.root, ['--from', kitTree(path.join(tmp, 'tree-one'), '1.0.0')]);
  assert.equal(r.code, 1);
  assert.match(r.out, /has no core part/);
});

test('only the pinned parts are filled, and a part from before is gone', async () => {
  const { root } = hire('1.0.0', ['spec']);
  mkdirSync(path.join(root, 'src', 'kit', 'web'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'kit', 'web', 'old.js'), 'old');
  assert.equal((await tool(root, ['--from', path.join(tmp, 'tree-a')])).code, 0);
  assert.ok(has(root, 'spec/c.md'));
  assert.ok(!has(root, 'a.ts') && !has(root, 'web'));
});

test('a kit tree at another version fills, but warns that kit.json pins another', async () => {
  const { root } = hire('1.0.0');
  const r = await tool(root, [], { STEWARD_KIT: kitTree(path.join(tmp, 'tree-b'), '1.1.0') });
  assert.equal(r.code, 0, r.out);
  assert.equal(read(root, 'VERSION').trim(), '1.1.0');
  assert.match(r.out, /kit\.json pins 1\.0\.0/);
});

test('with src/kit at the pinned version and parts, it does nothing; else a sibling Steward checkout at that version fills it', async () => {
  const { root, caseDir } = hire('2.0.0');
  kitTree(path.join(caseDir, 'Steward', 'kit'), '2.0.0');
  const first = await tool(root);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /Steward[\\/]kit/);
  writeFileSync(path.join(root, 'src', 'kit', 'a.ts'), 'touched');
  const again = await tool(root);
  assert.equal(again.code, 0);
  assert.equal(again.out.trim(), '', 'nothing to do');
  assert.equal(read(root, 'a.ts'), 'touched');
  // A sibling at another version is passed over: then the release, which isn't there.
  const other = hire('2.0.1');
  kitTree(path.join(other.caseDir, 'Steward', 'kit'), '2.0.0');
  const r = await tool(other.root, [], { STEWARD_RELEASES: 'http://127.0.0.1:9/none', STEWARD_REPO: 'nobody-here/nothing-here' });
  assert.notEqual(r.code, 0);
  assert.ok(!has(other.root, 'VERSION'));
});

/** Serves kit-v<version>/kit-<version>.zip and SHA256SUMS.txt like GitHub's release downloads. */
async function releases(version: string, o: { badSum?: boolean } = {}) {
  const tree = kitTree(path.join(tmp, `release-${version}-${++n}`), version);
  const zip = path.join(tmp, `kit-${version}-${n}.zip`);
  const parts = ['node', 'web', 'spec', 'core', 'dotnet'].filter((p) => existsSync(path.join(tree, p)));
  const meta = ['VERSION', 'CHANGELOG.md', 'LICENSE'].filter((f) => existsSync(path.join(tree, f)));
  execFileSync(TAR, ['-a', '-c', '-f', zip, '-C', tree, ...meta, ...parts]);
  const bytes = readFileSync(zip);
  const sum = o.badSum ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex');
  const served: string[] = [];
  const server = http.createServer((req, res) => {
    served.push(req.url ?? '');
    if (req.url === `/kit-v${version}/kit-${version}.zip`) return res.writeHead(200).end(bytes);
    if (req.url === `/kit-v${version}/SHA256SUMS.txt`) return res.writeHead(200).end(`${sum}  kit-${version}.zip\n`);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, served, close: () => new Promise((r) => server.close(r)) };
}

test('a kit release is downloaded, checked against SHA256SUMS.txt, unpacked, cached, and used again from the cache', async () => {
  const rel = await releases('3.1.4');
  const cache = path.join(tmp, 'cache-ok');
  try {
    const { root } = hire('3.1.4');
    const r = await tool(root, [], { STEWARD_RELEASES: rel.url, STEWARD_KITS: cache });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /kit release kit-v3\.1\.4/);
    assert.equal(read(root, 'VERSION').trim(), '3.1.4');
    assert.match(read(root, 'a.ts'), /3\.1\.4/);
    assert.equal(read(root, 'LICENSE'), 'MIT License\n', "the release's LICENSE, beside VERSION");
    assert.ok(existsSync(path.join(cache, '3.1.4', 'node', 'a.ts')), 'kept in the cache');
  } finally {
    await rel.close();
  }
  const { root } = hire('3.1.4');
  const r = await tool(root, [], { STEWARD_RELEASES: 'http://127.0.0.1:9/gone', STEWARD_KITS: cache });
  assert.equal(r.code, 0, r.out);
  assert.equal(read(root, 'VERSION').trim(), '3.1.4');
});

test('agents filling the same kit at once all succeed: the cache goes into place whole, and the last one in uses the first', async () => {
  // The Steward bumps two agents at a time; kit 2.0.0's rollout lost the Auditor to two fills sharing the cache.
  const rel = await releases('3.1.5');
  const cache = path.join(tmp, 'cache-race');
  try {
    const roots = [hire('3.1.5'), hire('3.1.5'), hire('3.1.5'), hire('3.1.5')].map((h) => h.root);
    const runs = await Promise.all(roots.map((root) => tool(root, [], { STEWARD_RELEASES: rel.url, STEWARD_KITS: cache })));
    runs.forEach((r, i) => assert.equal(r.code, 0, `fill ${i}: ${r.out}`));
    for (const root of roots) assert.equal(read(root, 'VERSION').trim(), '3.1.5');
    assert.deepEqual(readdirSync(cache), ['3.1.5'], 'one cached kit, no staging folders left');
  } finally {
    await rel.close();
  }
});

test("a release that doesn't match its SHA256SUMS.txt is refused, and nothing is filled or cached", async () => {
  const rel = await releases('3.1.5', { badSum: true });
  const cache = path.join(tmp, 'cache-bad');
  try {
    const { root } = hire('3.1.5');
    const r = await tool(root, [], { STEWARD_RELEASES: rel.url, STEWARD_KITS: cache });
    assert.equal(r.code, 1);
    assert.match(r.out, /doesn't match its SHA256SUMS\.txt/);
    assert.ok(!has(root, 'VERSION'));
    assert.ok(!existsSync(path.join(cache, '3.1.5')));
  } finally {
    await rel.close();
  }
});

test('without a pin or a kit tree it says what it needs', async () => {
  const dir = path.join(tmp, 'no-pin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'kit.json'), '{}');
  const r = await tool(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /pins no kit/);
});
