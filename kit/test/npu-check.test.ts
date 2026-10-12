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
function fakeOvms(port: number, o: { cap: number; dieOverCap?: boolean }) {
  const seen: any[] = [];
  let server: Server | null = null;
  const start = async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"OpenVINO/Qwen3-4B-int4-ov"}]}');
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
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '<think>\n\n</think>\n\nready' } }], usage: { prompt_tokens: promptTokens, completion_tokens: completion } }));
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

/** The catalog on a free port, and a scratch tools home with the server's program "installed" and the VC runtime "there". */
async function scene(o: { cap?: number; dieOverCap?: boolean } = {}) {
  const port = await freePort();
  const catalog = structuredClone(V.NPU_CATALOG);
  catalog.routes.intel.port = port;
  if (o.cap) catalog.routes.intel.maxContextTokens = o.cap;
  const tools = mkdtempSync(path.join(home, 'tools-'));
  const exe = V.serverExe(catalog.routes.intel, tools);
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, '');
  const sysRoot = path.join(tools, 'Windows');
  mkdirSync(path.join(sysRoot, 'System32'), { recursive: true });
  for (const f of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) writeFileSync(path.join(sysRoot, 'System32', f), '');
  const fake = fakeOvms(port, { cap: catalog.routes.intel.maxContextTokens, dieOverCap: o.dieOverCap });
  const ran: string[][] = [];
  const lines: string[] = [];
  const opts = {
    yes: true,
    tools,
    catalog,
    env: { ...process.env, SystemRoot: sysRoot, REEVE_HOME: home },
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
  return { port, catalog, tools, fake, ran, lines, opts };
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
  assert.ok(s.ran.some((a) => a.includes('--pull') && a.includes('OpenVINO/Qwen3-4B-int4-ov')));
  assert.equal(by.setup.data.downloadBytes, V.NPU_CATALOG.routes.intel.models[0].size);
  // Qwen3 (not an Instruct build) is told /no_think, and its empty think block is stripped from the answer.
  assert.match(s.fake.seen[0].messages.at(-1).content, /\/no_think$/);
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

test('a server that dies on a request past its cap fails the cap step, and is started again for the rest', async () => {
  const s = await scene({ cap: 1536, dieOverCap: true });
  const { code, report } = await C.npuCheck(s.opts);
  const cap = report.steps.find((x: any) => x.step === 'cap')!;
  assert.equal(cap.ok, false);
  assert.match(cap.say, /the server stopped answering/);
  assert.equal(code, 1);
  assert.equal(report.steps.find((x: any) => x.step === 'two-at-once')!.ok, true, 'measured after a start again');
});

test('a rehearsal of another maker’s route needs a scratch REEVE_HOME; without the VC runtime it stops at the requirements', async () => {
  const s = await scene();
  const env: NodeJS.ProcessEnv = { ...s.opts.env };
  delete env.REEVE_HOME;
  const noHome = await C.npuCheck({ ...s.opts, env, vendor: 'intel', device: 'CPU', detection: parseDetection('cpu|12|12|Snapdragon(R) X2 Elite\nram|34359738368\n') });
  assert.equal(noHome.code, 2);
  assert.match(noHome.report.steps.at(-1)!.say, /scratch home/);

  const sys = path.join(s.tools, 'Windows', 'System32', 'msvcp140.dll');
  rmSync(sys);
  const r = await C.npuCheck(s.opts);
  assert.equal(r.code, 1);
  assert.match(r.report.steps.find((x: any) => x.step === 'requirements')!.say, /Visual C\+\+ Redistributable/);
  assert.equal(s.fake.starts, 0);
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
