import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The NPU report (npu-report.ts, spec/NPU-REPORTS.md): what a PC may send about its NPU, and nothing more. Its
// schema is the Exchequer's too, so these are the reports it takes and the ones it refuses.
const home = mkdtempSync(path.join(tmpdir(), 'kit-npu-report-'));
process.env.REEVE_HOME = home;
delete process.env.ACCELERATORS_HOME;
after(() => rmSync(home, { recursive: true, force: true }));

const R = await import('./fixture/src/kit/npu-report.ts');
const { checkSchema } = await import('./fixture/src/kit/json-schema.ts');
const { parseDetection } = await import('./fixture/src/kit/detect.ts');
const V = await import('./fixture/src/kit/npu-vendors.ts');

const LUNAR = 'npu2|32.0.100.4239|2025-09-01|Intel Corporation|PCI\\VEN_8086&DEV_643E&SUBSYS_00000000&REV_04\\3&11583659&0&58|Intel(R) AI Boost';
const UNKNOWN = 'npu2|32.0.100.4841|2026-08-01|Intel Corporation|PCI\\VEN_8086&DEV_ABCD&SUBSYS_00000000&REV_04\\3&1&0&58|Intel(R) AI Boost';
const X64 = 'cpu|9|8|Intel(R) Core(TM) Ultra 7 258V\nram|34359738368\n';
const REPORTER = '0b6f3c1e-5d2a-4f7b-9c8e-1a2b3c4d5e6f';
const intel = () => V.routeFor(V.NPU_CATALOG.routes.intel, 'lunar-lake');

const fromSetup = (o: Partial<Parameters<typeof R.npuReportFromSetup>[0]> = {}) =>
  R.npuReportFromSetup({ detection: parseDetection(`${X64}${LUNAR}\n`), route: intel(), verified: true, speeds: { coldMs: 41_234.6, warmMs: 812, tokensPerSecond: 18.4567, readTokens: 998, readMs: 2_100 }, kit: '2.80.0', app: 'manor 0.16.200', reporter: REPORTER, day: '2026-10-16', release: '10.0.26200', ...o })!;

test('a setup report: ids, versions and times, rounded, and nothing else', () => {
  const r = fromSetup();
  assert.deepEqual(R.checkNpuReport(r), []);
  assert.deepEqual(r, {
    format: 'castellan-npu-report/1',
    reporter: REPORTER,
    day: '2026-10-16',
    source: 'setup',
    kit: '2.80.0',
    app: 'manor 0.16.200',
    chip: { vendor: 'intel', generation: 'lunar-lake', pciDevice: '643E', cpu: r.chip.cpu, npu: r.chip.npu, driver: '32.0.100.4239', driverDate: '2025-09-01', arch: 'x64', ramGb: 32, windows: '26200' },
    route: { server: intel().server, version: intel().version, model: 'Castellan-AI/Qwen3-VL-2B-Instruct-int8-sym-ov', cap: intel().maxContextTokens, verified: true },
    ok: true,
    failed: null,
    speeds: { coldMs: 41_235, warmMs: 812, tokensPerSecond: 18.46, readTokens: 998, readMs: 2_100 },
  });
  assert.match(r.chip.cpu!, /Ultra 7 258V$/);
  // Its keys, all of them: a field added here must be added to the schema, the spec and the app's preview first.
  assert.deepEqual(Object.keys(r), ['format', 'reporter', 'day', 'source', 'kit', 'app', 'chip', 'route', 'ok', 'failed', 'speeds']);
});

