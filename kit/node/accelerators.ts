import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from './core/index.js';
import { acceleratorsDir, lockDirFor } from './lock.ts';
import { lineState, queueDirFor, readLine, slotDirs, type Lane } from './npu-queue.ts';
import { powershell } from './ps.ts';
import { RULES } from './rules.ts';

/**
 * The accelerators the manor's models run on: the NPU, one or more graphics cards, or the processor,
 * each behind an OpenAI-compatible model server. The contract every agent follows is the kit's
 * spec/ACCELERATORS.md; its rules (reading and checking Reeve's config, the auto order, the failure
 * markers, the game check, the candidates and the pick) are the kit's core (src/kit/core/accelerators.js),
 * shared with every other driver, and this file is Node's side of them: it reads and writes the files,
 * reads the counters, and talks to the servers.
 * - Reeve's config.json lists them (`accelerators`, `acceleratorOrder`); an older config with only a
 *   `chatEndpoint` (and `embedEndpoint`) is read as one accelerator per device, `npu` for the NPU;
 * - each request is offered to the candidates that serve its kind, fit its size, haven't failed in the
 *   last 10 minutes, and (for background work) aren't a graphics card a game is using; it goes to the
 *   first with a free slot and nobody waiting, else to the shortest line;
 * - a server that won't start within 30 s, refuses the connection, answers 5xx or times out marks its
 *   accelerator failed (a file every agent reads), and the request goes once to the next candidate;
 *   a busy server (loading a model, or answering) is waited on, and a timeout while a model loads
 *   (ModelLoading) marks nothing;
 * - the servers' quirks: GenieX's prefix leak (a nonce first), and whether images go as a local path.
 * The turns themselves (locks, lines, this agent's manners) are the kit's npu.ts's.
 */

export type AcceleratorKind = core.AcceleratorKind;
export type Work = core.Work;

/** `prefix-leak`: each request starts with a nonce (GenieX v0.7.0). `image-path`: the server reads a local image path. */
export const QUIRKS: string[] = [...core.QUIRKS];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type Endpoint = core.Endpoint;
export type Accelerator = core.Accelerator;
export type AcceleratorConfig = core.AcceleratorConfig;
/** Where an answer came from, as answers and notes carry it. */
export type AcceleratorRef = core.AcceleratorRef;

export const refOf = (a: AcceleratorRef): AcceleratorRef => ({ id: a.id, name: a.name });

/** The NPU an older config, and every note written before accelerators, came from. */
export const LEGACY_NPU: AcceleratorRef = { ...core.LEGACY_NPU };

/** "the NPU", "the NVIDIA GeForce RTX 4090", "the graphics card": an accelerator in a sentence. */
export const theAccelerator = (a: AcceleratorRef | null | undefined) => core.theAccelerator(a);

/** A note's label: "note from the NVIDIA GeForce RTX 4090, unverified". */
export const noteLabel = (a: AcceleratorRef | null | undefined) => core.noteLabel(a);

/** Whether it serves this kind of request. */
export const serves = (a: Accelerator, work: Work) => core.serves(a, work);

// ---------------------------------------------------------------- Reeve's config

/**
 * Reeve's data folder: %USERPROFILE%\.reeve, or REEVE_HOME; the npu-agent folder on a PC where
 * `reeve migrate` hasn't run yet.
 */
export const reeveHome =
  process.env.REEVE_HOME ??
  [path.join(os.homedir(), '.reeve'), path.join(os.homedir(), '.npu-agent')].find((d) => existsSync(path.join(d, 'config.json'))) ??
  path.join(os.homedir(), '.reeve');

/** A card's id part: its name in lowercase, each run of other characters one dash, none at either end (as Reeve). */
export const slug = (name: string) => core.slug(name);

/** `npu`, `cpu`, or `gpu-<slug of the name>` ("NVIDIA GeForce RTX 4090 #2" is gpu-nvidia-geforce-rtx-4090-2). */
export const acceleratorId = (kind: AcceleratorKind, name: string) => core.acceleratorId(kind, name);

