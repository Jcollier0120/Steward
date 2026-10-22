import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPowerShell } from './detect.ts';

/**
 * What a PC can read of its own power, for the benchmark's energy step (spec/NPU-BENCHMARK.md, Energy), and the energy a
 * stretch of work took from it. Four meters:
 *
 * - **emi**: Windows' Energy Meter counters, where the PC's firmware has them (the Snapdragon X2 laptop does): a running
 *   energy total for each part it meters (npu, gpu, cpu_cluster_0, memory, soc, system…), in picowatt-hours, with its
 *   clock in milliseconds. Read through CIM (Win32_PerfRawData_PowerMeterCounter_EnergyMeter), not by counter name,
 *   which Windows translates. No administrator needed. Two readings give a stretch's energy exactly, so it is read at
 *   each end only: its PowerShell costs the same in every stretch, and taking rest from work takes it away.
 * - **shelly:<address>**: a Shelly plug (Gen2 or later) between the wall and the PC, its present power over the local
 *   network (`/rpc/Switch.GetStatus?id=0`, `apower` in watts), read every second. The whole PC, its charger's loss too.
 * - **nvidia**: the graphics card's own reading from nvidia-smi: its running total (`total_energy_consumption`, mJ) where
 *   the card keeps one (Volta and later), else its present draw read every second. The card alone, not the PC.
 * - **battery**: the battery's discharge rate (`root\wmi` `BatteryStatus.DischargeRate`, mW) every 5 s, on battery only.
 *   Least trusted: on the Lunar Lake laptop it read nearly twice the real drain.
 *
 *   node <agent>\src\kit\power-meter.ts [--meter auto|emi|shelly:<address>|nvidia|battery] [--seconds <n>]
 *
 * says which meter the PC has (auto: the Energy Meter counters, else the battery when unplugged) and what each part
 * drew over a few seconds.
 */

export type MeterKind = 'emi' | 'shelly' | 'nvidia' | 'battery';

export interface Reading {
  /** When, in ms: the meter's own clock where it has one, else the caller's. */
  at: number;
  /** Running totals by part, in millijoules: a meter that keeps them. */
  totals?: Record<string, number>;
  /** Present power by part, in milliwatts: a meter that doesn't. */
  milliwatts?: Record<string, number>;
}

export interface Meter {
  kind: MeterKind;
  /** What it reads, for the log and the report. */
  say: string;
  /** The part that is the whole PC (system, plug, battery), or the card for nvidia's, which reads nothing else. */
  whole: string;
  /** It keeps running totals: a stretch is read at its two ends. Otherwise its power is read every `everyMs`. */
  totals: boolean;
  everyMs: number;
  read(): Promise<Reading | null>;
}

/** A stretch measured: how long, and each part's energy and average power over it. */
export interface Span {
  seconds: number;
  millijoules: Record<string, number>;
  milliwatts: Record<string, number>;
  readings: number;
}

/** A picowatt-hour in millijoules. */
const PWH_MJ = 3.6e-6;

/** The Energy Meter counters' raw values: a line `name|energy|time` for each part. */
export const EMI_PS = `$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_PerfRawData_PowerMeterCounter_EnergyMeter | ForEach-Object { "emi|$($_.Name)|$($_.Energy)|$($_.Time)" }`;

/** Reads EMI_PS's lines: each part's running total in mJ, at the counters' own clock (ms); null when there are none. */
export function parseEmi(out: string): Reading | null {
  const totals: Record<string, number> = {};
  let at: number | null = null;
  for (const line of out.split(/\r?\n/)) {
    const [tag, name, energy, time] = line.trim().split('|');
    if (tag !== 'emi' || !name || name.startsWith('_')) continue;
    const e = Number(energy);
    const t = Number(time);
    if (!Number.isFinite(e) || !Number.isFinite(t) || !energy || !time) continue;
    totals[name.toLowerCase()] = e * PWH_MJ;
    at ??= t;
  }
  return at === null || !Object.keys(totals).length ? null : { at, totals };
}

