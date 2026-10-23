import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { paced, until } from './until.ts';

// The NPU check (npu-check.ts): setup's steps timed, then the server measured, against a fake OpenVINO Model Server in
// this process. Nothing is downloaded or started, and no real config.json, server or lock is touched.
const home = mkdtempSync(path.join(tmpdir(), 'kit-npu-check-'));
process.env.REEVE_HOME = home;
delete process.env.REEVE_CONFIG;
delete process.env.ACCELERATORS_CONFIG;
delete process.env.ACCELERATORS_HOME;
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
after(() => rmSync(home, { recursive: true, force: true }));

const C = await import('./fixture/src/kit/npu-check.ts');
const V = await import('./fixture/src/kit/npu-vendors.ts');
const { parseDetection } = await import('./fixture/src/kit/detect.ts');
const { portablePath } = await import('./fixture/src/kit/setup.ts');
const { checkNpuReport } = await import('./fixture/src/kit/npu-report.ts');

const LUNAR = 'npu2|32.0.100.4239|2025-09-01|Intel Corporation|PCI\\VEN_8086&DEV_643E&SUBSYS_00000000&REV_04\\3&11583659&0&58|Intel(R) AI Boost';
const X64 = 'cpu|9|8|Intel(R) Core(TM) Ultra 7 258V\nram|34359738368\n';

/** A port nobody listens on. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** A fake OpenVINO Model Server: /v1/models, and chat that refuses a prompt past `cap` tokens (about 4 characters each). */
function fakeOvms(port: number, o: { cap: number; dieOverCap?: boolean; answer?: string }) {
  const seen: any[] = [];
  let server: Server | null = null;
  const start = async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov"}]}');
        const j = JSON.parse(body);
        seen.push(j);
        const prompt = j.messages.map((m: any) => m.content).join(' ');
        const promptTokens = Math.round(prompt.length / 4);
        if (promptTokens > o.cap) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `prompt of ${promptTokens} tokens is longer than max_prompt_len` }));
          if (o.dieOverCap) setImmediate(() => stop());
          return;
        }
        const completion = j.max_tokens > 100 ? 120 : 2;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: o.answer ?? '<think>\n\n</think>\n\nready' } }], usage: { prompt_tokens: promptTokens, completion_tokens: completion } }));
      });
    });
    await new Promise<void>((r) => server!.listen(port, '127.0.0.1', r));
  };
  const stop = async () => {
    if (!server) return;
    const s = server;
    server = null;
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  };
  return { seen, start, stop, starts: 0 };
}

/** The catalog on a free port, and a scratch tools home with the server's program and its C++ runtime "installed". */
async function scene(o: { cap?: number; dieOverCap?: boolean; answer?: string; embed?: boolean } = {}) {
  const port = await freePort();
  const catalog = structuredClone(V.NPU_CATALOG);
  catalog.routes.intel.port = port;
  if (o.cap) catalog.routes.intel.maxContextTokens = o.cap;
  delete catalog.routes.intel.models[0].pinned; // its pull is a fake that leaves no files to check
  // Its embedding server is measured in tests of its own.
  if (o.embed) delete (catalog.routes.intel.embedServer!.model as { pinned?: unknown }).pinned;
  else delete catalog.routes.intel.embedServer;
  const tools = mkdtempSync(path.join(home, 'tools-'));
  const exe = V.serverExe(catalog.routes.intel, tools);
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, '');
  for (const f of catalog.routes.intel.runtime!.files) writeFileSync(path.join(path.dirname(exe), f), '');
  const fake = fakeOvms(port, { cap: catalog.routes.intel.maxContextTokens, dieOverCap: o.dieOverCap, answer: o.answer });
  const ran: string[][] = [];
  const lines: string[] = [];
  const opts = {
    yes: true,
    tools,
    catalog,
    env: { ...process.env, REEVE_HOME: home },
    detection: parseDetection(`${X64}${LUNAR}\n`),
    out: path.join(tools, 'report.json'),
    log: (l: string) => lines.push(l),
    io: {
      setup: { run: async (_exe: string, args: string[]) => (ran.push(args), { code: 0, out: '' }) },
      // The route's own version installed: no server of this PC's is asked which it is.
      serverVersion: async (r: any) => r.version,
      start: async () => {
        fake.starts++;
        await fake.start();
        return { pid: 4242, stop: fake.stop };
      },
      memory: async () => ({ workingSetBytes: 3.2 * 1024 ** 3, privateBytes: 1.1 * 1024 ** 3 }),
      kitTest: async () => [] as string[],
    },
  };
  return { port, catalog, tools, exe, fake, ran, lines, opts };
}

test('the route on another device: OpenVINO gets its --target_device, and off the NPU loses --max_prompt_len, its NPU plugin settings and the NPU\'s prefix caching off; GenieX has no other', () => {
  const intel = V.NPU_CATALOG.routes.intel;
  const cpu = C.routeOnDevice(intel, 'cpu');
  assert.equal(cpu.serve[cpu.serve.indexOf('--target_device') + 1], 'CPU');
  assert.ok(!cpu.serve.includes('--max_prompt_len'));
  assert.ok(!cpu.serve.includes('--plugin_config'));
  assert.ok(intel.serve.includes('--enable_prefix_caching'));
  assert.ok(!cpu.serve.includes('--enable_prefix_caching'), "the CPU keeps OpenVINO's own prefix caching");
  assert.ok(!cpu.serve.includes('false'), 'and the flag goes with its value');
  assert.ok(!C.routeOnDevice(V.routeFor(intel, 'meteor-lake'), 'GPU').serve.includes('--plugin_config'), "the NPU 3720's prompt chunks stay on the NPU");
  assert.deepEqual(C.routeOnDevice(intel, 'NPU').serve, intel.serve);
  // Its embedding server, OpenVINO too, goes with it, and loses the NPU's fixed --max_length.
  const es = cpu.embedServer!.serve;
  assert.equal(es[es.indexOf('--target_device') + 1], 'CPU');
  assert.ok(!es.includes('--max_length') && es.includes('--pooling'));
  assert.deepEqual(C.routeOnDevice(intel, 'NPU').embedServer, intel.embedServer);
  // The NPU 3720's runs on the processor's graphics (its generation's embedArgs): checking the NPU leaves it there, with
  // its --max_length; checking the processor moves it with chat.
  const meteor = V.routeFor(intel, 'meteor-lake');
  assert.deepEqual(C.routeOnDevice(meteor, 'NPU').embedServer, meteor.embedServer);
  const onNpu = C.routeOnDevice(meteor, 'NPU').embedServer!.serve;
  assert.equal(onNpu[onNpu.indexOf('--target_device') + 1], 'GPU');
  const onCpu = C.routeOnDevice(meteor, 'CPU').embedServer!.serve;
  assert.equal(onCpu[onCpu.indexOf('--target_device') + 1], 'CPU');
  assert.throws(() => C.routeOnDevice(V.NPU_CATALOG.routes.qualcomm, 'CPU'), /NPU only/);
  assert.equal(C.routeOnDevice(V.NPU_CATALOG.routes.qualcomm, 'NPU'), V.NPU_CATALOG.routes.qualcomm);
});

test("the measurements compile in the check's own cache, emptied first: a first load is a compile, never the manor's warm cache", async () => {
  const intel = V.NPU_CATALOG.routes.intel;
  const own = C.checkServe(intel);
  const cache = (serve: string[]) => serve[serve.indexOf('--cache_dir') + 1];
  assert.equal(cache(own.serve), '{tools}\\models\\openvino\\.check-cache');
  assert.equal(cache(own.embedServer!.serve), cache(own.serve), 'its embedding server compiles there too');
  assert.equal(cache(intel.serve), '{tools}\\models\\openvino\\.npu-cache', "the route's own is left as it is");
  assert.equal(C.checkServe(V.NPU_CATALOG.routes.qualcomm).serve.includes('--cache_dir'), false, 'a server without one gets none');

  const s = await scene();
  const cleared: string[] = [];
  let startsBeforeClear = -1;
  const { code } = await C.npuCheck({ ...s.opts, io: { ...s.opts.io, clearCache: (dir: string) => (cleared.push(dir), (startsBeforeClear = s.fake.starts)) } });
  assert.equal(code, 0, s.lines.join('\n'));
  assert.deepEqual(cleared, [path.join(s.tools, 'models', 'openvino', '.check-cache')]);
  assert.equal(startsBeforeClear, 0, 'emptied before the first start');
});

