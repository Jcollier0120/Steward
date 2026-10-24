import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// A release's THIRD-PARTY-NOTICES.txt (notices.ts, kit 2.128.0): made from what it carries, and no release that
// carries something of others' with no notice for it. And no document in a release (release.ts' isDoc).
const STEWARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.STEWARD_ESBUILD = STEWARD;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'notices-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const { NOTICES, bundledPackages, headings, isLicenseFile, noticesText, packageDir, partsOf, unnoticed, writeNotices } = await import('./fixture/src/kit/notices.ts');
const { isDoc, pickReleaseFiles, repoFiles } = await import('./fixture/src/kit/release.ts');
const { PAGE_ENTRY, releasePage } = await import('./fixture/src/kit/react-page.ts');
const { loadEsbuild } = await import('./fixture/src/kit/minify.ts');
const { appRoot } = await import('./fixture/src/app.ts');

let n = 0;
/** A folder with these files in it (paths with /), for a stage or a package. */
function folder(files: Record<string, string>): string {
  const dir = path.join(tmp, `f${++n}`);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), text);
  }
  return dir;
}

const MIT = 'MIT License\n\nCopyright (c) Someone\n\nPermission is hereby granted...\n';
const pkgOf = (name: string, more: Record<string, string> = { LICENSE: MIT }) => folder({ 'package.json': JSON.stringify({ name, version: '1.2.3', license: 'MIT' }), ...more });

test('license and notice files are known by their names; a document is any other .md', () => {
  for (const f of ['LICENSE', 'LICENSE.txt', 'license.md', 'LICENCE', 'NOTICE', 'notice.txt', 'COPYING', 'third-party-programs.txt', 'THIRD_PARTY_NOTICES.txt']) assert.ok(isLicenseFile(f), f);
  for (const f of ['README.md', 'LICENSE-NOTES.txt', 'notices.ts', 'license-check.ts', 'NOTICES.txt.bak']) assert.ok(!isLicenseFile(f), f);
  assert.ok(isDoc('src/kit/spec/RELEASES.md') && isDoc('src\\kit\\geniex\\README.md') && isDoc('src/notes.MD'));
  assert.ok(!isDoc('LICENSE.md') && !isDoc('src/kit/x/NOTICE.md') && !isDoc('src/kit/spec/npu-vendors.json'));
});

test('a release carries no document: the kit\'s pages and READMEs stay out, its license files go', () => {
  assert.deepEqual(
    pickReleaseFiles(['src/cli.ts', 'src/kit/spec/RELEASES.md', 'src/kit/spec/rules.json', 'src/kit/geniex/README.md', 'src/kit/geniex/LICENSE', 'src/kit/geniex/NOTICE', 'src/docs/HOW.md', 'art/ABOUT.md', 'src/vendor/LICENSE.md', 'package.json']),
    ['package.json', 'src/cli.ts', 'src/kit/geniex/LICENSE', 'src/kit/geniex/NOTICE', 'src/kit/spec/rules.json', 'src/vendor/LICENSE.md'],
  );
});

test("an agent's own release picks no .md, though its kit has them (a new one would fail here)", () => {
  for (const root of [appRoot, STEWARD]) {
    const all = repoFiles(root);
    assert.ok(all.some((f) => f.startsWith('src/kit/') && f.endsWith('.md')), `${root}: its kit has documents to leave out`);
    const own = pickReleaseFiles(all);
    assert.deepEqual(own.filter((f) => f.toLowerCase().endsWith('.md') && !isLicenseFile(path.posix.basename(f))), [], root);
    assert.ok(own.includes('src/kit/geniex/LICENSE') && own.includes('src/kit/geniex/NOTICE') && own.includes('src/kit/openvino/NOTICE'), root);
  }
});

test("a bundled file's package is the last node_modules/<name> in its path, scoped or not; the agent's own has none", () => {
  assert.equal(packageDir('../../node_modules/react/index.js'), '../../node_modules/react');
  assert.equal(packageDir('..\\node_modules\\@scope\\pkg\\dist\\a.js'), '../node_modules/@scope/pkg');
  assert.equal(packageDir('node_modules/a/node_modules/b/lib/x.js'), 'node_modules/a/node_modules/b');
  assert.equal(packageDir('main.tsx'), null);
  assert.equal(packageDir('../kit/react/shell.tsx'), null);
  const base = folder({
    'node_modules/a/package.json': '﻿' + JSON.stringify({ name: 'a', version: '2.0.0', license: 'ISC' }),
    'node_modules/@s/b/package.json': JSON.stringify({ name: '@s/b', version: '0.1.0', license: { type: 'MIT' } }),
  });
  assert.deepEqual(bundledPackages(['node_modules/a/index.js', 'node_modules/a/lib/x.js', 'node_modules/@s/b/b.js', 'main.tsx'], base), [
    { dir: path.join(base, 'node_modules', '@s', 'b'), name: '@s/b', version: '0.1.0', license: 'see its license files, below' },
    { dir: path.join(base, 'node_modules', 'a'), name: 'a', version: '2.0.0', license: 'ISC' },
  ]);
});

