import os from 'node:os';
import path from 'node:path';
import { type Accelerator as ConfiguredAccelerator, type AcceleratorEntry, type EndpointKind, readAccelerator } from './accelerator-config.ts';
import { expandEnv, lockDirsOf, parseAccelerators } from './accelerators.ts';
import { pcReaper, type ReapedServer, reapedServers, type ReapOutcome, serverProcesses } from './keeper.ts';
import { Npu, type Waking } from './npu.ts';
import { lineState } from './npu-queue.ts';
import { coldStartMsOf, idleMinutesFor, NPU_CATALOG, type NpuIdleStop, npuIdleStopMinutes, type NpuRoute, routeOfServer, smallPc } from './npu-vendors.ts';
import { RULES } from './rules.ts';

/**
 * npu-check's `--idle`: the NPU's idle stop run for real on this PC's NPU, each step passing or failing, so a PC with
 * little memory (the 16 GB Intel and AMD laptops) is checked by a run, not by a person's checklist:
 * - idle-wake: a chat (and, where the route has its own embedding server, an embedding) asked through the kit as an
 *   agent asks, so the servers run with their models loaded; what they hold of the PC's memory;
 * - idle-stop: the keeper's own look (keeper.ts' Reaper, on this PC's processes and the NPU's real line), given a short
 *   idle time, stops every server once nobody has used the NPU for it, and their processes are gone;
 * - idle-cold-answer: a person's request after that (the interactive lane, Envoy's 20 s caption timeout) is told the
 *   local AI is waking (onWaking), waits for the cold start rather than failing, and answers; its time is the route's
 *   cold start on this PC, and the minutes the rule gives it (idleMinutesFor) are suggested for npu-vendors.json;
 * - idle-in-flight: a keeper's look while a request holds the NPU's turn finds it in use and stops nothing, and the
 *   request answers.
 * What the rule chooses on this PC (its memory, each server's minutes) is said in idle-stop.
 */

export interface IdleAsked {
  ok: boolean;
  ms: number;
  text: string;
  error?: string;
  /** What onWaking was told, or null when the model was already up. */
  woke: Waking | null;
}

/** The PC as the idle check uses it: swapped for fakes in tests. */
export interface IdleDeps {
  /** A chat request through the kit (Npu, the interactive lane), given `timeoutMs`. */
  chat: (prompt: string, maxTokens: number, timeoutMs: number) => Promise<IdleAsked>;
  /** An embedding through the kit, when the NPU has its own embedding server. */
  embed?: () => Promise<IdleAsked>;
  /** One keeper's look at these servers, stopping each that nobody used for `idleMs`. */
  look: (servers: ReapedServer[], idleMs: number) => Promise<ReapOutcome[]>;
  /** The working set of a server's processes, in bytes; 0 when none runs. */
  held: (s: ReapedServer) => Promise<number>;
  /** Whether someone holds the NPU's turn now. */
  npuHeld: () => boolean;
  /** This PC's memory, in bytes. */
  ramBytes: number;
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
}