test('a filler prompt is about the tokens asked for, each line its own', () => {
  const p = C.fillerPrompt(1000);
  assert.ok(p.length >= 4000 && p.length < 4200, String(p.length));
  assert.match(p, /Line 1:.*\nLine 2:/);
});

test('the arguments: --route, --device, --small-pc, --yes, --no-setup, --out; anything else is refused', () => {
  assert.deepEqual(C.parseCheckArgs(['--route', 'intel', '--device', 'cpu', '--yes', '--no-setup', '--out', 'r.json']), { vendor: 'intel', device: 'CPU', yes: true, setup: false, out: 'r.json' });
  assert.deepEqual(C.parseCheckArgs(['--small-pc']), { smallPc: true });
  assert.match((C.parseCheckArgs(['--route', 'nvidia']) as any).error, /--route takes/);
  assert.match((C.parseCheckArgs(['--device', 'tpu']) as any).error, /NPU, CPU or GPU/);
  assert.match((C.parseCheckArgs(['--fast']) as any).error, /unknown argument/);
});

test('on an Intel NPU: setup timed, every measurement taken, the report kept, and timeouts suggested from the numbers', async () => {
  const s = await scene({ cap: 1536 });
  const { code, report } = await C.npuCheck(s.opts);
  const by = Object.fromEntries(report.steps.map((x: any) => [x.step, x]));
  assert.deepEqual(report.steps.map((x: any) => x.step), ['detect', 'requirements', 'setup', 'start', 'first-answer', 'warm', 'speed', 'read', 'cap', 'two-at-once', 'memory', 'restart', 'kit-test']);
  assert.equal(code, 0, s.lines.join('\n'));
  assert.equal(report.ok, true);
  assert.equal(report.vendor, 'intel');
  assert.equal(report.rehearsal, false);
  assert.equal((report.npu as any).pciDevice, '643E');
  assert.equal((report.npu as any).generation, 'lunar-lake');
  // The model was pulled with OpenVINO's own command; nothing was downloaded (the program was there).
  assert.ok(s.ran.some((a) => a.includes('--pull') && a.includes('Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov')));
  assert.equal(by.setup.data.downloadBytes, V.NPU_CATALOG.routes.intel.models[0].size);
  // Qwen3-4B-Instruct-2507 doesn't think, so isn't told /no_think; a think block (the fake writes one) is stripped all the same.
  assert.doesNotMatch(s.fake.seen[0].messages.at(-1).content, /\/no_think/);
  assert.match(by['first-answer'].say, /answered "ready" \(with an empty think block, stripped\)/);
  // Under the cap answers; past it is refused plainly, and the server keeps answering.
  assert.equal(by.cap.ok, true);
  assert.deepEqual(by.cap.data.tried.map((t: any) => [t.ok, t.status, t.stillUp]), [[true, 200, true], [false, 400, true]]);
  assert.equal(by.memory.data.workingSetBytes, 3.2 * 1024 ** 3);
  assert.equal(s.fake.starts, 2, 'a first start, and a start again from the cache');
  assert.ok(report.suggest?.timeouts.requestPerTokenMs! > 0);
  assert.ok(report.suggest?.timeouts.requestBaseMs! >= 10_000);
  assert.ok(report.suggest?.timeouts.coldLoadMs! >= 30_000);
  assert.equal(report.suggest?.maxContextTokens, undefined);
  const kept = JSON.parse(readFileSync(s.opts.out, 'utf8'));
  assert.equal(kept.steps.length, 13);
  assert.ok(s.lines.some((l) => l.startsWith('Suggested for npu-vendors.json')));
  assert.ok(!existsSync(path.join(s.tools, 'npu-report.json')), 'a given detection keeps no NPU report unless asked to');
});

test("the NPU's report (npu-report.ts): kept after a check on this PC's NPU, with its numbers and the route as the catalog has it; none for a rehearsal or a check that never reached the NPU", async () => {
  const s = await scene();
  const file = path.join(s.tools, 'acc', 'npu-report.json');
  const { code, report } = await C.npuCheck({ ...s.opts, npuReportFile: file, app: 'manor 0.16.200' });
  assert.equal(code, 0, s.lines.join('\n'));
  assert.ok(existsSync(file), s.lines.join('\n'));
  const r = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(checkNpuReport(r), []);
  assert.equal(r.source, 'npu-check');
  assert.equal(r.app, 'manor 0.16.200');
  assert.equal(r.day, report.at.slice(0, 10));
  assert.deepEqual(r.chip, { ...r.chip, vendor: 'intel', generation: 'lunar-lake', pciDevice: '643E', driver: '32.0.100.4239', driverDate: '2025-09-01', ramGb: 32 });
  assert.match(r.chip.cpu, /Ultra 7 258V$/);
  assert.match(r.chip.npu, /AI Boost$/);
  const intel = V.routeFor(V.NPU_CATALOG.routes.intel, 'lunar-lake');
  assert.deepEqual(r.route, { server: intel.server, version: intel.version, model: 'Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov', cap: intel.maxContextTokens, verified: true });
  assert.equal(r.ok, true);
  assert.equal(r.failed, null);
  const by = Object.fromEntries(report.steps.map((x: any) => [x.step, x]));
  assert.equal(r.speeds.coldMs, by['first-answer'].data.loadMs);
  assert.equal(r.speeds.warmMs, by.warm.ms);
  // The fake answers at once: a speed past what any NPU writes is left out, not the report.
  const tps = by.speed.data.tokensPerSecond;
  assert.equal(r.speeds.tokensPerSecond, tps > 100_000 ? null : Math.round(tps * 100) / 100);
  assert.equal(r.speeds.readTokens, by.read.data.promptTokens);
  // The reporter: random, made once beside it, and the same for the next report.
  const id = JSON.parse(readFileSync(path.join(s.tools, 'acc', 'npu-reporter.json'), 'utf8')).id;
  assert.equal(r.reporter, id);
  assert.match(id, /^[0-9a-f-]{36}$/);

  // A server that dies past its cap: the report says the cap failed.
  const d = await scene({ cap: 1536, dieOverCap: true });
  const dFile = path.join(d.tools, 'npu-report.json');
  await C.npuCheck({ ...d.opts, npuReportFile: dFile });
  assert.ok(existsSync(dFile), d.lines.join('\n'));
  const dr = JSON.parse(readFileSync(dFile, 'utf8'));
  assert.equal(dr.ok, false);
  assert.deepEqual(dr.failed, { step: 'cap' });
  assert.equal(dr.reporter, JSON.parse(readFileSync(path.join(d.tools, 'npu-reporter.json'), 'utf8')).id);

  // An NPU this kit can't use stops at detection, before the NPU: no report from the check (setup's says so).
  const o = await scene();
  const oFile = path.join(o.tools, 'npu-report.json');
  await C.npuCheck({ ...o.opts, npuReportFile: oFile, detection: parseDetection(`${X64}${LUNAR.replace('32.0.100.4239', '31.0.100.2016')}\n`) });
  assert.ok(!existsSync(oFile));
});

