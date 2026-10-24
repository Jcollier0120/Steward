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
  assert.equal(m.packFor('x64', {}, intel('lunar-lake')), null, 'a generation not measured yet keeps Windows OCR');
  assert.equal(m.packFor('x64', {}, intel(null)), null);
  assert.equal(m.packFor('x64', {}, () => ({ vendor: 'amd' as const, generation: 'xdna2' })), null, "AMD's NPU is still to be measured");
  assert.equal(m.packFor('x64', {}, () => null), null, 'no NPU, or no setup yet');
  assert.equal(m.packFor('x64', { KIT_OCR_NPU: 'openvino' }), m.OPENVINO_PACK);
  assert.equal(m.packFor('x64', { KIT_OCR_NPU: ' VitisAI' }), m.VITISAI_PACK);
  assert.equal(m.packFor('arm64', { KIT_OCR_NPU: 'vitisai' }), m.QNN_PACK, 'an Arm PC has no AMD NPU');
  assert.equal(m.packFor('x64', { KIT_OCR_NPU: 'none' }, intel('meteor-lake')), null);
  assert.equal(m.packFor('arm64', { KIT_OCR_NPU: 'none' }), null);
  assert.equal(m.packFor('ia32', {}, intel('meteor-lake')), null);
});

test("AMD's: Windows ML's DLL in its own folder, the program told to load only compiled graphs where it reads", () => {
  const place = m.placeOf(path.join(home, 'amd'), 'x64', m.VITISAI_PACK);
  assert.equal(place.pack, path.join(home, 'amd', 'winml-2.4.89'), "Envoy's folder name, so one PC keeps one copy");
  assert.equal(place.graphs, m.AMD_GRAPHS ? path.join(home, 'amd', `amd-graphs-${m.MODEL_VERSION}-${m.AMD_GRAPHS.plugin}`) : null);
  assert.deepEqual(m.missingIn(place), [place.models, place.ort, place.pack, place.graphs].filter(Boolean));
  const args = m.readerArgs(place, m.VITISAI_PACK);
  assert.equal(args[args.indexOf('--on') + 1], 'npu');
  assert.equal(args[args.indexOf('--vitisai') + 1], place.pack);
  assert.ok(args.includes('--compiled-only'), 'compiling is prepareReader\'s, in the background');
  assert.ok(!args.includes('--qnn') && !args.includes('--openvino'));
  assert.ok(!m.readerArgs(place, m.QNN_PACK).includes('--compiled-only'));
});

test("which engine reads: the model where it's worth it, Windows' OCR under node:test unless told", () => {
  assert.equal(m.engineSetting({}), 'auto');
  assert.equal(m.engineSetting({ NODE_TEST_CONTEXT: 'child' }), 'windows', 'no test fetches the model');
  assert.equal(m.engineSetting({ NODE_TEST_CONTEXT: 'child', KIT_OCR_ENGINE: 'model' }), 'model');
  assert.equal(m.engineSetting({ KIT_OCR_ENGINE: 'Windows ' }), 'windows');
});

