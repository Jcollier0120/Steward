import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The NPU benchmark (npu-bench.ts): its suite, grades, pictures and measurements, and a whole run against a fake
// OpenVINO Model Server in this process that streams as the real one does. Nothing is downloaded or started.
const home = mkdtempSync(path.join(tmpdir(), 'kit-npu-bench-'));
process.env.REEVE_HOME = home;
delete process.env.REEVE_CONFIG;
delete process.env.ACCELERATORS_CONFIG;
delete process.env.ACCELERATORS_HOME;
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
after(() => rmSync(home, { recursive: true, force: true }));

const B = await import('./fixture/src/kit/npu-bench.ts');
const V = await import('./fixture/src/kit/npu-vendors.ts');
const { routeOnDevice } = await import('./fixture/src/kit/npu-check.ts');
const { parseDetection } = await import('./fixture/src/kit/detect.ts');
const { mb, portablePath } = await import('./fixture/src/kit/setup.ts');

const LUNAR = 'npu2|32.0.100.4239|2025-09-01|Intel Corporation|PCI\\VEN_8086&DEV_643E&SUBSYS_00000000&REV_04\\3&11583659&0&58|Intel(R) AI Boost';
const METEOR = 'npu2|32.0.100.4023|2025-05-01|Intel Corporation|PCI\\VEN_8086&DEV_7D1D&SUBSYS_0B0A1028&REV_04\\3&11583659&0&58|Intel(R) AI Boost';
const X64 = 'cpu|9|8|Intel(R) Core(TM) Ultra 7 256V\nram|16849174528\n';
// The owner's Snapdragon laptop, as detection reads it (npu-vendors.test.ts).
const X2 = 'npu2|30.0.228.10000|2026-07-20|Qualcomm Technologies, Inc.|ACPI\\VEN_QCOM&DEV_0FF0&SUBSYS_CRD08480&REV_0056\\2&DABA3FF&0|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm(R) Hexagon(TM) NPU';
const ARM = 'cpu|12|18|Snapdragon(R) X2 Elite Extreme - X2E94100 - Qualcomm Oryon(TM) CPU\nram|51127103488\n';
const SUITE = B.SUITE;
/** The line freshPrompt puts first in every read and job: the run's tag and a count. */
const FRESH = /^\[bench [a-z0-9]*-\d+\]\n/;

/** A right answer to every quality question, by id: each must pass its own grade. */
const RIGHT: Record<string, string> = {
  ready: 'ready',
  colour: 'green',
  capitals: 'CASTLE',
  'three-words': 'Vast, restless blue',
  list: 'Monday, Tuesday, Wednesday',
  'no-punctuation': '7',
  'find-start': '5150',
  'find-middle': 'Imogen Rhys',
  'find-end': '7319',
  'find-pump': '8',
  'find-shelf': '150',
  'find-invoice': 'HL-20931',
  'json-person': '{"name": "Mary", "age": 34}',
  'json-triage': '```json\n{"label": "technical"}\n```',
  'json-date': '{"date": "2026-03-14"}',
  'json-list': '{"fruit": ["apples", "pears"]}',
  'json-boolean': '{"refund": true}',
  'json-place': '{"city": "Leeds", "country": "England"}',
  add: '42',
  multiply: '72',
  larger: '0.8',
  'day-after': 'Wednesday',
  time: '3:15 pm',
  apples: '11',
  triage: '{"label": "billing", "urgent": true}',
  reply: 'Of course! Saturday is fine. The ladder will be by the side gate from nine.',
  summary: 'The cellar is now dry and usable. The works cost $18,400 in total, under the $20,000 budget. The door and window still need attention.',
  red: 'Red.',
  halves: 'left blue, right yellow',
  number: '472',
  count: '3',
};

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * A fake OpenVINO Model Server (or GenieX: the same OpenAI routes) that knows the suite's right answers (or answers
 * `wrong`), streamed or not. Each picture a request carries is looked at as it arrives: its URL, and whether that is a
 * PNG file on this PC, as GenieX reads one.
 */