test("a route's power tool (AMD's xrt-smi, for FastFlowLM): its run noted after setup, never failed and never timed as setup, so the reports count the PCs where it can't start", async () => {
  const s = await scene({ cap: 1536 });
  // Intel's route given AMD's power tool, here a file in the scene's tools home, that ends as xrt-smi does beside an older driver's DLLs.
  const exe = path.join(s.tools, 'AMD', 'xrt-smi.exe');
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, '');
  s.catalog.routes.intel.powerTool = { ...V.NPU_CATALOG.routes.amd.powerTool!, exe };
  const run = (code: number) => async (e: string, args: string[]) => (e === exe ? (s.ran.push(['power', ...args]), { code, out: '' }) : (s.ran.push(args), { code: 0, out: '' }));
  const { code, report } = await C.npuCheck({ ...s.opts, io: { ...s.opts.io, setup: { run: run(0xc0000139) } } });
  assert.equal(code, 0, s.lines.join('\n'));
  assert.deepEqual(report.steps.map((x: any) => x.step).slice(0, 5), ['detect', 'requirements', 'setup', 'power-tool', 'start']);
  const power = report.steps.find((x: any) => x.step === 'power-tool')!;
  assert.equal(power.ok, null);
  assert.match(power.say, /^xrt-smi\.exe couldn't start \(exit 0xC0000139\): OpenVINO Model Server can't set the NPU's power mode, so the NPU runs at its default mode; an older AMD NPU driver left its files/);
  assert.deepEqual(power.data, { exe, missing: false, code: 3221225785, broken: true });
  assert.deepEqual(s.ran.filter((a) => a[0] === 'power'), [['power', 'examine']], 'run once, read only');
  assert.equal((report.steps.find((x: any) => x.step === 'setup')!.data!.timed as Record<string, number>).install, undefined, 'not timed as an install');

  const fine = await scene({ cap: 1536 });
  fine.catalog.routes.intel.powerTool = { ...V.NPU_CATALOG.routes.amd.powerTool!, exe };
  const ok = await C.npuCheck({ ...fine.opts, io: { ...fine.opts.io, setup: { run: async () => ({ code: 0, out: '' }) } } });
  assert.match(ok.report.steps.find((x: any) => x.step === 'power-tool')!.say, /^xrt-smi\.exe ran: OpenVINO Model Server can set the NPU's power mode$/);
  const gone = await scene({ cap: 1536 });
  gone.catalog.routes.intel.powerTool = { ...V.NPU_CATALOG.routes.amd.powerTool!, exe: path.join(gone.tools, 'AMD', 'xrt-smi.exe') };
  const missing = await C.npuCheck(gone.opts);
  assert.match(missing.report.steps.find((x: any) => x.step === 'power-tool')!.say, /^xrt-smi\.exe isn't on this PC/);
});

test("a route's own embedding server: set up beside the server, started by the kit, a query and a chunk timed warm, then stopped", async () => {
  const s = await scene({ cap: 1536 });
  // The Intel route given an embedding server of its own, as Qualcomm's has, on a port of its own.
  const ePort = await freePort();
  const q = V.NPU_CATALOG.routes.qualcomm.embedServer!;
  s.catalog.routes.intel.embedServer = { ...structuredClone(q), port: ePort };
  const got: string[] = [];
  let embedServer: Server | null = null;
  const inputs: string[] = [];
  const startEmbed = async () => {
    embedServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"qwen3-embedding-0.6b-gguf"}]}');
        inputs.push(JSON.parse(body).input);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.01) }] }));
        // The kit's started record would name it for the check to stop; this fake stops after the two it times.
        if (inputs.length === 2) setImmediate(() => (embedServer!.closeAllConnections(), embedServer!.close()));
      });
    });
    await new Promise<void>((r) => embedServer!.listen(ePort, '127.0.0.1', r));
  };
  const opts = {
    ...s.opts,
    io: {
      ...s.opts.io,
      setup: {
        ...s.opts.io.setup,
        download: async (d: { what: string }) => void got.push(`download ${d.what}`),
        unpack: (_zip: string, into: string) => {
          got.push('unpack');
          mkdirSync(into, { recursive: true });
          writeFileSync(path.join(into, 'llama-server.exe'), '');
        },
        overlay: (_from: string, _into: string, files: string[]) => (got.push(`overlay ${files.length}`), files.length),
      },
      embedTest: async () => (await startEmbed(), [] as string[]),
    },
  };
  const { code, report } = await C.npuCheck(opts);
  assert.equal(code, 0, s.lines.join('\n'));
  assert.deepEqual(report.steps.map((x: any) => x.step).slice(-2), ['kit-test', 'embed']);
  assert.deepEqual(got, ['download llama-b11125-bin-win-opencl-adreno-arm64.zip', 'unpack', 'overlay 13', 'download Qwen3-Embedding-0.6B-Q8_0.gguf']);
  const embed = report.steps.at(-1) as any;
  assert.equal(embed.ok, true);
  assert.equal(embed.data.dims, 1024);
  assert.equal(typeof embed.data.queryMs, 'number');
  assert.match(embed.say, /the kit started llama\.cpp and had a vector in .* a query took \d+ ms and a chunk of code \d+ ms \(1024 dimensions\)/);
  assert.equal(inputs[0], 'where is the push notification token registered');
  assert.ok(inputs[1].length > 1500, 'a chunk about the size Reeve indexes');
  assert.equal(report.steps.find((x: any) => x.step === 'setup')!.data!.downloadBytes, V.NPU_CATALOG.routes.intel.models[0].size + q.download!.size + q.model.size);
});

test("Intel's embedding server: a second OpenVINO Model Server, nothing downloaded for it but its model, which it pulls", async () => {
  const s = await scene({ cap: 1536, embed: true });
  const ePort = await freePort();
  s.catalog.routes.intel.embedServer!.port = ePort;
  let embedServer: Server | null = null;
  const inputs: string[] = [];
  const startEmbed = async () => {
    embedServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov"}]}');
        inputs.push(JSON.parse(body).input);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.01) }] }));
        if (inputs.length === 2) setImmediate(() => (embedServer!.closeAllConnections(), embedServer!.close()));
      });
    });
    await new Promise<void>((r) => embedServer!.listen(ePort, '127.0.0.1', r));
  };
  const downloads: string[] = [];
  const opts = { ...s.opts, io: { ...s.opts.io, setup: { ...s.opts.io.setup, download: async (d: { what: string }) => void downloads.push(d.what) }, embedTest: async () => (await startEmbed(), [] as string[]) } };
  const { code, report } = await C.npuCheck(opts);
  assert.equal(code, 0, s.lines.join('\n'));
  assert.deepEqual(report.steps.map((x: any) => x.step).slice(-2), ['kit-test', 'embed']);
  assert.deepEqual(downloads, [], 'the program is the route\'s, already here');
  assert.ok(s.ran.some((a) => a.includes('--pull') && a.includes('OpenVINO/Qwen3-Embedding-0.6B-int4-cw-ov') && a.includes('embeddings')), JSON.stringify(s.ran));
  const embed = report.steps.at(-1) as any;
  assert.equal(embed.ok, true);
  assert.match(embed.say, /the kit started OpenVINO Model Server and had a vector in .* \(1024 dimensions\)/);
  assert.equal(report.steps.find((x: any) => x.step === 'setup')!.data!.downloadBytes, V.NPU_CATALOG.routes.intel.models[0].size + V.NPU_CATALOG.routes.intel.embedServer!.model.size);
});

test('a server that dies on a request past its cap fails the cap step, and is started again for the rest', async () => {
  const s = await scene({ cap: 1536, dieOverCap: true });
  const { code, report } = await C.npuCheck(s.opts);
  const cap = report.steps.find((x: any) => x.step === 'cap')!;
  assert.equal(cap.ok, false);
  assert.match(cap.say, /the server stopped answering/);
  assert.equal(code, 1);
  assert.equal(report.steps.find((x: any) => x.step === 'two-at-once')!.ok, true, 'measured after a start again');
});

