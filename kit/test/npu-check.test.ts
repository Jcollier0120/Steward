import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

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

test('the route on another device: OpenVINO gets its --target_device, and off the NPU loses --max_prompt_len; GenieX has no other', () => {
  const intel = V.NPU_CATALOG.routes.intel;
  const cpu = C.routeOnDevice(intel, 'cpu');
  assert.equal(cpu.serve[cpu.serve.indexOf('--target_device') + 1], 'CPU');
  assert.ok(!cpu.serve.includes('--max_prompt_len'));
  assert.deepEqual(C.routeOnDevice(intel, 'NPU').serve, intel.serve);
  // Its embedding server, OpenVINO too, goes with it, and loses the NPU's fixed --max_length.
  const es = cpu.embedServer!.serve;
  assert.equal(es[es.indexOf('--target_device') + 1], 'CPU');
  assert.ok(!es.includes('--max_length') && es.includes('--pooling'));
  assert.deepEqual(C.routeOnDevice(intel, 'NPU').embedServer, intel.embedServer);
  assert.throws(() => C.routeOnDevice(V.NPU_CATALOG.routes.qualcomm, 'CPU'), /NPU only/);
  assert.equal(C.routeOnDevice(V.NPU_CATALOG.routes.qualcomm, 'NPU'), V.NPU_CATALOG.routes.qualcomm);
});

test('a filler prompt is about the tokens asked for, each line its own', () => {
  const p = C.fillerPrompt(1000);
  assert.ok(p.length >= 4000 && p.length < 4200, String(p.length));
  assert.match(p, /Line 1:.*\nLine 2:/);
});

test('the arguments: --route, --device, --yes, --no-setup, --out; anything else is refused', () => {
  assert.deepEqual(C.parseCheckArgs(['--route', 'intel', '--device', 'cpu', '--yes', '--no-setup', '--out', 'r.json']), { vendor: 'intel', device: 'CPU', yes: true, setup: false, out: 'r.json' });
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
  for (let i = 0; i < 200 && !existsSync(mark); i++) await new Promise((r) => setTimeout(r, 25));
  await s.stop();
  delete process.env.NPU_CHECK_TEST_NODE;
  assert.equal(existsSync(mark), true, readFileSync(path.join(dir, 'server.log'), 'utf8'));
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
// ------------------------------------------------------------------------------------------------
// The report's generation and its patch; --harden, setup's failures forced and its calibration checked

const METEOR = 'npu2|32.0.100.4023|2025-05-01|Intel Corporation|PCI\\VEN_8086&DEV_7D1D&SUBSYS_0B0A1028&REV_04\\3&11583659&0&58|Intel(R) AI Boost';
const METEOR_CPU = 'cpu|9|22|Intel(R) Core(TM) Ultra 7 155H\nram|34359738368\n';

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

  // A Meteor Lake (NPU 3720): its starting values run (a 2048-token prompt), and its patch flips it to verified.
  const s = await scene({ cap: 2048 });
  const { code, report } = await C.npuCheck({ ...s.opts, detection: parseDetection(`${METEOR_CPU}${METEOR}\n`) });
  assert.equal(code, 0, s.lines.join('\n'));
  assert.equal(report.generation, 'meteor-lake');
  assert.deepEqual(s.ran.find((a) => a.includes('--pull')) !== undefined, true);
  const g = (report.patch as any).routes.intel.generations['meteor-lake'];
  assert.equal(g.verified, true);
  assert.deepEqual(g.timeouts, { ...V.NPU_CATALOG.routes.intel.generations['meteor-lake'].timeouts, ...report.suggest!.timeouts });
  assert.match(g.basis, /^Measured by the NPU check on Intel Core Ultra 7 155H, NPU driver 32\.0\.100\.4023, \d{4}-\d\d-\d\d, every step passing/);
  assert.equal(JSON.parse(readFileSync(s.opts.out, 'utf8')).patch.routes.intel.generations['meteor-lake'].verified, true, 'kept in the JSON report');
  assert.ok(s.lines.some((x) => /^The change to npu-vendors.json this run supports \(it flips meteor-lake to verified\)/.test(x)), s.lines.join('\n'));
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
  const h = await harden({ timeout: ["didn't answer in time (1 s): aborted"] }, { warmMs: 2_000, tokensPerSecond: 6 }, { vendor: 'intel', device: 'CPU', generation: 'meteor-lake', detection: parseDetection('cpu|12|12|Snapdragon(R) X2 Elite\nram|34359738368\n') });
  assert.equal(h.code, 0, h.s.lines.join('\n'));
  assert.equal(h.report.generation, 'meteor-lake');
  assert.equal(h.by['harden-driver'].ok, true, h.by['harden-driver'].say);
  assert.match(h.by['harden-driver'].say, /a rehearsal: one of the route's devices/);
  assert.equal(h.by['harden-nonsense'].ok, null);
  assert.deepEqual(h.asked, ['timeout', 'calibrate']);
  // Meteor Lake's starting values, raised where the measurements need more.
  const meteorRoute = V.routeFor(V.NPU_CATALOG.routes.intel, 'meteor-lake');
  assert.deepEqual(h.by['harden-calibrate'].data.written, V.calibrate({ ...h.by['harden-calibrate'].data.measured }, meteorRoute).timeouts);
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