function fakeOvms(port: number, o: { stream?: boolean; wrong?: string; usage?: boolean } = {}) {
  const answers = new Map<string, string>();
  for (const item of [...SUITE.quality, ...SUITE.jobs]) answers.set(B.promptOf(SUITE, item), RIGHT[item.id]);
  for (const v of SUITE.vision) answers.set(v.prompt, RIGHT[v.id]);
  const seen: any[] = [];
  const pictures: { url: string; pngFile: boolean }[] = [];
  let server: Server | null = null;
  const answerFor = (asked: string) => {
    if (o.wrong) return o.wrong;
    const prompt = asked.replace(FRESH, '');
    if (prompt === SUITE.short.prompt) return 'ready';
    if (prompt === SUITE.write.prompt) return Array.from({ length: 100 }, (_, i) => `n${i + 1}`).join(', ');
    if (prompt.endsWith(SUITE.read.question)) return '42';
    return answers.get(prompt) ?? 'I do not know';
  };
  const start = async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov"}]}');
        const j = JSON.parse(body);
        seen.push(j);
        const content = j.messages.at(-1).content;
        const parts: any[] = Array.isArray(content) ? content : [];
        const url = parts.find((p) => p.type === 'image_url')?.image_url?.url;
        if (typeof url === 'string') pictures.push({ url, pngFile: !/^data:/.test(url) && existsSync(url) && readFileSync(url).subarray(1, 4).toString() === 'PNG' });
        const text = answerFor(typeof content === 'string' ? content : (parts.find((p) => p.type === 'text')?.text ?? ''));
        const pieces = text.split(/(?<=\s)/);
        const usage = o.usage === false ? undefined : { prompt_tokens: Math.round(JSON.stringify(j.messages).length / 4), completion_tokens: pieces.length };
        if (j.stream && o.stream !== false) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const p of pieces) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [], ...(usage ? { usage } : {}) })}\n\n`);
          return res.end('data: [DONE]\n\n');
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: text } }], ...(usage ? { usage } : {}) }));
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
  return { seen, pictures, start, stop, starts: 0, commands: [] as string[][] };
}

const PLUGGED = { onBattery: false, batteryPercent: 80, powerMode: 'balanced', brightness: 60, windowsBuild: '26200', make: 'HP', model: 'HP OmniBook X Laptop 17-dd0xxx' };

/**
 * The catalog on a free port, a scratch tools home with the server "installed", and a suite that holds for moments, not
 * minutes. On a Snapdragon (`vendor: 'qualcomm'`), GenieX is "installed" where its installer puts it, in a scratch
 * %LOCALAPPDATA%, and its embedding server is left out: the benchmark asks for no embeddings.
 */
async function scene(o: { stream?: boolean; wrong?: string; usage?: boolean; busy?: number; conditions?: typeof PLUGGED; rate?: (working: boolean) => number | null; npu?: string; vendor?: 'intel' | 'qualcomm' } = {}) {
  const port = await freePort();
  const vendor = o.vendor ?? 'intel';
  const catalog = structuredClone(V.NPU_CATALOG);
  const route = catalog.routes[vendor];
  route.port = port;
  // Its pull is a fake that leaves no files to check: a generation's own models' (and a small PC's, smallPc) too.
  for (const m of [...route.models, ...Object.values(route.generations).flatMap((g) => [...(g.models ?? []), ...(g.smallPc?.models ?? [])])]) delete m.pinned;
  const tools = mkdtempSync(path.join(home, 'tools-'));
  let env: NodeJS.ProcessEnv = { ...process.env, REEVE_HOME: home };
  if (vendor === 'qualcomm') {
    delete route.embedServer;
    env = Object.fromEntries(Object.entries(env).filter(([k]) => !/^(localappdata|userprofile)$/i.test(k)));
    Object.assign(env, { LOCALAPPDATA: path.join(tools, 'local'), USERPROFILE: path.join(tools, 'profile') });
  }
  const exe = V.serverExe(route, tools, env);
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, '');
  for (const f of route.runtime?.files ?? []) writeFileSync(path.join(path.dirname(exe), f), '');
  const fake = fakeOvms(port, o);
  const suite = structuredClone(SUITE);
  suite.holding.minutes = 0.002;
  suite.energy.restSeconds = 0.05;
  suite.energy.loadMinutes = 0.002;
  suite.quiet.samples = 2;
  // A fake in this process answers in a millisecond or two, so its tries can't agree to 15%; and on a busy PC, or one
  // held to the checks pace's cap, one try now and then waits a tenth of a second for the processor: never noisy here.
  suite.steady.maxSpread = Infinity;
  const lines: string[] = [];
  const cleared: string[] = [];
  // The battery reads higher once requests are arriving: working, against at rest.
  let seenAtRest = -1;
  const working = () => {
    if (seenAtRest < 0) seenAtRest = fake.seen.length;
    return fake.seen.length > seenAtRest;
  };
  const opts = {
    yes: true,
    tools,
    catalog,
    suite,
    kitVersion: '2.62.0',
    env,
    detection: parseDetection(vendor === 'qualcomm' ? `${ARM}${o.npu ?? X2}\n` : `${X64}${o.npu ?? LUNAR}\n`),
    out: path.join(tools, 'report.json'),
    log: (l: string) => lines.push(l),
    io: {
      setup: { run: async () => ({ code: 0, out: '' }) },
      // The route's own version installed: no server of this PC's is asked which it is.
      serverVersion: async (r: any) => r.version,
      start: async (e: any) => {
        fake.starts++;
        fake.commands.push(e.chat.startCommand);
        await fake.start();
        return { pid: 4242, stop: fake.stop };
      },
      memory: async () => ({ workingSetBytes: 3.6 * 1024 ** 3, privateBytes: 1.2 * 1024 ** 3 }),
      conditions: async () => o.conditions ?? PLUGGED,
      cpuBusy: async () => o.busy ?? 4,
      dischargeRate: async () => (o.rate ? o.rate(working()) : null),
      sleep: () => new Promise<void>((r) => setTimeout(r, 1)),
      clearCache: (dir: string) => cleared.push(dir),
    },
  };
  return { port, catalog, tools, fake, lines, cleared, opts };
}

test('the suite: 24 graded questions, six of each kind, three must-pass, ids unique, and every prompt fits under the smallest cap', () => {
  const kinds = SUITE.quality.reduce((m: Record<string, number>, q: any) => ((m[q.kind] = (m[q.kind] ?? 0) + 1), m), {});
  assert.deepEqual(kinds, { instruction: 6, find: 6, json: 6, reasoning: 6 });
  assert.deepEqual(SUITE.quality.filter((q: any) => q.mustPass).map((q: any) => q.id), ['ready', 'find-end', 'json-person']);
  const ids = [...SUITE.quality, ...SUITE.jobs, ...SUITE.vision].map((q: any) => q.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(SUITE.jobs.map((j: any) => j.id), ['triage', 'reply', 'summary']);
  // About four characters a token, as the kit estimates: prompt and answer together under the suite's limit, and the
  // limit under every route's cap.
  // Chat's and vision's caps: the suite asks questions, never for embeddings.
  const smallest = Math.min(...Object.values(V.NPU_CATALOG.routes).flatMap((r: any) => [r.maxContextTokens, r.caps.chat ?? Infinity, r.caps.vision ?? Infinity]));
  assert.ok(SUITE.maxTokensAll <= smallest, `the suite's ${SUITE.maxTokensAll} under the smallest cap, ${smallest}`);
  for (const item of [...SUITE.quality, ...SUITE.jobs]) {
    const tokens = Math.ceil(B.promptOf(SUITE, item).length / 4) + item.maxTokens;
    assert.ok(tokens <= SUITE.maxTokensAll, `${item.id}: about ${tokens} tokens`);
  }
  for (const n of SUITE.read.sizes) assert.ok(n + SUITE.read.maxTokens <= SUITE.maxTokensAll);
  // The long-text jobs really are long: the triage thread about 1,000 tokens, the summary's report about 900.
  assert.ok(B.promptOf(SUITE, SUITE.jobs[0]).length / 4 > 800);
  assert.ok(B.promptOf(SUITE, SUITE.jobs[2]).length / 4 > 700);
});

test("every question's right answer passes its own grade, and its document carries the sentence it asks about", () => {
  for (const item of [...SUITE.quality, ...SUITE.jobs]) assert.ok(B.grade(item.grade, RIGHT[item.id]), `${item.id}: "${RIGHT[item.id]}"`);
  const end = SUITE.quality.find((q: any) => q.id === 'find-end')!;
  const p = B.promptOf(SUITE, end);
  assert.ok(p.indexOf('key safe code is 7319') > p.indexOf('guarantee on the damp works'), 'the end sentence comes after the last paragraph');
  const start = B.promptOf(SUITE, SUITE.quality.find((q: any) => q.id === 'find-start')!);
  assert.ok(start.indexOf('file number is 5150') < start.indexOf('Summary.'));
});

