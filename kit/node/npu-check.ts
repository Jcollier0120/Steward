import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatBody, serverEnv } from './accelerators.ts';
import { type Accelerator, type AcceleratorEntry, readAccelerator, toolsHome } from './accelerator-config.ts';
import { type Detection, detect, runPowerShell } from './detect.ts';
import { NPU_CATALOG, type NpuCatalog, type NpuRoute, type NpuSupport, type NpuVendor, NPU_VENDORS, pciDevice, planNpu, runProgram } from './npu-vendors.ts';
import { download, mb, type NpuIo, setUpNpu, testNpuEntry, unpack } from './setup.ts';

/**
 * The NPU check (spec/NPU-VENDORS.md, "Verified, and not"): on a PC with an NPU whose route hasn't run on real hardware,
 * it does what setup does for the NPU (its server and models, each step timed) without writing config.json, then
 * measures the server on the NPU: how long it takes to start and compile its model, a warm answer, how fast it writes
 * and reads, what happens at and past its cap, two requests at once, its memory, a start again from its compile cache,
 * and the kit's own test request in the NPU's turn. It says which steps passed, and the caps and timeouts the numbers
 * suggest for npu-vendors.json, and keeps the whole report as JSON beside the servers.
 *
 * `--route intel --device CPU` rehearses a maker's route off its NPU (OpenVINO on the processor, on any PC Windows runs
 * x64 programs on): its download, layout, environment, pull, serve and routes, all but the NPU. A rehearsal runs only in
 * a scratch REEVE_HOME, so it never touches this PC's servers, models or locks.
 *
 *   node <kit>\node\npu-check.ts [--yes] [--no-setup] [--route intel|amd|qualcomm] [--device NPU|CPU|GPU] [--out <file>]
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
  steps: CheckStep[];
  suggest: Suggestion | null;
  ok: boolean;
}

/** A server the check started itself: its process, and how to stop it (its whole tree). */
export interface RunningServer {
  pid: number | undefined;
  stop: () => Promise<void>;
}

export interface NpuCheckOptions {
  /** A maker's route to rehearse on this PC instead of its own NPU's (needs a scratch REEVE_HOME). */
  vendor?: NpuVendor;
  /** The device the route's server targets (OpenVINO's --target_device): NPU unless rehearsing. */
  device?: string;
  /** Install the server and models when they're missing (default); false checks only what's there. */
  setup?: boolean;
  /** Download without asking. */
  yes?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  out?: string;
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
    now?: () => number;
  };
}

// ------------------------------------------------------------------------------------------------
// The route, as the check runs it

/**
 * The route with its server pointed at another device (OpenVINO's --target_device): off the NPU its NPU-only
 * arguments (--max_prompt_len) go. A route without a device argument runs on its NPU only.
 */
export function routeOnDevice(route: NpuRoute, device: string): NpuRoute {
  const i = route.serve.indexOf('--target_device');
  if (i < 0) {
    if (device.toUpperCase() !== 'NPU') throw new Error(`${route.server} runs on the NPU only: it has no device to choose`);
    return route;
  }
  const serve = [...route.serve];
  serve[i + 1] = device.toUpperCase();
  if (device.toUpperCase() !== 'NPU') {
    const j = serve.indexOf('--max_prompt_len');
    if (j >= 0) serve.splice(j, 2);
  }
  return { ...route, serve };
}

/** A prompt of about `tokens` tokens (about four characters a token, as the kit's estimate): plain sentences, numbered so no two are alike. */
export function fillerPrompt(tokens: number): string {
  const lines: string[] = [];
  let chars = 0;
  for (let i = 1; chars < tokens * 4; i++) {
    const line = `Line ${i}: the steward counts the barrels in the cellar and writes the number down.`;
    lines.push(line);
    chars += line.length + 1;
  }
  return `${lines.join('\n')}\n\nHow many lines are above? Reply with the number only.`;
}

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