test('every file the reader fetches is pinned by size and SHA-256, from its maker or the manor\'s releases', () => {
  const pins = [
    ...Object.values(m.ORT_ZIPS),
    m.QNN_PACK.package,
    m.OPENVINO_PACK.package,
    m.VITISAI_PACK.package,
    ...Object.values(m.MODEL_FILES),
    ...(m.AMD_GRAPHS ? [m.AMD_GRAPHS.zip] : []),
  ];
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
 * in that folder, or on AMD's, that they're to be prepared until "prepared" is there), then an answer per line; a path
 * with "die" ends it, "slow" is never answered. With --prepare: noise first, as AMD's compiler prints, then what it did.
 */
const fake = path.join(home, 'fake-reader.mjs');
writeFileSync(
  fake,
  `import { existsSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
const has = (a) => process.argv.includes(a);
if (has('--prepare')) {
  console.log('{ "not": "the program\\'s line"');
  console.log('[vitisai] compiling');
  writeFileSync('prepared', '');
  console.log(JSON.stringify({ prepared: 1, graphs: 5, compiled: 5, atOnce: 3, ms: 60000, args: process.argv.slice(2) }));
  process.exit(0);
}
const on = has('--on') ? process.argv[process.argv.indexOf('--on') + 1] : 'npu';
const fail = has('--fail');
const ep = on !== 'npu' ? 'cpu' : has('--vitisai') ? 'vitisai' : 'qnn';
const prepare = has('--compiled-only') && !existsSync('prepared');
const compiled = on === 'npu' && ep !== 'vitisai' && !existsSync('compiled') ? (writeFileSync('compiled', ''), 9) : 0;
console.log(JSON.stringify(fail ? { hello: 1, error: 'no runtime' } : { hello: 1, on, ep, why: process.cwd(), compiled, prepare }));
if (prepare) process.exit(0);
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

test("an AMD PC reads with the model on the processor: fetched without an NPU's plugin, and started there", async () => {
  const amd = { PROCESSOR_IDENTIFIER: 'AMD64 Family 26 Model 36 Stepping 0, AuthenticAMD' };
  const intel = { PROCESSOR_IDENTIFIER: 'Intel64 Family 6 Model 181 Stepping 0, GenuineIntel' };
  assert.equal(m.onProcessor(amd), true);
  assert.equal(m.onProcessor(intel), m.ON_PROCESSOR, "an Intel PC's reader keeps to its NPU, or Windows' OCR");
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

/** What modelReader logged, and a wait for a line it hasn't yet. */
function logs() {
  const lines: string[] = [];
  const waits: { re: RegExp; done: () => void }[] = [];
  return {
    lines,
    log(line: string) {
      lines.push(line);
      for (const w of waits.filter((x) => x.re.test(line))) w.done();
    },
    seen: (re: RegExp) =>
      lines.some((l) => re.test(l)) ? Promise.resolve() : new Promise<void>((done) => waits.push({ re, done: () => setImmediate(done) })),
  };
}

/** AMD's compile, stood in for: it waits for `gate`, then leaves what --prepare leaves (the fake reads "prepared"). */
function amdPrepare(said: { prepared: 0 | 1; error?: string } = { prepared: 1 }) {
  const calls: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let called!: () => void;
  const first = new Promise<void>((r) => (called = r));
  const prepare = async (place: any, pack: any) => {
    calls.push(pack.id);
    called();
    await gate;
    mkdirSync(place.cache, { recursive: true });
    if (said.prepared) writeFileSync(path.join(place.cache, 'prepared'), '');
    return { graphs: 5, compiled: said.prepared ? 5 : 0, atOnce: 3, ms: 60_000, ...said };
  };
  return { calls, open, first, prepare };
}

test("AMD's NPU: its graphs compiled once, in the background, while Windows' OCR reads; then read there", async () => {
  const where = readyPlace('x64', m.VITISAI_PACK);
  const started: string[][] = [];
  const start = (args: string[], cwd: string) => (started.push(args), startFake(args, cwd));
  const amd = amdPrepare();
  const l = logs();
  const o = { env: { KIT_OCR_NPU: 'vitisai' }, arch: 'x64', home: where, start, prepare: amd.prepare, log: l.log };
  assert.equal(await m.modelReader(o), null, "Windows' OCR reads while they compile");
  assert.ok(started[0].includes('--compiled-only'), 'the program reading never compiles');
  await amd.first;
  assert.deepEqual(amd.calls, ['vitisai']);
  assert.equal(await m.modelReader(o), null);
  assert.equal(started.length, 1, 'not started again while compiling');
  amd.open();
  await l.seen(/AMD's NPU compiled the text reader's model \(5 graphs, 3 at once, in 1 min\)/);
  const r = await m.modelReader(o);
  assert.equal(r?.engine, 'model-npu');
  assert.equal(started.length, 2, 'its graphs compiled already: started once');
  assert.deepEqual(amd.calls, ['vitisai'], 'compiled once');
  const got = await r!.read([{ file: path.join(home, 'amd.png'), scale: 1, orient: true }]);
  assert.equal(got[0]?.engine, 'model-npu');
  assert.equal(existsSync(path.join(path.dirname(process.env.NPU_AGENT_NPU_LOCK!), 'ocr-prepare')), false, 'the lock given back');
});

test("AMD's NPU: a compile that fails leaves Windows' OCR reading, and isn't tried again for a while", async () => {
  const where = readyPlace('x64', m.VITISAI_PACK);
  let starts = 0;
  const start = (args: string[], cwd: string) => (starts++, startFake(args, cwd));
  const amd = amdPrepare({ prepared: 0, error: 'the compiler ended' });
  const l = logs();
  const o = { env: { KIT_OCR_NPU: 'vitisai' }, arch: 'x64', home: where, start, prepare: amd.prepare, log: l.log };
  assert.equal(await m.modelReader(o), null);
  amd.open();
  await l.seen(/couldn't compile the text reader's model \(the compiler ended\)/);
  assert.equal(await m.modelReader(o), null);
  assert.equal(await m.modelReader({ ...o, now: Date.now() + 11 * 60_000 }), null);
  assert.equal(starts, 1, 'not started again');
  assert.deepEqual(amd.calls, ['vitisai']);
});

test("AMD's NPU: while another agent compiles, this one doesn't, and looks again in a while", async () => {
  const L = await import('./fixture/src/kit/lock.ts');
  const where = readyPlace('x64', m.VITISAI_PACK);
  const started: string[][] = [];
  const start = (args: string[], cwd: string) => (started.push(args), startFake(args, cwd));
  const amd = amdPrepare();
  const l = logs();
  const o = { env: { KIT_OCR_NPU: 'vitisai' }, arch: 'x64', home: where, start, prepare: amd.prepare, log: l.log };
  let release!: () => void;
  const held = L.withLock(path.join(L.locksDir, 'ocr-prepare'), () => new Promise<void>((r) => (release = r)));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await m.modelReader(o), null);
  await l.seen(/another agent on this PC is compiling/);
  assert.deepEqual(amd.calls, [], 'not compiled twice');
  assert.equal(await m.modelReader(o), null);
  assert.equal(started.length, 1, 'not started again yet');
  release();
  await held;
  amd.open();
  const later = { ...o, now: Date.now() + 11 * 60_000 };
  assert.equal(await m.modelReader(later), null, 'ten minutes on: still not compiled here, so compiled now');
  await l.seen(/AMD's NPU compiled/);
  assert.deepEqual(amd.calls, ['vitisai']);
  assert.equal((await m.modelReader(later))?.engine, 'model-npu');
});

test("AMD's NPU on an AMD PC: the model reads on the processor while its graphs compile, then on the NPU", async () => {
  const where = readyPlace('x64', m.VITISAI_PACK);
  const started: string[][] = [];
  const start = (args: string[], cwd: string) => (started.push(args), startFake(args, cwd));
  const amd = amdPrepare();
  const l = logs();
  const env = { KIT_OCR_NPU: 'vitisai', PROCESSOR_IDENTIFIER: 'AMD64 Family 26 Model 36 Stepping 0, AuthenticAMD' };
  const r = await m.modelReader({ env, arch: 'x64', home: where, start, prepare: amd.prepare, log: l.log });
  assert.equal(r?.engine, 'model-cpu', 'the processor reads while they compile');
  assert.deepEqual(started.map((a) => a[a.indexOf('--on') + 1]), ['npu', 'cpu']);
  await amd.first;
  assert.ok(l.lines.some((x) => /compiling the text reader's model .*: the model reads on the processor until then/.test(x)));
  const page = (f: string) => [{ file: path.join(home, f), scale: 1, orient: true }];
  assert.equal((await r!.read(page('a.png')))[0]?.engine, 'model-cpu');
  assert.equal(started.length, 2);
  amd.open();
  await l.seen(/AMD's NPU compiled/);
  assert.equal((await r!.read(page('b.png')))[0]?.engine, 'model-npu', 'from the next batch, on the NPU');
  assert.equal(started.length, 3);
  assert.ok(started[2].includes('--vitisai'));
});

test("AMD's NPU on an AMD PC: a compile that fails leaves the processor reading", async () => {
  const where = readyPlace('x64', m.VITISAI_PACK);
  const started: string[][] = [];
  const start = (args: string[], cwd: string) => (started.push(args), startFake(args, cwd));
  const amd = amdPrepare({ prepared: 0, error: 'the compiler ended' });
  const l = logs();
  const env = { KIT_OCR_NPU: 'vitisai', PROCESSOR_IDENTIFIER: 'AMD64 Family 26 Model 36 Stepping 0, AuthenticAMD' };
  const r = await m.modelReader({ env, arch: 'x64', home: where, start, prepare: amd.prepare, log: l.log });
  amd.open();
  await l.seen(/couldn't compile the text reader's model \(the compiler ended\): the model reads on the processor/);
  assert.equal((await r!.read([{ file: path.join(home, 'c.png'), scale: 1, orient: true }]))[0]?.engine, 'model-cpu');
  assert.equal((await m.modelReader({ env, arch: 'x64', home: where, start, prepare: amd.prepare }))?.engine, 'model-cpu');
  assert.equal(started.filter((a) => a.includes('--vitisai')).length, 1, 'the NPU not tried again for a while');
  assert.deepEqual(amd.calls, ['vitisai']);
});

test("AMD's compile: the program with --prepare and without --compiled-only, its answer found below the compiler's noise", async () => {
  const place = m.placeOf(readyPlace('x64', m.VITISAI_PACK), 'x64', m.VITISAI_PACK);
  const viaFake = ((_exe: string, args: readonly string[], opts: any) => spawnImpl(process.execPath, [fake, ...args], opts)) as typeof spawn;
  const p: any = await m.prepareReader(place, m.VITISAI_PACK, { exe: 'ocr-npu.exe', spawnImpl: viaFake });
  assert.equal(p.prepared, 1);
  assert.equal(p.atOnce, 3);
  assert.ok(p.args.includes('--prepare'));
  assert.ok(!p.args.includes('--compiled-only'));
  assert.equal(p.args[p.args.indexOf('--vitisai') + 1], place.pack);
  assert.ok(existsSync(path.join(place.cache, 'prepared')), 'run in the cache folder');
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