test('a rehearsal of another maker’s route needs a scratch REEVE_HOME; a missing C++ runtime is put beside the server, with no administrator', async () => {
  const s = await scene();
  const env: NodeJS.ProcessEnv = { ...s.opts.env };
  delete env.REEVE_HOME;
  const noHome = await C.npuCheck({ ...s.opts, env, vendor: 'intel', device: 'CPU', detection: parseDetection('cpu|12|12|Snapdragon(R) X2 Elite\nram|34359738368\n') });
  assert.equal(noHome.code, 2);
  assert.match(noHome.report.steps.at(-1)!.say, /scratch home/);

  // A server set up before the runtime was carried: its msvcp140.dll isn't beside it, so setup brings Microsoft's.
  const rt = s.catalog.routes.intel.runtime!;
  const dir = path.dirname(s.exe);
  rmSync(path.join(dir, 'msvcp140.dll'));
  const got: string[] = [];
  const setup = {
    ...s.opts.io.setup,
    download: async (d: { what: string }) => void got.push(d.what),
    unpack: (_zip: string, into: string) => {
      mkdirSync(path.join(into, rt.from), { recursive: true });
      for (const f of rt.files) writeFileSync(path.join(into, rt.from, f), 'from Microsoft');
    },
  };
  const r = await C.npuCheck({ ...s.opts, io: { ...s.opts.io, setup } });
  assert.match(r.report.steps.find((x: any) => x.step === 'requirements')!.say, /needs the Microsoft Visual C\+\+ runtime 14\.44, which setup puts beside it \(3 MB, no administrator\)/);
  assert.deepEqual(got, [rt.file]);
  for (const f of rt.files) assert.equal(readFileSync(path.join(dir, f), 'utf8'), 'from Microsoft', f);
  assert.equal(r.report.steps.find((x: any) => x.step === 'setup')!.data!.downloadBytes, rt.size + s.catalog.routes.intel.models[0].size);
  assert.equal(r.code, 0, s.lines.join('\n'));
});

test('no download without --yes; an unsupported NPU stops at detection', async () => {
  const s = await scene();
  const r = await C.npuCheck({ ...s.opts, yes: false });
  assert.equal(r.code, 1);
  assert.match(r.report.steps.at(-1)!.say, /run again with --yes/);
  const old = await C.npuCheck({ ...s.opts, detection: parseDetection(`${X64}${LUNAR.replace('32.0.100.4239', '31.0.100.2016')}\n`) });
  assert.equal(old.code, 1);
  assert.match(old.report.steps[0].say, /needs Intel's NPU driver/);
  assert.ok(existsSync(s.opts.out));
});

test("the server is started from its entry's command with its %VARIABLES% expanded, as setup writes %USERPROFILE%\\... paths", async () => {
  // Found on a Lunar Lake (2026-10-12): the check spawned "%USERPROFILE%\...\ovms.exe" as written, and nothing started.
  const dir = path.join(home, 'started');
  mkdirSync(dir, { recursive: true });
  process.env.NPU_CHECK_TEST_NODE = path.dirname(process.execPath);
  const mark = path.join(dir, 'ran');
  const entry = { id: 'npu', chat: { baseUrl: 'http://127.0.0.1:1', model: 'm', startCommand: [`%NPU_CHECK_TEST_NODE%\\${path.basename(process.execPath)}`, '-e', `require('fs').writeFileSync(${JSON.stringify(mark)}, 'ok')`] } };
  const s = await C.startServer(entry as any, path.join(dir, 'server.log'));
  for (let i = 0; i < paced(200) && !existsSync(mark); i++) await new Promise((r) => setTimeout(r, 25));
  await s.stop();
  delete process.env.NPU_CHECK_TEST_NODE;
  assert.equal(existsSync(mark), true, readFileSync(path.join(dir, 'server.log'), 'utf8'));
});

test("on Windows, the check's and the benchmark's server starts apart, in the servers' capped job, as an agent's does (kit 2.78.7)", { skip: process.platform !== 'win32' }, async () => {
  // Found by the AMD Dev Manager (2026-10-16): startServer was a plain detached child, so npu-check and npu-bench measured
  // a server outside the servers' job. This one keeps every processor busy for 3 s, then writes its process id and the
  // processor time it had against the PC's in that time, and waits to be stopped.
  const { alive } = await import('./fixture/src/kit/apart.ts');
  const dir = path.join(home, 'apart');
  mkdirSync(dir, { recursive: true });
  const said = path.join(dir, 'burned.json');
  const burn = [
    'const { Worker } = require("worker_threads"); const os = require("os"); const t0 = Date.now(); const n = os.availableParallelism(); console.log("up");',
    'const spin = "const end = Date.now() + 3000; let x = 0; while (Date.now() < end) x = (x * 31 + 7) % 1000003;";',
    'let left = n; for (let i = 0; i < n; i++) new Worker(spin, { eval: true }).on("exit", () => { if (--left) return;',
    '  const u = process.cpuUsage(); require("fs").writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, share: (u.user + u.system) / ((Date.now() - t0) * 1000 * n) })); });',
    'setTimeout(() => {}, 60000);',
  ].join(' ');
  const entry = { id: 'npu', chat: { baseUrl: 'http://127.0.0.1:1', model: 'm', startCommand: [process.execPath, '-e', burn, said] } };
  const before = { KIT_APART: process.env.KIT_APART, KIT_APART_CAP: process.env.KIT_APART_CAP, KIT_APART_JOB_NAME: process.env.KIT_APART_JOB_NAME };
  Object.assign(process.env, { KIT_APART: '1', KIT_APART_CAP: '1000', KIT_APART_JOB_NAME: `kit-test-npu-apart-${process.pid}` });
  let s: Awaited<ReturnType<typeof C.startServer>>;
  try {
    s = await C.startServer(entry as any, path.join(dir, 'server.log'));
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  try {
    assert.ok(s.pid && s.pid > 0, 'its process id');
    await until(() => existsSync(said) && readFileSync(said, 'utf8'), 60_000, 'the server to have burned its 3 s');
    const burned = JSON.parse(readFileSync(said, 'utf8'));
    assert.equal(burned.pid, s.pid, "the pid answered is the server's own, not the launcher's, so stop() stops it");
    // The job's cap is a tenth of the PC here; a server outside it (a plain child) would take most of it.
    assert.ok(burned.share <= 0.14, `${(100 * burned.share).toFixed(1)}% of the processor, not past the job's 10%`);
    assert.match(readFileSync(path.join(dir, 'server.log'), 'utf8'), /up/, 'its output in the log');
  } finally {
    await s.stop();
  }
  await until(() => !alive(s.pid!), 10_000, 'the server to have stopped');
});

test('a model that answers nonsense on the NPU fails the check at its first answer, as setup refuses it', async () => {
  // OpenVINO's Qwen3-4B INT4 export on a Lunar Lake NPU (2026-10-12): it loads, answers fast, and says nothing.
  const s = await scene({ cap: 1536, answer: '?option?option?option?option' });
  const { code, report } = await C.npuCheck(s.opts);
  const last = report.steps.at(-1) as any;
  assert.equal(code, 1);
  assert.equal(last.step, 'first-answer');
  assert.equal(last.ok, false);
  assert.match(last.say, /not "ready" as asked: the model doesn't run properly on this NPU/);
  const { saysReady } = await import('./fixture/src/kit/setup.ts');
  assert.deepEqual(['<think>\n\n</think>\n\nready', 'Ready.', '?option?option', 'hydrated hydrated', '<think>ready'].map(saysReady), [true, true, false, false, false]);
});
test("FastFlowLM up without its model: /api/ps says it holds none, the log says why, and an answer that is only an error keeps its words", async () => {
  const S = await import('./fixture/src/kit/npu-server.ts');
  // FastFlowLM 1.0.7 on an XDNA 2 that couldn't hold its model (2026-10-15): its port open, every model listed.
  let holds = false;
  const port = await freePort();
  const flm = createServer((req, res) => {
    if (req.url === '/api/ps') return res.writeHead(200, { 'content-type': 'application/json' }).end(holds ? '{"models":[{"name":"qwen3-it:4b"}]}' : '{"error":"[json.exception.invalid_iterator.207] cannot use key() for non-object iterators"}');
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"qwen3-it:4b"}]}');
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(holds ? '{"choices":[{"message":{"content":"ready"}}]}' : '{"error":"Failed to load qwen3-it:4b model!"}'));
  });
  await new Promise<void>((r) => flm.listen(port, '127.0.0.1', r));
  const acc = (exe: string) => ({ id: 'npu', kind: 'npu', name: 'NPU', slots: 1, maxContextTokens: 4096, quirks: [], chat: { baseUrl: `http://127.0.0.1:${port}`, model: 'qwen3-it:4b', startCommand: [exe, 'serve', 'qwen3-it:4b'] } }) as any;
  try {
    const c = S.serverClient(acc('C:\\tools\\servers\\fastflowlm-1.0.7\\flm.exe'));
    assert.equal(await c.answers(), true, '/v1/models answers either way');
    assert.equal(await c.loaded(), false);
    const a = await c.ask('Reply with the single word: ready', 16, 5000);
    assert.equal(a.ok, false);
    assert.match(a.error!, /Failed to load qwen3-it:4b model/, 'its words, not "null"');
    holds = true;
    assert.equal(await c.loaded(), true);
    assert.equal((await c.ask('Reply with the single word: ready', 16, 5000)).answer, 'ready');
    assert.equal(await S.serverClient(acc('C:\\servers\\ovms.exe')).loaded(), null, "a server that doesn't say");
  } finally {
    flm.closeAllConnections();
    await new Promise((r) => flm.close(r));
  }
  // What it prints, from where the check's start began (the log is appended to across runs).
  const log = path.join(home, 'flm-load.log');
  writeFileSync(log, '[ERROR]  Failed to load model: an older run\n');
  const from = S.logLength(log);
  writeFileSync(log, '[FLM]  Loading model: C:\\Users\\x\\.flm\\models\\Qwen3-4B-Instruct-2507-NPU2\n[XRT] ERROR: Failed to submit command to hw queue (0xc01e0200):\n[ERROR]  Failed to load model: Failed to submit command to hw queue (0xc01e0200):\n[Error]  Failed to load default model: qwen3-it:4b\n', { flag: 'a' });
  assert.equal(S.loadFailure(log, from), 'Failed to submit command to hw queue (0xc01e0200)');
  assert.equal(S.loadFailure(log, S.logLength(log)), null);
  assert.equal(S.loadFailure(path.join(home, 'no-such.log')), null);
  assert.equal(S.logLength(path.join(home, 'no-such.log')), 0);
});

