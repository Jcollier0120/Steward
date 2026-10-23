import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LLAMA_PIN } from '../src/kit/setup.ts';
import { actions, AS_IS, catalogPin, cdf, hostOf, listMarkdown, sources, type Listed } from '../tools/sign-binaries.ts';
import { downloadPin, variantsAsked } from '../tools/sign-llama.ts';

// tools/sign-binaries.ts and sign-llama.ts' --variants: what the sitting signs and lists, without signing or downloading.

test("sign-binaries' sources: FastFlowLM, NVIDIA's runtime and GenieX by catalog, the embedding servers' llama.cpp builds by signed copy, as the kit pins them", () => {
  const s = sources();
  const by = new Map(s.map((x) => [x.id, x]));
  assert.equal(by.get('fastflowlm-1.0.7')?.how, 'catalog');
  assert.equal(by.get('fastflowlm-1.0.7')?.catalog, 'castellan-amd-fastflowlm-1.0.7.cat');
  assert.equal(by.get('cudart-12.4')?.catalog, 'castellan-cuda-cudart-12.4.cat');
  assert.equal(by.get('cudart-12.4')?.download.sha256, LLAMA_PIN.files['cudart-llama-bin-win-cuda-12.4-x64.zip'].sha256);
  for (const b of ['b11645', 'b11125']) {
    const c = by.get(`llama.cpp-${b}-opencl-adreno-arm64`);
    assert.equal(c?.how, 'signed-copy', b);
    assert.equal(c?.build, b);
    assert.equal(c?.variant, 'opencl-adreno-arm64');
  }
  // One entry a build, though two GenieX versions run b11645.
  assert.equal(s.filter((x) => x.build === 'b11645').length, 1);
  for (const v of ['0.8.0', '0.9.1', '0.9.3']) {
    assert.equal(by.get(`geniex-${v}`)?.catalog, `castellan-qualcomm-geniex-${v}.cat`, v);
    assert.equal(by.get(`geniex-${v}`)?.installs, true);
  }
  // Every catalog's name is one catalogs.ts takes as Castellan's.
  for (const x of s.filter((y) => y.catalog)) assert.match(x.catalog!, /^castellan-[a-z0-9][a-z0-9.-]*\.cat$/);
  assert.ok(s.every((x) => /^[0-9a-f]{64}$/.test(x.download.sha256) && x.download.size > 0), 'each download pinned');
});

test("sign-binaries signs or lists only the unsigned files, leaves the maker's signed ones, and stops at a broken one", () => {
  const [copy, cat] = [sources().find((s) => s.how === 'signed-copy')!, sources().find((s) => s.how === 'catalog')!];
  const sigs = [
    { file: 'a.dll', size: 1, status: 'NotSigned', type: 'None', signer: null, version: null },
    { file: 'msvcp140.dll', size: 2, status: 'Valid', type: 'Authenticode', signer: 'Microsoft Corporation', version: '14.44' },
  ];
  assert.deepEqual(actions(copy, sigs).files.map((f) => f.action), ['sign', 'as-is']);
  assert.deepEqual(actions(cat, sigs).files.map((f) => [f.action, f.signer]), [['catalog', null], ['as-is', 'Microsoft Corporation']]);
  const broken = actions(cat, [...sigs, { file: 'b.dll', size: 3, status: 'HashMismatch', type: 'Authenticode', signer: 'X', version: null }]);
  assert.deepEqual(broken.bad.map((b) => b.file), ['b.dll']);
  assert.equal(broken.files.length, 2);
});

test("sign-binaries' catalog definition: SHA-256, a member a line, as MakeCat takes it", () => {
  const text = cdf('castellan-amd-fastflowlm-1.0.7.cat', 'C:\\out', ['C:\\x\\flm.exe', 'C:\\x\\q4.dll']);
  const lines = text.split('\r\n');
  assert.ok(lines.includes('CatalogVersion=2') && lines.includes('HashAlgorithms=SHA256'));
  assert.ok(lines.includes('Name=castellan-amd-fastflowlm-1.0.7.cat') && lines.includes('ResultDir=C:\\out'));
  assert.deepEqual(lines.filter((l) => l.startsWith('<HASH>')), ['<HASH>f001=C:\\x\\flm.exe', '<HASH>f002=C:\\x\\q4.dll']);
});

