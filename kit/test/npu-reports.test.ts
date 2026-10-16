import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The owners' NPU reports into npu-vendors.json (npu-reports.ts, spec/NPU-REPORTS.md): the Exchequer's summary read
// against the catalog, on made-up counts. Nothing is fetched but from a fake, and nothing is changed.
const home = mkdtempSync(path.join(tmpdir(), 'kit-npu-reports-'));
after(() => rmSync(home, { recursive: true, force: true }));

const P = await import('./fixture/src/kit/npu-reports.ts');
const V = await import('./fixture/src/kit/npu-vendors.ts');

const intel = V.NPU_CATALOG.routes.intel;
const ON_INTEL = { vendor: 'intel', pciDevice: null, server: intel.server, version: intel.version, model: 'Castellan-AI/Qwen3-4B-Instruct-2507-int4-cw-ov' } as const;
const spread = (pcs: number, median: number | null, slow: number | null) => ({ pcs, median, slow });
// As the Exchequer writes a speed no PC measured: null.
const NO_SPEEDS = { tokensPerSecond: null, coldMs: null, warmMs: null, readMsPer1k: null };
const group = (o: Record<string, unknown>) => ({ ...ON_INTEL, reports: 1, pcs: 1, passedPcs: 1, failedPcs: 0, failures: {}, drivers: ['32.0.100.4512'], cpus: ['Intel(R) Core(TM) Ultra 5 228V'], firstDay: '2026-10-20', lastDay: '2026-11-02', speeds: NO_SPEEDS, ...o }) as any;

const summary = {
  format: 'castellan-npu-summary/1',
  at: '2026-11-02T09:00:00.000Z',
  groups: [
    // Panther Lake, unverified: 4 PCs passed and none failed, slower to read and start than its starting values allow.
    group({ generation: 'panther-lake', reports: 6, pcs: 4, passedPcs: 4, drivers: ['32.0.100.5540', '32.0.100.5612'], speeds: { tokensPerSecond: spread(4, 11.4, 8), coldMs: spread(4, 150_000, 200_000), warmMs: spread(4, 1_400, 2_000), readMsPer1k: spread(4, 4_800, 6_000) } }),
    // Wildcat Lake: 3 PCs passed, but none read: its base from the route's estimate of reading, its cold start unmeasured.
    group({ generation: 'wildcat-lake', reports: 3, pcs: 3, passedPcs: 3, speeds: { tokensPerSecond: spread(3, 9, 6), coldMs: null, warmMs: spread(3, 900, 1_000), readMsPer1k: null } }),
    // Arrow Lake, unverified: 1 of 3 failing is too many.
    group({ generation: 'arrow-lake', reports: 3, pcs: 3, passedPcs: 2, failedPcs: 1, failures: { 'test-timeout': 1 } }),
    // Lunar Lake, verified: fast, inside its timeouts; its speed for the site.
    group({ generation: 'lunar-lake', reports: 5, pcs: 5, passedPcs: 5, speeds: { tokensPerSecond: spread(5, 24.26, 20), coldMs: spread(5, 41_400, 60_000), warmMs: spread(5, 600, 800), readMsPer1k: spread(5, 1_500, 2_500) } }),
    // On a server version the route no longer runs: counts for nothing.
    group({ generation: 'lunar-lake', version: '2026.3.0', reports: 2, pcs: 2, passedPcs: 2 }),
    // Meteor Lake left out for its driver: no route, so nothing about how the route runs.
    group({ generation: 'meteor-lake', server: null, version: null, model: null, reports: 2, pcs: 2, passedPcs: 0, failedPcs: 2, failures: { driver: 2 } }),
    // A PCI id nobody has listed, on 2 PCs; another on 1.
    group({ generation: 'unknown', pciDevice: 'ABCD', reports: 2, pcs: 2, passedPcs: 2 }),
    group({ vendor: 'amd', generation: 'unknown', pciDevice: '17F1', server: 'FastFlowLM', version: '1.0.7', model: 'qwen3.5:2b' }),
  ],
};