test("setup's test request asks about the picture first and chat last, so a server holding one model at a time is left holding chat; a model that didn't load fails it in its own words", async () => {
  const { testNpuEntry } = await import('./fixture/src/kit/setup.ts');
  // FastFlowLM: one model held, a switch on demand; `loads` false makes every load fail, as on a PC that can't hold it.
  let held = 'qwen3-it:4b';
  let loads = true;
  const asked: string[] = [];
  const port = await freePort();
  const flm = createServer((req, res) => {
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"qwen3-it:4b"},{"id":"qwen3vl-it:4b"}]}');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const model = JSON.parse(raw).model;
      asked.push(model);
      if (!loads) return res.writeHead(200, { 'content-type': 'application/json' }).end(`{"error":"Failed to load ${model} model!"}`);
      held = model;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: model === 'qwen3vl-it:4b' ? 'Red' : 'ready' } }] }));
    });
  });
  await new Promise<void>((r) => flm.listen(port, '127.0.0.1', r));
  const entry = { id: 'npu', name: 'NPU', chat: { baseUrl: `http://127.0.0.1:${port}`, model: 'qwen3-it:4b', startCommand: ['C:\\nowhere\\flm.exe', 'serve', 'qwen3-it:4b'] }, vision: { model: 'qwen3vl-it:4b' } } as any;
  const dir = mkdtempSync(path.join(home, 'test-image-'));
  try {
    assert.deepEqual(await testNpuEntry(entry, { dir, timeoutMs: paced(10_000) }), []);
    assert.deepEqual(asked, ['qwen3vl-it:4b', 'qwen3-it:4b']);
    assert.equal(held, 'qwen3-it:4b', 'left holding the chat model');
    loads = false;
    const problems = await testNpuEntry(entry, { dir, timeoutMs: paced(10_000) });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /failed \(200\).*Failed to load qwen3vl-it:4b model/);
  } finally {
    flm.closeAllConnections();
    await new Promise((r) => flm.close(r));
  }
});

// ------------------------------------------------------------------------------------------------
// The report's generation and its patch; --harden, setup's failures forced and its calibration checked

const ARROW_S = 'npu2|32.0.100.4023|2025-05-01|Intel Corporation|PCI\\VEN_8086&DEV_AD1D&SUBSYS_0B0A1028&REV_04\\3&11583659&0&58|Intel(R) AI Boost';
const ARROW_S_CPU = 'cpu|9|24|Intel(R) Core(TM) Ultra 9 285K\nram|34359738368\n';

test('the arguments: --generation names a rehearsal\'s generation, --harden runs the hardening', () => {
  assert.deepEqual(C.parseCheckArgs(['--route', 'intel', '--device', 'CPU', '--generation', 'meteor-lake', '--harden']), { vendor: 'intel', device: 'CPU', generation: 'meteor-lake', harden: true });
  assert.match((C.parseCheckArgs(['--generation']) as any).error, /--generation takes/);
});

test('the report names the generation, and on one not yet verified, every step passing gives the patch that verifies it', async () => {
  // Lunar Lake: verified already, so nothing to change.
  const lunar = await scene({ cap: 1536 });
  const l = await C.npuCheck(lunar.opts);
  assert.equal(l.report.generation, 'lunar-lake');
  assert.equal(l.report.patch, null);
  assert.ok(lunar.lines.some((x) => /lunar-lake is verified already/.test(x)), lunar.lines.join('\n'));

  // An Arrow Lake-S (NPU 3720, not yet measured): its starting values run (a 2048-token prompt), and its patch flips it to verified.
  const s = await scene({ cap: 2048 });
  const { code, report } = await C.npuCheck({ ...s.opts, detection: parseDetection(`${ARROW_S_CPU}${ARROW_S}\n`) });
  assert.equal(code, 0, s.lines.join('\n'));
  assert.equal(report.generation, 'arrow-lake');
  assert.deepEqual(s.ran.find((a) => a.includes('--pull')) !== undefined, true);
  const g = (report.patch as any).routes.intel.generations['arrow-lake'];
  assert.equal(g.verified, true);
  assert.deepEqual(g.timeouts, { ...V.NPU_CATALOG.routes.intel.generations['arrow-lake'].timeouts, ...report.suggest!.timeouts });
  assert.match(g.basis, /^Measured by the NPU check on Intel Core Ultra 9 285K, NPU driver 32\.0\.100\.4023, \d{4}-\d\d-\d\d, every step passing/);
  assert.equal(JSON.parse(readFileSync(s.opts.out, 'utf8')).patch.routes.intel.generations['arrow-lake'].verified, true, 'kept in the JSON report');
  assert.ok(s.lines.some((x) => /^The change to npu-vendors.json this run supports \(it flips arrow-lake to verified\)/.test(x)), s.lines.join('\n'));
});

test('the patch: none for a rehearsal, a failed step, a verified generation; a cap that failed under the route\'s goes in with it', () => {
  const route = V.NPU_CATALOG.routes.intel;
  const base = { vendor: 'intel' as const, generation: 'panther-lake', rehearsal: false, steps: [{ step: 'detect', ok: true, say: '' }], suggest: { timeouts: { requestBaseMs: 20_000 }, why: ['measured'] }, route, pc: 'Intel(R) Core(TM) Ultra X7 358H', driver: '32.0.100.5540', at: '2026-11-02T10:00:00.000Z' };
  assert.equal(C.checkPatch({ ...base, rehearsal: true }), null);
  assert.equal(C.checkPatch({ ...base, steps: [{ step: 'cap', ok: false, say: '' }] }), null);
  assert.equal(C.checkPatch({ ...base, generation: 'lunar-lake' }), null);
  assert.equal(C.checkPatch({ ...base, generation: null }), null);
  const p = C.checkPatch({ ...base, suggest: { timeouts: {}, maxContextTokens: 3072, why: ['4096 tokens failed'] } }) as any;
  const g = p.routes.intel.generations['panther-lake'];
  assert.deepEqual([g.verified, g.maxContextTokens, g.caps, g.args['--max_prompt_len']], [true, 3072, { chat: 3072 }, '3072']);
  assert.equal(g.basis, 'Measured by the NPU check on Intel(R) Core(TM) Ultra X7 358H, NPU driver 32.0.100.5540, 2026-11-02, every step passing: 4096 tokens failed.');
});

// An Intel NPU whose PCI id npu-vendors.json doesn't list yet (a generation after Wildcat Lake, say), with the driver
// the newest ones it knows need.
const INTEL_NEW = 'npu2|32.0.100.5540|2026-08-28|Intel Corporation|PCI\\VEN_8086&DEV_ABCD&SUBSYS_00000000&REV_04\\3&11583659&0&58|Intel(R) AI Boost';