test("a setup report of a failure, or of an NPU left out: the step as a code, and no speeds it didn't measure", () => {
  const failed = fromSetup({ failed: 'test-timeout', speeds: { coldMs: null } });
  assert.deepEqual([failed.ok, failed.failed, failed.speeds], [false, { step: 'test-timeout' }, R.NO_SPEEDS]);
  const left = fromSetup({ route: null, skipped: 'driver', speeds: { warmMs: 5 } });
  assert.deepEqual([left.ok, left.failed, left.route, left.speeds], [false, { step: 'driver' }, null, R.NO_SPEEDS]);
  assert.deepEqual(fromSetup({ route: null }).failed, { step: 'not-supported' });
  // A generation nobody has listed: 'unknown', with its PCI id, which is how a new one is found.
  const unknown = fromSetup({ detection: parseDetection(`${X64}${UNKNOWN}\n`), route: null, skipped: 'not-supported' });
  assert.deepEqual([unknown.chip.generation, unknown.chip.pciDevice], [V.UNKNOWN_GENERATION, 'ABCD']);
  assert.deepEqual(R.checkNpuReport(unknown), []);
  // A speed no NPU writes (a clock that didn't move) is left out, rather than the report refused.
  const odd = fromSetup({ speeds: { coldMs: 1e12, warmMs: 0, tokensPerSecond: Infinity, readTokens: 1e9, readMs: -1 } });
  assert.deepEqual(odd.speeds, { coldMs: 86_400_000, warmMs: 0, tokensPerSecond: null, readTokens: null, readMs: null });
  assert.deepEqual(R.checkNpuReport(odd), []);
  // A PC without an NPU has no report.
  assert.equal(R.npuReportFromSetup({ detection: parseDetection(X64), kit: '2.80.0', reporter: REPORTER }), null);
  // Why setup left an NPU out, as a code.
  assert.equal(R.skippedStep({ supported: false, why: 'its driver needs an update (32.0.100.3104 or newer)' }, false), 'driver');
  assert.equal(R.skippedStep({ supported: false, why: 'no model server runs on it yet' }, false), 'not-supported');
  assert.equal(R.skippedStep({ supported: true }, true), 'memory');
  assert.equal(R.skippedStep({ supported: true }, false), null);
  assert.equal(R.skippedStep(null, true), null);
});

test("names as Windows gives them, but never a path, a user's name in one, or a line break", () => {
  assert.equal(R.reportText('  Intel(R) Core(TM)\r\n Ultra 7  258V '), 'Intel(R) Core(TM) Ultra 7 258V');
  assert.equal(R.reportText('C:\\Users\\jeremy\\npu.exe'), null);
  assert.equal(R.reportText('device: Jeremy’s laptop'), null);
  assert.equal(R.reportText(''), null);
  assert.equal([...R.reportText('x'.repeat(300))!].length, 100);
  assert.equal(R.windowsBuild('10.0.26200'), '26200');
  assert.equal(R.windowsBuild('nonsense'), null);
  assert.equal(R.reportApp('manor 0.16.200'), 'manor 0.16.200');
  assert.equal(R.reportApp('Manor at C:\\Users\\jeremy'), null);
  assert.equal(R.reportApp(undefined), null);
  // A chip whose fields aren't what they should be leaves them out rather than send them.
  const odd = parseDetection(`${X64}${LUNAR}\n`);
  Object.assign(odd.npu!, { driver: 'C:\\drivers\\npu.inf', driverDate: 'yesterday', generation: 'Lunar Lake!' });
  const chip = R.reportChip(odd, { release: '10.0.26200' });
  assert.deepEqual([chip.driver, chip.driverDate, chip.generation], [null, null, null]);
});

