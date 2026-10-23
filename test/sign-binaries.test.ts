import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LLAMA_PIN } from '../src/kit/setup.ts';
import { NPU_CATALOG } from '../src/kit/npu-vendors.ts';
import { actions, AS_IS, catalogPin, cdf, GENIEX_NOTICES, GENIEX_SDK, hostOf, listMarkdown, noticesReadme, signedBuildPin, sources, type Listed } from '../tools/sign-binaries.ts';
import { downloadPin, variantsAsked } from '../tools/sign-llama.ts';

// tools/sign-binaries.ts and sign-llama.ts' --variants: what the sitting signs and lists, without signing or downloading.

test("sign-binaries' sources: FastFlowLM and NVIDIA's runtime by catalog, the embedding servers' llama.cpp builds by signed copy, GenieX by signed build, as the kit pins them", () => {
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
  // GenieX at each version a generation installs (0.9.1 on the X2, 0.9.3 on the X Elite), from Qualcomm's SDK zip; not 0.8.0, which none installs new.
  for (const v of ['0.9.1', '0.9.3']) {
    const g = by.get(`geniex-${v}`);
    assert.equal(g?.how, 'signed-build', v);
    assert.deepEqual(g?.download, GENIEX_SDK[v]);
    assert.deepEqual([g?.folder, g?.exe, g?.signed], ['lib', 'geniex.exe', { tag: `geniex-${v}-castellan`, zip: `geniex-cli-windows-arm64-v${v}-castellan.zip` }]);
    assert.equal(g?.catalog, undefined);
  }
  assert.equal(by.get('geniex-0.8.0'), undefined);
  assert.deepEqual(s.filter((x) => x.how === 'signed-build').map((x) => x.version), ['0.9.1', '0.9.3']);
  // A generation pinned to a GenieX with no SDK pin is a stop, not a source left out.
  const cat = structuredClone(NPU_CATALOG);
  cat.routes.qualcomm.generations['snapdragon-x'].serverPin!.version = '0.9.9';
  assert.throws(() => sources(cat), /GenieX 0\.9\.9: a generation installs it, and GENIEX_SDK has no pin of its SDK zip/);
  // Every catalog's name is one catalogs.ts takes as Castellan's.
  for (const x of s.filter((y) => y.catalog)) assert.match(x.catalog!, /^castellan-[a-z0-9][a-z0-9.-]*\.cat$/);
  assert.ok(s.every((x) => /^[0-9a-f]{64}$/.test(x.download.sha256) && x.download.size > 0), 'each download pinned');
});

