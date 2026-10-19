import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Accelerator, type AcceleratorEntry, readAccelerator, toolsHome } from './accelerator-config.ts';
import { type Detection, detect } from './detect.ts';
import { atVersion, calibrate, CALIBRATION, generationOf, installedVersion, MAKERS, NPU_CATALOG, type NpuCatalog, type NpuDevice, type NpuPlan, type NpuRoute, type NpuSupport, type NpuVendor, NPU_VENDORS, npuSupport, pciDevice, pinnedRoute, planNpu, type Played, playedRoute, playedSay, playGeneration, routeFor, setUpPlayed, smallPc, UNKNOWN_GENERATION } from './npu-vendors.ts';
import { loadFailure, logLength, longFetch, processMemory, refusedConnection, type RunningServer, serverClient, setUpRoute, startServer, stopStartedAt } from './npu-server.ts';
import { type IdleDeps, idleSteps, realIdleDeps } from './npu-idle.ts';
import { npuReportFile, npuReportFromCheck, rememberNpuReport, reporterId } from './npu-report.ts';
import { fillerPrompt, kitVersion, mb, measureNpu, type NpuIo, npuNoteFor, saysReady, setUpNpu, testNpuEmbed, testNpuEntry } from './setup.ts';

export { processMemory, type RunningServer, startServer } from './npu-server.ts';

/**
 * The NPU check (spec/NPU-VENDORS.md, "Verified, and not"): on a PC with an NPU whose route hasn't run on real hardware,
 * it does what setup does for the NPU (its server and models, each step timed) without writing config.json, then
 * measures the server on the NPU: how long it takes to start and compile its model, a warm answer, how fast it writes
 * and reads, what happens at and past its cap, two requests at once, its memory, a start again from its compile cache,
 * and the kit's own test request in the NPU's turn; then, where the route has one, its embedding server (Qualcomm's
 * llama-server on the Hexagon), started by the kit and timed warm. It says which steps passed, and the caps and timeouts the numbers
 * suggest for npu-vendors.json, and keeps the whole report as JSON beside the servers.
 *
 * `--route intel --device CPU` rehearses a maker's route off its NPU (OpenVINO on the processor, on any PC Windows runs
 * x64 programs on): its download, layout, environment, pull, serve and routes, all but the NPU. A rehearsal runs only in
 * a scratch REEVE_HOME, so it never touches this PC's servers, models or locks.
 *
 *   node <agent>\src\kit\npu-check.ts [--yes] [--no-setup] [--route intel|amd|qualcomm] [--device NPU|CPU|GPU] [--generation <id>] [--small-pc] [--harden] [--idle] [--out <file>]
 *
 * It runs the models setup would on this PC: its generation's own, where it has any (a Snapdragon X2's Qwen3-VL-2B), and
 * on one with little memory (under idleStop.smallPcGb) its generation's smallPc models, where it has any (none now).
 * `--small-pc` runs those on a bigger PC too.
 *
 * `--generation <id>` on an NPU of another generation plays it, and verifies nothing: a Snapdragon X2 plays a Snapdragon X
 * whole (npu-vendors.ts' playGeneration: GenieX on a data folder of its own with AI Hub's X Elite build, the embeddings on
 * Hexagon v73 code); an Intel or AMD NPU runs that generation's starting values. A newer generation on an older chip is refused.
 *
 * `--idle` runs the NPU's idle stop instead of the measurements (npu-idle.ts): the keeper stops the servers once the NPU
 * goes unused, a person's request after that is told the local AI is waking and answers, and a request in flight is
 * never stopped. Each a step that passes or fails.
 */

export interface CheckStep {
  step: string;
  /** Passed, failed, or null: measured only, or not run. */
  ok: boolean | null;
  ms?: number;
  say: string;
  data?: Record<string, unknown>;
}

export interface Suggestion {
  maxContextTokens?: number;
  timeouts: { requestBaseMs?: number; requestPerTokenMs?: number; coldLoadMs?: number };
  why: string[];
}

export interface NpuCheckReport {
  at: string;
  pc: { cpu: string | null; arch: string | null; ramGb: number };
  npu: Record<string, unknown> | null;
  vendor: NpuVendor | null;
  server: string | null;
  device: string;
  rehearsal: boolean;
  /** The generation it ran on (npu-vendors.json's id: `meteor-lake`, `lunar-lake`…), or a rehearsal's --generation. */
  generation: string | null;
  /** The older Snapdragon this one played (playGeneration), its data folder filled in; null when it played none. */
  played: Played | null;
  steps: CheckStep[];
  suggest: Suggestion | null;
  /**
   * The change to npu-vendors.json this run supports (checkPatch), as a JSON merge patch: on a generation not yet
   * verified, every step passing on its NPU flips it to verified with the timeouts measured. Null otherwise.
   */
  patch: Record<string, unknown> | null;
  ok: boolean;
}

export interface NpuCheckOptions {
  /** A maker's route to rehearse on this PC instead of its own NPU's (needs a scratch REEVE_HOME). */
  vendor?: NpuVendor;
  /** The device the route's server targets (OpenVINO's --target_device): NPU unless rehearsing. */
  device?: string;
  /**
   * The generation whose starting values (routeFor) it runs with: a rehearsal's, or on an NPU another generation of its
   * maker's played by this one (the Lunar Lake standing in for an NPU 3720), which verifies nothing. Unset, the NPU's own.
   */
  generation?: string;
  /** The models a PC with little memory runs (its generation's smallPc), whatever this PC's memory. */
  smallPc?: boolean;
  /**
   * Setup's hardening, on this PC's NPU (hardenCheck): the failures setup must fall back from quietly, forced (a model
   * that answers nonsense, an impossible timeout, a driver below the minimum), and setup's calibration checked
   * against what it measured. Each a step that passes or fails; instead of the measurements.
   */
  harden?: boolean;
  /** The NPU's idle stop, run for real (npu-idle.ts' idleSteps), instead of the measurements. */
  idle?: boolean;
  /** --idle's idle time for the keeper (a minute by default). */
  idleMs?: number;
  /** Install the server and models when they're missing (default); false checks only what's there. */
  setup?: boolean;
  /** Download without asking. */
  yes?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  out?: string;
  /**
   * Where the NPU's report goes (npu-report.ts, spec/NPU-REPORTS.md) after a run that measured this PC's own NPU:
   * npuReportFile() by default; tests give their own, and with a given detection none is kept unless they do.
   */
  npuReportFile?: string | null;
  /** The app running the check, for its report ("manor 0.16.200"). */
  app?: string;
  log?: (line: string) => void;
  detection?: Detection;
  catalog?: NpuCatalog;
  tools?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests give fakes: the setup steps, the server's start and the requests. */
  io?: {
    setup?: Partial<NpuIo>;
    start?: (entry: AcceleratorEntry, logFile: string) => Promise<RunningServer>;
    fetch?: typeof fetch;
    memory?: (pid: number) => Promise<{ workingSetBytes: number; privateBytes: number } | null>;
    kitTest?: (entry: AcceleratorEntry) => Promise<string[]>;
    /** The embedding server's test request (setup.ts' testNpuEmbed). */
    embedTest?: (entry: AcceleratorEntry) => Promise<string[]>;
    /** --harden's test requests (its cases: timeout, nonsense, calibrate), in place of setup's own. */
    hardenTest?: (kase: string, entry: AcceleratorEntry) => Promise<string[]>;
    /** --idle's PC: the kit's requests, the keeper's looks, the servers' memory (npu-idle.ts' realIdleDeps). */
    idle?: IdleDeps;
    /** Whether a port is free (portFree): the route's own, or one a rehearsal moves to. */
    portFree?: (port: number) => Promise<boolean>;
    /** Empties the check's own compile cache before its first start (checkServe). */
    clearCache?: (dir: string) => void;
    /** The version of the route's server installed here (npu-vendors.ts' installedVersion by default). */
    serverVersion?: (route: NpuRoute) => Promise<string | null>;
    now?: () => number;
  };
}