test("an NPU of a generation setup doesn't know: its PCI id printed ready for devices, run on the most cautious values, and every step passing gives the patch that adds it", async () => {
  const s = await scene({ cap: 2048 });
  const { code, report } = await C.npuCheck({ ...s.opts, detection: parseDetection(`${X64}${INTEL_NEW}\n`) });
  assert.equal(code, 0, s.lines.join('\n'));
  assert.equal(report.generation, V.UNKNOWN_GENERATION);
  const detect = report.steps.find((x) => x.step === 'detect')!;
  assert.match(detect.say, /^Intel AI Boost \(Intel NPU of a generation setup doesn't know yet, device ABCD\), device ABCD, driver 32\.0\.100\.5540 of 2026-08-28: the manor can use it on guessed values, the most cautious its route has$/);
  assert.deepEqual(detect.data!.unknownDevice, { vendor: 'intel', pciDevice: 'ABCD', devices: { intel: { ABCD: 'intel-abcd' } } });
  assert.ok(s.lines.includes(`npu-vendors.json doesn't know device ABCD: add it to devices, under the generation it is (one it has, or the new one this check's patch adds when every step passes): {"devices":{"intel":{"ABCD":"intel-abcd"}}}`), s.lines.join('\n'));
  // Its cap: the NPU 3720's, the smallest Intel's route has, compiled so (the fake refuses past it, as OpenVINO does).
  const cap = report.steps.find((x) => x.step === 'cap')!;
  assert.equal(cap.ok, true, cap.say);
  const p = report.patch as any;
  assert.deepEqual(p.devices, { intel: { ABCD: 'intel-abcd' } });
  const g = p.routes.intel.generations['intel-abcd'];
  const guessed = V.unknownGeneration(s.catalog.routes.intel)!;
  assert.deepEqual([g.label, g.supported, g.verified, g.maxContextTokens, g.args['--max_prompt_len'], g.driverMin], ['Intel NPU, device ABCD', true, true, 2048, '2048', '32.0.100.5540']);
  assert.deepEqual(g.timeouts, { ...guessed.timeouts, ...report.suggest!.timeouts });
  assert.match(g.basis, /^Measured by the NPU check on Intel Core Ultra 7 258V, NPU driver 32\.0\.100\.5540, \d{4}-\d\d-\d\d, every step passing, on the most cautious of the route's values \(its cap, memory and driver minimum unmeasured\)/);
  assert.ok(s.lines.some((x) => /^The change to npu-vendors.json this run supports \(it adds device ABCD to devices as a new generation, intel-abcd, verified on this NPU/.test(x)), s.lines.join('\n'));
});

test("the patch for an NPU setup doesn't know: a new generation for its PCI id; none for a Snapdragon (told by its name), a rehearsal or a failed step", () => {
  const route = V.NPU_CATALOG.routes.amd;
  const base = { vendor: 'amd' as const, generation: V.UNKNOWN_GENERATION, rehearsal: false, steps: [{ step: 'detect', ok: true, say: '' }], suggest: { timeouts: { requestBaseMs: 25_000 }, why: ['measured'] }, route, pc: 'AMD Ryzen AI 7 450', driver: '32.0.20101.3760', device: '17F1', at: '2026-11-02T10:00:00.000Z' };
  const p = C.checkPatch(base) as any;
  assert.deepEqual(p.devices, { amd: { '17F1': 'amd-17f1' } });
  const g = p.routes.amd.generations['amd-17f1'];
  assert.deepEqual([g.label, g.verified, g.maxContextTokens, g.caps, g.timeouts], ['AMD NPU, device 17F1', true, 4096, { chat: 4096, vision: 4096 }, { ...route.timeouts, requestBaseMs: 25_000 }]);
  assert.equal(C.checkPatch({ ...base, device: null }), null);
  assert.equal(C.checkPatch({ ...base, rehearsal: true }), null);
  assert.equal(C.checkPatch({ ...base, steps: [{ step: 'first-answer', ok: false, say: '' }] }), null);
  // A Snapdragon's ACPI id has a DEV_ too, but its generation is told by its name, in code.
  const snapdragon = { vendor: 'qualcomm' as const, deviceId: 'ACPI\\VEN_QCOM&DEV_0FF0&SUBSYS_CRD08480&REV_0056\\2&DABA3FF&0', name: 'Snapdragon X3 Elite - X3E96100 - Qualcomm Hexagon NPU' };
  assert.equal(C.unknownDevice(snapdragon).devices, null);
  assert.match(C.unknownDeviceSay(snapdragon), /no PCI id: a Snapdragon's generation is told by its name \("Snapdragon X3 Elite - X3E96100 - Qualcomm Hexagon NPU"\), in npu-vendors\.ts' npuGeneration/);
  assert.equal(C.unknownDevice({ vendor: 'amd', deviceId: 'PCI\\VEN_1022&DEV_17f1&REV_10', name: 'NPU Compute Accelerator Device' }).devices!.amd['17F1'], 'amd-17f1');
});

test('a server just stopped holds its port a moment: it is gone only once a connection is refused, never on a timeout or a reset', async () => {
  const S = await import('./fixture/src/kit/npu-server.ts');
  // GenieX killed on the X2 Elite (2026-10-15): gone in 71 ms, its port bound about 2 s more, timing requests out for
  // the first second, then resetting them, then refusing. A restart in that time couldn't bind the port.
  const port = await freePort();
  const sockets: import('node:net').Socket[] = [];
  let seen = 0;
  const held = net.createServer((sock) => {
    sockets.push(sock);
    seen++;
    if (seen === 1) return; // taken, never answered: the request times out
    sock.resetAndDestroy(); // then reset
    if (seen === 3) held.close(); // then refused
  });
  await new Promise<void>((r) => held.listen(port, '127.0.0.1', r));
  try {
    const c = S.serverClient({ id: 'npu', kind: 'npu', name: 'NPU', slots: 1, maxContextTokens: 2400, quirks: [], chat: { baseUrl: `http://127.0.0.1:${port}`, model: 'm' } } as any);
    assert.equal(await c.untilGone(), true);
    assert.equal(seen, 3, 'a timeout and two resets, each taken for a port still held');
    assert.equal(await c.listening(), false);
  } finally {
    for (const s of sockets) s.destroy();
  }
  // What a refused connection looks like to each way the kit asks: Node's fetch (its cause) and longFetch (node:http).
  const failure = async (f: () => Promise<unknown>) => f().then(() => null, (e) => e);
  assert.equal(S.refusedConnection(await failure(() => fetch(`http://127.0.0.1:${port}/v1/models`))), true);
  assert.equal(S.refusedConnection(await failure(() => S.longFetch(`http://127.0.0.1:${port}/v1/models`))), true);
  assert.equal(S.refusedConnection(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), false);
  assert.equal(S.refusedConnection(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), false);
  assert.equal(S.refusedConnection(new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ECONNREFUSED' })])), true);
  assert.equal(S.refusedConnection(new Error('something else')), false);
});

/** --harden on the scene: its test requests answered by `answers` (by case), setup's measuring by `measured`. */
async function harden(answers: Record<string, string[]>, measured: { warmMs: number; tokensPerSecond: number } | null, more: Record<string, unknown> = {}) {
  const s = await scene({ cap: 1536 });
  const asked: string[] = [];
  const r = await C.npuCheck({
    ...s.opts,
    harden: true,
    ...more,
    io: { ...s.opts.io, setup: { ...s.opts.io.setup, measure: async () => measured }, hardenTest: async (kase: string) => (asked.push(kase), answers[kase] ?? []) },
  });
  return { ...r, s, asked, by: Object.fromEntries(r.report.steps.map((x: any) => [x.step, x])) as Record<string, any> };
}

test('--harden: a driver below the minimum, a test given 1 s and the model that answers nonsense each leave the NPU out with a plain note; calibration writes what it measured', async () => {
  const h = await harden({ timeout: ["didn't answer in time (1 s): This operation was aborted"], nonsense: ['chat answered nonsense ("?option?option?opt"), not "ready" as asked'] }, { warmMs: 800, tokensPerSecond: 25 });
  assert.deepEqual(h.report.steps.map((x: any) => x.step), ['detect', 'requirements', 'setup', 'harden-driver', 'harden-timeout', 'harden-nonsense', 'harden-calibrate']);
  assert.equal(h.code, 0, h.s.lines.join('\n'));
  assert.deepEqual(h.asked, ['timeout', 'nonsense', 'calibrate']);
  assert.match(h.by['harden-driver'].say, /a minimum of 33\.0\.0\.0 over driver 32\.0\.100\.4239: not used, noted "The NPU \(.*\) isn't used: the NPU's driver needs an update/);
  assert.match(h.by['harden-timeout'].say, /given 1 s, no NPU entry, noted ".*didn't answer its test in time/);
  assert.match(h.by['harden-nonsense'].say, /OpenVINO\/Qwen3-4B-int4-ov: no NPU entry, noted ".*its chat model doesn't run properly on it/);
  // The nonsense model was pulled as the route's own is, under its own name.
  assert.ok(h.s.ran.some((a) => a.includes('--pull') && a.includes('OpenVINO/Qwen3-4B-int4-ov')), JSON.stringify(h.s.ran));
  const cal = h.by['harden-calibrate'];
  assert.equal(cal.ok, true, cal.say);
  assert.deepEqual(cal.data.written, V.calibrate(cal.data.measured, h.s.catalog.routes.intel).timeouts);
  assert.equal(cal.data.measured.tokensPerSecond, 25);
  assert.equal(h.report.patch, null, 'no patch from the hardening');
});

test('--harden fails where setup would have kept the NPU, or written timeouts short of what it measured; too slow fails on the NPU', async () => {
  // Setup took the answers: nothing was forced, so the case fails.
  const kept = await harden({ timeout: [], nonsense: [] }, { warmMs: 800, tokensPerSecond: 25 });
  assert.equal(kept.code, 1);
  assert.equal(kept.by['harden-timeout'].ok, false);
  assert.match(kept.by['harden-timeout'].say, /setup still wrote an NPU entry/);
  // The nonsense model answering sensibly here isn't a failure of setup: nothing to reject.
  assert.equal(kept.by['harden-nonsense'].ok, null);
  // An NPU too slow for the chat model: setup leaves it out, but on the NPU that is a FAIL to report.
  const slow = await harden({ timeout: ["didn't answer in time (1 s): aborted"], nonsense: ['chat answered nonsense ("?")'] }, { warmMs: 9_000, tokensPerSecond: 1.2 });
  assert.equal(slow.by['harden-calibrate'].ok, false);
  assert.match(slow.by['harden-calibrate'].say, /not used: it wrote 1\.2 tokens a second/);
  // Nothing measured at all: a failure.
  const none = await harden({ timeout: ["didn't answer in time (1 s): aborted"], nonsense: ['chat answered nonsense ("?")'] }, null);
  assert.equal(none.by['harden-calibrate']?.ok, false, JSON.stringify(none.report.steps.map((x: any) => [x.step, x.ok, x.say])));
});

test('--harden in a rehearsal: the driver case on one of the route\'s devices, no nonsense case off the NPU, calibration as measured', async () => {
  const h = await harden({ timeout: ["didn't answer in time (1 s): aborted"] }, { warmMs: 2_000, tokensPerSecond: 6 }, { vendor: 'intel', device: 'CPU', generation: 'arrow-lake', detection: parseDetection('cpu|12|12|Snapdragon(R) X2 Elite\nram|34359738368\n') });
  assert.equal(h.code, 0, h.s.lines.join('\n'));
  assert.equal(h.report.generation, 'arrow-lake');
  assert.equal(h.by['harden-driver'].ok, true, h.by['harden-driver'].say);
  assert.match(h.by['harden-driver'].say, /a rehearsal: one of the route's devices/);
  assert.equal(h.by['harden-nonsense'].ok, null);
  assert.deepEqual(h.asked, ['timeout', 'calibrate']);
  // Arrow Lake's starting values, raised where the measurements need more.
  const arrowRoute = V.routeFor(V.NPU_CATALOG.routes.intel, 'arrow-lake');
  assert.deepEqual(h.by['harden-calibrate'].data.written, V.calibrate({ ...h.by['harden-calibrate'].data.measured }, arrowRoute).timeouts);
  assert.ok(h.by['harden-calibrate'].data.written.requestPerTokenMs >= 400);
  assert.equal(h.report.patch, null, 'a rehearsal verifies nothing');
});

test('--generation on a real NPU of another generation: the NPU plays it, with its starting values, and verifies nothing', async () => {
  // The Lunar Lake standing in for an NPU 3720: Meteor Lake's values, its 2048-token prompt, and no patch.
  const h = await harden({ timeout: ["didn't answer in time (1 s): aborted"], nonsense: ['chat answered nonsense ("?")'] }, { warmMs: 830, tokensPerSecond: 17 }, { generation: 'meteor-lake' });
  assert.equal(h.code, 0, h.s.lines.join('\n'));
  assert.equal(h.report.generation, 'meteor-lake');
  assert.equal(h.report.rehearsal, true);
  assert.equal(h.report.device, 'NPU');
  assert.ok(h.s.lines.some((x) => /^Running meteor-lake's starting values on this lunar-lake/.test(x)), h.s.lines.join('\n'));
  const meteorRoute = V.routeFor(V.NPU_CATALOG.routes.intel, 'meteor-lake');
  assert.equal(meteorRoute.maxContextTokens, 2048);
  const cal = h.by['harden-calibrate'];
  assert.deepEqual(cal.data.startingValues, meteorRoute.timeouts);
  assert.deepEqual(cal.data.written, V.calibrate(cal.data.measured, meteorRoute).timeouts);
  assert.equal(h.report.patch, null);

  // Its own generation, named: an ordinary run on its own values (the ports' check passing first).
  const own = await harden({ timeout: ["didn't answer in time (1 s): aborted"], nonsense: ['chat answered nonsense ("?")'] }, { warmMs: 830, tokensPerSecond: 17 }, { generation: 'lunar-lake' });
  assert.equal(own.report.rehearsal, false);
  assert.equal(own.report.generation, 'lunar-lake');
});

// The owner's Snapdragon X2 Elite and an X Elite, as detection reads them (npu-vendors.test.ts).
const X2 = 'npu2|30.0.228.10000|2026-07-20|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0FF0&SUBSYS_CRD08480&REV_0056\\2&DABA3FF&0|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU';
const X1 = 'npu2|30.0.140.1000|2025-03-01|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0D0A&SUBSYS_CRD08380&REV_0001\\2&DABA3FF&0|Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Hexagon(TM) NPU';
const ARM = 'cpu|12|18|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm Oryon(TM) CPU\nram|51127103488\n';

/**
 * A Snapdragon's check on fake servers: GenieX "installed" in a scratch %LOCALAPPDATA% and its pull a fake (what it ran
 * and with which GENIEX_DATADIR kept), a fake GenieX and a fake llama-server for its embeddings, each on a free port.
 */
async function snapdragonScene(npu: string) {
  const port = await freePort();
  const ePort = await freePort();
  const catalog = structuredClone(V.NPU_CATALOG);
  const q = catalog.routes.qualcomm;
  q.port = port;
  q.embedServer!.port = ePort;
  delete q.models[0].pinned; // its pull is a fake that leaves no files: the played folder's pins are checked in npu-vendors.test.ts
  delete q.generations['snapdragon-x'].models![0].pinned; // the X Elite's Qwen3-VL-2B (kit 2.101.0), the same
  const tools = mkdtempSync(path.join(home, 'tools-'));
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(localappdata|userprofile)$/i.test(k)));
  Object.assign(env, { REEVE_HOME: home, LOCALAPPDATA: path.join(tools, 'local'), USERPROFILE: path.join(tools, 'profile') });
  const exe = V.serverExe(q, tools, env);
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, '');
  const fake = fakeOvms(port, { cap: q.maxContextTokens });
  const ran: { args: string[]; datadir: string | undefined }[] = [];
  const started: any[] = [];
  const tested: any[] = [];
  const inputs: string[] = [];
  const lines: string[] = [];
  const startEmbed = async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"qwen3-embedding-0.6b-gguf"}]}');
        inputs.push(JSON.parse(body).input);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.01) }] }));
        // The kit's started record would name it for the check to stop; this fake stops after the two it times.
        if (inputs.length === 2) setImmediate(() => (server.closeAllConnections(), server.close()));
      });
    });
    await new Promise<void>((r) => server.listen(ePort, '127.0.0.1', r));
  };
  const opts = {
    yes: true,
    tools,
    catalog,
    env,
    detection: parseDetection(`${ARM}${npu}\n`),
    out: path.join(tools, 'report.json'),
    log: (l: string) => lines.push(l),
    io: {
      setup: {
        run: async (_exe: string, args: string[], ro?: { env?: NodeJS.ProcessEnv }) => (ran.push({ args, datadir: ro?.env?.GENIEX_DATADIR }), { code: 0, out: '' }),
        download: async () => {},
        unpack: (_zip: string, into: string) => {
          mkdirSync(into, { recursive: true });
          writeFileSync(path.join(into, 'llama-server.exe'), '');
        },
        overlay: (_from: string, _into: string, files: string[]) => files.length,
      },
      start: async (e: any) => {
        started.push(e);
        fake.starts++;
        await fake.start();
        return { pid: 4242, stop: fake.stop };
      },
      memory: async () => ({ workingSetBytes: 5.8 * 1024 ** 3, privateBytes: 1.6 * 1024 ** 3 }),
      kitTest: async (e: any) => (tested.push(e), [] as string[]),
      embedTest: async (e: any) => (tested.push(e), await startEmbed(), [] as string[]),
    },
  };
  return { tools, fake, ran, started, tested, inputs, lines, opts };
}