test("sign-binaries signs or lists only the unsigned files, leaves the maker's signed ones, and stops at a broken one", () => {
  const [copy, build, cat] = ['signed-copy', 'signed-build', 'catalog'].map((how) => sources().find((s) => s.how === how)!);
  const sigs = [
    { file: 'a.dll', size: 1, status: 'NotSigned', type: 'None', signer: null, version: null },
    { file: 'msvcp140.dll', size: 2, status: 'Valid', type: 'Authenticode', signer: 'Microsoft Corporation', version: '14.44' },
  ];
  assert.deepEqual(actions(copy, sigs).files.map((f) => f.action), ['sign', 'as-is']);
  assert.deepEqual(actions(build, sigs).files.map((f) => f.action), ['sign', 'as-is']);
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
  const [g091, g093] = ['geniex-0.9.1', 'geniex-0.9.3'].map((id) => all.find((s) => s.id === id)!);
  const file = (p: string, action: 'sign' | 'catalog' | 'as-is', signer: string | null = null) => ({ path: p, size: 10, sha256: 'ab'.repeat(32), version: null, signer, status: signer ? 'Valid' : 'NotSigned', action });
  const listed: Listed[] = [
    { ...flm, host: hostOf(flm), files: [file('flm.exe', 'catalog'), file('qwen3_npu.dll', 'catalog'), file('msvcp140.dll', 'as-is', 'Microsoft Corporation')] },
    { ...copy, host: hostOf(copy), files: [file('llama-server.exe', 'sign')] },
    { ...g093, host: hostOf(g093), files: [file('geniex.exe', 'sign'), file('llama_cpp\\llama.dll', 'sign'), file('qairt\\QnnHtp.dll', 'as-is', 'Qualcomm Technologies, Inc')] },
    { ...g091, host: hostOf(g091), files: [], missing: 'a PC with it installed gives its folder' },
  ];
  assert.match(hostOf(copy), /^https:\/\/github\.com\/Jcollier0120\/Manor-releases\/releases\/download\/llama\.cpp-b\d+\/llama-b\d+-bin-win-opencl-adreno-arm64\.zip$/);
  assert.equal(hostOf(g093), 'https://github.com/Jcollier0120/Manor-releases/releases/download/geniex-0.9.3-castellan/geniex-cli-windows-arm64-v0.9.3-castellan.zip');
  assert.match(hostOf(flm), /kit\\node\\catalogs\\castellan-amd-fastflowlm-1\.0\.7\.cat/);
  const md = listMarkdown(listed, AS_IS, '2026-10-23');
  assert.match(md, /Nothing here is signed or published until the owner approves it/);
  assert.match(md, /\| FastFlowLM \| 1\.0\.7 \| catalog castellan-amd-fastflowlm-1\.0\.7\.cat \| 2 to list, 1 its maker signed \|/);
  assert.match(md, /\| flm\.exe \|  \| 10 \| (ab){32} \| nobody \| listed \|/);
  assert.match(md, /\| msvcp140\.dll \|  \| 10 \| (ab){32} \| Microsoft Corporation \| left as it is \|/);
  assert.match(md, /\| llama-server\.exe \|.*\| signed \|/);
  assert.match(md, /\| GenieX CLI \| 0\.9\.3 \| signed build \| 2 to sign, 1 its maker signed \| https:\/\/github\.com\/Jcollier0120\/Manor-releases\/releases\/download\/geniex-0\.9\.3-castellan\//);
  assert.match(md, /Setup downloads geniex-sdk-windows-arm64-v0\.9\.3\.zip from Qualcomm's release, unchanged, takes its lib folder as GenieX's folder, and lays the signed copies over it: no installer runs/);
  assert.match(md, /\| qairt\\QnnHtp\.dll \|.*\| Qualcomm Technologies, Inc \| left as it is \|/);
  assert.match(md, /Its files aren't listed yet: a PC with it installed gives its folder/);
  // GenieX's pin: each file signed by its path, as it was and as it is now, the SDK zip and the signed copies' zip.
  const pin = signedBuildPin(listed[2], { size: 12, sha256: 'cd'.repeat(32) }, { 'geniex.exe': { size: 20, sha256: 'ef'.repeat(32) }, 'llama_cpp\\llama.dll': { size: 21, sha256: '01'.repeat(32) } }, '2026-10-23');
  assert.deepEqual(pin.copies, {
    'geniex.exe': { stock: { size: 10, sha256: 'ab'.repeat(32) }, signed: { size: 20, sha256: 'ef'.repeat(32) } },
    'llama_cpp\\llama.dll': { stock: { size: 10, sha256: 'ab'.repeat(32) }, signed: { size: 21, sha256: '01'.repeat(32) } },
  });
  assert.deepEqual(pin.files, { ...GENIEX_SDK['0.9.3'], folder: 'lib' });
  assert.deepEqual(pin.signed, { file: 'geniex-cli-windows-arm64-v0.9.3-castellan.zip', url: hostOf(g093), size: 12, sha256: 'cd'.repeat(32) });
  assert.equal(pin.serverVersion, '0.9.3');
  assert.throws(() => signedBuildPin(listed[2], { size: 1, sha256: 'x' }, {}, '2026-10-23'), /geniex\.exe wasn't signed/);
  // The notices' README names each source at its commit.
  const readme = noticesReadme(g093, GENIEX_NOTICES.map((n) => ({ name: n.name, repo: n.repo, ref: n.name === 'GenieX' ? 'v0.9.3' : 'e467e5b5e5ba43071d6151b3d881deb9300d000e' })));
  assert.match(readme, /with Castellan's Authenticode signature added and nothing else changed/);
  assert.match(readme, /- llama\.cpp: https:\/\/github\.com\/ggml-org\/llama\.cpp at e467e5b5e5ba43071d6151b3d881deb9300d000e, in llama\.cpp\\/);
  assert.deepEqual(GENIEX_NOTICES.map((n) => n.name), ['GenieX', 'geniex-qairt-plugin', 'geniex-proc', 'llama.cpp']);
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