test('grades: a regular expression, the first number (commas allowed), JSON fields (case aside), all and any', () => {
  assert.equal(B.grade({ regex: '^\\W*ready\\W*$', flags: 'i' }, ' Ready. '), true);
  assert.equal(B.grade({ regex: '^\\W*ready\\W*$', flags: 'i' }, 'I am ready'), false);
  assert.equal(B.grade({ number: 18400 }, 'It cost $18,400 in all.'), true);
  assert.equal(B.grade({ number: 0.8 }, '0.80'), true);
  assert.equal(B.grade({ number: 42 }, '32, or 42'), false);
  assert.equal(B.grade({ json: { label: 'billing' } }, 'Sure: {"label": "Billing", "urgent": true}'), true);
  assert.equal(B.grade({ json: { fruit: ['apples', 'pears'] } }, '{"fruit": ["apples"]}'), false);
  assert.equal(B.grade({ json: { a: 1 } }, 'no JSON here'), false);
  assert.equal(B.grade({ all: [{ regex: 'a' }, { regex: 'b' }] }, 'ab'), true);
  assert.equal(B.grade({ all: [{ regex: 'a' }, { regex: 'b' }] }, 'a'), false);
  assert.equal(B.grade({ any: [{ number: 3 }, { regex: 'three' }] }, 'three'), true);
});

test('pictures: PNGs drawn here, as data: URLs, the size asked for', () => {
  for (const v of SUITE.vision) {
    const url = B.picture(v.image);
    assert.match(url, /^data:image\/png;base64,/);
    const png = Buffer.from(url.split(',')[1], 'base64');
    assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
    if (v.image.width) assert.equal(png.readUInt32BE(16), v.image.width);
  }
});

test('a measurement: median, spread, and steady only when every try worked and they agree', () => {
  assert.deepEqual(B.measure([100, 104, 98, 101, 102], 0.15), { tries: [100, 104, 98, 101, 102], median: 101, spread: 0.059, steady: true });
  assert.equal(B.measure([100, 150, 100], 0.15).steady, false);
  assert.equal(B.measure([100, Number.NaN, 100], 0.15).steady, false);
  assert.equal(B.measure([Number.NaN], 0.15).median, null);
  assert.equal(B.measure([10, 20], 1).median, 15);
});

test("a job's tries are judged at one answer length: answers of their own lengths aren't noise, a slower server is", () => {
  // Reading 300 ms, then 25 ms a token: answers of 21 to 41 tokens take 800 to 1,300 ms, 48% apart as they stand.
  const tokens = [21, 31, 41, 26, 36];
  const first = [300, 300, 300, 300, 300];
  const tries = tokens.map((n) => 300 + (n - 1) * 25);
  assert.deepEqual(B.atAnswerLength(tries, tokens, first), [1050, 1050, 1050, 1050, 1050]);
  const steady = B.jobMeasure(tries, tokens, first, 0.15);
  assert.deepEqual(steady, { tries, median: 1050, spread: 0.476, steady: true, answerTokens: tokens, firstTokenMs: first, spreadAtLength: 0 });
  assert.equal(B.measure(tries, 0.15).steady, false, 'the whole times alone would call it noisy');
  // The same answer each time, but one try a third slower to write: noisy.
  const slow = B.jobMeasure([1050, 1050, 1300, 1050, 1050], [31, 31, 31, 31, 31], first, 0.15);
  assert.equal(slow.spreadAtLength, 0.238);
  assert.equal(slow.steady, false);
  // Reading slower once is noisy too: the first token is the server's, whatever the answer's length.
  const slowRead = B.jobMeasure([800, 1050, 1650, 925, 1175], tokens, [300, 300, 650, 300, 300], 0.15);
  assert.equal(slowRead.spreadAtLength, 0.333);
  assert.equal(slowRead.steady, false);
  // Without the counts or the first-token times (a server that doesn't stream or count, marked so), the whole times;
  // and a failed try still keeps the job from being steady.
  assert.deepEqual(B.atAnswerLength(tries, [null, null, null, null, null], first), tries);
  assert.deepEqual(B.atAnswerLength(tries, tokens, [null, null, null, null, null]), tries);
  assert.equal(B.jobMeasure([1050, Number.NaN, 1050], [31, null, 31], [300, null, 300], 0.15).steady, false);
});

test("conditions: plugged in or the battery, Windows' power mode on that source, the laptop's make and model", () => {
  const plugged = B.parseConditions('battery|1|True|60000|75000\npc|HP|HP OmniBook X Laptop 17-dd0xxx|26200\npower|ded574b5-45a0-4f42-8737-46345c09c238|\nbrightness|75');
  assert.deepEqual(plugged, { onBattery: false, batteryPercent: 80, powerMode: 'best performance', brightness: 75, windowsBuild: '26200', make: 'HP', model: 'HP OmniBook X Laptop 17-dd0xxx' });
  const battery = B.parseConditions('battery|1|False|30000|75000\npc|HP|X|26200\npower|ded574b5-45a0-4f42-8737-46345c09c238|961cc777-2547-4f9d-8174-7d86181b8a7a\nbrightness|');
  assert.equal(battery.onBattery, true);
  assert.equal(battery.powerMode, 'best power efficiency');
  assert.equal(battery.brightness, null);
  const desktop = B.parseConditions('battery|0|||\npc|Contoso|Tower|26100\npower||\nbrightness|');
  assert.equal(desktop.onBattery, false);
  assert.equal(desktop.batteryPercent, null);
  assert.equal(desktop.powerMode, 'balanced');
});

test("the route for a run: its own compile cache, a cap where the server has one, the model asked for, or a candidate pulled as the route's are", () => {
  const intel = V.NPU_CATALOG.routes.intel;
  const r = B.benchServe(intel, { device: 'NPU', cap: 2048 });
  assert.equal(r.serve[r.serve.indexOf('--cache_dir') + 1], '{tools}\\models\\openvino\\.bench-cache-npu-2048');
  assert.equal(r.serve[r.serve.indexOf('--max_prompt_len') + 1], '2048');
  assert.equal(r.maxContextTokens, 2048);
  assert.throws(() => B.benchServe(V.NPU_CATALOG.routes.qualcomm, { device: 'NPU', cap: 2048 }), /no prompt cap/);
  // Off the NPU nothing is compiled for a cap: --cap only places the long read, as an NPU run at that cap would.
  const gpu = B.benchServe(routeOnDevice(intel, 'GPU'), { device: 'GPU', cap: 2048 });
  assert.equal(gpu.maxContextTokens, 2048);
  assert.ok(!gpu.serve.includes('--max_prompt_len'));
  assert.equal(gpu.serve[gpu.serve.indexOf('--cache_dir') + 1], '{tools}\\models\\openvino\\.bench-cache-gpu');
  const c = B.candidateRoute(intel, 'Castellan-AI/Qwen3-1.7B-int4-cw-ov');
  assert.equal(c.models.length, 1);
  assert.ok(c.models[0].pull.includes('Castellan-AI/Qwen3-1.7B-int4-cw-ov'));
  assert.equal(c.models[0].pinned, undefined);
  assert.throws(() => B.routeWithModel(intel, 'nobody/nothing'), /use --candidate/);
});