/**
 * Auto: graphics cards with 2 GB or more of their own memory first, the most memory first; then the
 * NPU; then graphics that share the PC's memory; then the CPU. Ties keep the config's order.
 */
export function autoOrder(list: Accelerator[]): Accelerator[] {
  return core.autoOrder(RULES, list);
}

/** acceleratorOrder applied: the listed ids first, in its order, then any it leaves out, in auto order. */
export function ordered(list: Accelerator[], order: 'auto' | string[]): Accelerator[] {
  return core.ordered(RULES, list, order);
}

/**
 * What an agent says when Reeve has set up no model server here: no config.json (Reeve writes none on a PC
 * without an NPU), an empty list (its setup dropped the install's `npu` entry), or a list where nothing
 * serves anything. The same words in each case.
 *
 * Like every message the kit's model code gives (a config's error, `npu.problem`, an NpuError's or
 * NpuBusy's message), it is a clause with no full stop of its own: agents put it into their own sentences
 * ("No notes: …." or "Busy: notes deferred to a later round (…)") and end them as they need.
 */
export const REEVE_NOT_SET_UP = core.REEVE_NOT_SET_UP;

/**
 * The accelerators in a parsed config.json, or why there are none: REEVE_NOT_SET_UP when nothing serves
 * anything, unless some entries couldn't be read (then the config needs fixing, and they're named).
 */
export function parseAccelerators(raw: any): AcceleratorConfig | { error: string } {
  return core.parseAccelerators(RULES, raw);
}

/** Reeve's config.json (REEVE_HOME, else %USERPROFILE%\.reeve), or why its accelerators can't be used. */
export function loadAccelerators(file = path.join(reeveHome, 'config.json')): AcceleratorConfig | { error: string } {
  let text: string | null;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e: any) {
    if (e?.code !== 'ENOENT') return { error: core.say.configUnreadable(file, (e as Error).message) };
    text = null;
  }
  return core.readConfig(RULES, file, text);
}

// ---------------------------------------------------------------- shared files