test('the schema refuses what a report may not hold: other fields, paths, long text, numbers out of range', () => {
  const ok = fromSetup();
  const bad = (change: (r: any) => void) => {
    const r = structuredClone(ok) as any;
    change(r);
    return R.checkNpuReport(r);
  };
  assert.deepEqual(bad(() => {}), []);
  assert.match(bad((r) => (r.user = 'jeremy')).join(), /report\.user isn't in the schema/);
  assert.match(bad((r) => (r.chip.hostname = 'DESKTOP-1')).join(), /report\.chip\.hostname isn't in the schema/);
  assert.match(bad((r) => (r.chip.cpu = 'C:\\Users\\jeremy')).join(), /report\.chip\.cpu doesn't match/);
  assert.match(bad((r) => (r.chip.npu = 'x'.repeat(101))).join(), /longer than 100/);
  assert.match(bad((r) => (r.reporter = 'jeremy@example.com')).join(), /report\.reporter doesn't match/);
  assert.match(bad((r) => (r.failed = { step: 'C:\\Users\\jeremy\\server.exe crashed' })).join(), /report\.failed\.step is/);
  assert.match(bad((r) => (r.failed = { step: 'test', why: 'its words' })).join(), /report\.failed\.why isn't in the schema/);
  assert.match(bad((r) => (r.speeds.coldMs = -1)).join(), /under 0/);
  assert.match(bad((r) => (r.speeds.warmMs = 1.5)).join(), /is number, not integer or null/);
  assert.match(bad((r) => delete r.speeds).join(), /report\.speeds is missing/);
  assert.match(bad((r) => (r.format = 'castellan-npu-report/2')).join(), /report\.format isn't/);
  // Object's own names are keys like any other: refused as extra, and never standing in for a missing one.
  assert.match(bad((r) => (r.constructor = 'x')).join(), /report\.constructor isn't in the schema/);
  assert.match(bad((r) => Object.defineProperty(r.chip, '__proto__', { value: 'x', enumerable: true })).join(), /report\.chip\.__proto__ isn't in the schema/);
  assert.match(bad((r) => (r.route.toString = 'x')).join(), /report\.route\.toString isn't in the schema/);
  assert.deepEqual(checkSchema({}, { type: 'object', required: ['toString'] }), ['report.toString is missing']);
});

test('json-schema: $ref to its own $defs, several types, items, and an unknown $ref said plainly', () => {
  const schema = { $defs: { n: { type: ['integer', 'null'], minimum: 1 } }, type: 'object', properties: { a: { $ref: '#/$defs/n' }, b: { type: 'array', items: { $ref: '#/$defs/n' } }, c: { $ref: '#/$defs/missing' } } };
  assert.deepEqual(checkSchema({ a: null, b: [1, 2] }, schema), []);
  assert.deepEqual(checkSchema({ a: 0, b: [1, 'x'] }, schema), ['report.a is under 1', 'report.b[1] is string, not integer or null']);
  assert.deepEqual(checkSchema({ c: 1 }, schema), ["report.c's schema names #/$defs/missing, which it hasn't"]);
});

test('an NPU check report: its steps\' numbers, and the first step that failed as a code', () => {
  const steps = [
    { step: 'detect', ok: true, say: '' },
    { step: 'setup', ok: true, say: '', ms: 1 },
    { step: 'first-answer', ok: true, say: '', ms: 9_000, data: { loadMs: 62_000 } },
    { step: 'warm', ok: true, say: '', ms: 700 },
    { step: 'speed', ok: true, say: '', ms: 6_000, data: { tokensPerSecond: 20 } },
    { step: 'read', ok: null, say: '', ms: 3_000, data: { promptTokens: 1_228 } },
    { step: 'cap', ok: false, say: '' },
    { step: 'two-at-once', ok: false, say: '' },
  ];
  const check = { at: '2026-10-16T10:00:00.000Z', pc: { cpu: 'Intel(R) Core(TM) Ultra 7 258V', arch: 'x64', ramGb: 32 }, npu: { name: 'Intel(R) AI Boost', vendor: 'intel', generation: 'lunar-lake', deviceId: 'PCI\\VEN_8086&DEV_643E&SUBSYS_00000000', driver: '32.0.100.4239', driverDate: '2025-09-01' }, generation: 'lunar-lake', steps, ok: false } as any;
  const r = R.npuReportFromCheck(check, { route: intel(), verified: true, kit: '2.80.0', reporter: REPORTER, release: '10.0.26200' });
  assert.deepEqual(R.checkNpuReport(r), []);
  assert.deepEqual([r.source, r.day, r.ok, r.failed, r.chip.pciDevice, r.chip.ramGb], ['npu-check', '2026-10-16', false, { step: 'cap' }, '643E', 32]);
  assert.deepEqual(r.speeds, { coldMs: 62_000, warmMs: 700, tokensPerSecond: 20, readTokens: 1_228, readMs: 3_000 });
  // A step the report has no code for counts as the test failing.
  const other = R.npuReportFromCheck({ ...check, steps: [{ step: 'embed-kit-test', ok: false, say: '' }] }, { route: intel(), verified: false, kit: '2.80.0', reporter: REPORTER });
  assert.deepEqual([other.failed, other.route!.verified], [{ step: 'test' }, false]);
});

test('kept on the PC whole, read back only when it matches; the reporter made once; the key the same for the same report on another day', () => {
  const file = path.join(home, 'acc', 'npu-report.json');
  const r = fromSetup();
  assert.deepEqual(R.rememberNpuReport(r, file), []);
  assert.deepEqual(R.readNpuReport(file), r);
  assert.match(R.rememberNpuReport({ ...r, chip: { ...r.chip, cpu: 'C:\\x' } } as any, file).join(), /cpu/);
  assert.deepEqual(R.readNpuReport(file), r, 'a bad one never replaces a good one');
  writeFileSync(file, '{"format":"castellan-npu-report/1"}');
  assert.equal(R.readNpuReport(file), null);
  assert.equal(R.readNpuReport(path.join(home, 'none.json')), null);

  const who = path.join(home, 'acc', 'npu-reporter.json');
  const id = R.reporterId(who);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(R.reporterId(who), id);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(who, 'utf8'))), ['id', 'about']);

  assert.equal(R.npuReportKey(r), R.npuReportKey({ ...r, day: '2026-10-17', reporter: id }));
  assert.notEqual(R.npuReportKey(r), R.npuReportKey({ ...r, speeds: { ...r.speeds, warmMs: 813 } }));
  assert.match(R.npuReportKey(r), /^[0-9a-f]{16}$/);
});