// ------------------------------------------------------------------------------------------------
// The route, as the check runs it

/**
 * The route with its server pointed at another device (OpenVINO's --target_device): off the NPU its NPU-only
 * arguments (--max_prompt_len, its NPU plugin's settings in --plugin_config, the NPU's prefix caching turned off by
 * --enable_prefix_caching, and its embedding server's --max_length) go, so the other device keeps OpenVINO's own.
 * Its embedding server goes with it off the NPU when it has a device argument too; one without stays on the NPU. On the
 * NPU it stays where the route has it: a generation may run it on the graphics (the NPU 3720's, `embedArgs`). A route
 * without a device argument runs on its NPU only.
 */
export function routeOnDevice(route: NpuRoute, device: string): NpuRoute {
  const on = (args: string[]) => {
    const serve = [...args];
    serve[serve.indexOf('--target_device') + 1] = device.toUpperCase();
    if (device.toUpperCase() !== 'NPU') {
      for (const flag of ['--max_prompt_len', '--plugin_config', '--enable_prefix_caching', '--max_length']) {
        const j = serve.indexOf(flag);
        if (j >= 0) serve.splice(j, 2);
      }
    }
    return serve;
  };
  if (!route.serve.includes('--target_device')) {
    if (device.toUpperCase() !== 'NPU') throw new Error(`${route.server} runs on the NPU only: it has no device to choose`);
    return route;
  }
  const es = route.embedServer;
  const moves = es?.serve.includes('--target_device') && device.toUpperCase() !== 'NPU';
  return { ...route, serve: on(route.serve), ...(es && moves ? { embedServer: { ...es, serve: on(es.serve) } } : {}) };
}

/**
 * The route's servers given the check's own compile cache (OpenVINO's --cache_dir), emptied before the first start:
 * the first load compiles, as on a PC that has never run the model, or after a driver update (whose compiler can't
 * use the old compile), and the start again loads that compile. From the manor's warm cache an NPU 3720 whose
 * compile took 30 to 48 s answered first in 9 s, and the check suggested a 30 s cold load (2026-10-14).
 */
export function checkServe(route: NpuRoute): NpuRoute {
  const own = (args: string[]) => {
    const serve = [...args];
    const c = serve.indexOf('--cache_dir');
    if (c >= 0) serve[c + 1] = `${path.win32.dirname(serve[c + 1])}\\.check-cache`;
    return serve;
  };
  const es = route.embedServer;
  return { ...route, serve: own(route.serve), ...(es ? { embedServer: { ...es, serve: own(es.serve) } } : {}) };
}

/** Whether nothing answers or listens on 127.0.0.1's port. */
export async function portFree(port: number): Promise<boolean> {
  const answers = await new Promise<boolean>((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(1_000, () => (s.destroy(), res(false)));
    s.once('connect', () => (s.destroy(), res(true)));
    s.once('error', () => res(false));
  });
  if (answers) return false;
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)));
  });
}

/**
 * The route on ports nothing else holds. A server already on one (the manor's own local AI, most likely) is never
 * measured in the check's place: on the NPU the check refuses, as two servers on one NPU would skew every number; off
 * it (a rehearsal) its servers move to free ports beside it.
 */
export async function routeOnFreePorts(route: NpuRoute, onNpu: boolean, free: (port: number) => Promise<boolean> = portFree): Promise<{ route: NpuRoute; moved: string[] } | { held: number[] }> {
  const want = [route.port, ...(route.embedServer ? [route.embedServer.port] : [])];
  const held: number[] = [];
  for (const p of want) if (!(await free(p))) held.push(p);
  if (!held.length) return { route, moved: [] };
  if (onNpu) return { held };
  const taken = new Set(want);
  const moved: string[] = [];
  const pick = async (p: number) => {
    if (!held.includes(p)) return p;
    for (let q = p + 100; q < p + 200; q++) if (!taken.has(q) && (await free(q))) return (taken.add(q), moved.push(`${p} to ${q}`), q);
    throw new Error(`no free port from ${p + 100} to ${p + 199}`);
  };
  const port = await pick(route.port);
  const es = route.embedServer;
  return { route: { ...route, port, ...(es ? { embedServer: { ...es, port: await pick(es.port) } } : {}) }, moved };
}

/** A prompt of about `tokens` tokens: setup.ts' (setup's measuring read uses it too). */
export { fillerPrompt };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const roundUp = (n: number, step: number) => Math.ceil(n / step) * step;

/**
 * The caps and timeouts the measurements suggest for npu-vendors.json: a background request's base allows twice the
 * slowest full-cap read plus a warm answer, its per-token time twice what writing a token took, and a cold load half
 * again the slowest start seen. The cap stays unless a request under it failed (then the largest that passed).
 */
export function suggestFrom(steps: CheckStep[], route: Pick<NpuRoute, 'maxContextTokens' | 'timeouts'>): Suggestion | null {
  const get = (name: string) => steps.find((s) => s.step === name);
  const why: string[] = [];
  const timeouts: Suggestion['timeouts'] = {};
  const warm = get('warm');
  const speed = get('speed');
  const read = get('read');
  const tokPerS = Number(speed?.data?.tokensPerSecond) || 0;
  if (tokPerS > 0) {
    timeouts.requestPerTokenMs = roundUp((1000 / tokPerS) * 2, 50);
    why.push(`writes ${tokPerS.toFixed(1)} tokens a second: ${timeouts.requestPerTokenMs} ms a token allows twice that`);
  }
  if (warm?.ok && read?.ms) {
    timeouts.requestBaseMs = roundUp(Math.max(10_000, (read.ms + (warm.ms ?? 0)) * 2), 5_000);
    why.push(`reading ${read.data?.promptTokens ?? '?'} tokens took ${(read.ms / 1000).toFixed(1)} s: a ${timeouts.requestBaseMs / 1000} s base allows twice that and a warm answer`);
  }
  const loads = ['first-answer', 'restart', 'kit-test'].map((n) => get(n)).filter((s): s is CheckStep => !!s?.ok && typeof s.data?.loadMs === 'number').map((s) => s.data!.loadMs as number);
  if (loads.length) {
    timeouts.coldLoadMs = roundUp(Math.max(...loads) * 1.5, 30_000);
    why.push(`the slowest start to a first answer took ${(Math.max(...loads) / 1000).toFixed(0)} s: ${timeouts.coldLoadMs / 1000} s allows half again`);
  }
  const cap = get('cap');
  let maxContextTokens: number | undefined;
  const largestOk = Number(cap?.data?.largestOk) || 0;
  if (cap && cap.data?.underCapFailed && largestOk) {
    maxContextTokens = largestOk;
    why.push(`a request under the cap (${route.maxContextTokens}) failed: ${largestOk} is the largest that passed`);
  }
  if (!why.length) return null;
  return { ...(maxContextTokens ? { maxContextTokens } : {}), timeouts, why };
}