/** Written whole: a temporary file, then a rename, so a reader never sees half of it. */
function writeWhole(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, core.sharedText(value));
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e: any) {
      // Windows refuses a rename over a file another process has open for a moment.
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

/** A file's text, or null when it's absent or unreadable (which count the same). */
function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** A failed accelerator is skipped for this long, then tried again. */
export const FAILED_FOR_MS = RULES.accelerators.failedForMs;

export type Failure = core.Failure;

export const failedFile = (id: string) => path.join(acceleratorsDir, `${id}.failed.json`);

/** Its failure in the last 10 minutes, or null (none, expired, or unreadable). */
export function readFailure(id: string, now = Date.now()): Failure | null {
  return core.failureOf(RULES, readText(failedFile(id)), now);
}

/** Marks it failed, for every agent: `{since, reason, by}`, the reason's first line. */
export function markFailed(id: string, reason: string, by: string, now = Date.now()): void {
  try {
    writeWhole(failedFile(id), core.failureRecord(RULES, reason, by, now));
  } catch {
    // The marker is a courtesy to the others; the request's own error still goes back to the caller.
  }
}

/** A success on it: the marker goes. */
export function clearFailure(id: string): void {
  const f = failedFile(id);
  try {
    if (existsSync(f)) rmSync(f, { force: true });
  } catch {}
}

// ---------------------------------------------------------------- games

/** A card counts as in use by a game while another program keeps one of its 3D engines over this. */
export const GAME_PERCENT = RULES.accelerators.gamePercent;
/** games.json is checked again when it's older than this. */
export const GAMES_FRESH_MS = RULES.accelerators.gamesFreshMs;

export type CardUse = core.CardUse;
export type Games = core.Games;
/** One adapter as DXGI describes it (gpu-load.ps1). `luid` is "0x<high>_0x<low>", as the counters name it. */
export type DxgiAdapter = core.DxgiAdapter;
/** What gpu-load.ps1 prints. */
export type GpuLoad = core.GpuLoad;

export const gamesFile = () => path.join(acceleratorsDir, 'games.json');

/**
 * The graphics cards as Heiward names them (GpuAdapters.Keyed): Windows' software adapters left out,
 * and a second card of the same name "name #2", in DXGI's order.
 */
export function keyedCards(adapters: DxgiAdapter[]): (DxgiAdapter & { key: string })[] {
  return core.keyedCards(adapters);
}

/** What doesn't count as a game: the desktop's compositor, and the manor's own model servers (their startCommands', and the usual ones). */
export function serverNames(accs: Accelerator[]): string[] {
  return core.serverNames(accs);
}

/**
 * Which configured graphics cards a game is using, from one reading of the counters: per card (by its
 * LUID), each other program's busiest 3D engine; a card is busy while one is over GAME_PERCENT. The
 * desktop's compositor, this process and the manor's own model servers don't count. Cards are matched
 * to accelerators by name (Heiward's), or by the id that name gives.
 */
export function gameCards(load: GpuLoad, accs: Accelerator[], opts: { self?: number; exclude?: string[] } = {}): Record<string, CardUse> {
  return core.gameCards(RULES, load, accs, { self: opts.self ?? process.pid, exclude: opts.exclude });
}

/** games.json, or null when it's absent or unreadable. */
export function readGames(): Games | null {
  return core.gamesOf(readText(gamesFile()));
}

/** Whether games.json needs checking again: none, older than 15 s, or from a clock ahead of ours. */
export function gamesStale(g: Games | null, now = Date.now()): boolean {
  return core.gamesStale(RULES, g, now);
}

/** Reads the counters with gpu-load.ps1 (about 2 s, one of them the sample). */
export async function probeGpuLoad(): Promise<string> {
  return powershell(readFileSync(new URL('./gpu-load.ps1', import.meta.url), 'utf8'), { timeoutMs: 30_000 });
}

let pendingGames: Promise<Games | null> | undefined;

/**
 * Which graphics cards games are using now: games.json while it's under 15 s old, else the counters
 * read again (once, however many requests ask) and games.json rewritten for everyone. Null without a
 * graphics card in the config; a failed check leaves the file as it was.
 */
export async function currentGames(accs: Accelerator[], opts: { now?: number; probe?: () => Promise<string> } = {}): Promise<Games | null> {
  const now = opts.now ?? Date.now();
  const known = readGames();
  if (!accs.some((a) => a.kind === 'gpu' && a.enabled !== false)) return null;
  if (!gamesStale(known, now)) return known;
  pendingGames ??= (opts.probe ?? probeGpuLoad)()
    .then((text) => {
      const load = JSON.parse(text.trim()) as GpuLoad;
      const games: Games = {
        checkedAt: core.isoTime(now),
        cards: gameCards({ adapters: load.adapters ?? [], counters: load.counters ?? '', processes: load.processes ?? {}, compositor: load.compositor ?? null }, accs),
      };
      writeWhole(gamesFile(), games);
      return games;
    })
    .catch(() => known)
    .finally(() => (pendingGames = undefined));
  return pendingGames;
}

// ---------------------------------------------------------------- choosing

/** A background request doesn't join a line with this many already waiting. */
export const MAX_AHEAD = RULES.accelerators.maxAhead;

export type Need = core.Need;
export type Skipped = core.Skipped;

/**
 * The candidates for a request, in order: they serve its kind, its size fits their cap, they haven't
 * failed in the last 10 minutes (unless every one that would do has: then they all may, as a last
 * resort), a game isn't using them (background work only), and this agent isn't leaving them alone
 * after a line that was too long (`deferredMs`).
 */
export function candidates(
  accs: Accelerator[],
  need: Need,
  state: { failure?: (id: string) => Failure | null; games?: Games | null; deferredMs?: (id: string) => number; now?: number } = {},
): { list: Accelerator[]; skipped: Skipped[] } {
  const asked = accs.filter((a) => core.serves(a, need.work));
  return core.candidates(RULES, accs, need, {
    failures: state.failure ? Object.fromEntries(asked.map((a) => [a.id, state.failure!(a.id)])) : undefined,
    games: state.games ?? null,
    deferredMs: state.deferredMs ? Object.fromEntries(asked.map((a) => [a.id, state.deferredMs!(a.id)])) : undefined,
    nowMs: state.now ?? Date.now(),
  });
}

/** An accelerator's lock folders, one per slot: `locks\npu` for the NPU, `locks\<id>`, `<id>.2` … for the others. */
export const lockDirsOf = (acc: { id: string; slots?: number }) => slotDirs(lockDirFor(acc.id), core.lockFoldersOf(acc).length);

export type Look = core.Look;

/**
 * Its line on disk (Reeve's lineState), with this process's own tickets replaced by `localWaiting`:
 * its requests already headed there, whether they hold a ticket yet or not.
 */
export function lineLook(acc: Accelerator, localWaiting = 0): Look {
  const dirs = lockDirsOf(acc);
  const s = lineState(dirs);
  const others = readLine(queueDirFor(dirs[0])).filter((t) => t.pid !== process.pid).length;
  return { freeSlot: s.held < s.slots, waiting: others + localWaiting };
}

/**
 * The pick: the first candidate with a free slot and nobody waiting; else the one whose line is
 * shortest, ties by order. A background request that would be fifth or later in every line is
 * deferred; an interactive one always joins.
 */
export function pick(list: Accelerator[], lane: Lane, look: (a: Accelerator) => Look): { acc: Accelerator } | { deferred: string } {
  return core.pick(RULES, list, lane, Object.fromEntries(list.map((a) => [a.id, look(a)])));
}

// ---------------------------------------------------------------- servers

/**
 * The accelerator failed this request: its server won't start within 30 s, refuses the connection,
 * answers 5xx or times out. It is marked failed, and the request goes once to the next candidate.
 */
export class AcceleratorDown extends Error {}

/**
 * The request timed out while its model loaded (a server just started, or one busy loading when the
 * turn began, or the warm-up GenieX's model swaps need). That is the model being slow to load, not the
 * server failing: nothing is marked, and the work waits for a later round.
 */
export class ModelLoading extends AcceleratorDown {}

/** The server isn't running and the caller asked not to start it. Not a failure: nothing is marked. */
export class ServerNotRunning extends Error {}

/** How long a server may take to come up after its startCommand. */
export const START_WAIT_MS = RULES.accelerators.startWaitMs;
/** How long a look at /v1/models waits for an answer. */
export const PROBE_MS = RULES.accelerators.probeMs;
/** How long a busy server (loading its model, or answering a request) may take to be ready. */
export const READY_WAIT_MS = RULES.accelerators.readyWaitMs;

/**
 * A server as one look at its /v1/models finds it:
 * - `ready`: it answered;
 * - `busy`: it took the connection but gave no answer in time, or answered 503. GenieX answers nothing
 *   while it loads a model or answers a request (measured on GenieX v0.7.0, 2026-10-03), and npu-embed
 *   answers 503 while it loads: either way it is running, and another server must not be started;
 * - `down`: nothing took the connection, or it answered something else.
 */
export type ServerState = 'ready' | 'busy' | 'down';

export async function probe(baseUrl: string, ms = PROBE_MS): Promise<ServerState> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(ms) });
    await res.body?.cancel();
    return res.ok ? 'ready' : res.status === 503 ? 'busy' : 'down';
  } catch (e: any) {
    return e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'busy' : 'down';
  }
}