test("--generation snapdragon-x on an X2: the X Elite played whole (its Qwen3-VL-2B from a folder of its own, GenieX and the embeddings on Hexagon v73), verifying nothing", async () => {
  const s = await snapdragonScene(X2);
  const { code, report } = await C.npuCheck({ ...s.opts, generation: 'snapdragon-x' });
  assert.equal(code, 0, s.lines.join('\n'));
  assert.deepEqual(report.steps.map((x: any) => x.step), ['detect', 'requirements', 'setup', 'start', 'first-answer', 'warm', 'speed', 'read', 'cap', 'two-at-once', 'memory', 'restart', 'kit-test', 'embed']);
  assert.equal(report.generation, 'snapdragon-x');
  assert.equal(report.rehearsal, true);
  assert.equal(report.patch, null, 'a played run verifies nothing');
  assert.equal((report.npu as any).generation, 'snapdragon-x2', 'the NPU is still the X2 it is');
  const dir = path.join(s.tools, 'played', 'snapdragon-x', 'geniex');
  assert.deepEqual(report.played, { generation: 'snapdragon-x', on: 'snapdragon-x2', dataDir: dir, aiHubChipset: 'qualcomm-snapdragon-x-elite', hexagonArch: 'v73' });
  assert.ok(s.lines.some((l) => l.startsWith('Played: this Snapdragon X2 Elite / X2 Plus (Hexagon v81) plays the Snapdragon X / X Plus / X Elite (Hexagon v73)') && l.includes(dir)), s.lines.join('\n'));
  // Its folder names the X Elite to AI Hub; the real cache is left alone.
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')), { chipset: 'qualcomm-snapdragon-x-elite' });
  assert.equal(existsSync(path.join(s.tools, 'profile', '.cache', 'geniex')), false);
  // GenieX pulled its model into that folder: --data-dir before the command, and GENIEX_DATADIR as well.
  assert.deepEqual(s.ran.map((r) => [r.args.slice(0, 4), r.datadir]), [[['--data-dir', dir, 'pull', 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0'], dir]]);
  // Started on it, each time, as the kit's own start does (its entry's paths as config.json keeps them), its llama.cpp
  // plugin on the X's v73 code.
  assert.equal(s.started.length, 2, 'a first start, and a start again');
  for (const e of s.started) {
    assert.deepEqual(e.chat.startCommand.slice(1, 4), ['--data-dir', portablePath(dir), 'serve']);
    assert.equal(e.chat.env.GENIEX_DATADIR, portablePath(dir));
    assert.equal(e.chat.env.GGML_HEXAGON_ARCH, 'v73');
  }
  // The embeddings: llama.cpp's Hexagon backend told to run the X's v73 code, as the kit starts it, through the build
  // that loads GenieX 0.9's libraries (the X Elite pins 0.9.3).
  const embedEntry = s.tested.at(-1);
  assert.deepEqual(embedEntry.embed.env, { ADSP_LIBRARY_PATH: portablePath(path.join(s.tools, 'servers', 'llama.cpp', 'b11645-hexagon')), GGML_HEXAGON_ARCH: 'v73' });
  assert.equal(report.steps.at(-1)!.ok, true);
  assert.equal(s.inputs.length, 2);
});

test('--generation on a Snapdragon refuses a newer one on an older NPU, and one no server runs, before anything is set up', async () => {
  const older = await snapdragonScene(X1);
  const up = await C.npuCheck({ ...older.opts, generation: 'snapdragon-x2' });
  assert.equal(up.code, 2);
  assert.deepEqual([up.report.steps.at(-1)!.step, up.report.steps.at(-1)!.ok], ['play', false]);
  assert.equal(up.report.steps.at(-1)!.say, "the Snapdragon X2 Elite / X2 Plus (Hexagon v81) is newer than this NPU (v73): its Hexagon code doesn't run on an older one");
  assert.equal(up.report.played, null);
  assert.deepEqual(older.ran, [], 'nothing set up');
  assert.equal(existsSync(path.join(older.tools, 'played')), false, 'no folder made for it');

  const legacy = await snapdragonScene(X2);
  const no = await C.npuCheck({ ...legacy.opts, generation: 'snapdragon-8cx' });
  assert.equal(no.code, 2);
  assert.equal(no.report.steps.at(-1)!.step, 'play');
  assert.match(no.report.steps.at(-1)!.say, /can't be played: GenieX and Qualcomm AI Hub's model builds cover only the Snapdragon X and X2/);
  assert.equal(legacy.fake.starts, 0);
});

test('a server already on the route\'s port: on the NPU the check refuses, in a rehearsal its servers move beside it', async () => {
  // The manor's own local AI on Intel's port: never measured in the check's place.
  const s = await scene();
  const { code, report } = await C.npuCheck({ ...s.opts, io: { ...s.opts.io, portFree: async (p: number) => p !== s.port } });
  assert.equal(code, 2);
  const last = report.steps.at(-1)!;
  assert.equal(last.step, 'ports');
  assert.ok(last.say.startsWith(`a server already answers on ${s.port} (the manor's local AI, most likely): stop it first`), last.say);
  assert.ok(!s.ran.length, 'nothing set up');

  // Off the NPU, the chat and embedding servers each move 100 up, past a held one there too.
  const route = { ...V.NPU_CATALOG.routes.intel, port: 18183, embedServer: { ...V.NPU_CATALOG.routes.intel.embedServer!, port: 18184 } };
  const held = new Set([18183, 18184, 18283]);
  const r = await C.routeOnFreePorts(route, false, async (p) => !held.has(p));
  assert.ok('route' in r);
  assert.equal(r.route.port, 18284);
  assert.equal(r.route.embedServer!.port, 18285, 'not the port the chat server took');
  assert.deepEqual(r.moved, ['18183 to 18284', '18184 to 18285']);
  assert.deepEqual(await C.routeOnFreePorts(route, true, async (p) => !held.has(p)), { held: [18183, 18184] });
  // Nothing held: the route as it is.
  assert.equal(((await C.routeOnFreePorts(route, true, async () => true)) as any).route, route);
});

test('portFree: a port something listens on is not free; once closed it is', async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const p = (srv.address() as { port: number }).port;
  assert.equal(await C.portFree(p), false);
  await new Promise((r) => srv.close(r));
  assert.equal(await C.portFree(p), true);
});