// ------------------------------------------------------------------------------------------------
// The check

/** Runs the check: the report, and 0 when every step that can pass did. */
export async function npuCheck(o: NpuCheckOptions = {}): Promise<{ code: number; report: NpuCheckReport }> {
  const log = o.log ?? console.log;
  const env = o.env ?? process.env;
  const catalog = o.catalog ?? NPU_CATALOG;
  const now = o.io?.now ?? (() => performance.now());
  const http = o.io?.fetch ?? longFetch;
  const steps: CheckStep[] = [];
  const add = (s: CheckStep) => {
    steps.push(s);
    const mark = s.ok === true ? 'ok  ' : s.ok === false ? 'FAIL' : '--  ';
    log(`${mark} ${s.step}${s.ms !== undefined ? ` (${(s.ms / 1000).toFixed(1)} s)` : ''}: ${s.say}`);
    return s;
  };

  const d = o.detection ?? (await detect());
  const npu = d.npu;
  const report: NpuCheckReport = {
    at: new Date().toISOString(),
    pc: { cpu: d.cpu?.name ?? null, arch: d.cpu?.arch ?? null, ramGb: Math.round(d.ramBytes / 1024 ** 3) },
    npu: npu ? { name: npu.name, manufacturer: npu.manufacturer, deviceId: npu.deviceId, pciDevice: pciDevice(npu.deviceId), driver: npu.driver, driverDate: npu.driverDate, vendor: npu.vendor, generation: npu.generation, label: npu.label, supported: npu.supported, why: npu.why ?? null } : null,
    vendor: null,
    server: null,
    device: (o.device ?? 'NPU').toUpperCase(),
    rehearsal: false,
    generation: null,
    played: null,
    steps,
    suggest: null,
    patch: null,
    ok: false,
  };
  // The route measured on this PC's own NPU, once the measurements start: its NPU report is kept when the check ends.
  let measuring: { route: NpuRoute; verified: boolean } | null = null;
  const finish = (code: number) => {
    report.ok = code === 0;
    const file = o.out ?? path.join(o.tools ?? toolsHome(env), `npu-check-${report.vendor ?? 'none'}-${report.at.slice(0, 19).replace(/[:T]/g, '-')}.json`);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
      log(`The whole report: ${file}`);
    } catch (e: any) {
      log(`The report couldn't be written to ${file}: ${e?.message ?? e}`);
    }
    const keep = o.npuReportFile !== undefined ? o.npuReportFile : o.detection ? null : npuReportFile();
    if (measuring && keep) {
      try {
        const r = npuReportFromCheck(report, { ...measuring, ramBytes: d.ramBytes, kit: kitVersion(), app: o.app, reporter: reporterId(path.join(path.dirname(keep), 'npu-reporter.json')) });
        const bad = rememberNpuReport(r, keep);
        log(bad.length ? `The NPU report wasn't kept: ${bad.join('; ')}` : `The NPU report, which the app offers to send: ${keep}`);
      } catch (e: any) {
        log(`The NPU report couldn't be kept: ${e?.message ?? e}`);
      }
    }
    return { code, report };
  };

  // 1. Which NPU, and which route.
  const vendor = o.vendor ?? npu?.vendor ?? null;
  report.vendor = vendor;
  const rehearsal = !!o.vendor && o.vendor !== npu?.vendor;
  report.rehearsal = rehearsal || report.device !== 'NPU';
  add({
    step: 'detect',
    ok: rehearsal ? null : npu ? !!npu.supported : false,
    say: npu
      ? `${npu.name} (${npu.label}), device ${pciDevice(npu.deviceId) ?? npu.deviceId}, driver ${npu.driver || '?'}${npu.driverDate ? ` of ${npu.driverDate}` : ''}: ${npu.supported ? 'the manor can use it' : `not used: ${npu.why}`}${npu.supported && npu.guessed ? ' on guessed values, the most cautious its route has' : npu.supported && !npu.verified ? " (its generation hasn't run on real hardware before this check)" : ''}`
      : `Windows lists no NPU${d.problems.length ? ` (${d.problems.join('; ')})` : ''}`,
    data: { cpu: d.cpu, ramBytes: d.ramBytes, cards: d.cards.map((c) => ({ name: c.name, memoryGb: c.memoryGb })), ...(npu?.guessed ? { unknownDevice: unknownDevice(npu) } : {}) },
  });
  if (npu?.guessed) log(unknownDeviceSay(npu));
  if (!vendor || !NPU_VENDORS.includes(vendor)) return finish(1);
  if (!rehearsal && !npu?.supported) return finish(1);
  if (report.rehearsal && !env.REEVE_HOME) {
    add({ step: 'rehearsal', ok: false, say: 'a rehearsal off the NPU runs only in a scratch home: set REEVE_HOME to an empty folder, so this PC’s servers, models and locks are left alone' });
    return finish(2);
  }
  // The generation it runs on: the NPU's own, or the one a rehearsal is given (--generation), whose starting values it takes.
  // Given on an NPU of another generation, that NPU plays it, and the run verifies nothing: a Snapdragon plays an older
  // Snapdragon whole (playGeneration: its AI Hub build and its Hexagon code); an Intel or AMD NPU runs its starting values.
  const generation = rehearsal ? (o.generation ?? null) : (o.generation ?? npu?.generation ?? null);
  const playing = !rehearsal && !!o.generation && o.generation !== npu?.generation;
  if (playing) report.rehearsal = true;
  if (generation && !generationOf(catalog.routes[vendor], generation)) {
    add({ step: 'route', ok: false, say: `${vendor} has no generation ${generation} (it has ${[...Object.keys(catalog.routes[vendor].generations), UNKNOWN_GENERATION].join(', ')})` });
    return finish(2);
  }
  const play = playing ? playGeneration(npu!, generation!, catalog) : null;
  if (play?.kind === 'refused') {
    add({ step: 'play', ok: false, say: play.why });
    return finish(2);
  }
  const played = play?.kind === 'played' ? play.played : null;
  report.generation = generation;
  let route: NpuRoute;
  // The models setup runs on this PC's memory (a small PC's own, smallPc), or a small PC's when asked.
  const small = !!o.smallPc || smallPc(d.ramBytes);
  // At the server's version on this PC (a later GenieX the Smith's Use it left), as setup and the keeper run it; a
  // rehearsal of another maker's route runs that route's own.
  const version = rehearsal ? null : await (o.io?.serverVersion ?? ((r: NpuRoute) => installedVersion(r, { tools: o.tools ?? toolsHome(env), env })))(catalog.routes[vendor]);
  const generic = atVersion(pinnedRoute(catalog.routes[vendor], generation), version);
  try {
    route = routeOnDevice(routeFor(generic, generation, small), report.device);
    if (small && generationOf(catalog.routes[vendor], generation)?.smallPc) log(`A small PC's models (${o.smallPc ? '--small-pc' : `this PC's ${report.pc.ramGb} GB`}): ${route.models.map((m) => m.id).join(', ')}.`);
    if (played) route = playedRoute(route, played);
  } catch (e: any) {
    add({ step: 'route', ok: false, say: e.message });
    return finish(2);
  }
  try {
    const ports = await routeOnFreePorts(route, report.device === 'NPU', o.io?.portFree);
    if ('held' in ports) {
      add({ step: 'ports', ok: false, say: `a server already answers on ${ports.held.join(' and ')} (the manor's local AI, most likely): stop it first, as two servers on one NPU would skew every number`, data: { held: ports.held } });
      return finish(2);
    }
    route = ports.route;
    if (ports.moved.length) log(`A server already answers on the route's port (the manor's local AI, most likely): the rehearsal's moved from ${ports.moved.join(', ')}.`);
  } catch (e: any) {
    add({ step: 'ports', ok: false, say: e.message });
    return finish(2);
  }
  // The measurements compile the model in a cache of their own (the idle stop and hardening keep the manor's).
  if (!o.idle && !o.harden) route = checkServe(route);
  report.server = `${route.server} ${route.version}`;
  const tools = o.tools ?? toolsHome(env);
  const support: NpuSupport = rehearsal ? { vendor, generation, label: `${route.server} rehearsal`, supported: true, verified: false } : playing ? { ...npu!, generation, verified: false } : npu!;
  if (played) {
    // Its own GenieX data folder, naming the played chip to AI Hub, before the plan looks for its models there.
    const dir = setUpPlayed(played, tools);
    report.played = { ...played, dataDir: dir };
    log(`Played: ${playedSay(played, dir, catalog)}. A rehearsal, so npu-vendors.json is left as it is.`);
  } else if (playing) log(`Running ${generation}'s starting values on this ${npu!.generation ?? 'NPU'}: a rehearsal, so npu-vendors.json is left as it is.`);
  // This PC's cards, so its embeddings take the turn setup gives them (on the graphics, the graphics').
  const plan = planNpu({ support, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env, catalog: { ...catalog, routes: { ...catalog.routes, [vendor]: route } }, cards: d.cards })!;
  add({ step: 'requirements', ok: true, say: plan.runtime ? `${route.server} needs ${plan.runtime.what}, which setup puts beside it (${mb(plan.runtime.size)}, no administrator)` : `${route.server} needs nothing more on this PC` });

  // 2. Its server and models, as setup does them, each step timed.
  const needs = plan.downloadBytes;
  if (needs && o.setup === false) {
    add({ step: 'setup', ok: false, say: `${route.server} or its models aren't here, and --no-setup was given` });
    return finish(1);
  }
  if (needs && !o.yes) {
    const ok = o.confirm ? await o.confirm(`Download ${mb(needs)} (${route.server} ${route.version} and its models)? [y/N] `) : false;
    if (!ok) {
      add({ step: 'setup', ok: false, say: `it would download ${mb(needs)}: run again with --yes` });
      return finish(1);
    }
  }
  const sio: Partial<NpuIo> = o.io?.setup ?? {};
  const { entry, problems: setupProblems, timed, power } = await setUpRoute(plan, tools, sio, log, now);
  const r = { problems: setupProblems };
  add({
    step: 'setup',
    ok: !r.problems.length && !!entry,
    ms: Object.values(timed).reduce((a, b) => a + b, 0),
    say: r.problems.length ? r.problems.join('; ') : `${route.server} and ${plan.models.map((m) => m.id).join(', ')} are here${Object.keys(timed).length ? ` (${Object.entries(timed).map(([k, v]) => `${k} ${(v / 1000).toFixed(0)} s`).join(', ')})` : ', nothing to download'}`,
    data: { timed, downloadBytes: needs, exe: plan.exe },
  });
  // The tool its server sets the NPU's power mode with, where the route has one: noted, never failed, as setup does.
  // Every report says which way it went, so the reports count the PCs whose server can't set the mode.
  if (power) {
    const name = path.win32.basename(power.exe);
    add({
      step: 'power-tool',
      ok: null,
      say: power.missing
        ? `${name} isn't on this PC (${power.exe}): ${route.server} can't set the NPU's power mode`
        : power.broken
          ? `${name} couldn't start (exit 0x${(power.code! >>> 0).toString(16).toUpperCase()}): ${route.server} can't set the NPU's power mode, so the NPU runs at its default mode; ${plan.powerTool!.broken}`
          : power.code === 0
            ? `${name} ran: ${route.server} can set the NPU's power mode`
            : `${name} exited ${power.code}, which isn't the known failure: whether ${route.server} can set the NPU's power mode is unknown`,
      data: { ...power },
    });
  }
  if (!entry) return finish(1);

  // Or, asked for, setup's hardening instead of the measurements.
  if (o.harden) {
    await hardenSteps({ o, add, log, now, http, env, tools, vendor, route, support, catalog, rehearsal, device: report.device, npu });
    return finish(steps.some((s) => s.ok === false) ? 1 : 0);
  }

  // 3. The server on the NPU, measured.
  const acc = readAccelerator(entry) as Accelerator;
  const client = serverClient(acc, { http, now });

  // Or, asked for, the NPU's idle stop run for real instead.
  if (o.idle) {
    const logDir = path.join(tools, 'servers', 'logs');
    try {
      await idleSteps({ entry, route, vendor, deps: o.io?.idle ?? realIdleDeps(entry, { logFile: path.join(logDir, 'npu-check-idle.log') }), add, log, idleMs: o.idleMs, logDir });
    } finally {
      await client.stopKitStarted();
      const eb = acc.embed?.baseUrl;
      if (eb && eb !== client.ep.baseUrl) await stopStartedAt(eb, serverClient({ ...acc, chat: { ...acc.chat!, baseUrl: eb } } as Accelerator, { http, now }).listening, now);
    }
    return finish(steps.some((s) => s.ok === false) ? 1 : 0);
  }
  const { ep, lists, ask, answers, listening, untilAnswers } = client;
  const logFile = path.join(tools, 'servers', 'logs', `npu-check-${vendor}.log`);
  const start = o.io?.start ?? startServer;
  if (await listening(5_000)) {
    add({ step: 'start', ok: false, say: `something already answers at ${ep.baseUrl} (the keeper's server?): stop it first, so the check measures a start of its own` });
    return finish(1);
  }
  // From here on it measures this PC's own NPU (never a rehearsal's device): what it finds is the NPU's report.
  // A small PC's models are what it ran, so the report names them (npu-reports.ts counts them apart from the route's).
  if (!report.rehearsal) measuring = { route: routeFor(generic, generation, small), verified: !!support.verified };
  const cacheArg = route.serve.indexOf('--cache_dir');
  if (cacheArg >= 0) (o.io?.clearCache ?? ((p: string) => existsSync(p) && rmSync(p, { recursive: true, force: true })))(route.serve[cacheArg + 1].replace('{tools}', tools));
  const coldMs = route.timeouts.coldLoadMs ?? 180_000;
  // What a measured request may take: a slow device is measured, not cut off.
  const stepMs = Math.max(10 * 60_000, coldMs * 2);
  // A first start on the NPU compiles the model: allow far more than the route's cold load.
  const firstStartLimit = Math.max(20 * 60_000, coldMs * 5);
  const logFrom = logLength(logFile);
  let server = await start(entry, logFile);
  const up = await untilAnswers(firstStartLimit);
  // Answering isn't holding a model: FastFlowLM serves on after its model failed to load, and says so at /api/ps.
  const holds = up === null ? null : await client.loaded();
  const whyNot = holds === false ? loadFailure(logFile, logFrom) : null;
  add({
    step: 'start',
    ok: up !== null && holds !== false,
    ms: up ?? undefined,
    say:
      up === null
        ? `${route.server} didn't answer in ${firstStartLimit / 60_000} minutes: see ${logFile}`
        : holds === false
          ? `${route.server} answered /v1/models but holds no model: it failed to load${whyNot ? ` (${whyNot})` : ''}; see ${logFile}`
          : `${route.server} answered /v1/models${lists || holds ? ' with its model loaded' : ''}`,
    data: { pid: server.pid, logFile, ...(holds === false ? { loadFailure: whyNot } : {}) },
  });
  try {
    if (up === null || holds === false) return finish(1);
    const first = await ask('Reply with the single word: ready', 16, firstStartLimit);
    timed.first = first.ms;
    // Answering isn't enough: a model that doesn't run properly on the NPU answers with nonsense.
    const sensible = first.ok && saysReady(first.raw);
    add({
      step: 'first-answer',
      ok: sensible,
      ms: first.ms,
      say: !first.ok ? `no answer: ${first.error}` : `answered "${first.answer.slice(0, 40)}"${/<think>/.test(first.raw) ? ' (with an empty think block, stripped)' : ''}${sensible ? '' : ', not "ready" as asked: the model doesn\'t run properly on this NPU'}; the first load (and compile) took ${((up + first.ms) / 1000).toFixed(0)} s from the start`,
      data: { loadMs: up + first.ms, raw: first.raw.slice(0, 200), usage: first.usage },
    });
    if (!sensible) return finish(1);

    const warmMs: number[] = [];
    const warmSaid: string[] = [];
    for (let i = 0; i < 3; i++) {
      const w = await ask('Reply with the single word: ready', 16, stepMs);
      if (w.ok && saysReady(w.raw)) warmMs.push(w.ms);
      else warmSaid.push(w.ok ? `"${w.answer.slice(0, 30)}"` : String(w.error));
    }
    add({ step: 'warm', ok: warmMs.length === 3, ms: median(warmMs), say: `a short answer, warm: ${warmMs.map((m) => `${(m / 1000).toFixed(2)} s`).join(', ')}${warmSaid.length ? `; not "ready": ${warmSaid.join(', ')}` : ''}`, data: { ms: warmMs, ...(warmSaid.length ? { said: warmSaid } : {}) } });

    const sp = await ask('Write the numbers from one to one hundred in words, separated by commas.', 256, stepMs);
    const written = Number(sp.usage?.completion_tokens) || Math.round(sp.raw.length / 4);
    const tps = sp.ok ? written / (Math.max(1, sp.ms - (median(warmMs) || 0) / 2) / 1000) : 0;
    add({ step: 'speed', ok: sp.ok ? null : false, ms: sp.ms, say: sp.ok ? `wrote ${written} tokens${sp.usage ? '' : ' (estimated)'}: about ${tps.toFixed(1)} a second` : `failed: ${sp.error}`, data: { completionTokens: written, tokensPerSecond: Number(tps.toFixed(2)), usage: sp.usage } });

    const cap = route.maxContextTokens;
    const rd = await ask(fillerPrompt(Math.round(cap * 0.8)), 4, stepMs);
    const readTokens = Number(rd.usage?.prompt_tokens) || 0;
    add({ step: 'read', ok: rd.ok ? null : false, ms: rd.ms, say: rd.ok ? `read ${readTokens || 'about ' + Math.round(cap * 0.8)} tokens and answered in ${(rd.ms / 1000).toFixed(1)} s${readTokens ? ` (${(readTokens / (rd.ms / 1000)).toFixed(0)} a second)` : ''}` : `failed: ${rd.error}`, data: { promptTokens: readTokens || null, usage: rd.usage } });

    // At the cap, and past it: a request past it should be refused plainly (a 4xx), never take the server down.
    const sizes = [Math.round(cap * 0.95) - 64, cap + 256];
    const tried: Record<string, unknown>[] = [];
    let largestOk = 0;
    let underCapFailed = false;
    for (const n of sizes) {
      const c = await ask(fillerPrompt(n), 4, stepMs).catch((e) => ({ ok: false, status: 0, ms: 0, usage: null, error: String(e?.message ?? e), raw: '', answer: '' }));
      const promptTokens = Number(c.usage?.prompt_tokens) || null;
      const stillUp = await answers(10_000);
      tried.push({ asked: n, promptTokens, ok: c.ok, status: c.status, ms: c.ms, error: c.error, stillUp });
      if (c.ok) largestOk = Math.max(largestOk, promptTokens ?? n);
      else if (n <= cap) underCapFailed = true;
      if (!stillUp) break;
    }
    const over = tried[1];
    const capOk = !underCapFailed && !!over && over.stillUp === true;
    add({
      step: 'cap',
      ok: capOk,
      say: `${tried.map((t) => `${t.asked} tokens: ${t.ok ? 'answered' : `refused (${t.status}${t.error ? `: ${String(t.error).slice(0, 80)}` : ''})`}${t.stillUp ? '' : ', and the server stopped answering'}`).join('; ')}`,
      data: { cap, tried, largestOk, underCapFailed },
    });
    if (tried.some((t) => !t.stillUp)) {
      await server.stop();
      server = await start(entry, logFile);
      await untilAnswers(firstStartLimit);
    }

    const t0 = now();
    const pair = await Promise.all([ask('Name one colour. One word.', 16, stepMs), ask('Name one animal. One word.', 16, stepMs)]);
    const both = Math.round(now() - t0);
    add({ step: 'two-at-once', ok: pair.every((p) => p.ok), ms: both, say: pair.every((p) => p.ok) ? `both answered in ${(both / 1000).toFixed(2)} s together (${pair.map((p) => (p.ms / 1000).toFixed(2)).join(' and ')} s each)` : `${pair.filter((p) => !p.ok).map((p) => p.error).join('; ')}`, data: { ms: pair.map((p) => p.ms) } });

    const memory = server.pid ? await (o.io?.memory ?? processMemory)(server.pid) : null;
    add({ step: 'memory', ok: null, say: memory ? `${route.server} holds ${(memory.workingSetBytes / 1024 ** 3).toFixed(2)} GB (${(memory.privateBytes / 1024 ** 3).toFixed(2)} GB private)` : 'not read', data: memory ?? {} });

    // A start again, which finds its compiled model in the cache.
    await server.stop();
    const gone = await client.untilGone();
    if (!gone) {
      add({ step: 'restart', ok: false, say: `${route.server} still answers after it was stopped` });
      return finish(1);
    }
    server = await start(entry, logFile);
    const up2 = await untilAnswers(firstStartLimit);
    const again = up2 === null ? null : await ask('Reply with the single word: ready', 16, firstStartLimit).catch(() => null);
    const loadMs = up2 === null || !again?.ok || !saysReady(again.raw) ? null : up2 + again.ms;
    add({ step: 'restart', ok: loadMs !== null && loadMs <= coldMs, ms: loadMs ?? undefined, say: loadMs !== null ? `started again and answered in ${(loadMs / 1000).toFixed(0)} s (the route allows ${coldMs / 1000} s for a cold load)` : 'it didn’t answer after a start again', data: { loadMs } });
    await server.stop();
    await client.untilGone();

    // The kit's own test request: the server started as every agent starts it, in the NPU's turn.
    const k0 = now();
    const problems = await (o.io?.kitTest ?? ((e: AcceleratorEntry) => testNpuEntry(e)))(entry);
    const kitMs = Math.round(now() - k0);
    add({ step: 'kit-test', ok: !problems.length, ms: kitMs, say: problems.length ? problems.join('; ') : `the kit started ${route.server} and had its answer in its NPU turn`, data: { loadMs: kitMs } });
  } finally {
    await server.stop();
  }
  await client.stopKitStarted();

  // 4. The NPU's own embedding server, where the route has one: started as every agent starts it, in the NPU's turn,
  // then a short query and a chunk of code (what Reeve's index sends) timed warm.
  if (acc.embed?.baseUrl && acc.embed.baseUrl !== ep.baseUrl) {
    const eb = acc.embed.baseUrl;
    const up = async (timeoutMs = 1_000) => {
      try {
        await (await http(`${eb}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })).text();
        return true;
      } catch (e) {
        return !refusedConnection(e);
      }
    };
    const e0 = now();
    const problems = await (o.io?.embedTest ?? ((e: AcceleratorEntry) => testNpuEmbed(e)))(entry);
    const loadMs = Math.round(now() - e0);
    const timedEmbed = async (input: string) => {
      const t0 = now();
      try {
        const res = await http(`${eb}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: acc.embed!.model, input }), signal: AbortSignal.timeout(60_000) });
        const j: any = await res.json().catch(() => null);
        return { ms: Math.round(now() - t0), dims: Array.isArray(j?.data?.[0]?.embedding) ? j.data[0].embedding.length : 0 };
      } catch {
        return { ms: Math.round(now() - t0), dims: 0 };
      }
    };
    const query = problems.length ? null : await timedEmbed('where is the push notification token registered');
    const chunk = problems.length ? null : await timedEmbed(fillerPrompt(450));
    const ok = !problems.length && !!query?.dims && !!chunk?.dims;
    add({
      step: 'embed',
      ok,
      ms: loadMs,
      say: problems.length
        ? problems.join('; ')
        : ok
          ? `the kit started ${route.embedServer?.server ?? 'its embedding server'} and had a vector in ${(loadMs / 1000).toFixed(1)} s; warm, a query took ${query!.ms} ms and a chunk of code ${chunk!.ms} ms (${query!.dims} dimensions)`
          : 'the embedding server answered without a vector',
      data: { loadMs, queryMs: query?.ms, chunkMs: chunk?.ms, dims: query?.dims },
    });
    await stopStartedAt(eb, up, now);
  }

  report.suggest = suggestFrom(steps, route);
  if (report.suggest) {
    log(`Suggested for npu-vendors.json's ${vendor} route (${report.rehearsal ? 'a rehearsal: not for the NPU' : 'from this NPU'}):`);
    log(`  ${JSON.stringify({ ...(report.suggest.maxContextTokens ? { maxContextTokens: report.suggest.maxContextTokens } : {}), timeouts: report.suggest.timeouts })}`);
    for (const w of report.suggest.why) log(`  - ${w}`);
  }
  const pci = npu ? unknownDevice(npu).pciDevice : null;
  report.patch = checkPatch({ vendor, generation, rehearsal: report.rehearsal, steps, suggest: report.suggest, route: catalog.routes[vendor], pc: report.pc.cpu, driver: npu?.driver ?? null, device: pci, at: report.at });
  const gen = generationOf(catalog.routes[vendor], generation);
  const guessed = generation === UNKNOWN_GENERATION && !gen?.verified;
  if (report.patch) {
    log(
      guessed
        ? `The change to npu-vendors.json this run supports (it adds device ${pci} to devices as a new generation, ${newGenerationId(vendor, pci!)}, verified on this NPU: give it its processors' name in its label):`
        : `The change to npu-vendors.json this run supports (it flips ${generation} to verified):`,
    );
    log(JSON.stringify(report.patch, null, 2));
  } else if (!report.rehearsal)
    log(
      gen?.verified
        ? `${generation} is verified already: npu-vendors.json keeps its values.`
        : `No change to npu-vendors.json: ${steps.some((s) => s.ok === false) ? 'a step failed' : guessed && !pci ? "a Snapdragon's generation is told by its name, in npu-vendors.ts' npuGeneration" : 'its generation is unknown'}.`,
    );
  return finish(steps.some((s) => s.ok === false) ? 1 : 0);
}

