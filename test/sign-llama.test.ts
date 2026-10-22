import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { batches, peFiles, pinSnippet, releaseNotes, toSign, type Built } from '../tools/sign-llama.ts';

// tools/sign-llama.ts: what it signs and what its release says, without signing or downloading anything.
const dir = mkdtempSync(path.join(tmpdir(), 'sign-llama-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('sign-llama signs only the files with no signature, and stops at one whose signature is broken', () => {
  mkdirSync(path.join(dir, 'sub'));
  for (const f of ['llama-server.exe', 'ggml-cuda.dll', 'LICENSE-LLVM-OpenMP', 'sub/ggml-base.DLL', 'readme.md']) writeFileSync(path.join(dir, f), 'x');
  assert.deepEqual(peFiles(dir).map((f) => path.relative(dir, f)), ['ggml-cuda.dll', 'llama-server.exe', path.join('sub', 'ggml-base.DLL')]);
  const plan = toSign([
    { path: 'a.exe', status: 'NotSigned', thumbprint: '' },
    { path: 'b.dll', status: 'Valid', thumbprint: 'NVIDIA' },
    { path: 'c.dll', status: 'HashMismatch', thumbprint: 'X' },
  ]);
  assert.deepEqual(plan.sign, ['a.exe']);
  assert.deepEqual(plan.signedBefore.map((s) => s.path), ['b.dll'], "a file someone else signed stays as it is");
  assert.deepEqual(plan.bad.map((s) => s.path), ['c.dll']);
  const files = Array.from({ length: 300 }, (_, i) => `C:\\a\\llama\\b11734\\work\\cuda-12.4-x64\\file-${i}.dll`);
  const parts = batches(files, 2_000);
  assert.deepEqual(parts.flat(), files, 'every file, once, in order');
  assert.ok(parts.every((b) => b.reduce((n, f) => n + f.length + 3, 0) <= 2_000));
});

test("sign-llama's release notes name the source and give both sets of checksums", () => {
  const built: Built[] = [
    { variant: 'cpu-x64', zip: 'C:\\out\\llama-b11734-bin-win-cpu-x64.zip', size: 20606927, sha256: '11'.repeat(32), original: { name: 'llama-b11734-bin-win-cpu-x64.zip', size: 1, url: '', digest: `sha256:${'22'.repeat(32)}` }, signed: 50, signedBefore: 0 },
  ];
  const notes = releaseNotes('b11734', built, { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', size: 1, url: '', digest: `sha256:${'33'.repeat(32)}` }, 'LICENSE-llama.cpp.txt');
  assert.match(notes, /^llama\.cpp b11734: ggml-org's Windows builds, signed\./);
  assert.match(notes, /cpu-x64: 50 signed, 0 already signed/);
  assert.match(notes, /https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/tag\/b11734/);
  assert.match(notes, /LICENSE-llama\.cpp\.txt, beside the zips/);
  assert.ok(notes.includes(`${'11'.repeat(32)}  llama-b11734-bin-win-cpu-x64.zip`), 'the signed zip');
  assert.ok(notes.includes(`${'22'.repeat(32)}  llama-b11734-bin-win-cpu-x64.zip`), "ggml-org's");
  assert.ok(notes.includes(`${'33'.repeat(32)}  cudart-llama-bin-win-cuda-12.4-x64.zip`));
});

test("sign-llama writes the kit's pin of the build it signed: the signed zips' sizes and SHA-256s, NVIDIA's runtime from ggml-org (kit 2.97.0)", () => {
  const built: Built[] = [
    { variant: 'cpu-x64', zip: 'C:\\out\\llama-b11734-bin-win-cpu-x64.zip', size: 20606927, sha256: '11'.repeat(32), original: { name: 'llama-b11734-bin-win-cpu-x64.zip', size: 1, url: '', digest: `sha256:${'22'.repeat(32)}` }, signed: 50, signedBefore: 0 },
  ];
  const cudart = { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', size: 391443627, url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11734/cudart-llama-bin-win-cuda-12.4-x64.zip', digest: `sha256:${'33'.repeat(32)}` };
  assert.equal(
    pinSnippet('b11734', built, cudart),
    [
      'export const LLAMA_PIN: { build: string; signed: string; files: Record<string, PinnedDownload> } = {',
      "  build: 'b11734',",
      "  signed: 'llama.cpp-b11734',",
      '  files: {',
      `    'llama-b11734-bin-win-cpu-x64.zip': { size: 20606927, sha256: '${'11'.repeat(32)}' },`,
      "    'cudart-llama-bin-win-cuda-12.4-x64.zip': {",
      '      size: 391443627,',
      `      sha256: '${'33'.repeat(32)}',`,
      "      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11734/cudart-llama-bin-win-cuda-12.4-x64.zip',",
      '    },',
      '  },',
      '};',
      '',
    ].join('\n'),
    "the signed zip's own SHA-256, never ggml-org's",
  );
});