test('the parts: bundled packages, folders with their own license files, native notices; the agent\'s and the kit\'s own licenses aren\'t parts', () => {
  const react = pkgOf('react');
  const stage = folder({
    LICENSE: 'the agent\'s own\n',
    'src/cli.js': '',
    'src/kit/LICENSE': 'the kit\'s MIT\n',
    'src/kit/prebuilt/awake.exe': 'built from the kit\'s own sources',
    'src/kit/geniex/LICENSE': 'BSD 3-Clause License\r\n\r\nCopyright (c) Qualcomm\r\n',
    'src/kit/geniex/NOTICE': 'a modified build\n',
    'src/kit/geniex/geniex_plugin.dll': 'MZ',
    'src/kit/geniex/0.9.1/geniex_plugin.dll': 'MZ',
    'src/kit/openvino/LICENSE': 'Apache License\n',
    'src/kit/openvino/NOTICE': 'not Intel\'s release\n',
    'native/build/arm64/helper.dll': 'MZ',
    'native/build/notices/NOTICES.txt': 'ONNX Runtime: MIT\n',
  });
  const o = {
    name: 'Fixture',
    packages: [{ dir: react, name: 'react', version: '19.3.0', license: 'MIT' }],
    native: { out: 'native/build', notices: ['native/NOTICES.txt'], staged: ['native/build/notices/NOTICES.txt'] },
  };
  const parts = partsOf(stage, o);
  assert.deepEqual(parts.map((p) => p.heading), ['react 19.3.0', 'src\\kit\\geniex', 'src\\kit\\openvino', "Fixture's native files"]);
  assert.deepEqual(parts[1].texts.map((t) => t.file), ['LICENSE', 'NOTICE'], 'the license first, then what changed');
  assert.match(parts[0].where, /Bundled into Fixture's page/);

  const heads = writeNotices(stage, o);
  assert.deepEqual(heads, parts.map((p) => p.heading));
  const text = readFileSync(path.join(stage, NOTICES), 'utf8');
  assert.deepEqual(headings(text), heads);
  assert.ok(!/[^\r]\n/.test(text), 'Windows line endings throughout');
  assert.match(text, /License: MIT\r\n\r\n--- LICENSE ---\r\n\r\nMIT License/);
  assert.match(text, /Copyright \(c\) Qualcomm/);
  assert.match(text, /a modified build/);
  assert.match(text, /In native\\build in Fixture's app folder, with these notices in native\\build\\notices\.\r\nLicense: as in its notices, below\r\n\r\n--- NOTICES\.txt ---\r\n\r\nONNX Runtime: MIT/);
  assert.doesNotMatch(text, /the agent's own|the kit's MIT/, "the agent's and the kit's own licenses are named, not copied");
  assert.deepEqual(headings(noticesText('Fixture', [])), []);
  assert.match(noticesText('Fixture', []), /This release carries none\./);
});

test('a release that carries something of others\' with no notice for it is not built, and says what', () => {
  const ok = { name: 'Fixture', packages: [], native: null };
  assert.deepEqual(partsOf(folder({ 'src/a.js': '', 'src/kit/prebuilt/x.dll': 'MZ', 'art/icon.svg': '' }), ok), [], 'the kit\'s own builds need none');

  const bare = pkgOf('left-pad', {});
  assert.throws(() => partsOf(folder({ 'src/a.js': '' }), { ...ok, packages: [{ dir: bare, name: 'left-pad', version: '1.2.3', license: 'MIT' }] }), /Not built: .*the npm package left-pad 1\.2\.3, bundled into its page, with no license file/);
  assert.throws(() => partsOf(folder({ 'src/vendor/lib/thing.dll': 'MZ', 'src/fonts/a.woff2': '' }), ok), (e: Error) => /src\\vendor\\lib\\thing\.dll, with no license or notice file beside it/.test(e.message) && /src\\fonts\\a\.woff2/.test(e.message));
  assert.deepEqual(partsOf(folder({ 'src/vendor/LICENSE': MIT, 'src/vendor/lib/thing.dll': 'MZ' }), ok).map((p) => p.heading), ['src\\vendor'], 'a license in a folder above it is its notice');
  assert.throws(() => partsOf(folder({ 'native/build/x64/a.dll': 'MZ' }), { ...ok, native: { out: 'native/build', notices: [], staged: [] } }), /native\\build\\x64\\a\.dll, a native file, with no notices in kit\.json's "native"/);

  assert.deepEqual(unnoticed(['src/kit/prebuilt/a.exe', 'src/x/b.node', 'native/out/c.dll', 'src/y/d.wasm'], { licensed: ['src/y'], native: { out: 'native/out', notices: ['n.txt'] } }), ['src\\x\\b.node, with no license or notice file beside it']);
});

test("a release's page names the npm packages it bundled, each with its license, from esbuild's own list", async () => {
  const stage = folder({
    [PAGE_ENTRY]: "import { createRoot } from 'react-dom/client';\nimport { words } from './words.ts';\ncreateRoot(document.body).render(words);\n",
    'src/web/words.ts': "export const words = 'released';\n",
  });
  const esbuild = await loadEsbuild(STEWARD);
  if ('error' in esbuild) throw new Error(esbuild.error);
  const r = await releasePage(stage, STEWARD, esbuild);
  assert.ok(r);
  assert.deepEqual(r.packages.map((p) => p.name), ['react', 'react-dom', 'scheduler']);
  for (const p of r.packages) {
    assert.equal(p.version, JSON.parse(readFileSync(path.join(STEWARD, 'node_modules', p.name, 'package.json'), 'utf8')).version);
    assert.equal(p.license, 'MIT');
  }
  assert.deepEqual(partsOf(stage, { name: 'Fixture', packages: r.packages, native: null }).map((p) => p.heading), r.packages.map((p) => `${p.name} ${p.version}`));
});
