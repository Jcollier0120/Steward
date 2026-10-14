import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const { parseDetection } = await import('./fixture/src/kit/detect.ts');

const LUNAR = 'npu2|32.0.100.4239|2025-09-01|Intel Corporation|PCI\\VEN_8086&DEV_643E&SUBSYS_00000000&REV_04\\3&11583659&0&58|Intel(R) AI Boost';
const X64 = 'cpu|9|8|Intel(R) Core(TM) Ultra 7 256V\nram|16849174528\n';
const SUITE = B.SUITE;

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
};

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** A fake OpenVINO Model Server that knows the suite's right answers (or answers `wrong`), streamed or not. */
function fakeOvms(port: number, o: { stream?: boolean; wrong?: string; usage?: boolean } = {}) {
  const answers = new Map<string, string>();
  for (const item of [...SUITE.quality, ...SUITE.jobs]) answers.set(B.promptOf(SUITE, item), RIGHT[item.id]);
  const seen: any[] = [];
  let server: Server | null = null;
  const answerFor = (prompt: string) => {
    if (o.wrong) return o.wrong;
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
        const text = answerFor(typeof content === 'string' ? content : '');
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
  return { seen, start, stop, starts: 0 };
}

const PLUGGED = { onBattery: false, batteryPercent: 80, powerMode: 'balanced', brightness: 60, windowsBuild: '26200', make: 'HP', model: 'HP OmniBook X Laptop 17-dd0xxx' };

/** The catalog on a free port, a scratch tools home with the server "installed", and a suite that holds for moments, not minutes. */
async function scene(o: { stream?: boolean; wrong?: string; usage?: boolean; busy?: number; conditions?: typeof PLUGGED; rate?: (working: boolean) => number | null } = {}) {
  const port = await freePort();
  const catalog = structuredClone(V.NPU_CATALOG);
  catalog.routes.intel.port = port;
  delete catalog.routes.intel.models[0].pinned; // its pull is a fake that leaves no files to check
  const tools = mkdtempSync(path.join(home, 'tools-'));
  const exe = V.serverExe(catalog.routes.intel, tools);
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, '');
  for (const f of catalog.routes.intel.runtime!.files) writeFileSync(path.join(path.dirname(exe), f), '');
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
    env: { ...process.env, REEVE_HOME: home },
    detection: parseDetection(`${X64}${LUNAR}\n`),
    out: path.join(tools, 'report.json'),
    log: (l: string) => lines.push(l),
    io: {
      setup: { run: async () => ({ code: 0, out: '' }) },
      start: async () => {
        fake.starts++;
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
  for (const j of SUITE.jobs) assert.equal(report.results.jobs[j.id].passed, SUITE.tries.full);
  // The fake answers in a millisecond or so, which rounds to 0.00 s: check the sum, not that it took time.
  const jobSum = SUITE.jobs.reduce((n, j) => n + report.results.jobs[j.id].median!, 0);
  assert.equal(report.results.jobTimeS, Number((jobSum / 1000).toFixed(2)));
  assert.ok(report.results.holding!.firstMinuteMs! > 0);
  assert.equal(report.results.energy, null, 'no energy without --energy');
  assert.equal(s.fake.starts, 2, 'a cold start, and a start again from the cache');
  assert.match(s.cleared[0], /\.bench-cache-npu$/);
  // Every request was streamed, with the server's usage asked for.
  assert.ok(s.fake.seen.every((j) => j.stream === true && j.stream_options?.include_usage === true));
  assert.deepEqual(B.checkSchema(JSON.parse(readFileSync(s.opts.out, 'utf8')), B.REPORT_SCHEMA), []);
  // Nothing in it names the person or the PC.
  assert.doesNotMatch(readFileSync(s.opts.out, 'utf8'), new RegExp(process.env.USERNAME ?? 'no-user-name-here', 'i'));
  // Tries that disagree by more than the suite allows keep it off the board.
  const noisy = structuredClone(report);
  noisy.results.short!.steady = false;
  assert.deepEqual(B.marksFor(noisy, SUITE).map((m: any) => m.code), ['noisy']);
  assert.match(B.marksFor(noisy, SUITE)[0].say, /more than 15%: short answer/);
});

test("a server that doesn't stream or count tokens is measured all the same, and marked so it isn't ranked", async () => {
  const s = await scene({ stream: false, usage: false });
  const { code, report } = await B.npuBench({ ...s.opts, profile: 'quick' });
  assert.equal(code, 0);
  assert.equal(report.run.streamed, false);
  assert.equal(report.run.usageReported, false);
  assert.deepEqual(report.marks.map((m: any) => m.code), ['quick', 'not-streamed', 'no-usage']);
  assert.equal(report.ranked, false);
  assert.equal(report.results.holding, null, 'a quick run skips holding speed');
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