// ------------------------------------------------------------------------------------------------
// What the run supports for npu-vendors.json

/** The id a passing check gives the new generation of an NPU setup didn't know, from its maker and PCI id (`amd-17f1`). */
export const newGenerationId = (vendor: NpuVendor, pci: string) => `${vendor}-${pci.toLowerCase()}`;

/** An NPU of a generation setup doesn't know, as npu-vendors.json's `devices` would take it: its maker and PCI id (none on a Snapdragon, told by its name). */
export function unknownDevice(npu: { vendor: NpuVendor | null; deviceId: string; name: string }): { vendor: NpuVendor | null; pciDevice: string | null; devices: Record<string, Record<string, string>> | null } {
  // A Snapdragon's ACPI id (`ACPI\VEN_QCOM&DEV_0FF0`) has a DEV_ too, but npuGeneration tells it by its name first, and
  // a new Snapdragon wants its Hexagon, AI Hub chip and pins as well: no patch makes one.
  const pci = npu.vendor === 'qualcomm' ? null : pciDevice(npu.deviceId);
  return { vendor: npu.vendor, pciDevice: pci, devices: npu.vendor && pci ? { [npu.vendor]: { [pci]: newGenerationId(npu.vendor, pci) } } : null };
}

/** The line the check prints for an NPU setup doesn't know: its PCI id, ready to add to `devices`; a Snapdragon's name, for npuGeneration. */
export function unknownDeviceSay(npu: { vendor: NpuVendor | null; deviceId: string; name: string }): string {
  const u = unknownDevice(npu);
  if (!u.devices) {
    const acpi = pciDevice(npu.deviceId);
    return `npu-vendors.json doesn't know this NPU's generation, and it has no PCI id: a Snapdragon's generation is told by its name ("${npu.name}"), in npu-vendors.ts' npuGeneration${acpi ? `, or where its name doesn't say, by its ACPI id (${acpi}) in devices.qualcomm` : ''}.`;
  }
  return `npu-vendors.json doesn't know device ${u.pciDevice}: add it to devices, under the generation it is (one it has, or the new one this check's patch adds when every step passes): ${JSON.stringify({ devices: u.devices })}`;
}