export interface IdleStep {
  step: string;
  ok: boolean | null;
  ms?: number;
  say: string;
  data?: Record<string, unknown>;
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const s1 = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const READY = 'Reply with the single word: ready';
/** A person's short wait: Envoy's live captions give a request 20 s. */
export const PERSON_TIMEOUT_MS = 20_000;

/** The kit's own PC: the entry's servers asked through the kit, looked at by the keeper with this PC's processes and locks. */
export function realIdleDeps(entry: AcceleratorEntry, o: { logFile?: string } = {}): IdleDeps {
  const cfg = parseAccelerators({ accelerators: [entry] });
  const npu = new Npu(cfg);
  const asked = async (fn: (onWaking: (w: Waking) => void) => Promise<string>): Promise<IdleAsked> => {
    let woke: Waking | null = null;
    const t0 = performance.now();
    try {
      const text = await fn((w) => (woke ??= w));
      return { ok: true, ms: Math.round(performance.now() - t0), text, woke };
    } catch (e: any) {
      return { ok: false, ms: Math.round(performance.now() - t0), text: '', error: String(e?.message ?? e), woke };
    }
  };
  const acc = readAccelerator(entry) as ConfiguredAccelerator;
  return {
    chat: (prompt, maxTokens, timeoutMs) => asked(async (onWaking) => (await npu.chat([{ role: 'user', content: prompt }], { lane: 'interactive', maxTokens, timeoutMs, onWaking, accelerator: 'npu' })).text),
    ...(acc.embed?.baseUrl && acc.embed.baseUrl !== acc.chat?.baseUrl
      ? { embed: () => asked(async (onWaking) => `${(await npu.embed(['a cat sat on the mat'], { lane: 'interactive', onWaking, accelerator: 'npu' })).vectors[0].length} dimensions`) }
      : {}),
    look: (servers, idleMs) => pcReaper({ who: 'npu-check', logFile: o.logFile, options: { idleMs } }).look(servers),
    held: async (s) => (await serverProcesses(s.program, s.base).catch(() => [])).reduce((n, p) => n + (p.workingSetBytes ?? 0), 0),
    npuHeld: () => lineState(lockDirsOf({ id: 'npu', slots: 1 })).held > 0,
    ramBytes: os.totalmem(),
    now: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** The NPU's servers as the keeper looks after them, from the entry. */
export function idleServers(entry: AcceleratorEntry, idleMs: number, logDir: string): ReapedServer[] {
  return reapedServers([readAccelerator(entry) as ConfiguredAccelerator], logDir, { npuMs: idleMs });
}

/** The kind a server serves, for the rule: its embedding server's, else chat. */
const kindOf = (entry: AcceleratorEntry, s: ReapedServer): EndpointKind => (entry.embed?.baseUrl && s.base === entry.embed.baseUrl && entry.embed.baseUrl !== entry.chat?.baseUrl ? 'embed' : 'chat');

/**
 * The idle check's steps (above), in order; each is handed to `add` as it ends. `idleMs` is the keeper's idle time for
 * the run (a minute by default: the rule's own minutes would make the run long, and the keeper is the same code).
 */
export async function idleSteps(c: { entry: AcceleratorEntry; route: NpuRoute; vendor: string; deps: IdleDeps; add: (s: IdleStep) => void; log: (l: string) => void; idleMs?: number; logDir?: string; rule?: NpuIdleStop }): Promise<void> {
  const { entry, route, deps: d, add, log } = c;
  const idleMs = c.idleMs ?? 60_000;
  const rule = c.rule ?? NPU_CATALOG.idleStop;
  const servers = idleServers(entry, idleMs, c.logDir ?? path.join(os.tmpdir(), 'npu-check-logs'));
  const name = (s: ReapedServer) => `${path.win32.basename(s.program)} at ${s.base}`;
  const coldLoadMs = route.timeouts.coldLoadMs ?? RULES.accelerators.coldLoadMs;

  // Wake: chat, and the embedding server where the route has its own.
  const chat = await d.chat(READY, 16, coldLoadMs + RULES.accelerators.requestBaseMs);
  const emb = d.embed ? await d.embed() : null;
  const heldBefore = await Promise.all(servers.map((s) => d.held(s)));
  const woken = chat.ok && (!emb || emb.ok);
  add({
    step: 'idle-wake',
    ok: woken,
    ms: chat.ms,
    say: woken
      ? `the kit's request answered${emb ? ', and an embedding' : ''}; ${servers.map((s, i) => `${name(s)} holds ${gb(heldBefore[i])}`).join(', ')}`
      : `no answer to wake it with: ${[chat.error, emb?.error].filter(Boolean).join('; ')}`,
    data: { heldBytes: Object.fromEntries(servers.map((s, i) => [s.base, heldBefore[i]])), chatMs: chat.ms, embedMs: emb?.ms ?? null },
  });
  if (!woken) return;

  // The rule on this PC, and the keeper stopping every server once the NPU has gone unused for idleMs.
  const small = smallPc(d.ramBytes, rule);
  const minutes = servers.map((s) => npuIdleStopMinutes({ program: expandEnv(s.program), kind: kindOf(entry, s) === 'embed' ? 'embed' : 'chat', ramBytes: d.ramBytes, otherwise: RULES.keeper.npuIdleStopMinutes }));
  const t0 = d.now();
  const deadline = idleMs + 3 * 60_000;
  const stopped = new Set<string>();
  let last: ReapOutcome[] = [];
  while (d.now() - t0 < deadline) {
    last = await d.look(servers, idleMs);
    for (const r of last) if (r.did === 'stopped') stopped.add(r.base);
    if (servers.every((s) => stopped.has(s.base))) break;
    await d.sleep(5_000);
  }
  const heldAfter = await Promise.all(servers.map((s) => d.held(s)));
  const allStopped = servers.every((s) => stopped.has(s.base));
  const gone = heldAfter.every((b) => b === 0);
  const freed = heldBefore.reduce((a, b) => a + b, 0) - heldAfter.reduce((a, b) => a + b, 0);
  add({
    step: 'idle-stop',
    ok: allStopped && gone,
    ms: Math.round(d.now() - t0),
    say: `${allStopped ? `the keeper stopped ${servers.map(name).join(' and ')} once the NPU went unused for ${s1(idleMs)}` : `the keeper didn't stop ${servers.filter((s) => !stopped.has(s.base)).map(name).join(' and ')} in ${s1(deadline)} (last: ${last.map((r) => r.did).join(', ')})`}${gone ? `, freeing ${gb(Math.max(0, freed))}` : `; still running: ${servers.filter((_, i) => heldAfter[i] > 0).map(name).join(', ')}`}. On this PC (${gb(d.ramBytes)}${small ? `, under ${rule.smallPcGb} GB` : ''}) the keeper stops ${servers.map((s, i) => `${path.win32.basename(s.program)} after ${minutes[i]} min`).join(' and ')} unless config.json's npuIdleStopMinutes says otherwise`,
    data: { stopped: [...stopped], heldAfter, freedBytes: freed, smallPc: small, minutes: Object.fromEntries(servers.map((s, i) => [s.base, minutes[i]])) },
  });
  if (!allStopped) return;

  // A person's request after the stop: told it's waking, waits for the cold start, answers.
  const cold = await d.chat(READY, 16, PERSON_TIMEOUT_MS);
  const coldOk = cold.ok && /ready/i.test(cold.text) && cold.woke?.how === 'starting';
  const coldEmb = d.embed ? await d.embed() : null;
  const embOk = !coldEmb || (coldEmb.ok && !!coldEmb.woke);
  const measured: Record<string, number> = { chat: cold.ms, ...(coldEmb ? { embed: coldEmb.ms } : {}) };
  const suggest = { coldStartMs: measured, minutes: Object.fromEntries(Object.entries(measured).map(([k, ms]) => [k, idleMinutesFor(ms, rule)])) };
  const recorded = { chat: coldStartMsOf(route, 'chat'), ...(coldEmb ? { embed: coldStartMsOf(routeOfServer(expandEnv(entry.embed?.startCommand?.[0] ?? ''), 'embed') ?? route, 'embed') } : {}) };
  add({
    step: 'idle-cold-answer',
    ok: coldOk && embOk && cold.ms <= coldLoadMs,
    ms: cold.ms,
    say: !cold.ok
      ? `a person's request after the stop failed: ${cold.error}`
      : `${cold.woke ? `told "${cold.woke.line}", ` : 'never told it was waking, '}it answered "${cold.text.slice(0, 30)}" in ${s1(cold.ms)} with a person's ${s1(PERSON_TIMEOUT_MS)} timeout${coldEmb ? `; an embedding after the stop ${coldEmb.ok ? `in ${s1(coldEmb.ms)}${coldEmb.woke ? '' : ', never told it was waking'}` : `failed: ${coldEmb.error}`}` : ''}${cold.ms > coldLoadMs ? `, past the route's ${s1(coldLoadMs)} cold load` : ''}`,
    data: { measured, recorded, suggest, woke: cold.woke ?? null },
  });
  log(`For npu-vendors.json's ${c.vendor} idleStop, from this cold start (${rule.coldStartTimes} times it, at least ${rule.floorMinutes} min): ${JSON.stringify(suggest)}`);

  // A keeper's look while a request holds the NPU's turn: in use, nothing stopped.
  const busy = d.chat('Write the numbers from one to forty in words, separated by commas.', 200, coldLoadMs + RULES.accelerators.requestBaseMs);
  const h0 = d.now();
  while (!d.npuHeld() && d.now() - h0 < 30_000) await d.sleep(50);
  const holding = d.npuHeld();
  const during = holding ? await d.look(servers, 1) : [];
  const answered = await busy;
  const inUse = holding && during.length > 0 && during.every((r) => r.did === 'in-use');
  add({
    step: 'idle-in-flight',
    ok: holding ? inUse && answered.ok : null,
    ms: answered.ms,
    say: !holding
      ? `the request never held the NPU's turn where the check could see it: not run${answered.ok ? '' : ` (${answered.error})`}`
      : `a keeper's look, given 1 ms of idle time, while a request held the NPU: ${during.map((r) => `${r.did}`).join(', ')}; the request ${answered.ok ? `answered in ${s1(answered.ms)}` : `failed: ${answered.error}`}`,
    data: { during, answeredMs: answered.ms },
  });
}