test("sign-binaries' list and pins: each file's SHA-256 and what's done with it, where it will be hosted, and the route's pin of the catalog", () => {
  const all = sources();
  const flm = all.find((s) => s.id.startsWith('fastflowlm'))!;
  const copy = all.find((s) => s.how === 'signed-copy')!;
  const geniex = all.find((s) => s.installs)!;
  const file = (p: string, action: 'sign' | 'catalog' | 'as-is', signer: string | null = null) => ({ path: p, size: 10, sha256: 'ab'.repeat(32), version: null, signer, status: signer ? 'Valid' : 'NotSigned', action });
  const listed: Listed[] = [
    { ...flm, host: hostOf(flm), files: [file('flm.exe', 'catalog'), file('qwen3_npu.dll', 'catalog'), file('msvcp140.dll', 'as-is', 'Microsoft Corporation')] },
    { ...copy, host: hostOf(copy), files: [file('llama-server.exe', 'sign')] },
    { ...geniex, host: hostOf(geniex), files: [], missing: 'a PC with it installed gives its folder' },
  ];
  assert.match(hostOf(copy), /^https:\/\/github\.com\/Jcollier0120\/Manor-releases\/releases\/download\/llama\.cpp-b\d+\/llama-b\d+-bin-win-opencl-adreno-arm64\.zip$/);
  assert.match(hostOf(flm), /kit\\node\\catalogs\\castellan-amd-fastflowlm-1\.0\.7\.cat/);
  const md = listMarkdown(listed, AS_IS, '2026-10-23');
  assert.match(md, /Nothing here is signed or published until the owner approves it/);
  assert.match(md, /\| FastFlowLM \| 1\.0\.7 \| catalog castellan-amd-fastflowlm-1\.0\.7\.cat \| 2 to list, 1 its maker signed \|/);
  assert.match(md, /\| flm\.exe \|  \| 10 \| (ab){32} \| nobody \| listed \|/);
  assert.match(md, /\| msvcp140\.dll \|  \| 10 \| (ab){32} \| Microsoft Corporation \| left as it is \|/);
  assert.match(md, /\| llama-server\.exe \|.*\| signed \|/);
  assert.match(md, /Its files aren't listed yet: a PC with it installed gives its folder/);
  assert.match(md, /OpenVINO Model Server 2026\.4\.1 \(the Intel NPU\): Intel/);
  assert.deepEqual(catalogPin(listed[0], { size: 8940, sha256: 'cd'.repeat(32) }), {
    serverVersion: '1.0.7',
    file: 'castellan-amd-fastflowlm-1.0.7.cat',
    covers: "FastFlowLM 1.0.7's 2 unsigned program files",
    size: 8940,
    sha256: 'cd'.repeat(32),
  });
});

test("sign-llama's --variants: those builds alone, one the kit doesn't use a stop; each signed zip's pin as a route's download", () => {
  assert.deepEqual(variantsAsked(['b11645', '--variants=opencl-adreno-arm64']), ['opencl-adreno-arm64']);
  assert.ok(variantsAsked(['b11734']).length > 1, 'every build the kit uses when none is asked for');
  assert.throws(() => variantsAsked(['--variants=opencl-adreno-arm64,vulkan-x99']), /not a build the kit uses: vulkan-x99/);
  assert.deepEqual(downloadPin('b11645', { zip: 'C:\\a\\llama-b11645-bin-win-opencl-adreno-arm64.zip', size: 13300000, sha256: 'ef'.repeat(32) }), {
    file: 'llama-b11645-bin-win-opencl-adreno-arm64.zip',
    url: 'https://github.com/Jcollier0120/Manor-releases/releases/download/llama.cpp-b11645/llama-b11645-bin-win-opencl-adreno-arm64.zip',
    size: 13300000,
    sha256: 'ef'.repeat(32),
  });
});