/**
 * The change to npu-vendors.json a run on a real NPU supports, as a JSON merge patch: on a generation not yet verified
 * (its starting values guessed), every step passing flips it to verified, with the timeouts the measurements suggest in
 * place of the guess (and the cap, where a request under it failed), and what they were measured on. On an NPU of a
 * generation setup doesn't know (UNKNOWN_GENERATION), with a PCI id, it adds that id to `devices` as a new generation,
 * verified, on the most cautious values it ran with (unknownGeneration) and the timeouts measured. Null for a
 * rehearsal, a failed step, an unknown Snapdragon (told by its name), or one verified already (the Lunar Lake keeps
 * its values).
 */
export function checkPatch(o: {
  vendor: NpuVendor;
  generation: string | null;
  rehearsal: boolean;
  steps: CheckStep[];
  suggest: Suggestion | null;
  route: NpuRoute;
  pc: string | null;
  driver: string | null;
  /** The NPU's PCI device id, for an unknown generation's new one. */
  device?: string | null;
  at: string;
}): Record<string, unknown> | null {
  if (o.rehearsal || !o.generation || o.steps.some((s) => s.ok === false)) return null;
  const known = Object.hasOwn(o.route.generations, o.generation);
  const gen = generationOf(o.route, o.generation);
  if (!gen || gen.verified || (!known && !o.device)) return null;
  const g: Record<string, unknown> = known ? { verified: true } : { ...gen, label: `${MAKERS[o.vendor]} NPU, device ${o.device}`, verified: true };
  if (o.suggest && Object.keys(o.suggest.timeouts).length) g.timeouts = { ...gen.timeouts, ...o.suggest.timeouts };
  if (o.suggest?.maxContextTokens) {
    g.maxContextTokens = o.suggest.maxContextTokens;
    g.caps = known ? { chat: o.suggest.maxContextTokens } : { ...gen.caps, chat: o.suggest.maxContextTokens };
    if (o.route.serve.includes('--max_prompt_len')) g.args = { ...gen.args, '--max_prompt_len': String(o.suggest.maxContextTokens) };
  }
  g.basis = `Measured by the NPU check on ${o.pc ?? 'a PC'}${o.driver ? `, NPU driver ${o.driver}` : ''}, ${o.at.slice(0, 10)}, every step passing${known ? '' : `, on the most cautious of the route's values (its cap, memory and driver minimum unmeasured)`}${o.suggest?.why.length ? `: ${o.suggest.why.join('; ')}` : ''}.`;
  if (known) return { routes: { [o.vendor]: { generations: { [o.generation]: g } } } };
  const id = newGenerationId(o.vendor, o.device!);
  return { routes: { [o.vendor]: { generations: { [id]: g } } }, devices: { [o.vendor]: { [o.device!]: id } } };
}