test("the summary into a patch: verified from 3 PCs with under 1 in 5 failing, timeouts the slow end needs, the site's speeds, unknown PCI ids", () => {
  const r = P.reportsPatch(summary as any);
  const panther = (r.patch as any).routes.intel.generations['panther-lake'];
  assert.equal(panther.verified, true);
  // calibrate's formulas on the slow end: a full 4,096-token read at 6 s a thousand and a 2 s answer, twice, is 55 s; a
  // 200 s start half again is 300 s; 8 tokens a second needs 250 ms a token, under the 300 it has, so that one stays.
  assert.deepEqual(panther.timeouts, { requestBaseMs: 55_000, requestPerTokenMs: 300, coldLoadMs: 300_000 });
  assert.deepEqual(panther.measured, { pcs: 4, server: intel.server, model: ON_INTEL.model, tokensPerSecond: 11.4, coldStartS: 150, at: '2026-11-02' });
  assert.match(panther.basis, /^Not measured: NPU 5 .* Measured on 4 PCs by their owners' reports \(OpenVINO Model Server 2026\.4\.1, Castellan-AI\/Qwen3-4B-Instruct-2507-int4-cw-ov\), NPU drivers 32\.0\.100\.5540 to 32\.0\.100\.5612, 2026-10-20 to 2026-11-02: writes 11\.4 tokens a second \(the slowest tenth 8\.0\);/);
  // Wildcat Lake: verified on 3 PCs; no timeouts without a cold start, and no speed for the site.
  assert.deepEqual(Object.keys((r.patch as any).routes.intel.generations['wildcat-lake']), ['verified', 'basis']);
  assert.match((r.patch as any).routes.intel.generations['wildcat-lake'].basis, /writes 9\.0 tokens a second \(the slowest tenth 6\.0\); a short answer warm in 0\.9 s \(1\.0 s\)\.$/);
  // Arrow Lake: not verified, nothing changed.
  assert.equal((r.patch as any).routes.intel.generations['arrow-lake'], undefined);
  assert.ok(r.lines.some((l) => /not verified: 1 of 3 PCs failed \(test-timeout on 1\)/.test(l)), r.lines.join('\n'));
  // Lunar Lake: verified already, inside its timeouts: only its measured speed, and its basis as it is.
  assert.deepEqual((r.patch as any).routes.intel.generations['lunar-lake'], { measured: { pcs: 5, server: intel.server, model: ON_INTEL.model, tokensPerSecond: 24.3, coldStartS: 41, at: '2026-11-02' } });
  assert.equal(r.stale, 2);
  assert.deepEqual(r.unknown, [{ vendor: 'intel', pciDevice: 'ABCD', pcs: 2, passedPcs: 2, cpus: ['Intel(R) Core(TM) Ultra 5 228V'] }]);
  assert.ok(r.lines.some((l) => /device ABCD, on 2 PCs .* add "ABCD": "<its generation>" to devices\.intel/.test(l)), r.lines.join('\n'));
  assert.equal(Object.keys((r.patch as any).routes).join(), 'intel');
});

test('short of 3 PCs it says what is missing; a verified generation failing often is pointed out, never unverified', () => {
  const two = P.reportsPatch({ ...summary, groups: [group({ generation: 'wildcat-lake', reports: 2, pcs: 2, passedPcs: 2 })] } as any);
  assert.equal(two.patch, null);
  assert.ok(two.lines.some((l) => /not verified yet: 1 more PC passing needed/.test(l)), two.lines.join('\n'));
  assert.equal(two.lines.at(-1), 'No change to npu-vendors.json.');
  const shaky = P.reportsPatch({ ...summary, groups: [group({ generation: 'meteor-lake', reports: 5, pcs: 5, passedPcs: 3, failedPcs: 2, failures: { measure: 1, 'test-nonsense': 1 } })] } as any);
  assert.equal(shaky.patch, null);
  assert.ok(shaky.lines.some((l) => /verified, but 2 of 5 PCs failed \(measure on 1, test-nonsense on 1\): worth a look/.test(l)), shaky.lines.join('\n'));
  // 4 of 5 passing is 1 in 5 failing: not under it.
  const edge = P.reportsPatch({ ...summary, groups: [group({ generation: 'panther-lake', reports: 5, pcs: 5, passedPcs: 4, failedPcs: 1, failures: { 'too-slow': 1 } })] } as any);
  assert.equal((edge.patch as any)?.routes.intel.generations['panther-lake']?.verified, undefined);
});

test("the reports' sentence in a basis replaces the one they put there before, and leaves the rest", () => {
  const g = summary.groups[0] as any;
  const once = P.withReportsBasis('Not measured: a guess.', P.reportsBasis(g));
  assert.match(once, /^Not measured: a guess\. Measured on 4 PCs by their owners' reports/);
  const again = P.withReportsBasis(once, P.reportsBasis({ ...g, passedPcs: 9 }));
  assert.match(again, /^Not measured: a guess\. Measured on 9 PCs by their owners' reports .*\.$/);
  assert.equal(again.match(/by their owners' reports/g)!.length, 1);
  assert.match(P.withReportsBasis(undefined, P.reportsBasis(g)), /^Measured on 4 PCs/);
});

test('the command: a summary file, or --fetch with the publisher key, which is never printed', async () => {
  const file = path.join(home, 'summary.json');
  writeFileSync(file, JSON.stringify(summary));
  const out: string[] = [];
  assert.equal(await P.npuReportsCommand([file], { log: (l) => out.push(l) }), 0);
  assert.ok(out.includes('The patch for npu-vendors.json (a JSON merge patch: read it, merge it, release the kit):'), out.join('\n'));
  assert.equal(JSON.parse(out.at(-1)!).routes.intel.generations['panther-lake'].verified, true);

  writeFileSync(file, '{"format":"castellan-npu-summary/9","groups":[]}');
  const bad: string[] = [];
  assert.equal(await P.npuReportsCommand([file], { log: (l) => bad.push(l) }), 1);
  assert.match(bad[0], /not castellan-npu-summary\/1/);
  assert.equal(await P.npuReportsCommand([], { log: () => {} }), 2);

  const asked: { url: string; auth: string | null }[] = [];
  const fake = (async (url: string, init: any) => {
    asked.push({ url, auth: init.headers.authorization });
    return new Response(JSON.stringify(summary), { status: 200 });
  }) as typeof fetch;
  const env = { EXCHEQUER_PUBLISHER_KEY: 'pk-secret-1234' };
  const got: string[] = [];
  assert.equal(await P.npuReportsCommand(['--fetch', '--exchequer', 'http://127.0.0.1:9/'], { env, home, fetch: fake, log: (l) => got.push(l) }), 0);
  assert.deepEqual(asked, [{ url: 'http://127.0.0.1:9/api/v1/admin/npu-reports/summary', auth: 'Bearer pk-secret-1234' }]);
  const refused = (async () => new Response('{"error":"unauthorized","message":"not pk-secret-1234"}', { status: 401 })) as unknown as typeof fetch;
  const no: string[] = [];
  assert.equal(await P.npuReportsCommand(['--fetch'], { env, home, fetch: refused, log: (l) => no.push(l) }), 1);
  assert.ok(!no.join('\n').includes('pk-secret-1234'), no.join('\n'));
  assert.match(no.join('\n'), /401/);
  const none: string[] = [];
  assert.equal(await P.npuReportsCommand(['--fetch'], { env: {}, home, fetch: fake, log: (l) => none.push(l) }), 1);
  assert.match(none[0], /no publisher key/);
});
