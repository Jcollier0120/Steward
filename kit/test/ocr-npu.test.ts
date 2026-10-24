import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// The text reader's own model (ocr-npu.ts, kit 2.114.0): which engine and plugin a PC takes, the fetch into the
// reader's folder (real zips, unpacked by Windows' tar), the program's protocol (a stand-in program, so no model is
// needed), and the engine's choices. The real program on a real NPU is spec/OCR.md's measuring, not a test here.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-ocr-npu-'));
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'npu-agent', 'locks', 'npu');
/** The stand-in programs started: each holds its working folder until it has ended. */
const procs: ChildProcess[] = [];
after(async () => {
  m.resetModelReader();
  await Promise.all(procs.map((p) => (p.exitCode !== null || p.signalCode !== null ? null : new Promise((ended) => p.once('exit', ended)))));
  rmSync(home, { recursive: true, force: true });
});

const m = await import('./fixture/src/kit/ocr-npu.ts');
const { HELPERS, helperHash, compileHelperScript } = await import('./fixture/src/kit/prebuilt.ts');
beforeEach(() => m.resetModelReader());

const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** A zip of these files (path inside it: content), made by Windows' tar as the real ones are read by it. */
function makeZip(file: string, files: Record<string, string>): void {
  const src = `${file}.src`;
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, p)), { recursive: true });
    writeFileSync(path.join(src, p), body);
  }
  const r = spawnSync(tar, ['--format', 'zip', '-c', '-f', file, '-C', src, ...Object.keys(files)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  rmSync(src, { recursive: true, force: true });
}

test("the plugin a PC takes: Qualcomm's on Arm, Intel's on a generation measured for it or when tried, none at all when told", () => {
  const intel = (generation: string | null) => () => ({ vendor: 'intel' as const, generation });
  assert.equal(m.packFor('arm64', {}), m.QNN_PACK);
  assert.equal(m.packFor('x64', {}), null, 'no NPU report in a test run');
  assert.equal(m.packFor('x64', {}, intel('meteor-lake')), m.OPENVINO_PACK, "Intel's NPU 3720 was measured");
  assert.equal(m.packFor('x64', {}, intel('lunar-lake')), null, 'a generation not measured yet: no plugin, the processor reads');
  assert.equal(m.packFor('x64', {}, intel(null)), null);
  assert.equal(m.packFor('x64', {}, () => ({ vendor: 'amd' as const, generation: 'xdna2' })), null, "AMD's NPU is still to be measured");
  assert.equal(m.packFor('x64', {}, () => null), null, 'no NPU, or no setup yet');
  assert.equal(m.packFor('x64', { KIT_OCR_NPU: 'openvino' }), m.OPENVINO_PACK);
  assert.equal(m.packFor('x64', { KIT_OCR_NPU: 'none' }, intel('meteor-lake')), null);
  assert.equal(m.packFor('arm64', { KIT_OCR_NPU: 'none' }), null);
  assert.equal(m.packFor('ia32', {}, intel('meteor-lake')), null);
});

test("which engine reads: the model where it's worth it, Windows' OCR under node:test unless told", () => {
  assert.equal(m.engineSetting({}), 'auto');
  assert.equal(m.engineSetting({ NODE_TEST_CONTEXT: 'child' }), 'windows', 'no test fetches the model');
  assert.equal(m.engineSetting({ NODE_TEST_CONTEXT: 'child', KIT_OCR_ENGINE: 'model' }), 'model');
  assert.equal(m.engineSetting({ KIT_OCR_ENGINE: 'Windows ' }), 'windows');
});

test('every file the reader fetches is pinned by size and SHA-256, from its maker or the manor\'s releases', () => {
  const pins = [...Object.values(m.ORT_ZIPS), m.QNN_PACK.package, m.OPENVINO_PACK.package, ...Object.values(m.MODEL_FILES)];
  for (const p of pins) {
    assert.match(p.sha256, /^[0-9a-f]{64}$/);
    assert.ok(p.size > 0);
    assert.match(p.url, /^https:\/\/(github\.com\/microsoft\/onnxruntime|api\.nuget\.org|github\.com\/[^/]+\/Manor-releases)\//);
  }
  assert.notEqual(new Set(Object.values(m.MODEL_FILES).map((f) => f.sha256)).size, 1, 'the model files are pinned, not left blank');
});

test("the reader's folder: shared beside the NPU's line, one folder for each piece, whole once READY is in it", () => {
  assert.equal(m.ocrHome({}), path.join(path.dirname(path.dirname(process.env.NPU_AGENT_NPU_LOCK!)), 'ocr'));
  assert.equal(m.ocrHome({ KIT_OCR_HOME: 'D:\\ocr' }), 'D:\\ocr');
  const place = m.placeOf(path.join(home, 'place'), 'arm64', m.QNN_PACK);
  assert.deepEqual(m.missingIn(place), [place.models, place.ort, place.pack]);
  assert.equal(m.placeOf(home, 'x64', null).pack, null);
});

test('fetching: the model, ONNX Runtime and the plugin, each pinned, only the files used kept, with their notices', { skip: process.platform !== 'win32' }, async () => {
  const src = path.join(home, 'served');
  mkdirSync(src, { recursive: true });
  const top = `onnxruntime-win-arm64-${m.ORT_VERSION}`;
  makeZip(path.join(src, 'ort.zip'), {
    [`${top}/lib/onnxruntime.dll`]: 'ort',
    [`${top}/lib/onnxruntime_providers_shared.dll`]: 'shared',
    [`${top}/lib/onnxruntime.pdb`]: 'not kept',
    [`${top}/LICENSE`]: 'MIT',
    [`${top}/ThirdPartyNotices.txt`]: 'notices',
  });
  makeZip(path.join(src, 'qnn.nupkg'), {
    ...Object.fromEntries(m.QNN_PACK.keep.map((f: string) => [`${m.QNN_PACK.native}/${f}`, f])),
    [`${m.QNN_PACK.native}/QnnGpu.dll`]: 'not kept',
    ...Object.fromEntries(m.QNN_PACK.notices.map((f: string) => [f, f])),
  });
  const fetched: { url: string; sha256?: string }[] = [];
  const place = m.placeOf(path.join(home, 'fetch'), 'arm64', m.QNN_PACK);
  await m.fetchReader(place, 'arm64', m.QNN_PACK, {
    async download(d: any) {
      fetched.push({ url: d.url, sha256: d.sha256 });
      mkdirSync(path.dirname(d.dest), { recursive: true });
      if (d.url.endsWith('.zip')) copyFileSync(path.join(src, 'ort.zip'), d.dest);
      else if (d.url.endsWith('.nupkg')) copyFileSync(path.join(src, 'qnn.nupkg'), d.dest);
      else writeFileSync(d.dest, path.basename(d.dest));
    },
  });
  assert.deepEqual(m.missingIn(place), []);
  assert.deepEqual(fetched.map((f) => f.url), [...Object.values(m.MODEL_FILES).map((f: any) => f.url), m.ORT_ZIPS.arm64.url, m.QNN_PACK.package.url], 'the smallest first');
  assert.ok(fetched.every((f) => /^[0-9a-f]{64}$/.test(f.sha256 ?? '')), 'every download is checked against its pin');
  assert.deepEqual(readdirSync(place.ort).sort(), ['notices', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'ready']);
  assert.deepEqual(readdirSync(path.join(place.ort, 'notices')).sort(), ['LICENSE', 'ThirdPartyNotices.txt']);
  assert.deepEqual(readdirSync(place.pack!).sort(), [...m.QNN_PACK.keep, 'notices', 'ready'].sort());
  assert.equal(readFileSync(path.join(place.pack!, 'QnnHtp.dll'), 'utf8'), 'QnnHtp.dll');
  assert.deepEqual(readdirSync(place.models).sort(), ['charset.txt', 'det.onnx', 'notices', 'ready', 'rec.onnx']);
  assert.deepEqual(readdirSync(path.join(place.models, 'notices')).sort(), ['LICENSE.txt', 'NOTICE.txt']);
  assert.deepEqual(readdirSync(path.join(place.home, 'downloads')), [], 'the zips are deleted once unpacked');
  assert.deepEqual(readdirSync(place.home).filter((f) => /unpacking|fetching/.test(f)), []);
});

test('a zip without a member it should have: nothing put in place, nothing left behind', { skip: process.platform !== 'win32' }, () => {
  const zip = path.join(home, 'short.zip');
  makeZip(zip, { 'a.txt': 'a' });
  const into = path.join(home, 'short');
  assert.throws(() => m.unpackMembers(zip, into, [{ member: 'a.txt', as: 'a.txt' }, { member: 'b.txt', as: 'b.txt' }]), /didn't unpack/);
  assert.equal(existsSync(into), false);
  assert.equal(existsSync(`${into}.unpacking`), false);
});

/**
 * A stand-in for ocr-npu.exe: its hello (with its working folder; on the NPU, that it compiled its graphs the first time
 * in that folder), then an answer per line; a path with "die" ends it, "slow" is never answered.
 */
const fake = path.join(home, 'fake-reader.mjs');
writeFileSync(
  fake,
  `import { existsSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
const on = process.argv.includes('--on') ? process.argv[process.argv.indexOf('--on') + 1] : 'npu';
const fail = process.argv.includes('--fail');
const compiled = on === 'npu' && !existsSync('compiled') ? (writeFileSync('compiled', ''), 9) : 0;
console.log(JSON.stringify(fail ? { hello: 1, error: 'no runtime' } : { hello: 1, on, ep: on === 'npu' ? 'qnn' : 'cpu', why: process.cwd(), compiled }));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [id, scale, orient, file] = line.split('\\t');
  if (file.includes('die')) process.exit(3);
  if (file.includes('slow')) return;
  console.log(JSON.stringify({ id: Number(id), width: 100, height: 40, ms: 2, lines: [{ text: file.split(/[\\\\/]/).pop() + ' ' + scale + ' ' + orient, words: [] }] }));
});
`,
);
const spawnImpl = ((...a: Parameters<typeof spawn>) => {
  const p = spawn(...a);
  procs.push(p);
  return p;
}) as typeof spawn;
const startFake = (args: string[], cwd: string) => m.ReaderHost.start(process.execPath, [fake, ...args], cwd, { helloMs: 30_000, spawnImpl });

test("the program: hello from its working folder, one answer a picture, and a program that ends answers what's waiting", async () => {
  const cwd = path.join(home, 'cache');
  const h = await startFake(['--on', 'cpu'], cwd);
  assert.equal(h.hello.on, 'cpu');
  assert.equal(h.hello.why, cwd, 'it runs in the cache folder');
  const a = await h.read(path.join(home, 'shot.png'), 2, true);
  assert.equal(a.lines?.[0].text, 'shot.png 2 1');
  assert.equal((await h.read(path.join(home, 'photo.jpg'), 1, false)).lines?.[0].text, 'photo.jpg 1 0');
  const died = await h.read(path.join(home, 'die.png'), 1, true);
  assert.match(died.error ?? '', /stopped/);
  assert.equal(h.alive, false);
  assert.match((await h.read(path.join(home, 'after.png'), 1, true)).error ?? '', /stopped/, 'answered at once once gone');
});

test("a program that can't start says why; one that takes too long over a picture is ended", async () => {
  await assert.rejects(startFake(['--fail'], path.join(home, 'cache')), /no runtime/);
  const h = await startFake([], path.join(home, 'cache'));
  const slow = await h.read(path.join(home, 'slow.png'), 1, true, 300);
  assert.match(slow.error ?? '', /too long/);
  assert.equal(h.alive, false);
});

/** A reader's folder with every piece in place. */
function readyPlace(arch: 'arm64' | 'x64', pack: any): string {
  const where = mkdtempSync(path.join(home, 'ready-'));
  const place = m.placeOf(where, arch, pack);
  for (const d of [place.models, place.ort, place.pack]) {
    if (!d) continue;
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'ready'), 'x');
  }
  return where;
}

test("not fetched yet: Windows' OCR reads while the fetch starts; not worth it here: nothing fetched at all", async () => {
  const fetches: string[] = [];
  const fetch = (p: any) => void fetches.push(p.home);
  const where = path.join(home, 'empty');
  assert.equal(await m.modelReader({ env: {}, arch: 'arm64', home: where, fetch }), null);
  assert.deepEqual(fetches, [where]);
  assert.equal(await m.modelReader({ env: {}, arch: 'x64', home: where, fetch }), null);
  assert.deepEqual(fetches, [where], m.ON_PROCESSOR ? 'fetched for the processor' : "an x64 PC without an NPU the model uses fetches nothing (ON_PROCESSOR is off)");
  assert.equal(await m.modelReader({ env: { KIT_OCR_ENGINE: 'windows' }, arch: 'arm64', home: where, fetch }), null);
  assert.deepEqual(fetches, [where]);
});

test('on the processor when told: its program started there once, and every page answered by it', async () => {
  const where = readyPlace('x64', null);
  const started: string[][] = [];
  const start = (args: string[], cwd: string) => (started.push(args), startFake(args, cwd));
  const r = await m.modelReader({ env: { KIT_OCR_ENGINE: 'model' }, arch: 'x64', home: where, start });
  assert.ok(r);
  assert.equal(r.engine, 'model-cpu');
  const got = await r.read([1, 2, 3].map((n) => ({ file: path.join(home, `p${n}.png`), scale: 1, orient: true })));
  assert.deepEqual(got.map((g: any) => [g.lines[0].text, g.engine]), [1, 2, 3].map((n) => [`p${n}.png 1 1`, 'model-cpu']));
  assert.equal(started.length, 1);
  assert.equal(started[0][started[0].indexOf('--on') + 1], 'cpu');
  assert.ok(!started[0].includes('--qnn'));
});

test("an AMD or Intel PC reads with the model on the processor where no NPU can: fetched without a plugin, and started there", async () => {
  const amd = { PROCESSOR_IDENTIFIER: 'AMD64 Family 26 Model 36 Stepping 0, AuthenticAMD' };
  const intel = { PROCESSOR_IDENTIFIER: 'Intel64 Family 6 Model 189 Stepping 1, GenuineIntel' };
  const snapdragon = { PROCESSOR_IDENTIFIER: 'ARMv8 (64-bit) Family 8 Model 1 Revision 201, Qualcomm Technologies Inc' };
  assert.equal(m.onProcessor(amd), true);
  assert.equal(m.onProcessor(intel), true, "an Intel NPU not measured yet, or none: the processor");
  assert.equal(m.onProcessor(snapdragon), m.ON_PROCESSOR, "a Snapdragon's reader keeps to its NPU, or Windows' OCR");
  assert.equal(m.onProcessor({}), m.ON_PROCESSOR);
  const fetches: [string, unknown][] = [];
  const fetch = (p: any, _arch: string, pack: unknown) => void fetches.push([p.home, pack]);
  const empty = path.join(home, 'empty-amd');
  assert.equal(await m.modelReader({ env: amd, arch: 'x64', home: empty, fetch }), null, "Windows' OCR reads while it's fetched");
  assert.deepEqual(fetches, [[empty, null]], 'ONNX Runtime and the model, no plugin');
  const where = readyPlace('x64', null);
  const started: string[][] = [];
  const start = (args: string[], cwd: string) => (started.push(args), startFake(args, cwd));
  const r = await m.modelReader({ env: amd, arch: 'x64', home: where, start });
  assert.equal(r?.engine, 'model-cpu');
  assert.equal(started[0][started[0].indexOf('--on') + 1], 'cpu');
  assert.ok(!started[0].includes('--openvino'));
});

test("on the NPU: started again once it has compiled, its turn taken, pages answered; a page that ends the program leaves the rest to Windows' OCR", async () => {
  const where = readyPlace('arm64', m.QNN_PACK);
  const started: string[][] = [];
  const start = (args: string[], cwd: string) => (started.push(args), startFake(args, cwd));
  const r = await m.modelReader({ env: {}, arch: 'arm64', home: where, start });
  assert.ok(r);
  assert.equal(r.engine, 'model-npu');
  assert.equal(started.length, 2, "the first start compiled its graphs: started again, without the compiler's memory");
  assert.deepEqual(started[1], started[0]);
  assert.equal(started[0][started[0].indexOf('--qnn') + 1], m.placeOf(where, 'arm64', m.QNN_PACK).pack);
  const files = ['a.png', 'die.png', 'c.png'].map((f) => ({ file: path.join(home, f), scale: 1, orient: true }));
  const got = await r.read(files, { lane: 'interactive' });
  assert.equal(got[0]?.engine, 'model-npu');
  assert.match(got[1]?.error ?? '', /stopped/);
  assert.equal(got[2], null, 'not read: Windows reads it');
  assert.equal(existsSync(process.env.NPU_AGENT_NPU_LOCK!), false, 'the NPU given back');
});

test("an NPU that fails the program's check isn't used, and isn't tried again for a while", async () => {
  const where = readyPlace('arm64', m.QNN_PACK);
  let starts = 0;
  const start = (args: string[], cwd: string) => (starts++, startFake(args.map((a) => (a === 'npu' ? 'cpu' : a)), cwd));
  const r = await m.modelReader({ env: {}, arch: 'arm64', home: where, start });
  if (m.ON_PROCESSOR) {
    assert.equal(r?.engine, 'model-cpu', 'read on the processor instead');
  } else {
    assert.equal(r, null, "Windows' OCR reads instead");
    assert.equal(await m.modelReader({ env: {}, arch: 'arm64', home: where, start }), null);
    assert.equal(starts, 1, 'not started again');
  }
});

test("the program's name carries its references and manifest, the older helpers' names don't change", () => {
  assert.ok(HELPERS['ocr-npu'].refs?.includes('System.Drawing.dll'));
  assert.equal(HELPERS['ocr-npu'].manifest, 'arm64');
  assert.equal(HELPERS.gentle.refs, undefined);
  assert.notEqual(helperHash('ocr-npu', 'class A {}'), helperHash('checks-pace', 'class A {}'), 'same type and source, but references and a manifest');
  const ps = compileHelperScript('ocr-npu', 'C:\\kit\\ocr-npu.cs', 'C:\\kit\\ocr-npu-1.exe');
  assert.match(ps, /System\.Drawing\.dll/);
  assert.match(ps, /\/win32manifest:"C:\\kit\\ocr-npu-1\.exe\.manifest"/);
  assert.match(ps, /<supportedArchitectures [^>]*>amd64 arm64</);
  assert.match(ps, /GenerateExecutable = \$true/);
});