/** Starts a server from its entry, detached, its output appended to `logFile`; stopped with its whole tree. */
export async function startServer(entry: AcceleratorEntry, logFile: string): Promise<RunningServer> {
  const ep = entry.chat!;
  const [cmd, ...args] = ep.startCommand!;
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, cwd: os.homedir(), env: serverEnv({ env: ep.env }) });
  closeSync(fd);
  child.on('error', () => {});
  child.unref();
  return {
    pid: child.pid,
    stop: () =>
      new Promise((resolve) => {
        if (!child.pid) return resolve();
        const k = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.on('exit', () => resolve());
        k.on('error', () => resolve());
      }),
  };
}

/** A process's working set and private bytes, from Windows. */
export async function processMemory(pid: number): Promise<{ workingSetBytes: number; privateBytes: number } | null> {
  try {
    const out = await runPowerShell(`$p = Get-Process -Id ${pid} -ErrorAction Stop; "$($p.WorkingSet64)|$($p.PrivateMemorySize64)"`, 20_000);
    const [ws, priv] = out.trim().split('|').map(Number);
    return Number.isFinite(ws) ? { workingSetBytes: ws, privateBytes: priv } : null;
  } catch {
    return null;
  }
}

/** Runs the check: the report, and 0 when every step that can pass did. */
export async function npuCheck(o: NpuCheckOptions = {}): Promise<{ code: number; report: NpuCheckReport }> {
  const log = o.log ?? console.log;
  const env = o.env ?? process.env;
  const catalog = o.catalog ?? NPU_CATALOG;
  const now = o.io?.now ?? (() => performance.now());
  const http = o.io?.fetch ?? fetch;
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
    steps,
    suggest: null,
    ok: false,
  };
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
    return { code, report };
  };

  // 1. Which NPU, and which route.
  const vendor = o.vendor ?? npu?.vendor ?? null;
  report.vendor = vendor;
  const rehearsal = !!o.vendor && o.vendor !== npu?.vendor;
  report.rehearsal = rehearsal || report.device !== 'NPU';
  add({
    step: 'detect',
    ok: npu ? !!npu.supported : rehearsal ? null : false,
    say: npu
      ? `${npu.name} (${npu.label}), device ${pciDevice(npu.deviceId) ?? npu.deviceId}, driver ${npu.driver || '?'}${npu.driverDate ? ` of ${npu.driverDate}` : ''}: ${npu.supported ? 'the manor can use it' : `not used: ${npu.why}`}${npu.supported && !npu.verified ? " (its generation hasn't run on real hardware before this check)" : ''}`
      : `Windows lists no NPU${d.problems.length ? ` (${d.problems.join('; ')})` : ''}`,
    data: { cpu: d.cpu, ramBytes: d.ramBytes, cards: d.cards.map((c) => ({ name: c.name, memoryGb: c.memoryGb })) },
  });
  if (!vendor || !NPU_VENDORS.includes(vendor)) return finish(1);
  if (!rehearsal && !npu?.supported) return finish(1);
  if (report.rehearsal && !env.REEVE_HOME) {
    add({ step: 'rehearsal', ok: false, say: 'a rehearsal off the NPU runs only in a scratch home: set REEVE_HOME to an empty folder, so this PC’s servers, models and locks are left alone' });
    return finish(2);
  }
  let route: NpuRoute;
  try {
    route = routeOnDevice(catalog.routes[vendor], report.device);
  } catch (e: any) {
    add({ step: 'route', ok: false, say: e.message });
    return finish(2);
  }
  report.server = `${route.server} ${route.version}`;
  const tools = o.tools ?? toolsHome(env);
  const support: NpuSupport = rehearsal ? { vendor, generation: null, label: `${route.server} rehearsal`, supported: true, verified: false } : npu!;
  const plan = planNpu({ support, tools, downloadsDir: path.join(tools, 'servers', 'downloads'), env, catalog: { ...catalog, routes: { ...catalog.routes, [vendor]: route } } })!;
  add({ step: 'requirements', ok: plan.missing.length === 0, say: plan.missing.length ? `missing: ${plan.missing.join('; ')}` : `${route.server} needs nothing more on this PC` });
  if (plan.missing.length) return finish(1);

  // 2. Its server and models, as setup does them, each step timed.
  const needs = (!plan.installed ? (plan.download?.size ?? 0) : 0) + plan.models.filter((m) => !m.have).reduce((n, m) => n + m.size, 0);
  if ((!plan.installed || plan.models.some((m) => !m.have)) && o.setup === false) {
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
  const timed: Record<string, number> = {};
  const time = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    const t0 = now();
    try {
      return await fn();
    } finally {
      timed[name] = (timed[name] ?? 0) + Math.round(now() - t0);
    }
  };
  const sio: Partial<NpuIo> = o.io?.setup ?? {};
  let entry: AcceleratorEntry | undefined;
  const r = await setUpNpu(plan, tools, {
    ...sio,
    log: (l) => log(`  ${l}`),
    download: (dl, progress) => time('download', () => (sio.download ?? download)(dl, progress)),
    unpack: (zip, into) => {
      const t0 = now();
      (sio.unpack ?? unpack)(zip, into);
      timed.unpack = Math.round(now() - t0);
    },
    run: (exe, args, ro) => time(args.some((a) => /pull/i.test(a)) ? 'pull' : 'install', () => (sio.run ?? defaultRun)(exe, args, ro)),
    testNpu: async (e) => {
      entry = e;
      return [];
    },
  });
  add({
    step: 'setup',
    ok: !r.problems.length && !!entry,
    ms: Object.values(timed).reduce((a, b) => a + b, 0),
    say: r.problems.length ? r.problems.join('; ') : `${route.server} and ${plan.models.map((m) => m.id).join(', ')} are here${Object.keys(timed).length ? ` (${Object.entries(timed).map(([k, v]) => `${k} ${(v / 1000).toFixed(0)} s`).join(', ')})` : ', nothing to download'}`,
    data: { timed, downloadBytes: needs, exe: plan.exe },
  });
  if (!entry) return finish(1);

  // 3. The server on the NPU, measured.
  const acc = readAccelerator(entry) as Accelerator;
  const ep = { ...acc.chat!, baseUrl: acc.chat!.baseUrl! };
  const logFile = path.join(tools, 'servers', 'logs', `npu-check-${vendor}.log`);
  const start = o.io?.start ?? startServer;
  const ask = async (prompt: string, maxTokens: number, timeoutMs: number) => {
    const t0 = now();
    const res = await http(`${ep.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chatBody(acc as unknown as Parameters<typeof chatBody>[0], ep as any, [{ role: 'user', content: prompt }], maxTokens)), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    const ms = Math.round(now() - t0);
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const raw = String(json?.choices?.[0]?.message?.content ?? '');
    return { status: res.status, ok: res.ok && typeof json?.choices?.[0]?.message?.content === 'string', ms, raw, answer: raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim(), usage: json?.usage ?? null, error: res.ok ? null : text.slice(0, 300) };
  };
  const answers = async (timeoutMs = 5_000) => {
    try {
      const res = await http(`${ep.baseUrl}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  };
  const untilAnswers = async (deadlineMs: number) => {
    const t0 = now();
    while (now() - t0 < deadlineMs) {
      if (await answers(2_000)) return Math.round(now() - t0);
      await new Promise((res) => setTimeout(res, 500));
    }
    return null;
  };
  if (await answers()) {
    add({ step: 'start', ok: false, say: `something already answers at ${ep.baseUrl} (the keeper's server?): stop it first, so the check measures a start of its own` });
    return finish(1);
  }
  const coldMs = route.timeouts.coldLoadMs ?? 180_000;
  // A first start on the NPU compiles the model: allow far more than the route's cold load.
  const firstStartLimit = Math.max(20 * 60_000, coldMs * 5);
  let server = await start(entry, logFile);
  const up = await untilAnswers(firstStartLimit);
  add({ step: 'start', ok: up !== null, ms: up ?? undefined, say: up !== null ? `${route.server} answered /v1/models` : `${route.server} didn't answer in ${firstStartLimit / 60_000} minutes: see ${logFile}`, data: { pid: server.pid, logFile } });
  try {
    if (up === null) return finish(1);
    const first = await time('first', () => ask('Reply with the single word: ready', 16, firstStartLimit)).catch((e) => ({ ok: false, ms: 0, raw: '', answer: '', status: 0, usage: null, error: String(e?.message ?? e) }));
    add({
      step: 'first-answer',
      ok: first.ok,
      ms: first.ms,
      say: first.ok ? `answered "${first.answer.slice(0, 40)}"${/<think>/.test(first.raw) ? ' (with an empty think block, stripped)' : ''}; the first load (and compile) took ${((up + first.ms) / 1000).toFixed(0)} s from the start` : `no answer: ${first.error}`,
      data: { loadMs: up + first.ms, raw: first.raw.slice(0, 200), usage: first.usage },
    });
    if (!first.ok) return finish(1);

    const warmMs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const w = await ask(`Reply with the single word: ready (${i + 1})`, 16, coldMs);
      if (w.ok) warmMs.push(w.ms);
    }
    add({ step: 'warm', ok: warmMs.length === 3, ms: median(warmMs), say: `a short answer, warm: ${warmMs.map((m) => `${(m / 1000).toFixed(2)} s`).join(', ')}`, data: { ms: warmMs } });

    const sp = await ask('Write the numbers from one to one hundred in words, separated by commas.', 256, coldMs);
    const written = Number(sp.usage?.completion_tokens) || Math.round(sp.raw.length / 4);
    const tps = sp.ok ? written / (Math.max(1, sp.ms - (median(warmMs) || 0) / 2) / 1000) : 0;
    add({ step: 'speed', ok: sp.ok ? null : false, ms: sp.ms, say: sp.ok ? `wrote ${written} tokens${sp.usage ? '' : ' (estimated)'}: about ${tps.toFixed(1)} a second` : `failed: ${sp.error}`, data: { completionTokens: written, tokensPerSecond: Number(tps.toFixed(2)), usage: sp.usage } });

    const cap = route.maxContextTokens;
    const rd = await ask(fillerPrompt(Math.round(cap * 0.8)), 4, coldMs);
    const readTokens = Number(rd.usage?.prompt_tokens) || 0;
    add({ step: 'read', ok: rd.ok ? null : false, ms: rd.ms, say: rd.ok ? `read ${readTokens || 'about ' + Math.round(cap * 0.8)} tokens and answered in ${(rd.ms / 1000).toFixed(1)} s${readTokens ? ` (${(readTokens / (rd.ms / 1000)).toFixed(0)} a second)` : ''}` : `failed: ${rd.error}`, data: { promptTokens: readTokens || null, usage: rd.usage } });

    // At the cap, and past it: a request past it should be refused plainly (a 4xx), never take the server down.
    const sizes = [Math.round(cap * 0.95) - 64, cap + 256];
    const tried: Record<string, unknown>[] = [];
    let largestOk = 0;
    let underCapFailed = false;
    for (const n of sizes) {
      const c = await ask(fillerPrompt(n), 4, coldMs).catch((e) => ({ ok: false, status: 0, ms: 0, usage: null, error: String(e?.message ?? e), raw: '', answer: '' }));
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
    const pair = await Promise.all([ask('Name one colour. One word.', 16, coldMs), ask('Name one animal. One word.', 16, coldMs)]);
    const both = Math.round(now() - t0);
    add({ step: 'two-at-once', ok: pair.every((p) => p.ok), ms: both, say: pair.every((p) => p.ok) ? `both answered in ${(both / 1000).toFixed(2)} s together (${pair.map((p) => (p.ms / 1000).toFixed(2)).join(' and ')} s each)` : `${pair.filter((p) => !p.ok).map((p) => p.error).join('; ')}`, data: { ms: pair.map((p) => p.ms) } });

    const memory = server.pid ? await (o.io?.memory ?? processMemory)(server.pid) : null;
    add({ step: 'memory', ok: null, say: memory ? `${route.server} holds ${(memory.workingSetBytes / 1024 ** 3).toFixed(2)} GB (${(memory.privateBytes / 1024 ** 3).toFixed(2)} GB private)` : 'not read', data: memory ?? {} });

    // A start again, which finds its compiled model in the cache.
    await server.stop();
    const gone = await (async () => {
      const t = now();
      while (now() - t < 30_000) {
        if (!(await answers(1_000))) return true;
        await new Promise((res) => setTimeout(res, 250));
      }
      return false;
    })();
    if (!gone) {
      add({ step: 'restart', ok: false, say: `${route.server} still answers after it was stopped` });
      return finish(1);
    }
    server = await start(entry, logFile);
    const up2 = await untilAnswers(firstStartLimit);
    const again = up2 === null ? null : await ask('Reply with the single word: ready', 16, firstStartLimit).catch(() => null);
    const loadMs = up2 === null || !again?.ok ? null : up2 + again.ms;
    add({ step: 'restart', ok: loadMs !== null && loadMs <= coldMs, ms: loadMs ?? undefined, say: loadMs !== null ? `started again and answered in ${(loadMs / 1000).toFixed(0)} s (the route allows ${coldMs / 1000} s for a cold load)` : 'it didn’t answer after a start again', data: { loadMs } });
    await server.stop();
    await untilGone(answers, now);

    // The kit's own test request: the server started as every agent starts it, in the NPU's turn.
    const k0 = now();
    const problems = await (o.io?.kitTest ?? ((e: AcceleratorEntry) => testNpuEntry(e)))(entry);
    const kitMs = Math.round(now() - k0);
    add({ step: 'kit-test', ok: !problems.length, ms: kitMs, say: problems.length ? problems.join('; ') : `the kit started ${route.server} and had its answer in its NPU turn`, data: { loadMs: kitMs } });
  } finally {
    await server.stop();
  }
  await stopKitStarted(ep.baseUrl, answers, now);

  report.suggest = suggestFrom(steps, route);
  if (report.suggest) {
    log(`Suggested for npu-vendors.json's ${vendor} route (${report.rehearsal ? 'a rehearsal: not for the NPU' : 'from this NPU'}):`);
    log(`  ${JSON.stringify({ ...(report.suggest.maxContextTokens ? { maxContextTokens: report.suggest.maxContextTokens } : {}), timeouts: report.suggest.timeouts })}`);
    for (const w of report.suggest.why) log(`  - ${w}`);
  }
  return finish(steps.some((s) => s.ok === false) ? 1 : 0);
}