test('the arguments: --profile, --device, --model or --candidate, --cap, --energy, --yes, --no-setup, --out', () => {
  assert.deepEqual(B.parseBenchArgs(['--profile', 'quick', '--device', 'gpu', '--candidate', 'a/b', '--cap', '2048', '--energy', '--yes', '--out', 'r.json']), { profile: 'quick', device: 'GPU', candidate: 'a/b', cap: 2048, energy: true, yes: true, out: 'r.json' });
  assert.match((B.parseBenchArgs(['--profile', 'long']) as any).error, /quick or full/);
  assert.match((B.parseBenchArgs(['--model', 'a', '--candidate', 'b']) as any).error, /one or the other/);
  assert.match((B.parseBenchArgs(['--cap', '12']) as any).error, /256 or more/);
  assert.match((B.parseBenchArgs(['--fast']) as any).error, /unknown argument/);
});

test('a full run on an Intel NPU: streamed, every measurement taken, all 24 right, the job time, the report matching its schema, and ranked', async () => {
  const s = await scene();
  const { code, report } = await B.npuBench(s.opts);
  assert.equal(code, 0, s.lines.join('\n'));
  assert.deepEqual(report.marks, []);
  assert.equal(report.ranked, true);
  assert.equal(report.run.streamed, true);
  assert.equal(report.run.usageReported, true);
  assert.equal(report.run.model, 'Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov');
  assert.equal(report.run.cap, V.NPU_CATALOG.routes.intel.maxContextTokens, "the route's own cap");
  assert.equal(report.pc.chip, 'Core Ultra 200V, Lunar Lake (NPU 4)');
  assert.equal(report.pc.make, 'HP');
  assert.equal(report.quality.passed, 24);
  assert.equal(report.quality.gate, true);
  assert.equal(report.vision, null, "Intel's route has no vision model");
  assert.deepEqual(Object.keys(report.results.readFirstTokenMs), ['512', '1024']);
  assert.ok(report.results.writeTokensPerSecond!.median! > 0);
  for (const j of SUITE.jobs) {
    const m = report.results.jobs[j.id];
    assert.equal(m.passed, SUITE.tries.full);
    // Each try's answer tokens (the server's count) and first-token time, so its steadiness is judged at one length.
    assert.equal(m.answerTokens.length, SUITE.tries.full);
    assert.ok(m.answerTokens.every((n: number | null) => typeof n === 'number' && n > 0), JSON.stringify(m.answerTokens));
    assert.ok(m.firstTokenMs.every((x: number | null) => typeof x === 'number'), JSON.stringify(m.firstTokenMs));
    assert.equal(typeof m.spreadAtLength, 'number');
  }
  // The fake answers in a millisecond or so, which rounds to 0.00 s: check the sum, not that it took time.
  const jobSum = SUITE.jobs.reduce((n, j) => n + report.results.jobs[j.id].median!, 0);
  assert.equal(report.results.jobTimeS, Number((jobSum / 1000).toFixed(2)));
  assert.ok(report.results.holding!.firstMinuteMs! > 0);
  assert.equal(report.results.energy, null, 'no energy without --energy');
  assert.equal(s.fake.starts, 2, 'a cold start, and a start again from the cache');
  assert.match(s.cleared[0], /\.bench-cache-npu$/);
  // Every request was streamed, with the server's usage asked for; Intel's route has no quirks, so none starts with a nonce.
  assert.ok(s.fake.seen.every((j) => j.stream === true && j.stream_options?.include_usage === true));
  assert.ok(s.fake.seen.every((j) => j.messages[0].role === 'user'));
  assert.deepEqual(B.checkSchema(JSON.parse(readFileSync(s.opts.out, 'utf8')), B.REPORT_SCHEMA), []);
  // Nothing in it names the person or the PC.
  assert.doesNotMatch(readFileSync(s.opts.out, 'utf8'), new RegExp(process.env.USERNAME ?? 'no-user-name-here', 'i'));
  // Tries that disagree by more than the suite allows keep it off the board.
  const noisy = structuredClone(report);
  noisy.results.short!.steady = false;
  assert.deepEqual(B.marksFor(noisy, SUITE).map((m: any) => m.code), ['noisy']);
  assert.match(B.marksFor(noisy, SUITE)[0].say, /more than 15%: short answer/);
  const noisyJob = structuredClone(report);
  noisyJob.results.jobs.reply.steady = false;
  assert.match(B.marksFor(noisyJob, SUITE)[0].say, /more than 15%: the reply job \(at one answer length\)$/);
  // A report from before (no answer tokens) keeps its own verdict, said as it was.
  delete (noisyJob.results.jobs.reply as Partial<typeof noisyJob.results.jobs.reply>).spreadAtLength;
  assert.match(B.marksFor(noisyJob, SUITE)[0].say, /more than 15%: the reply job$/);
});

test("every read and job is a prompt the server hasn't seen, so no prefix cache answers it; the short answer, writing and quality are the same each time", async () => {
  assert.equal(B.freshPrompt('Read this.', 'bench a1-7'), '[bench a1-7]\nRead this.');
  const s = await scene();
  const { code } = await B.npuBench(s.opts);
  assert.equal(code, 0, s.lines.join('\n'));
  const asked: string[] = s.fake.seen.map((j) => j.messages.at(-1).content).filter((c) => typeof c === 'string');
  assert.equal(new Set(asked.filter((p) => FRESH.test(p))).size, asked.filter((p) => FRESH.test(p)).length, 'never the same twice');
  // Each size's warm-up and tries: the same text under a first line of its own, which also keeps two sizes from sharing
  // their first lines (readPrompt's 1,024 tokens start as its 512 do).
  const reads = asked.filter((p) => p.endsWith(SUITE.read.question));
  for (const n of SUITE.read.sizes) {
    const these = reads.filter((p) => p.replace(FRESH, '') === B.readPrompt(SUITE, n));
    assert.equal(these.length, SUITE.warmups + SUITE.tries.full, `${n} tokens`);
    assert.ok(these.every((p) => FRESH.test(p)));
    assert.equal(new Set(these).size, these.length, `${n} tokens: two reads, two prompts`);
  }
  assert.equal(reads.length, SUITE.read.sizes.length * (SUITE.warmups + SUITE.tries.full) + 1, 'and the read near the cap');
  assert.ok(reads.every((p) => FRESH.test(p)));
  // The jobs too, and holding speed's triage jobs after them.
  for (const job of SUITE.jobs) {
    const these = asked.filter((p) => p.replace(FRESH, '') === B.promptOf(SUITE, job));
    assert.ok(these.length >= SUITE.warmups + SUITE.tries.full, job.id);
    assert.ok(these.every((p) => FRESH.test(p)), job.id);
    assert.equal(new Set(these).size, these.length, job.id);
  }
  // Shorter than a block, or graded rather than timed: asked as they are.
  assert.ok(asked.filter((p) => p === SUITE.short.prompt).length > SUITE.tries.full);
  assert.equal(asked.filter((p) => p === SUITE.write.prompt).length, SUITE.warmups + SUITE.tries.full);
  for (const item of SUITE.quality) assert.ok(asked.includes(B.promptOf(SUITE, item)), item.id);
});