/** Whether an endpoint answers now, without starting it. */
export async function ping(baseUrl: string, ms = PROBE_MS): Promise<boolean> {
  return (await probe(baseUrl, ms)) === 'ready';
}

/** %NAME% expanded from the environment, as Windows does (any case); an unknown name stays as it is. */
export function expandEnv(s: string, env: Record<string, string | undefined> = process.env): string {
  return s.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key && env[key] !== undefined ? env[key]! : whole;
  });
}

const starting = new Map<string, Promise<ServerReady>>();

/** Kept for callers from before 2.6.0: servers are looked at afresh on every turn, so there is nothing to forget. */
export function forgetServers(): void {}

/** How a server was found: `started` by this call, or `waited` on while it was busy. Either way its model may be loading. */
export interface ServerReady {
  started: boolean;
  waited: boolean;
}

/**
 * Makes sure an endpoint's server is up and ready, looking afresh each time: Reeve stops an idle
 * GenieX, and starts it again on demand, as this does. A server that is running but busy is waited on
 * (up to readyWaitMs), never started a second time. One that isn't running is started from its
 * startCommand (detached, hidden, in the home folder so it never holds an agent's folder, shared by
 * everyone after) and given 30 s to take connections: once per server, however many requests wait on it.
 */
export async function ensureServer(ep: Endpoint, opts: { start?: boolean; waitMs?: number; readyMs?: number } = {}): Promise<ServerReady> {
  const readyMs = opts.readyMs ?? READY_WAIT_MS;
  const state = await probe(ep.baseUrl);
  if (state === 'ready') return { started: false, waited: false };
  if (state === 'busy') {
    await untilReady(ep.baseUrl, readyMs);
    return { started: false, waited: true };
  }
  if (opts.start === false) throw new ServerNotRunning(core.say.serverNotRunning(ep.baseUrl));
  if (!ep.startCommand?.length) throw new AcceleratorDown(core.say.noStartCommand(ep.baseUrl));
  let pending = starting.get(ep.baseUrl);
  if (!pending) {
    pending = start(ep, opts.waitMs ?? START_WAIT_MS, readyMs).finally(() => starting.delete(ep.baseUrl));
    starting.set(ep.baseUrl, pending);
  }
  return pending;
}