/** nvidia-smi's `total_energy_consumption,power.draw` lines (one a card): its totals (mJ) where every card has one, else its draw (mW). */
export function parseNvidia(out: string, at: number): Reading | null {
  const lines = out.split(/\r?\n/).map((l) => l.split(',').map((x) => x.trim())).filter((l) => l.length >= 2 && l[0] !== '');
  if (!lines.length) return null;
  const name = (i: number) => (lines.length === 1 ? 'card' : `card${i}`);
  const totals = lines.map((l) => Number(l[0]));
  if (totals.every(Number.isFinite)) return { at, totals: Object.fromEntries(totals.map((v, i) => [name(i), v])) };
  const draws = lines.map((l) => Number(l[1]) * 1000);
  return draws.every(Number.isFinite) ? { at, milliwatts: Object.fromEntries(draws.map((v, i) => [name(i), v])) } : null;
}

/** A Shelly plug's `Switch.GetStatus` answer: its present power (W) as the plug's milliwatts. */
export function parseShelly(json: unknown, at: number): Reading | null {
  const w = Number((json as { apower?: unknown } | null)?.apower);
  return Number.isFinite(w) ? { at, milliwatts: { plug: w * 1000 } } : null;
}

export interface MeterIo {
  now?: () => number;
  powerShell?: (script: string) => Promise<string>;
  run?: (file: string, args: string[]) => Promise<string>;
  fetch?: typeof fetch;
  dischargeRate?: () => Promise<number | null>;
}

const runFile = (file: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(file, args, { windowsHide: true, timeout: 20_000 }, (err, stdout) => resolve(err ? '' : String(stdout))));