test("a server that doesn't stream or count tokens is measured all the same, and marked so it isn't ranked", async () => {
  const s = await scene({ stream: false, usage: false });
  const { code, report } = await B.npuBench({ ...s.opts, profile: 'quick' });
  assert.equal(code, 0);
  assert.equal(report.run.streamed, false);
  assert.equal(report.run.usageReported, false);
  assert.deepEqual(report.marks.map((m: any) => m.code), ['quick', 'not-streamed', 'no-usage']);
  assert.equal(report.ranked, false);
  // Neither the answers' tokens nor their first tokens: each job is judged on its whole times.
  for (const j of SUITE.jobs) assert.deepEqual(report.results.jobs[j.id].answerTokens, [null, null, null]);
  assert.equal(report.results.holding, null, 'a quick run skips holding speed');
});

test("--no-setup with the chat model here and Intel's embedder not: nothing pulled, the suite asks for no embeddings; with the chat model gone too, refused, and the prompt names the chat model's size", async () => {
  // Intel's embedding model is in the route's embedServer, not its models: on WEASELDEV02 (2026-10-17) setup pulled it
  // (428 MB through OpenVINO Model Server) past --no-setup, because the bench counted only the route's models.
  const s = await scene();
  const route = s.catalog.routes.intel;
  const models = [...route.models, ...Object.values(route.generations).flatMap((g: any) => [...(g.models ?? []), ...(g.smallPc?.models ?? [])])];
  for (const m of models.filter((m: any) => m.present)) {
    const file = V.expandRoute(m.present, { tools: s.tools, env: s.opts.env });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  const embedder = V.embedPaths(route, s.tools, s.opts.env).model;
  assert.ok(route.embedServer && !existsSync(embedder), "Intel's route has an embedding server, and its model isn't here");
  const ran: string[] = [];
  const io = { ...s.opts.io, setup: { run: async (exe: string, args: string[]) => (ran.push([exe, ...args].join(' ')), { code: 0, out: '' }) } };
  let asked: string | null = null;
  const confirm = async (q: string) => ((asked = q), false);
  const { code, report } = await B.npuBench({ ...s.opts, io, yes: false, setup: false, confirm, profile: 'quick' });
  assert.equal(code, 0, s.lines.join('\n'));
  assert.deepEqual(report.marks.map((m: any) => m.code), ['quick'], 'no setup mark: nothing was missing');
  assert.equal(asked, null, 'nothing to ask');
  assert.deepEqual(ran.filter((r) => /pull/i.test(r) || r.includes(route.embedServer!.model.id)), [], 'nothing pulled, the embedder least of all');
  assert.doesNotMatch(s.lines.join('\n'), /downloading/);
  assert.ok(!existsSync(embedder));

  // Nothing here: --no-setup refuses before anything runs, and the prompt counts what setup would fetch, the chat model.
  const bare = await scene();
  const before = ran.length;
  const off = await B.npuBench({ ...bare.opts, io: { ...bare.opts.io, setup: io.setup }, yes: false, setup: false, confirm });
  assert.equal(off.code, 1);
  assert.deepEqual(off.report.marks.map((m: any) => m.code), ['setup']);
  assert.match(off.report.marks[0].say, /--no-setup was given/);
  assert.equal(asked, null, '--no-setup refuses without asking');
  const no = await B.npuBench({ ...bare.opts, io: { ...bare.opts.io, setup: io.setup }, yes: false, confirm });
  assert.equal(no.code, 1);
  const chat = models.find((m: any) => m.id === no.report.run.model)!;
  assert.equal(asked, `Download ${mb(chat.size)} (${route.server} ${route.version} and its models)? [y/N] `);
  assert.match(no.report.marks[0].say, new RegExp(`would download ${mb(chat.size)}: run again with --yes`));
  assert.equal(bare.fake.starts, 0, 'nothing started where it refused');
  assert.equal(ran.length, before, 'nor run');
});

test('a model that answers nonsense never gets past its first answer; a busy processor or the battery keeps a run off the board', async () => {
  const bad = await scene({ wrong: 'banana banana' });
  const r1 = await B.npuBench(bad.opts);
  assert.equal(r1.code, 1);
  assert.deepEqual(r1.report.marks.map((m: any) => m.code), ['start']);
  const busy = await scene({ busy: 60, conditions: { ...PLUGGED, onBattery: true }, rate: (w) => (w ? 10000 : 4000) });
  const r2 = await B.npuBench({ ...busy.opts, profile: 'quick', energy: true });
  assert.equal(r2.code, 0);
  assert.deepEqual(r2.report.marks.map((m: any) => m.code), ['quick', 'battery', 'busy']);
  assert.equal(r2.report.conditions.cpuBusyPercent, 60);
  assert.equal(r2.report.results.energy!.restMilliwatts, 4000);
  assert.ok(r2.report.results.energy!.loadMilliwatts > 4000);
  assert.ok(r2.report.results.energy!.jobs > 0);
  assert.ok(r2.report.results.energy!.millijoulesPerToken! > 0);
});

test("a generation with its own cap is run, reported and read near at it; --cap isn't undone by it; a GPU run says nothing of the NPU", async () => {
  const gen = V.routeFor(V.NPU_CATALOG.routes.intel, 'meteor-lake');
  assert.notEqual(gen.maxContextTokens, V.NPU_CATALOG.routes.intel.maxContextTokens, "Meteor Lake's NPU 3720 compiles a shorter prompt than the route's");
  const capOf = (cmd: string[]) => cmd[cmd.indexOf('--max_prompt_len') + 1];
  const own = await scene({ npu: METEOR });
  const r = await B.npuBench({ ...own.opts, profile: 'quick' });
  assert.equal(r.code, 0, own.lines.join('\n'));
  assert.equal(r.report.run.cap, gen.maxContextTokens, "the generation's cap, not the route's");
  assert.equal(capOf(own.fake.commands[0]), String(gen.maxContextTokens));
  assert.ok(r.report.results.readAtCap, own.lines.join('\n'));
  assert.ok(own.lines.some((l) => l.startsWith(`reading near the cap (`) && l.includes(` of ${gen.maxContextTokens} tokens)`)), own.lines.join('\n'));

  const asked = await scene({ npu: METEOR });
  const r2 = await B.npuBench({ ...asked.opts, profile: 'quick', cap: 4096 });
  assert.equal(r2.report.run.cap, 4096);
  assert.equal(capOf(asked.fake.commands[0]), '4096', '--cap is what the server compiles');

  // On the graphics card: no cap compiled, the long read at the NPU's, and setup's lines aren't about the NPU.
  const card = await scene({ npu: METEOR });
  const r3 = await B.npuBench({ ...card.opts, profile: 'quick', device: 'GPU' });
  assert.equal(r3.code, 0, card.lines.join('\n'));
  assert.equal(r3.report.run.cap, null);
  assert.ok(!card.fake.commands[0].includes('--max_prompt_len'));
  assert.ok(card.lines.some((l) => l.includes(` of ${gen.maxContextTokens} tokens)`)), 'comparable with the NPU run');
  assert.deepEqual(card.lines.filter((l) => /on (the|this) NPU/.test(l)), []);
  assert.ok(card.lines.some((l) => /OpenVINO Model Server is set up for: chat/.test(l)), card.lines.join('\n'));
});

test("an energy figure only when working draws clearly more than rest: the battery's wobble isn't the model's energy", async () => {
  for (const [rest, work] of [
    [28_373, 29_970], // the Lunar Lake laptop's NPU run: 2.3 mJ a token, from a reading at rest nearly twice the real drain
    [29_346, 29_019], // its graphics card's: less working than resting
  ]) {
    const s = await scene({ conditions: { ...PLUGGED, onBattery: true }, rate: (w) => (w ? work : rest) });
    const r = await B.npuBench({ ...s.opts, profile: 'quick', energy: true });
    assert.equal(r.code, 0);
    assert.equal(r.report.results.energy!.millijoulesPerToken, null, `${rest} → ${work} mW`);
    assert.equal(r.report.results.energy!.restMilliwatts, rest, 'what was read is kept');
    assert.ok(s.lines.some((l) => /^energy: not counted: working read \d+ mW against \d+ mW at rest/.test(l)), s.lines.join('\n'));
  }
});

test("a run on a Snapdragon: GenieX's nonce first in every request, and each picture a file it reads, not a data: URL", async () => {
  const geniex = V.NPU_CATALOG.routes.qualcomm;
  assert.deepEqual(geniex.quirks, ['prefix-leak', 'image-path'], "the quirks come from GenieX's route, as the kit's own requests take them");
  const s = await scene({ vendor: 'qualcomm' });
  const { code, report } = await B.npuBench({ ...s.opts, profile: 'quick' });
  assert.equal(code, 0, s.lines.join('\n'));
  assert.equal(report.run.server, `GenieX ${geniex.version}`);
  assert.equal(report.run.cap, geniex.maxContextTokens);
  assert.equal(report.quality.passed, 24);
  // GenieX leaks state between requests that share a prompt's start, and the benchmark asks the same prompt a warm-up
  // and three or five times over: every request starts with a nonce of its own, as an agent's do.
  const nonces = s.fake.seen.map((j) => (j.messages[0].role === 'system' ? /^\[req [a-z0-9]+\]/.exec(j.messages[0].content)?.[0] : undefined));
  assert.ok(nonces.every(Boolean), 'a nonce first in every request');
  assert.equal(new Set(nonces).size, nonces.length, 'never the same twice');
  const shorts = s.fake.seen.filter((j) => j.messages.at(-1).content === SUITE.short.prompt);
  assert.ok(shorts.length >= SUITE.warmups + SUITE.tries.quick, 'the same prompt, asked again and again');
  // Each picture as a PNG file, its path sent, there while GenieX reads it: a warm-up, then the four graded.
  assert.equal(s.fake.pictures.length, SUITE.warmups + SUITE.vision.length);
  for (const p of s.fake.pictures) {
    assert.doesNotMatch(p.url, /^data:/);
    assert.ok(path.isAbsolute(p.url), p.url);
    assert.ok(p.pngFile, `${p.url}: a PNG file on this PC`);
  }
  assert.deepEqual(report.vision, { passed: 4, of: 4, items: report.vision!.items });
  assert.deepEqual(report.vision!.items.map((x: any) => x.id), SUITE.vision.map((v: any) => v.id), 'the warm-up is no item');
  assert.ok(s.fake.pictures.every((p) => !existsSync(p.url)), 'the pictures are gone after the run');
  assert.ok(s.lines.some((l) => /^GenieX's requests as the kit sends them: a nonce first in every request \(prefix-leak\); each picture as a file/.test(l)), s.lines.join('\n'));
  assert.deepEqual(B.checkSchema(JSON.parse(readFileSync(s.opts.out, 'utf8')), B.REPORT_SCHEMA), []);
});

test('on a Snapdragon GenieX is the NPU only: --device GPU and --cap are refused before anything starts', async () => {
  const s = await scene({ vendor: 'qualcomm' });
  const gpu = await B.npuBench({ ...s.opts, device: 'GPU' });
  assert.equal(gpu.code, 2);
  assert.match(gpu.report.marks[0].say, /GenieX runs on the NPU only/);
  const cap = await B.npuBench({ ...s.opts, cap: 4096 });
  assert.equal(cap.code, 2);
  assert.match(cap.report.marks[0].say, /no prompt cap to set/);
  assert.equal(s.fake.starts, 0);
});

test('--generation snapdragon-x on an X2: the X Elite played (its AI Hub build, from a folder of its own), the report says so, and it is never ranked', async () => {
  const s = await scene({ vendor: 'qualcomm' });
  const ran: { args: string[]; datadir: string | undefined }[] = [];
  const run = async (_exe: string, args: string[], ro?: { env?: NodeJS.ProcessEnv }) => (ran.push({ args, datadir: ro?.env?.GENIEX_DATADIR }), { code: 0, out: '' });
  const { code, report } = await B.npuBench({ ...s.opts, profile: 'quick', generation: 'snapdragon-x', io: { ...s.opts.io, setup: { run } } });
  assert.equal(code, 0, s.lines.join('\n'));
  assert.equal(report.run.played, 'snapdragon-x');
  assert.equal(report.marks[0].code, 'played');
  assert.match(report.marks[0].say, /played snapdragon-x: its numbers are that generation's code on this NPU, not that chip's: shown, never ranked$/);
  assert.equal(report.ranked, false);
  assert.equal(report.quality.passed, 24);
  const dir = path.join(s.tools, 'played', 'snapdragon-x', 'geniex');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')), { chipset: 'qualcomm-snapdragon-x-elite' });
  assert.deepEqual(ran.map((r) => [r.args.slice(0, 3), r.datadir]), [[['--data-dir', dir, 'pull'], dir]], 'pulled into its own folder');
  for (const c of s.fake.commands) assert.deepEqual(c.slice(1, 4), ['--data-dir', portablePath(dir), 'serve']);
  assert.ok(s.lines.some((l) => /^Played: this Snapdragon X2 Elite .* plays the Snapdragon X \/ X Plus \/ X Elite \(Hexagon v73\).*Shown, never ranked\.$/.test(l)), s.lines.join('\n'));
  assert.deepEqual(B.checkSchema(JSON.parse(readFileSync(s.opts.out, 'utf8')), B.REPORT_SCHEMA), []);

  // Its own generation, named: an ordinary run, nothing played.
  const own = await scene({ vendor: 'qualcomm' });
  const mine = await B.npuBench({ ...own.opts, profile: 'quick', generation: 'snapdragon-x2' });
  assert.equal(mine.code, 0, own.lines.join('\n'));
  assert.equal(mine.report.run.played, undefined);
  assert.ok(!mine.report.marks.some((m: any) => m.code === 'played'));
});

test('--generation is refused, before anything starts, for a newer Snapdragon on an older one and on any NPU but a Snapdragon', async () => {
  const x1 = await scene({ vendor: 'qualcomm', npu: X2.replace('DEV_0FF0', 'DEV_0D0A').replace('X2 Elite Extreme - X2E94100', 'X Elite - X1E78100') });
  const up = await B.npuBench({ ...x1.opts, generation: 'snapdragon-x2' });
  assert.equal(up.code, 2);
  assert.deepEqual(up.report.marks, [{ code: 'played', say: "the Snapdragon X2 Elite / X2 Plus (Hexagon v81) is newer than this NPU (v73): its Hexagon code doesn't run on an older one" }]);
  assert.equal(x1.fake.starts, 0);
  // An Intel NPU's server builds for the NPU it finds: another generation would be its starting values alone.
  const lunar = await scene();
  const values = await B.npuBench({ ...lunar.opts, generation: 'meteor-lake' });
  assert.equal(values.code, 2);
  assert.match(values.report.marks[0].say, /^only a Snapdragon plays another generation in the benchmark/);
  assert.equal(lunar.fake.starts, 0);
  assert.deepEqual(B.parseBenchArgs(['--generation', 'snapdragon-x']), { generation: 'snapdragon-x' });
  assert.match((B.parseBenchArgs(['--generation']) as any).error, /--generation takes an older Snapdragon to play on this one/);
});

test('a candidate chats only unless --vision says it sees: pulled as its own type, found in its own folder', () => {
  const geniex = V.NPU_CATALOG.routes.qualcomm;
  const text = B.candidateRoute(geniex, 'ai-hub-models/Qwen3-4B-Instruct-2507');
  assert.deepEqual(text.models.map((m: any) => m.kinds), [['chat']], "not the kinds of GenieX's model, which sees");
  assert.deepEqual(text.models[0].pull, ['pull', 'ai-hub-models/Qwen3-4B-Instruct-2507', '--model-type', 'llm', '--skip-update']);
  // GenieX's folder drops the id's :tag, so the route's model's folder isn't taken for the candidate's.
  assert.equal(text.models[0].present, '%USERPROFILE%\\.cache\\geniex\\models\\ai-hub-models\\Qwen3-4B-Instruct-2507\\geniex.json');
  const sees = B.candidateRoute(geniex, 'qualcomm/Qwen3-VL-4B-Instruct-2:W8A16', { vision: true });
  assert.deepEqual(sees.models[0].kinds, ['chat', 'vision']);
  assert.deepEqual(sees.models[0].pull, ['pull', 'qualcomm/Qwen3-VL-4B-Instruct-2:W8A16', '--model-type', 'vlm', '--skip-update'], 'renamed once, not again inside the new name');
  assert.equal(sees.models[0].present, '%USERPROFILE%\\.cache\\geniex\\models\\qualcomm\\Qwen3-VL-4B-Instruct-2\\geniex.json');
  // FastFlowLM's tags are its models' names: the whole id is renamed.
  assert.deepEqual(B.candidateRoute(V.NPU_CATALOG.routes.amd, 'qwen3-it:1.7b').models[0].pull, ['pull', 'qwen3-it:1.7b']);
  const intel = B.candidateRoute(V.NPU_CATALOG.routes.intel, 'Castellan-AI/Qwen3-1.7B-int4-cw-ov');
  assert.equal(intel.models[0].present, '{tools}\\models\\openvino\\Castellan-AI\\Qwen3-1.7B-int4-cw-ov\\graph.pbtxt');
  assert.throws(() => B.candidateRoute(V.NPU_CATALOG.routes.intel, 'a/b', { vision: true }), /has no vision/);
  assert.deepEqual(B.parseBenchArgs(['--candidate', 'a/b', '--vision']), { candidate: 'a/b', vision: true });
  assert.match((B.parseBenchArgs(['--vision']) as any).error, /--vision says a --candidate sees/);
});

test("every X2 measures Qwen3-VL-2B as setup runs it, whatever its memory; --model the 4B measures the 4B on one", async () => {
  const TWO_B = 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0';
  const FOUR_B = 'qualcomm/Qwen3-VL-4B-Instruct:W4A16';
  const ARM16 = ARM.replace(/ram\|\d+/, 'ram|16876666880');
  const run = async (o: object, arm = ARM) => {
    const s = await scene({ vendor: 'qualcomm' });
    const pulls: string[][] = [];
    const r = await B.npuBench({ ...s.opts, detection: parseDetection(`${arm}${X2}\n`), profile: 'quick', ...o, io: { ...s.opts.io, setup: { run: async (_exe: string, args: string[]) => (pulls.push(args), { code: 0, out: '' }) } } });
    assert.equal(r.code, 0, s.lines.join('\n'));
    return { ...r, s, pulls };
  };
  for (const [what, arm] of [['the 47.6 GB X2', ARM], ['a 16 GB X2', ARM16]] as const) {
    const two = await run({}, arm);
    assert.equal(two.report.run.model, TWO_B, what);
    assert.deepEqual(two.pulls, [['pull', TWO_B, '--model-hub', 'hf', '--model-type', 'vlm', '--skip-update']], `${what}: from Hugging Face`);
    assert.deepEqual(two.s.fake.commands[0].slice(-6), ['--compute', 'npu', '--vit-compute', 'GPUOpenCL', '--nctx', '2560'], `${what}: its pictures' encoder on the Adreno and its window at 2,560 tokens, as setup starts it`);
    assert.ok(two.s.fake.seen.every((j) => j.model === TWO_B), `${what}: every request names the 2B`);
  }
  assert.equal((await run({ smallPc: true })).report.run.model, TWO_B, '--small-pc: no generation has a small PC of its own now');
  assert.equal((await run({ model: TWO_B })).report.run.model, TWO_B, '--model the X2 its own');
  for (const [what, arm] of [['the 47.6 GB X2', ARM], ['a 16 GB X2', ARM16]] as const) {
    const four = await run({ model: FOUR_B }, arm);
    assert.equal(four.report.run.model, FOUR_B, `--model the route's own on ${what}`);
    assert.ok(!four.s.fake.commands[0].includes('--vit-compute'), `${what}: GenieX's QAIRT model never gets the 2B's arguments`);
  }
  // On an X2 whose GenieX is 0.9.1 (the Smith's Use it left it), as setup and the keeper run it there.
  const s9 = await scene({ vendor: 'qualcomm' });
  const nine = await B.npuBench({ ...s9.opts, detection: parseDetection(`${ARM}${X2}\n`), profile: 'quick', io: { ...s9.opts.io, serverVersion: async () => '0.9.1' } });
  assert.equal(nine.code, 0, s9.lines.join('\n'));
  assert.equal(nine.report.run.server, 'GenieX 0.9.1');
  assert.deepEqual(s9.fake.commands[0].slice(-4), ['--compute', 'npu', '--nctx', '2560'], "GenieX 0.9 reads its pictures on the Hexagon's second session");
  const none =await B.npuBench({ ...(await scene({ vendor: 'qualcomm' })).opts, detection: parseDetection(`${ARM}${X2}\n`), profile: 'quick', model: 'a/b' });
  assert.match(none.report.marks.map((m) => m.say).join('\n'), new RegExp(`has no model a/b \\(it has ${TWO_B}, ${FOUR_B}\\)`), 'what it has: the X2\'s own, then the route\'s');
  assert.deepEqual(B.parseBenchArgs(['--small-pc']), { smallPc: true });
});

test("a text candidate on a Snapdragon is pulled as one and asked no pictures; with --vision it's asked them, not the route's model", async () => {
  const C = 'ai-hub-models/Qwen3-4B-Instruct-2507';
  for (const vision of [false, true]) {
    const s = await scene({ vendor: 'qualcomm' });
    const pulls: string[][] = [];
    const { code, report } = await B.npuBench({ ...s.opts, profile: 'quick', candidate: C, vision, io: { ...s.opts.io, setup: { run: async (_exe: string, args: string[]) => (pulls.push(args), { code: 0, out: '' }) } } });
    assert.equal(code, 0, s.lines.join('\n'));
    assert.equal(report.run.candidate, true);
    assert.equal(report.run.model, C);
    assert.deepEqual(pulls, [['pull', C, '--model-type', vision ? 'vlm' : 'llm', '--skip-update']]);
    assert.ok(s.fake.seen.every((j) => j.model === C), 'every request names the candidate');
    if (vision) {
      assert.deepEqual([report.vision!.passed, report.vision!.of], [4, 4]);
      assert.equal(s.fake.pictures.length, SUITE.warmups + SUITE.vision.length);
    } else {
      assert.equal(report.vision, null, 'a text model has no vision column');
      assert.deepEqual(s.fake.pictures, []);
    }
  }
});

test("a candidate's files are measured once it's pulled: each one in its folder, by size and SHA-256; FastFlowLM's aren't, and its log says so", async () => {
  const C = 'ai-hub-models/Qwen3-4B-Instruct-2507';
  const s = await scene({ vendor: 'qualcomm' });
  // Where GenieX's pull puts it, in the scene's %USERPROFILE%: its folder drops no tag, as this id has none.
  const dir = path.join(s.opts.env.USERPROFILE!, '.cache', 'geniex', 'models', 'ai-hub-models', 'Qwen3-4B-Instruct-2507');
  const written: Record<string, Buffer> = { 'geniex.json': Buffer.from('{"model_type": "llm"}'), 'part1_of_1.bin': Buffer.alloc(70_000, 7), 'tokenizer/tokenizer.json': Buffer.from('{}') };
  const pull = async () => {
    for (const [name, bytes] of Object.entries(written)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), bytes);
    }
    return { code: 0, out: '' };
  };
  const { code, report } = await B.npuBench({ ...s.opts, profile: 'quick', candidate: C, io: { ...s.opts.io, setup: { run: pull } } });
  assert.equal(code, 0, s.lines.join('\n'));
  const want = Object.fromEntries(Object.entries(written).map(([name, bytes]) => [name, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]));
  assert.deepEqual(report.run.files, want, 'every file, a folder inside it too, named as in the folder');
  assert.ok(s.lines.some((l) => l === "the candidate's files: 3 measured (1 MB), each one's size and SHA-256 in the report"), s.lines.join('\n'));
  const onDisk = JSON.parse(readFileSync(s.opts.out, 'utf8'));
  assert.deepEqual(onDisk.run.files, want);
  assert.deepEqual(B.checkSchema(onDisk, B.REPORT_SCHEMA), []);
  // FastFlowLM keeps its models its own way: its route's `present` names its own folder for the model, not the id, so a
  // candidate gets none (kept, it would find the route's own model and never be pulled), and nothing says where to look.
  const lines: string[] = [];
  assert.match(V.NPU_CATALOG.routes.amd.models[0].present!, /Qwen3\.5-2B-NPU2/);
  const amd = B.candidateRoute(V.NPU_CATALOG.routes.amd, 'qwen3-it:1.7b').models[0];
  assert.equal(amd.present, undefined);
  assert.equal(await B.candidateFiles(amd, { server: 'FastFlowLM', tools: s.tools, log: (l: string) => lines.push(l) }), null);
  assert.deepEqual(lines, ["the candidate's files: not measured, as FastFlowLM's route doesn't say where its models are"]);
});

test('energy on a PC busy enough to hold the bench past its windows: a reading at rest, and readings working until a job is done', async () => {
  const busy = await scene({ conditions: { ...PLUGGED, onBattery: true }, rate: (w) => (w ? 10000 : 4000) });
  // From the first reading on, every look at the clock is ten minutes later: each window has passed at its first look.
  let late = 0;
  let reading = false;
  const now = () => performance.now() + (reading ? (late += 600_000) : 0);
  const io = { ...busy.opts.io, now, dischargeRate: async () => ((reading = true), busy.opts.io.dischargeRate()) };
  const r = await B.npuBench({ ...busy.opts, io, profile: 'quick', energy: true });
  assert.equal(r.code, 0);
  const e = r.report.results.energy!;
  assert.ok(e, 'measured, not "the battery gave no discharge rate"');
  assert.equal(e.restMilliwatts, 4000);
  assert.ok(e.loadMilliwatts > 4000, 'read while working');
  assert.ok(e.jobs > 0);
});