/** Waits until a busy server answers /v1/models; AcceleratorDown when it stops answering, or is still busy after `ms`. */
async function untilReady(baseUrl: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const state = await probe(baseUrl, Math.max(250, Math.min(PROBE_MS, deadline - Date.now())));
    if (state === 'ready') return;
    if (state === 'down') throw new AcceleratorDown(core.say.connectionRefused('/v1/models', baseUrl, 'it stopped answering while busy'));
    if (Date.now() >= deadline) throw new AcceleratorDown(core.say.stillBusy(baseUrl, Math.round(ms / 1000)));
  }
}

async function start(ep: Endpoint, waitMs: number, readyMs: number): Promise<ServerReady> {
  const [cmd, ...args] = ep.startCommand!.map((a) => expandEnv(a));
  const program = path.win32.basename(cmd);
  let spawnError: Error | undefined;
  let exited: number | null | undefined;
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.homedir() });
    child.on('error', (e) => (spawnError = e));
    child.on('exit', (code) => (exited = code));
    child.unref();
  } catch (e) {
    spawnError = e as Error;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (spawnError) throw new AcceleratorDown(core.say.couldNotStart(cmd, spawnError.message));
    const state = await probe(ep.baseUrl, 2000);
    if (state === 'ready') return { started: true, waited: false };
    if (state === 'busy') {
      await untilReady(ep.baseUrl, readyMs);
      return { started: true, waited: true };
    }
    // GenieX exits at once (code 0) when another server holds its port: it is down only if nothing answers.
    if (exited !== undefined) throw new AcceleratorDown(core.say.exitedWhileStarting(program, exited, ep.baseUrl));
  }
  throw new AcceleratorDown(core.say.didNotAnswer(program, ep.baseUrl, Math.round(waitMs / 1000)));
}