const defaultRun: NonNullable<Parameters<typeof setUpNpu>[2]['run']> = (exe, args, o) => runProgram(exe, args, o);

async function untilGone(answers: (ms?: number) => Promise<boolean>, now: () => number): Promise<void> {
  const t = now();
  while (now() - t < 30_000 && (await answers(1_000))) await new Promise((res) => setTimeout(res, 250));
}

/** Stops the server the kit's test request started (its started record names it), so the check leaves nothing running. */
async function stopKitStarted(base: string, answers: (ms?: number) => Promise<boolean>, now: () => number): Promise<void> {
  if (!(await answers(1_000))) return;
  const { readStarted } = await import('./accelerators.ts');
  for (const s of readStarted().filter((x) => x.base === base)) {
    await new Promise<void>((resolve) => {
      const k = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(s.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('exit', () => resolve());
      k.on('error', () => resolve());
    });
  }
  await untilGone(answers, now);
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
    } else if (a === '--out') o.out = argv[++i];
    else return { error: `unknown argument ${a}` };
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseCheckArgs(process.argv.slice(2));
  if ('error' in o) {
    console.error(`${o.error}\nUsage: node npu-check.ts [--yes] [--no-setup] [--route intel|amd|qualcomm] [--device NPU|CPU|GPU] [--out <file>]`);
    process.exit(2);
  }
  const { code } = await npuCheck(o);
  process.exit(code);
}