// ------------------------------------------------------------------------------------------------
// Setup's hardening, on the NPU

/** The group-wise AWQ export that answers nonsense on a Lunar Lake NPU (2026-10-12): the nonsense case's model. */
export const NONSENSE_MODEL = 'OpenVINO/Qwen3-4B-int4-ov';

/** The route with another chat model in its place (its pull and the file that says it's here, renamed). */
function withChatModel(route: NpuRoute, id: string, size: number): NpuRoute {
  const m = route.models.find((x) => x.kinds.includes('chat'))!;
  const swap = (s: string) => s.split(m.id).join(id).split(m.id.replace(/\//g, '\\')).join(id.replace(/\//g, '\\'));
  return { ...route, models: [{ id, kinds: ['chat'], pull: m.pull.map(swap), size, licence: 'Apache-2.0', ...(m.present ? { present: swap(m.present) } : {}) }], embedServer: undefined };
}

/**
 * Setup's hardening on this PC's NPU (or a rehearsal's device): what setup must fall back from quietly, each forced,
 * then its calibration. Each case runs setup's own NPU step (setUpNpu) as setup runs it, servers started by the kit and
 * stopped after, and is a step that passes or fails:
 * - harden-driver: a driver minimum above this PC's driver: the NPU isn't used, and its note says the driver needs an update;
 * - harden-timeout: a test request given 1 s, where the first load takes seconds: no entry, and its note says it didn't answer in time;
 * - harden-nonsense (on the NPU only): the AWQ export that answers "?option?option…" there: no entry, and its note says
 *   the chat model doesn't run properly (where it answers sensibly, nothing was forced: not counted);
 * - harden-calibrate: setup's measuring requests on this NPU as on a generation nobody has measured: the timeouts it
 *   writes are calibrate's from what it measured, cover what it measured, and stay inside CALIBRATION's bounds.
 */
async function hardenSteps(c: {
  o: NpuCheckOptions;
  add: (s: CheckStep) => CheckStep;
  log: (l: string) => void;
  now: () => number;
  http: typeof fetch;
  env: NodeJS.ProcessEnv;
  tools: string;
  vendor: NpuVendor;
  route: NpuRoute;
  support: NpuSupport;
  catalog: NpuCatalog;
  rehearsal: boolean;
  device: string;
  npu: Detection['npu'];
}): Promise<void> {
  const { o, add, log, now, http, tools, vendor, route } = c;
  const forced = o.io?.hardenTest;
  const downloadsDir = path.join(tools, 'servers', 'downloads');
  const planOf = (r: NpuRoute, support: NpuSupport) => planNpu({ support, tools, downloadsDir, env: c.env, catalog: { ...c.catalog, routes: { ...c.catalog.routes, [vendor]: r } }, noEmbed: true })!;
  const answersAt = (base: string) => async (timeoutMs = 1_000) => {
    try {
      await (await http(`${base}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })).text();
      return true;
    } catch (e) {
      return !refusedConnection(e);
    }
  };
  const chatBase = `http://127.0.0.1:${route.port}${route.baseUrlPath ?? ''}`;
  const stopAll = () => stopStartedAt(chatBase, answersAt(chatBase), now);
  const setUp = (plan: NpuPlan, io: Partial<NpuIo>) => setUpNpu(plan, tools, { ...o.io?.setup, log: (l) => log(`  ${l}`), measure: async () => null, ...io });
  const realTest = (name: string, e: AcceleratorEntry, real: () => Promise<string[]>) => (forced ? forced(name, e) : real());
  /** Until a server answers at base (its port open, its model loading or not), or ms have passed. */
  const untilAnswering = async (base: string, ms: number) => {
    const t0 = now();
    while (now() - t0 < ms && !(await answersAt(base)())) await new Promise((res) => setTimeout(res, 500));
  };

  // A driver below the minimum: decided before anything runs, on this NPU (or one of the route's devices in a rehearsal).
  const firstId = Object.keys(c.catalog.devices[vendor] ?? {})[0];
  const dev: NpuDevice | null = !c.rehearsal && c.npu
    ? { device: c.npu.name, manufacturer: c.npu.manufacturer, deviceId: c.npu.deviceId, driver: c.npu.driver, driverDate: c.npu.driverDate }
    : firstId
      ? { device: `${vendor} NPU`, manufacturer: vendor === 'intel' ? 'Intel Corporation' : vendor === 'amd' ? 'Advanced Micro Devices, Inc.' : 'Qualcomm', deviceId: `PCI\\VEN_0000&DEV_${firstId}`, driver: '32.0.100.4512', driverDate: '' }
      : null;
  if (!dev?.driver) add({ step: 'harden-driver', ok: null, say: 'no NPU driver to compare: not run' });
  else {
    const raised: NpuCatalog = structuredClone(c.catalog);
    const above = `${Number(dev.driver.split('.')[0]) + 1}.0.0.0`;
    raised.routes[vendor].driverMin = above;
    for (const g of Object.values(raised.routes[vendor].generations)) if (g.driverMin) g.driverMin = above;
    const s = npuSupport(dev, raised.routes[vendor].arch, raised);
    const note = s.why ? npuNoteFor(s.label, 'chat', s.why) : '';
    const ok = !s.supported && /driver needs an update/.test(note);
    add({ step: 'harden-driver', ok, say: ok ? `a minimum of ${above} over driver ${dev.driver}${c.rehearsal ? ' (a rehearsal: one of the route\'s devices)' : ''}: not used, noted "${note}"` : `a minimum of ${above} over driver ${dev.driver}: ${s.supported ? 'still used' : `not used, but noted "${note}"`}`, data: { driver: dev.driver, driverMin: above, supported: s.supported, note } });
  }

  // A test request given 1 s: the first load takes seconds anywhere.
  await stopAll();
  const t = await setUp(planOf(route, c.support), { testNpu: (e) => realTest('timeout', e, () => testNpuEntry(e, { timeoutMs: 1_000 })) });
  // Given 1 s, the server setup started is still starting, and stopAll stops only a server that answers: wait for it to
  // open its port, or it is left loading the route's model and answers the next case's test itself (on the NPU 3720 the
  // nonsense case's server was never started, its test refused 404 by this one's, 2026-10-15).
  if (!forced) await untilAnswering(chatBase, 60_000);
  await stopAll();
  const tOk = !t.entry && /in time/.test(t.note ?? '');
  add({ step: 'harden-timeout', ok: tOk, say: tOk ? `given 1 s, no NPU entry, noted "${t.note}"` : t.entry ? 'given 1 s, setup still wrote an NPU entry' : `given 1 s, no NPU entry, but noted "${t.note ?? 'nothing'}" (${t.problems.join('; ')})`, data: { note: t.note ?? null, problems: t.problems } });

  // The model that answers nonsense on the NPU: only the NPU answers nonsense with it.
  if (c.device !== 'NPU') add({ step: 'harden-nonsense', ok: null, say: `${NONSENSE_MODEL} answers properly off the NPU: not run in a rehearsal` });
  else {
    const bad = withChatModel(route, NONSENSE_MODEL, 2_400_000_000);
    const plan = planOf(bad, c.support);
    if (plan.downloadBytes && !o.yes && !(o.confirm && (await o.confirm(`Download ${mb(plan.downloadBytes)} (${NONSENSE_MODEL}, the model that answers nonsense)? [y/N] `)))) {
      add({ step: 'harden-nonsense', ok: false, say: `it would download ${mb(plan.downloadBytes)}: run again with --yes` });
    } else {
      await stopAll();
      const r = await setUp(plan, { testNpu: (e) => realTest('nonsense', e, () => testNpuEntry(e)) });
      await stopAll();
      const ok = r.entry ? null : /doesn't run properly/.test(r.note ?? '');
      add({ step: 'harden-nonsense', ok, say: r.entry ? `${NONSENSE_MODEL} answered sensibly on this NPU: there was no nonsense to reject` : ok ? `${NONSENSE_MODEL}: no NPU entry, noted "${r.note}"` : `${NONSENSE_MODEL}: no NPU entry, but noted "${r.note ?? 'nothing'}" (${r.problems.join('; ')})`, data: { note: r.note ?? null, problems: r.problems } });
    }
  }

  // Calibration: setup's measuring requests, and the timeouts it writes from them.
  await stopAll();
  const cal = await setUp(planOf(route, { ...c.support, verified: false }), {
    testNpu: (e) => realTest('calibrate', e, () => testNpuEntry(e)),
    measure: o.io?.setup?.measure ?? ((e) => measureNpu(e)),
  });
  await stopAll();
  const m = cal.measured;
  if (!m) add({ step: 'harden-calibrate', ok: false, say: `nothing measured: ${cal.problems.join('; ') || 'no measurement'}`, data: { problems: cal.problems } });
  else {
    const want = calibrate(m, planOf(route, c.support).route);
    const wrote = cal.entry?.timeouts;
    const why: string[] = [];
    if (!wrote) {
      if (!want.tooSlow) why.push(`no entry: ${cal.problems.join('; ')}`);
    } else {
      for (const k of ['requestBaseMs', 'requestPerTokenMs', 'coldLoadMs'] as const) if (wrote[k] !== want.timeouts[k]) why.push(`${k} written ${wrote[k]}, calibrate gives ${want.timeouts[k]}`);
      if ((wrote.requestPerTokenMs ?? 0) < 1000 / m.tokensPerSecond) why.push(`${wrote.requestPerTokenMs} ms a token is under the ${Math.round(1000 / m.tokensPerSecond)} measured`);
      if ((wrote.coldLoadMs ?? 0) < m.coldMs) why.push(`a ${wrote.coldLoadMs} ms cold load is under the ${m.coldMs} ms measured`);
      if ((wrote.requestBaseMs ?? 0) < m.warmMs) why.push(`a ${wrote.requestBaseMs} ms base is under the ${m.warmMs} ms warm answer measured`);
      if ((wrote.requestPerTokenMs ?? 0) > CALIBRATION.maxPerTokenMs || (wrote.requestBaseMs ?? 0) > CALIBRATION.maxBaseMs || (wrote.coldLoadMs ?? 0) > CALIBRATION.maxColdLoadMs) why.push('a timeout past its bound');
    }
    // Too slow is right when it is: on the NPU that's a failure of the NPU, off it (a rehearsal) only what was measured.
    const ok = why.length ? false : want.tooSlow ? (c.rehearsal ? null : false) : true;
    add({
      step: 'harden-calibrate',
      ok,
      ms: m.coldMs,
      say: `measured the first answer ${(m.coldMs / 1000).toFixed(0)} s after the start, ${(m.warmMs / 1000).toFixed(2)} s warm, ${m.tokensPerSecond.toFixed(1)} tokens a second; ${
        wrote ? `wrote ${(wrote.requestBaseMs ?? 0) / 1000} s, ${wrote.requestPerTokenMs} ms a token, cold load ${(wrote.coldLoadMs ?? 0) / 1000} s` : want.tooSlow ? `not used: ${want.tooSlow}` : 'wrote nothing'
      }${why.length ? `: ${why.join('; ')}` : ''}`,
      data: { measured: m, written: wrote ?? null, expected: want.timeouts, startingValues: planOf(route, c.support).route.timeouts, tooSlow: want.tooSlow ?? null, note: cal.note ?? null },
    });
  }
}

// ------------------------------------------------------------------------------------------------
// As a command

export function parseCheckArgs(argv: string[]): NpuCheckOptions | { error: string } {
  const o: NpuCheckOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--no-setup') o.setup = false;
    else if (a === '--route') {
      const v = argv[++i] as NpuVendor;
      if (!NPU_VENDORS.includes(v)) return { error: `--route takes ${NPU_VENDORS.join(', ')}` };
      o.vendor = v;
    } else if (a === '--device') {
      const v = (argv[++i] ?? '').toUpperCase();
      if (!/^(NPU|CPU|GPU)$/.test(v)) return { error: '--device takes NPU, CPU or GPU' };
      o.device = v;
    } else if (a === '--generation') {
      const v = argv[++i];
      if (!v) return { error: '--generation takes a generation of the route (meteor-lake, lunar-lake…)' };
      o.generation = v;
    } else if (a === '--small-pc') o.smallPc = true;
    else if (a === '--harden') o.harden = true;
    else if (a === '--idle') o.idle = true;
    else if (a === '--out') o.out = argv[++i];
    else return { error: `unknown argument ${a}` };
  }
  return o;
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const o = parseCheckArgs(process.argv.slice(2));
  if ('error' in o) {
    console.error(`${o.error}\nUsage: node npu-check.ts [--yes] [--no-setup] [--route intel|amd|qualcomm] [--device NPU|CPU|GPU] [--generation <id>] [--small-pc] [--harden] [--idle] [--out <file>]`);
    process.exit(2);
  }
  const { code } = await npuCheck(o);
  process.exit(code);
}