/**
 * One POST to a server. Down (AcceleratorDown): no connection, no answer in time, or a 5xx. With
 * `loading`, a timeout is ModelLoading instead: the model was loading, and that is no failure. Any other
 * refusal (a 4xx: a request it won't take) is a plain Error, and says nothing about the accelerator.
 */
export async function postJson(ep: Endpoint, route: string, body: unknown, timeoutMs: number, opts: { loading?: boolean } = {}): Promise<{ json: any; ms: number }> {
  const t0 = performance.now();
  const down = (e: any) => {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const seconds = Math.round(timeoutMs / 1000);
    if (timedOut && opts.loading) return new ModelLoading(core.say.modelLoadTimedOut(route, ep.baseUrl, seconds));
    return new AcceleratorDown(timedOut ? core.say.requestTimedOut(route, ep.baseUrl, seconds) : core.say.connectionRefused(route, ep.baseUrl, String(e?.cause?.code ?? e?.message ?? e)));
  };
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${ep.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    throw down(e);
  }
  const ms = Math.round(performance.now() - t0);
  if (res.status >= 500) throw new AcceleratorDown(core.say.serverFailed(route, ep.baseUrl, res.status, text.slice(0, 200)));
  if (!res.ok) throw new Error(core.say.serverRefused(res.status, text.slice(0, 300)));
  try {
    return { json: JSON.parse(text), ms };
  } catch {
    throw new Error(core.say.notJson(text.slice(0, 120)));
  }
}

// ---------------------------------------------------------------- the servers' quirks

const nonce = () => `[req ${Math.random().toString(36).slice(2, 10)}]`;

/** Room the estimate keeps for a nonce and Qwen3's /no_think, whichever accelerator takes the request. */
export const QUIRK_ROOM_CHARS = RULES.tokens.quirkRoomChars;

/** Qwen3 thinks by default and spends the output budget on it; the 2507 Instruct models don't. */
const thinks = (model: string) => /(^|\/)qwen3(?!\.5)(?!.*instruct-2507)/i.test(model);

/**
 * A chat request at temperature 0, as this accelerator's server needs it. GenieX v0.7.0 leaks state
 * between requests that share a prompt prefix (`prefix-leak`, measured by npu-agent, 2026-09-26): a
 * unique first token stops the reuse.
 */
export function chatBody(acc: Accelerator, ep: Endpoint, messages: ChatMessage[], maxTokens: number): Record<string, unknown> {
  let msgs = messages;
  if (acc.quirks.includes('prefix-leak')) {
    const n = nonce();
    msgs = msgs[0]?.role === 'system' ? [{ ...msgs[0], content: `${n} ${msgs[0].content}` }, ...msgs.slice(1)] : [{ role: 'system', content: n }, ...msgs];
  }
  if (thinks(ep.model)) msgs = msgs.map((m, i) => (i === msgs.length - 1 ? { ...m, content: `${m.content}\n/no_think` } : m));
  return { model: ep.model, messages: msgs, max_tokens: maxTokens, temperature: 0, stream: false };
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

/** A local image as a `data:` URL; a URL is left as it is. */
export function imageUrl(image: string, asPath: boolean): string {
  if (/^(data|https?):/i.test(image)) return image;
  if (asPath) return image.replace(/\\/g, '/');
  const mime = MIME[path.extname(image).toLowerCase()] ?? 'image/png';
  return `data:${mime};base64,${readFileSync(image).toString('base64')}`;
}

/** One question about one image: a local path the server reads itself (`image-path`), else a `data:` URL. */
export function visionBody(acc: Accelerator, ep: Endpoint, image: string, question: string, maxTokens: number): Record<string, unknown> {
  const system = `${acc.quirks.includes('prefix-leak') ? `${nonce()} ` : ''}You answer questions about images briefly and literally.`;
  return {
    model: ep.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl(image, acc.quirks.includes('image-path')) } }, { type: 'text', text: question }] },
    ],
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
  };
}
