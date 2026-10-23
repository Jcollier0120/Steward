import assert from 'node:assert/strict';
import { test } from 'node:test';

const M = await import('./fixture/src/kit/power-meter.ts');

// Two of the Snapdragon X2 laptop's Energy Meter counters, as CIM gave them on 2026-10-22: picowatt-hours, and the
// counters' clock in ms.
const X2_EMI = ['emi|SYSTEM|1246119061686198|13437174392116', 'emi|NPU|6300301920572|13437174392116', 'emi|_Total|713156195745|0', ''].join('\r\n');

test("the Energy Meter counters: each part's running total from picowatt-hours to millijoules, at the counters' clock; _Total left out", () => {
  const r = M.parseEmi(X2_EMI)!;
  assert.equal(r.at, 13437174392116);
  assert.deepEqual(Object.keys(r.totals!), ['system', 'npu']);
  assert.ok(Math.abs(r.totals!.system - 1246119061686198 * 3.6e-6) < 1e-3);
  // 114,176,432,291 pWh more over 10,022 ms, as measured: 41 W, as Windows' own formatted Power read then.
  const later = M.parseEmi('emi|SYSTEM|1246233238118489|13437174402138')!;
  const watts = (later.totals!.system - r.totals!.system) / (later.at - r.at);
  assert.ok(watts > 40 && watts < 42, `${watts} W`);
  assert.equal(M.parseEmi(''), null, 'a PC without them');
  assert.equal(M.parseEmi('problem|PowerShell: Invalid class'), null);
});

// A Core Ultra 5 225U's (Lenovo 83KS) counters, as CIM gave them on 2026-10-22: Intel's RAPL, no system and no NPU.
const INTEL_EMI = [
  'emi|RAPL_Package0_PP1|1340468781388|8773310',
  'emi|RAPL_Package0_PP0|2216215789722|8773310',
  'emi|RAPL_Package0_DRAM|0|8773310',
  'emi|RAPL_Package0_PKG|9820345436111|8773310',
  'emi|_Total|13377030007221|0',
].join('\r\n');

test("Intel's counters: the package is the whole, not the first listed (its graphics); its cores the processor, pp1 the graphics", async () => {
  const opened = await M.openMeter('auto', { onBattery: false, io: { powerShell: async () => INTEL_EMI } });
  assert.ok('meter' in opened);
  assert.equal(opened.meter.whole, 'rapl_package0_pkg');
  const said = M.partsSay(opened.meter, { rapl_package0_pp1: 2100, rapl_package0_pp0: 1100, rapl_package0_dram: 0, rapl_package0_pkg: 6100 });
  assert.equal(said, '6.1 W (graphics 2.1 W, processor 1.1 W, memory 0.00 W)');
  // The Snapdragon's, unchanged.
  const x2 = await M.openMeter('auto', { onBattery: false, io: { powerShell: async () => X2_EMI } });
  assert.ok('meter' in x2);
  assert.equal(M.partsSay(x2.meter, { system: 21300, npu: 5100, gpu: 200, cpu_cluster_0: 3000, cpu_cluster_1: 2000, memory: 900 }), '21.3 W (npu 5.1 W, graphics 0.20 W, processor 5.0 W, memory 0.90 W)');
});

test("nvidia-smi: the card's running total where it keeps one, else its draw; one name a card", () => {
  assert.deepEqual(M.parseNvidia('123456789, 35.20\r\n', 7), { at: 7, totals: { card: 123456789 } });
  assert.deepEqual(M.parseNvidia('[N/A], 35.20\r\n', 7), { at: 7, milliwatts: { card: 35200 } });
  assert.deepEqual(M.parseNvidia('10, 1.5\r\n20, 2.5\r\n', 7), { at: 7, totals: { card0: 10, card1: 20 } });
  assert.equal(M.parseNvidia('', 7), null, 'no card, or no driver');
});

test("a Shelly plug's power: its apower in watts as the plug's milliwatts", () => {
  assert.deepEqual(M.parseShelly({ id: 0, output: true, apower: 41.3, aenergy: { total: 12.5 } }, 3), { at: 3, milliwatts: { plug: 41300 } });
  assert.equal(M.parseShelly({ id: 0 }, 3), null);
  assert.equal(M.parseShelly(null, 3), null);
});