/** The battery's discharge rate in milliwatts (0 when plugged in), or null without a battery. */
export async function dischargeRate(): Promise<number | null> {
  try {
    const out = await runPowerShell(`(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus -ErrorAction Stop | Select-Object -First 1).DischargeRate`, 20_000);
    const n = Number(out.trim());
    return out.trim() && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Whether the battery is charging now (it would swamp a plug's reading of the PC), or null without a battery. */
export async function charging(): Promise<boolean | null> {
  try {
    const out = await runPowerShell(`$b = Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus -ErrorAction Stop | Select-Object -First 1; "$($b.Charging)|$($b.ChargeRate)"`, 20_000);
    const [on, rate] = out.trim().split('|');
    if (!on) return null;
    return /^true$/i.test(on) || Number(rate) > 0;
  } catch {
    return null;
  }
}

/**
 * The meter `spec` names (`emi`, `shelly:<address>`, `nvidia`, `battery`), checked with one reading; `auto` (or none)
 * the Energy Meter counters, else the battery when `onBattery`. Null, with why, when the PC can't read it.
 */
export async function openMeter(spec: string | undefined, o: { onBattery: boolean | null; io?: MeterIo }): Promise<{ meter: Meter } | { why: string }> {
  const now = o.io?.now ?? (() => performance.now());
  const kind = (spec ?? 'auto').toLowerCase();
  const emi = async (): Promise<Meter | null> => {
    const read = async () => parseEmi(await (o.io?.powerShell ?? ((s: string) => runPowerShell(s, 20_000)))(EMI_PS));
    const first = await read();
    if (!first) return null;
    return { kind: 'emi', say: `Windows' Energy Meter counters (${Object.keys(first.totals!).join(', ')})`, whole: 'system' in first.totals! ? 'system' : Object.keys(first.totals!)[0], totals: true, everyMs: 1_000, read };
  };
  const battery = (): Meter => {
    const rate = o.io?.dischargeRate ?? dischargeRate;
    return {
      kind: 'battery',
      say: "the battery's discharge rate",
      whole: 'battery',
      totals: false,
      everyMs: 5_000,
      read: async () => {
        const v = await rate();
        return v !== null && v > 0 ? { at: now(), milliwatts: { battery: v } } : null;
      },
    };
  };
  if (kind === 'auto') {
    const m = await emi();
    if (m) return { meter: m };
    if (o.onBattery) return { meter: battery() };
    return { why: 'this PC has no Energy Meter counters and is plugged in: unplug it for the battery\'s reading, or give a meter (--meter shelly:<address> for a plug, --meter nvidia for a card)' };
  }
  if (kind === 'emi') {
    const m = await emi();
    return m ? { meter: m } : { why: "this PC has no Energy Meter counters (Windows lists none under Win32_PerfRawData_PowerMeterCounter_EnergyMeter)" };
  }
  if (kind === 'battery') return o.onBattery ? { meter: battery() } : { why: 'the PC is plugged in, so the battery reads nothing: unplug it, or give another meter' };
  if (kind === 'nvidia') {
    const read = async () => parseNvidia(await (o.io?.run ?? runFile)('nvidia-smi', ['--query-gpu=total_energy_consumption,power.draw', '--format=csv,noheader,nounits']), now());
    const first = await read();
    if (!first) return { why: "nvidia-smi gave no reading: this PC has no NVIDIA card, or its driver isn't installed" };
    const totals = !!first.totals;
    return { meter: { kind: 'nvidia', say: `the graphics card's own ${totals ? 'energy total' : 'power draw'} (nvidia-smi), the card alone`, whole: Object.keys(first.totals ?? first.milliwatts!)[0], totals, everyMs: 1_000, read } };
  }
  const shelly = /^shelly:(.+)$/.exec(spec ?? '');
  if (shelly) {
    const host = shelly[1].replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const url = `http://${host}/rpc/Switch.GetStatus?id=0`;
    const read = async () => {
      try {
        const r = await (o.io?.fetch ?? fetch)(url, { signal: AbortSignal.timeout(5_000) });
        return r.ok ? parseShelly(await r.json(), now()) : null;
      } catch {
        return null;
      }
    };
    if (o.onBattery) return { why: 'the PC is on its battery, so a plug reads nothing of it: plug it in' };
    if (!(await read())) return { why: `the plug at ${host} gave no reading (${url})` };
    return { meter: { kind: 'shelly', say: `a Shelly plug at ${host}, the whole PC from the wall`, whole: 'plug', totals: false, everyMs: 1_000, read } };
  }
  return { why: `--meter takes auto, emi, shelly:<address>, nvidia or battery, not ${spec}` };
}

/**
 * The energy a stretch took: with `work`, until it's done (a batch); with `ms`, that long, `during` run again and again
 * until one has finished (a window, as at rest or the triage minutes). A meter with totals is read at the two ends; one
 * without, every `everyMs` throughout, and on a PC busy enough to hold this process past the window, until a job has
 * finished and a reading came after it. Null when it gave no reading.
 */
export async function measureSpan(meter: Meter, o: { now: () => number; sleep: (ms: number) => Promise<void>; ms?: number; work?: () => Promise<void>; during?: () => Promise<void> }): Promise<Span | null> {
  const t0 = o.now();
  const first = meter.totals ? await meter.read() : null;
  let finished = 0;
  let stop = false;
  let done = false;
  const working = o.work
    ? o.work().finally(() => {
        done = true;
      })
    : o.during
      ? (async () => {
          while (!stop)
            try {
              await o.during!();
            } finally {
              finished++;
            }
        })()
      : null;
  const over = () => (o.work ? done : o.now() - t0 >= (o.ms ?? 0) && (!o.during || finished > 0));
  const samples: Reading[] = [];
  if (meter.totals) {
    if (o.work) await working;
    else while (!over()) await o.sleep(Math.min(meter.everyMs, Math.max(1, (o.ms ?? 0) - (o.now() - t0))));
  } else
    for (;;) {
      const end = over();
      const r = await meter.read();
      if (r?.milliwatts) samples.push(r);
      if (end || (over() && samples.length)) break;
      await o.sleep(meter.everyMs);
    }
  stop = true;
  const last = meter.totals ? await meter.read() : null;
  await working;
  if (meter.totals) {
    if (!first?.totals || !last?.totals) return null;
    const seconds = (last.at - first.at) / 1000;
    if (!(seconds > 0)) return null;
    const millijoules: Record<string, number> = {};
    for (const [p, v] of Object.entries(last.totals)) if (p in first.totals) millijoules[p] = Math.max(0, v - first.totals[p]);
    return { seconds, millijoules, milliwatts: Object.fromEntries(Object.entries(millijoules).map(([p, mj]) => [p, mj / seconds])), readings: 2 };
  }
  if (!samples.length) return null;
  const seconds = (o.now() - t0) / 1000;
  const milliwatts: Record<string, number> = {};
  for (const p of Object.keys(samples[0].milliwatts!)) {
    const xs = samples.map((s) => s.milliwatts![p]).filter((x) => Number.isFinite(x));
    if (xs.length) milliwatts[p] = xs.reduce((a, b) => a + b, 0) / xs.length;
  }
  return { seconds, milliwatts, millijoules: Object.fromEntries(Object.entries(milliwatts).map(([p, mw]) => [p, mw * seconds])), readings: samples.length };
}

/** A part's power in a log line: watts to a tenth (a hundredth under one). */
export const watts = (mw: number | undefined) => (mw === undefined ? '—' : `${(mw / 1000).toFixed(Math.abs(mw) < 1000 ? 2 : 1)} W`);

/** A part's energy in a log line: joules to a tenth (a hundredth under ten). */
export const joules = (mj: number | undefined) => (mj === undefined ? '—' : `${(mj / 1000).toFixed(Math.abs(mj) < 10_000 ? 2 : 1)} J`);

/** The parts worth naming in a log line: the whole PC, then the NPU, the graphics, the processor's clusters added up, and memory. */
export function partsSay(meter: Meter, values: Record<string, number>, say: (v: number | undefined) => string = watts): string {
  const cpu = Object.entries(values).filter(([p]) => p.startsWith('cpu')).reduce((a, [, v]) => a + v, 0);
  const named: [string, number | undefined][] = [
    ['npu', values.npu],
    ['graphics', values.gpu],
    ['processor', Object.keys(values).some((p) => p.startsWith('cpu')) ? cpu : undefined],
    ['memory', values.memory],
  ];
  const rest = named.filter(([, v]) => v !== undefined).map(([n, v]) => `${n} ${say(v)}`);
  return `${say(values[meter.whole])}${rest.length ? ` (${rest.join(', ')})` : ''}`;
}

// ------------------------------------------------------------------------------------------------
// As a command: which meter this PC has, and a few seconds of it

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const at = (k: string) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : undefined);
  const seconds = Number(at('--seconds') ?? 10);
  const onBattery = await (async () => {
    const out = await runPowerShell(`$b = Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1; "$([int]($null -ne $b))|$($b.PowerOnline)"`, 20_000);
    const [has, online] = out.trim().split('|');
    return has === '1' ? !/^true$/i.test(online ?? '') : false;
  })();
  const opened = await openMeter(at('--meter'), { onBattery });
  if ('why' in opened) {
    console.log(`No meter: ${opened.why}`);
    process.exit(1);
  }
  const { meter } = opened;
  console.log(`The meter: ${meter.say}. ${seconds} s of it, the PC as it is now:`);
  const span = await measureSpan(meter, { now: () => performance.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ms: seconds * 1000 });
  if (!span) {
    console.log('It gave no reading.');
    process.exit(1);
  }
  console.log(`  ${partsSay(meter, span.milliwatts)} over ${span.seconds.toFixed(1)} s`);
  for (const [p, mw] of Object.entries(span.milliwatts).sort((a, b) => b[1] - a[1])) console.log(`  ${p.padEnd(14)} ${watts(mw).padStart(8)}`);
}
