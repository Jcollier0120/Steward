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
async function scene(o: { cap?: number; dieOverCap?: boolean; answer?: string } = {}) {
  const port = await freePort();
  const catalog = structuredClone(V.NPU_CATALOG);
  catalog.routes.intel.port = port;
  if (o.cap) catalog.routes.intel.maxContextTokens = o.cap;
  delete catalog.routes.intel.models[0].pinned; // its pull is a fake that leaves no files to check
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
  assert.equal(report.steps.find((x: any) => x.step === 'setup')!.data!.downloadBytes, V.NPU_CATALOG.routes.intel.models[0].size + q.download.size + q.model.size);
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