test('which meter: auto takes the counters, else the battery unplugged; each named meter checked with one reading, or why not', async () => {
  const emi = { powerShell: async () => X2_EMI };
  const none = { powerShell: async () => '' };
  const auto = await M.openMeter(undefined, { onBattery: false, io: emi });
  assert.ok('meter' in auto);
  assert.equal(auto.meter.kind, 'emi');
  assert.equal(auto.meter.whole, 'system');
  assert.equal(auto.meter.totals, true);
  assert.equal(auto.meter.say, "Windows' Energy Meter counters (system, npu)");

  const unplugged = await M.openMeter('auto', { onBattery: true, io: { ...none, dischargeRate: async () => 9000 } });
  assert.ok('meter' in unplugged && unplugged.meter.kind === 'battery');
  assert.deepEqual(await unplugged.meter.read().then((r: any) => r.milliwatts), { battery: 9000 });

  const plugged = await M.openMeter('auto', { onBattery: false, io: none });
  assert.ok('why' in plugged && /no Energy Meter counters and is plugged in/.test(plugged.why));
  assert.ok('why' in (await M.openMeter('emi', { onBattery: true, io: none })));
  assert.ok('why' in (await M.openMeter('battery', { onBattery: false, io: none })), 'plugged in, the battery reads nothing');
  assert.ok('why' in (await M.openMeter('watts', { onBattery: false, io: none })));

  const asked: string[] = [];
  const plug = { fetch: (async (url: string) => (asked.push(url), new Response(JSON.stringify({ apower: 30.5 })))) as unknown as typeof fetch };
  const shelly = await M.openMeter('shelly:http://192.168.1.40/', { onBattery: false, io: plug });
  assert.ok('meter' in shelly);
  assert.equal(shelly.meter.whole, 'plug');
  assert.equal(shelly.meter.totals, false);
  assert.deepEqual(asked, ['http://192.168.1.40/rpc/Switch.GetStatus?id=0']);
  const onBattery = await M.openMeter('shelly:192.168.1.40', { onBattery: true, io: plug });
  assert.ok('why' in onBattery && /on its battery/.test(onBattery.why), 'a plug reads nothing of a PC on its battery');
  const silent = await M.openMeter('shelly:192.168.1.40', { onBattery: false, io: { fetch: (async () => new Response('', { status: 500 })) as unknown as typeof fetch } });
  assert.ok('why' in silent && /gave no reading/.test(silent.why));

  const card = await M.openMeter('nvidia', { onBattery: false, io: { run: async () => '5000, 20.0\n' } });
  assert.ok('meter' in card && card.meter.totals && card.meter.whole === 'card');
  assert.ok('why' in (await M.openMeter('nvidia', { onBattery: false, io: { run: async () => '' } })));
});

test('a stretch with totals: read at its two ends only, the seconds from its own clock, each part its energy and average power', async () => {
  let at = 0;
  let mj = 0;
  let reads = 0;
  const meter = { kind: 'emi' as const, say: 'test', whole: 'system', totals: true, everyMs: 1000, read: async () => (reads++, { at, totals: { system: mj } }) };
  const span = await M.measureSpan(meter, {
    now: () => at,
    sleep: async () => {},
    work: async () => {
      at += 2_000;
      mj += 30_000;
    },
  });
  assert.deepEqual(span, { seconds: 2, millijoules: { system: 30_000 }, milliwatts: { system: 15_000 }, readings: 2 });
  assert.equal(reads, 2, 'no readings in between: they would cost energy of their own');
});

test('a stretch without totals: power read every so often while it lasts, averaged, and a window waits for a job to finish', async () => {
  let at = 0;
  const draws = [5_000, 7_000, 9_000];
  let i = 0;
  const meter = { kind: 'shelly' as const, say: 'test', whole: 'plug', totals: false, everyMs: 1000, read: async () => ({ at, milliwatts: { plug: draws[Math.min(i++, draws.length - 1)] } }) };
  let jobs = 0;
  const span = (await M.measureSpan(meter, {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
    ms: 1_500,
    during: async () => {
      at += 400;
      jobs++;
    },
  }))!;
  assert.ok(jobs > 0);
  assert.ok(span.readings >= 2);
  assert.ok(span.milliwatts.plug >= 5_000 && span.milliwatts.plug <= 9_000);
  assert.ok(Math.abs(span.millijoules.plug - span.milliwatts.plug * span.seconds) < 1e-6);
  const nothing = await M.measureSpan({ ...meter, read: async () => null }, { now: () => (at += 1000), sleep: async () => {}, ms: 10 });
  assert.equal(nothing, null, 'no reading, no figure');
});
