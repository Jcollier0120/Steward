import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'kit-prebuilt-'));
after(() => rmSync(home, { recursive: true, force: true }));

const { HELPERS, PREBUILT_DIR, SIGNED_BY, helperHash, prebuiltName, signedHelper } = await import('./fixture/src/kit/prebuilt.ts');
type Helper = keyof typeof HELPERS;
const helpers = Object.keys(HELPERS) as Helper[];
const source = (h: Helper) => readFileSync(new URL(`./fixture/src/kit/${h}.cs`, import.meta.url), 'utf8');
const shipped = existsSync(PREBUILT_DIR) ? readdirSync(PREBUILT_DIR) : [];

test("every prebuilt helper is for its helper's source now: a changed source is signed again, or its old copy removed", () => {
  const now = new Set(helpers.map((h) => prebuiltName(h, source(h))));
  for (const f of shipped) assert.ok(now.has(f), `kit/node/prebuilt/${f} was built from a source that has changed since: sign the helpers again (node tools/sign-helpers.ts, SimplySign connected), or remove it so the PCs compile that helper as before`);
});

test('on Windows, every prebuilt helper is signed with the owner\'s certificate', { skip: process.platform !== 'win32' || !shipped.length }, () => {
  const ps = `Get-ChildItem -LiteralPath '${PREBUILT_DIR}' | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_.FullName; $_.Name + ' ' + $s.Status + ' ' + $s.SignerCertificate.Thumbprint }`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
  assert.deepEqual(out.sort(), shipped.map((f) => `${f} Valid ${SIGNED_BY}`).sort());
});

test("a helper's name is the same for a checkout's CRLF, and changes with its source and how it's compiled", () => {
  assert.equal(helperHash('gentle', 'class A {\r\n}\r\n'), helperHash('gentle', 'class A {\n}\n'));
  assert.notEqual(helperHash('gentle', 'class A {}'), helperHash('gentle', 'class B {}'));
  assert.notEqual(helperHash('checks-pace', 'class A {}'), helperHash('awake', 'class A {}'), 'a console program and a windowless one are different files');
  assert.match(prebuiltName('awake', 'class A {}'), /^awake-[0-9a-f]{12}\.exe$/);
  assert.match(prebuiltName('working-set', 'class A {}'), /^working-set-[0-9a-f]{12}\.dll$/);
});

test('a signed helper is copied into the shared kit folder once, under a name of its own; none for a source the kit has none for', () => {
  const from = path.join(home, 'prebuilt');
  const into = path.join(home, 'kit');
  mkdirSync(from, { recursive: true });
  writeFileSync(path.join(from, prebuiltName('gentle', 'class A {}')), 'signed');
  const got = signedHelper('gentle', 'class A {}', { from, into });
  assert.equal(got, path.join(into, prebuiltName('gentle', 'class A {}').replace(/\.dll$/, '.signed.dll')));
  assert.equal(readFileSync(got!, 'utf8'), 'signed');
  writeFileSync(path.join(from, prebuiltName('gentle', 'class A {}')), 'newer');
  assert.equal(signedHelper('gentle', 'class A {}', { from, into }), got);
  assert.equal(readFileSync(got!, 'utf8'), 'signed', 'one an agent may be running is never overwritten');
  assert.deepEqual(readdirSync(into), [path.basename(got!)], 'nothing left behind');
  assert.equal(signedHelper('gentle', 'class B {}', { from, into }), null, 'a changed source: compiled on the PC');
  assert.equal(signedHelper('gentle', 'class A {}', { from, into: path.join(from, prebuiltName('gentle', 'class A {}'), 'x') }), null, 'never throws');
});
