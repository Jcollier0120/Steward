import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alive, startApart } from './apart.ts';
import { type Block, blockedExit, blockedExitSay, blockedIn, blockedSay, cpuVariants, keepCpuVariant, loadedCpuVariant, type ReadLog, type SacState, smartAppControlOutsideTests } from './app-control.ts';
import * as core from './core/index.js';
import { acceleratorsDir, lockDirFor } from './lock.ts';
import { manorStopped } from './manor.ts';
import { lineState, queueDirFor, readLine, slotDirs, type Lane } from './npu-queue.ts';
import { powershell, psQuote } from './ps.ts';
import { samePath } from './real-path.ts';
import { RULES } from './rules.ts';
import { trimWorkingSet } from './working-set.ts';

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
 *   last 10 minutes, and (for background work) aren't a graphics card a game is using. The NPU first: when
 *   it comes first and can do the request, it alone is offered it, busy or not; otherwise it goes to the
 *   first with a free slot and nobody waiting, else to the shortest line;
 * - a server that won't start within 30 s, refuses the connection, answers 5xx or times out marks its
 *   accelerator failed (a file every agent reads), and the request goes once to the next candidate;
 *   a busy server (loading a model, or answering) is waited on, and a timeout while a model loads
 *   (ModelLoading) marks nothing;
 * - the servers' quirks: GenieX's prefix leak (a nonce first), whether images go as a local path, and FastFlowLM's
 *   pictures with a side of a whole number of 32 px (made a pixel longer).
 * The turns themselves (locks, lines, this agent's manners) are the kit's npu.ts's.
 */

export type AcceleratorKind = core.AcceleratorKind;
export type Work = core.Work;

/**
 * `prefix-leak`: each request starts with a nonce (GenieX v0.7.0). `image-path`: the server reads a local image path.
 * `sides-of-32`: a picture's side of a whole number of 32 px is made a pixel longer first (FastFlowLM 1.0.7 and 1.0.10: fitPicture).
 */
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

/** "the NPU", "the NVIDIA GeForce RTX 4090", "the graphics card": an accelerator in a sentence, for developers' views and logs. */
export const theAccelerator = (a: AcceleratorRef | null | undefined) => core.theAccelerator(a);

/**
 * A note's label: "note from the local AI, unverified" for everyone; with `developer` (isDeveloper(), a log), where
 * it was written: "note from the NVIDIA GeForce RTX 4090, unverified".
 */
export const noteLabel = (a: AcceleratorRef | null | undefined, developer = false) => core.noteLabel(a, developer);

/** Whether it serves this kind of request. */
export const serves = (a: Accelerator, work: Work) => core.serves(a, work);

// ---------------------------------------------------------------- the accelerators' config

/**
 * Reeve's data folder: %USERPROFILE%\.reeve, or REEVE_HOME; the npu-agent folder on a PC where
 * `reeve migrate` hasn't run yet. The accelerators were kept in its config.json until kit 2.31.0.
 */
export const reeveHome =
  process.env.REEVE_HOME ??
  [path.join(os.homedir(), '.reeve'), path.join(os.homedir(), '.npu-agent')].find((d) => existsSync(path.join(d, 'config.json'))) ??
  path.join(os.homedir(), '.reeve');

/**
 * The accelerators' own folder, which Manor owns (kit 2.31.0): %USERPROFILE%\.manor\accelerators, or MANOR_HOME's
 * `accelerators`; ACCELERATORS_HOME names another. It holds their config.json, and on a PC set up since, the model
 * servers and models (servers\, models\), so a household gets working models without hiring Reeve. A scratch
 * REEVE_HOME (tests, trials) keeps everything in itself, as before.
 */
export function acceleratorsHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ACCELERATORS_HOME) return env.ACCELERATORS_HOME;
  if (env.REEVE_HOME) return env.REEVE_HOME;
  return path.join(env.MANOR_HOME || path.join(os.homedir(), '.manor'), 'accelerators');
}

/**
 * The accelerators' config.json, where their keeper writes: ACCELERATORS_CONFIG, else REEVE_CONFIG (a scratch Reeve's),
 * else REEVE_HOME's (a scratch home keeps one file, as before), else the accelerators' folder's (acceleratorsHome).
 * Agents read readableConfigFile().
 */
export function acceleratorConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ACCELERATORS_CONFIG) return env.ACCELERATORS_CONFIG;
  if (env.REEVE_CONFIG) return env.REEVE_CONFIG;
  if (env.REEVE_HOME) return path.join(env.REEVE_HOME, 'config.json');
  return path.join(acceleratorsHome(env), 'config.json');
}

/**
 * Reeve's config.json, where the accelerators were kept before kit 2.31.0, when it's another file than theirs and
 * exists: null with a scratch home or an explicit file (then the two are one), and on a PC that never had one.
 * `home` is the profile folder (tests give one).
 */
export function legacyConfigFile(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  if (env.ACCELERATORS_CONFIG || env.REEVE_CONFIG || env.REEVE_HOME) return null;
  const found = [path.join(home, '.reeve'), path.join(home, '.npu-agent')].map((d) => path.join(d, 'config.json')).find((f) => existsSync(f));
  return found && !samePath(found, acceleratorConfigFile(env)) ? found : null;
}

/**
 * The file agents read the accelerators from: theirs when it exists, else Reeve's older one (a PC whose keeper hasn't
 * moved them yet: accelerator-config.ts' migrateAcceleratorConfig), else theirs (none: not set up).
 */
export function readableConfigFile(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const own = acceleratorConfigFile(env);
  if (existsSync(own)) return own;
  return legacyConfigFile(env, home) ?? own;
}

/** A card's id part: its name in lowercase, each run of other characters one dash, none at either end (as Reeve). */
export const slug = (name: string) => core.slug(name);

/** `npu`, `cpu`, or `gpu-<slug of the name>` ("NVIDIA GeForce RTX 4090 #2" is gpu-nvidia-geforce-rtx-4090-2). */
export const acceleratorId = (kind: AcceleratorKind, name: string) => core.acceleratorId(kind, name);

/**
 * Auto: the NPU first; then graphics cards with 2 GB or more of their own memory, the most memory first;
 * then graphics that share the PC's memory; then the CPU. Ties keep the config's order.
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
/** The same words by their new name (kit 2.31.0): they point to Castellan's Set up local AI, not to Reeve. */
export const NOT_SET_UP = core.NOT_SET_UP;

/**
 * The accelerators in a parsed config.json, or why there are none: REEVE_NOT_SET_UP when nothing serves
 * anything, unless some entries couldn't be read (then the config needs fixing, and they're named).
 */
export function parseAccelerators(raw: any, hw: Hardware | null = readHardware()): AcceleratorConfig | { error: string } {
  return core.parseAccelerators(RULES, raw, hw);
}

/** The accelerators' config.json (readableConfigFile: theirs, else Reeve's older one), or why they can't be used. */
export function loadAccelerators(file = readableConfigFile(), hw: Hardware | null = readHardware()): AcceleratorConfig | { error: string } {
  let text: string | null;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e: any) {
    if (e?.code !== 'ENOENT') return { error: core.say.configUnreadable(file, (e as Error).message) };
    text = null;
  }
  return core.readConfig(RULES, file, text, hw);
}

// ---------------------------------------------------------------- what this PC has

/**
 * Whether this PC has an NPU, and its graphics cards: what detection found, never guessed from a model. With the
 * NPU's and the processor's names as Windows gives them, every accelerator's name comes from here (the core's
 * acceleratorName), never from config.json.
 */
export interface Hardware {
  npu: boolean;
  /** Each named as DXGI describes it, " #2" on a second card of a name. */
  cards: { name: string; memoryGb: number | null }[];
  /** The NPU's name as Windows lists it, (R) and (TM) taken out, when it has one. */
  npuName?: string;
  /** The processor's name, (R), (TM) and (C) taken out. */
  cpuName?: string;
}

/** hardware.json, beside the failure markers in the accelerators folder every program shares. */
export const hardwareFile = () => path.join(acceleratorsDir, 'hardware.json');

/**
 * What detection last found here (setup writes it, and Reeve's keeper once a day), or null when it never ran or
 * couldn't tell: then a config's word stands, as it always has.
 */
export function readHardware(file = hardwareFile()): Hardware | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (typeof j?.npu !== 'boolean' || !Array.isArray(j.cards)) return null;
    const cards = j.cards
      .filter((c: any) => c && typeof c.name === 'string' && c.name)
      .map((c: any) => ({ name: c.name as string, memoryGb: typeof c.memoryGb === 'number' ? c.memoryGb : null }));
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const npuName = j.npu ? text(j.npuName) : undefined;
    const cpuName = text(j.cpuName);
    return { npu: j.npu, cards, ...(npuName ? { npuName } : {}), ...(cpuName ? { cpuName } : {}) };
  } catch {
    return null;
  }
}

/** Keeps what detection found (detect.ts' hardwareOf), with when, for every program that reads Reeve's config. */
export function rememberHardware(hw: Hardware, file = hardwareFile()): void {
  writeWhole(file, {
    at: new Date().toISOString(),
    npu: hw.npu,
    cards: hw.cards,
    ...(hw.npu && hw.npuName ? { npuName: hw.npuName } : {}),
    ...(hw.cpuName ? { cpuName: hw.cpuName } : {}),
  });
}

/** npu-note.json, beside hardware.json: why the NPU, or its embeddings, isn't used, as setup last found it. */
export const npuNoteFile = () => path.join(acceleratorsDir, 'npu-note.json');

/**
 * Keeps setup's note on the NPU (setup.ts' npuNoteFor: "The NPU (…) isn't used: its driver needs an update. …"), with
 * when; null clears it, once the NPU is set up whole. A note, never an alarm: the NPU's work goes elsewhere.
 */
export function rememberNpuNote(note: string | null, file = npuNoteFile()): void {
  if (note) writeWhole(file, { at: new Date().toISOString(), note });
  else rmSync(file, { force: true });
}

/** The note setup last kept on the NPU, or null. */
export function readNpuNote(file = npuNoteFile()): { at: string; note: string } | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return typeof j?.note === 'string' && j.note ? { at: typeof j.at === 'string' ? j.at : '', note: j.note } : null;
  } catch {
    return null;
  }
}

/** blocked.json, beside npu-note.json (kit 2.104.0): what Windows blocked of the model servers at setup's last run. */
export const blockedFile = () => path.join(acceleratorsDir, 'blocked.json');

/** One file Windows' application control blocked as setup tried a server: the file, its policy, and whose server it's part of. */
export interface BlockedServerFile extends Block {
  server: string;
}

/** What setup's last run found blocked (blocked.json): when, Smart App Control's state then, and each file blocked. */
export interface BlockedRecord {
  at: string;
  smartAppControl: SacState | null;
  blocked: BlockedServerFile[];
}

/**
 * Keeps what Windows blocked of the servers setup tried (kit 2.104.0), file by file, so a round of signing knows exactly
 * which files to sign; none clears it, once setup ran with nothing blocked. A record, never an alarm: setup has gone on
 * to the next server that runs, and its note says so.
 */
export function rememberBlocked(blocked: BlockedServerFile[], sac: SacState | null, file = blockedFile()): void {
  const one = blocked.filter((b, i) => blocked.findIndex((x) => x.file.toLowerCase() === b.file.toLowerCase()) === i);
  if (one.length) writeWhole(file, { at: new Date().toISOString(), smartAppControl: sac, blocked: one });
  else rmSync(file, { force: true });
}

/** What setup's last run found blocked, or null when it found nothing (or the record can't be read). */
export function readBlocked(file = blockedFile()): BlockedRecord | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(j?.blocked) && j.blocked.length ? { at: String(j.at ?? ''), smartAppControl: j.smartAppControl ?? null, blocked: j.blocked } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- shared files

/** Written whole: a temporary file, on the disk before the rename (kit 2.73.3), then the rename, so a reader never sees half of it. */
function writeWhole(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, core.sharedText(value), { flush: true });
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

// ---------------------------------------------------------------- the model last served

/**
 * The model an accelerator's server last answered, and when: `{baseUrl, model, at}`, written by every agent after each
 * answer, so one agent's turn tells the next whether that model is still loaded and its warm-up can be skipped.
 */
export const servedFile = (id: string) => path.join(acceleratorsDir, `${id}.served.json`);

export function noteServed(id: string, ep: Pick<Endpoint, 'baseUrl' | 'model'>, now = Date.now()): void {
  try {
    writeWhole(servedFile(id), { baseUrl: ep.baseUrl, model: ep.model, at: new Date(now).toISOString() });
  } catch {
    // Only a hint for the next turn: without it, that turn warms up as before.
  }
}

/** How long GenieX keeps a model loaded unused: its start command's `--keepalive` (seconds), else its default, 300. */
export function keepaliveMs(startCommand?: string[]): number {
  const i = startCommand ? startCommand.indexOf('--keepalive') : -1;
  const s = i >= 0 ? Number(startCommand![i + 1]) : NaN;
  return (Number.isFinite(s) && s > 0 ? s : 300) * 1000;
}

/**
 * Whether this server answered this same model recently enough that it still has it loaded: within its keepalive,
 * less half a minute. Another model answered since (one GenieX keeping one model at a time), another server, or no
 * record: not recent, and the turn warms up.
 */
export function servedRecently(id: string, ep: Pick<Endpoint, 'baseUrl' | 'model' | 'startCommand'>, now = Date.now()): boolean {
  try {
    const s = JSON.parse(readText(servedFile(id)) ?? 'null');
    if (!s || s.baseUrl !== ep.baseUrl || s.model !== ep.model) return false;
    const age = now - Date.parse(s.at);
    return age >= 0 && age < keepaliveMs(ep.startCommand) - 30_000;
  } catch {
    return false;
  }
}

/**
 * When the NPU last answered an embedding: `{at}`, written by every agent after its embeddings there (no more than once
 * every few seconds), so a chat's turn knows whether the embedding server is in use (keeper.ts' yieldEmbedServer).
 */
export const embeddedFile = (id: string) => path.join(acceleratorsDir, `${id}.embedded.json`);

export function noteEmbedded(id: string, now = Date.now()): void {
  try {
    writeWhole(embeddedFile(id), { at: new Date(now).toISOString() });
  } catch {
    // Only a hint: without it, the embedding server is taken as unused.
  }
}

/** When noteEmbedded last wrote, or null. */
export function embeddedAt(id: string): number | null {
  try {
    const at = Date.parse(JSON.parse(readText(embeddedFile(id)) ?? 'null')?.at);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
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

/**
 * The program a game check found using a graphics card ("Cyberpunk2077.exe"; "a game" when it didn't say which), or
 * null when no card is in use by one, or there was no check. Kit 2.87.0: the Scribe's and the Marshal's (their
 * game.ts), for work that waits while a game is played.
 */
export function gameIn(g: Games | null): string | null {
  const busy = g ? Object.values(g.cards).find((u) => u.busy) : undefined;
  return busy ? (busy.by[0] ?? 'a game') : null;
}

/**
 * The accelerators a game check looks at: the config's, while one of them is an enabled graphics card (as currentGames
 * always has); else (no local AI set up, or one on the NPU or the processor only) the graphics cards hardware.json
 * says this PC has, added beside them, so a PC that runs no model on its card still sees a game on it. Each added
 * card is for the check only: its id is the one acceleratorId gives its name, and it serves nothing. No hardware.json
 * (detection never ran here), nothing is added, and there's no check, as before. Nothing is detected here.
 */
export function gameWatchCards(accs: Accelerator[], hw: Hardware | null): Accelerator[] {
  if (!hw || accs.some((a) => a.kind === 'gpu' && a.enabled !== false)) return accs;
  return [...accs, ...hw.cards.map((c): Accelerator => ({ id: acceleratorId('gpu', c.name), kind: 'gpu', name: c.name, memoryGb: c.memoryGb, slots: 1, maxContextTokens: 0, quirks: [] }))];
}

/**
 * The game using a graphics card now (gameIn), from games.json while it's under 15 s old, else checked again and
 * written for everyone (currentGames); null when none is, or it can't be told. The cards are the config's, or with no
 * graphics card in it, this PC's (gameWatchCards). Never throws. `file`, `hw`, `now` and `probe` are for tests.
 */
export async function gameNow(o: { file?: string; hw?: Hardware | null; now?: number; probe?: () => Promise<string> } = {}): Promise<string | null> {
  try {
    const hw = o.hw === undefined ? readHardware() : o.hw;
    const cfg = loadAccelerators(o.file ?? readableConfigFile(), hw);
    return gameIn(await currentGames(gameWatchCards('error' in cfg ? [] : cfg.accelerators, hw), { now: o.now, probe: o.probe }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- choosing

/** A background request doesn't join a line with this many already waiting. */
export const MAX_AHEAD = RULES.accelerators.maxAhead;

export type Need = core.Need;
export type Skipped = core.Skipped;
export type WorkOrder = core.WorkOrder;

/**
 * The candidates for a request, in order: they serve its kind, its size fits their cap, they haven't
 * failed in the last 10 minutes (unless every one that would do has: then they all may, as a last
 * resort), a game isn't using them (background work only), and this agent isn't leaving them alone
 * after a line that was too long (`deferredMs`). The config's `workOrder` for its kind, when it has one, orders them
 * first, with `running` (serversUp) for its runningFirst, and `waiting` (how many of the work wait, this one included)
 * for its batchAt.
 */
export function candidates(
  accs: Accelerator[],
  need: Need,
  state: { failure?: (id: string) => Failure | null; games?: Games | null; deferredMs?: (id: string) => number; now?: number; workOrder?: WorkOrder | null; running?: (id: string) => boolean; waiting?: number } = {},
): { list: Accelerator[]; skipped: Skipped[]; npuFirst: boolean } {
  const asked = accs.filter((a) => core.serves(a, need.work));
  return core.candidates(RULES, accs, need, {
    failures: state.failure ? Object.fromEntries(asked.map((a) => [a.id, state.failure!(a.id)])) : undefined,
    games: state.games ?? null,
    deferredMs: state.deferredMs ? Object.fromEntries(asked.map((a) => [a.id, state.deferredMs!(a.id)])) : undefined,
    nowMs: state.now ?? Date.now(),
    ...(state.workOrder ? { workOrder: state.workOrder } : {}),
    ...(state.running ? { running: Object.fromEntries(asked.map((a) => [a.id, state.running!(a.id)])) } : {}),
    ...(state.waiting ? { waiting: state.waiting } : {}),
  });
}

/** How long a look at whether a server is up waits: a server that isn't refuses at once, and one that takes longer is up. */
export const UP_PROBE_MS = 500;

/**
 * Whose servers for this work are up (running: ready, or busy loading or answering), by id, when the work's order goes by
 * it (`workOrder`'s runningFirst); else none is asked and the answer is undefined. One look each, all at once, starting
 * nothing.
 */
export async function serversUp(accs: Accelerator[], work: Work, workOrder: WorkOrder | null | undefined, look: (baseUrl: string) => Promise<ServerState> = (b) => probe(b, UP_PROBE_MS)): Promise<((id: string) => boolean) | undefined> {
  if (!workOrder?.[work]?.runningFirst) return undefined;
  const up = new Map<string, boolean>();
  await Promise.all(accs.filter((a) => core.serves(a, work)).map(async (a) => up.set(a.id, (await look(a[work]!.baseUrl)) !== 'down')));
  return (id) => up.get(id) ?? false;
}

/** An accelerator's lock folders, one per slot: `locks\npu` for the NPU, `locks\<id>`, `<id>.2` … for the others. */
export const lockDirsOf = (acc: { id: string; slots?: number }) => slotDirs(lockDirFor(acc.id), core.lockFoldersOf(acc).length);

/**
 * The accelerator whose turn a request of this kind takes on `acc` (the core's turnOf), named for its messages: its
 * own, or the device its endpoint's `turn` names, whose server runs there (the NPU 3720's embeddings, on the
 * processor's graphics). `list` gives that device's slots and name when it has an entry; else one slot, and its name
 * from this PC (hardware.json).
 */
export function turnFor(acc: Pick<Accelerator, 'id' | 'name' | 'slots'> & Partial<Pick<Accelerator, Work>>, work: Work, list: ReadonlyArray<Pick<Accelerator, 'id' | 'name' | 'slots'>> = []): { id: string; name: string; slots: number } {
  const t = core.turnOf(acc, work, list);
  if (t.id === acc.id) return { id: acc.id, name: acc.name, slots: acc.slots };
  return { ...t, name: list.find((x) => x.id === t.id)?.name ?? core.acceleratorName(core.kindOfId(t.id) ?? 'gpu', t.id, readHardware()) };
}

/**
 * The devices whose turns the entries' servers take (an endpoint's `turn`) that have no entry of their own: the NPU
 * 3720's graphics, on a PC whose graphics serve nothing else. Their lines are the PC's too, for a status page.
 */
export function turnsWithoutEntry(list: Accelerator[]): { id: string; name: string; slots: number }[] {
  const out = new Map<string, { id: string; name: string; slots: number }>();
  for (const a of list) {
    if (a.enabled === false) continue;
    for (const w of ['chat', 'vision', 'embed'] as const) {
      if (!a[w]) continue;
      const t = turnFor(a, w, list);
      if (t.id !== a.id && !list.some((x) => x.id === t.id)) out.set(t.id, t);
    }
  }
  return [...out.values()];
}

export type Look = core.Look;

/**
 * Its line on disk (Reeve's lineState), with this process's own tickets replaced by `localWaiting`:
 * its requests already headed there, whether they hold a ticket yet or not.
 */
export function lineLook(acc: { id: string; slots?: number }, localWaiting = 0): Look {
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

/**
 * The server isn't running, and the manor is stopped (Manor's Settings, manor.ts' manorStopped): no model server starts
 * until it's started again (kit 2.99.1). A server already running still serves. Not a failure: nothing is marked.
 */
export class ManorStopped extends ServerNotRunning {}

/**
 * The server's program isn't where its startCommand says (kit 2.113.5): its setup removed, or never seen by the staff
 * (setup run inside a packaged app once left GenieX in that app's own AppData, which the staff can't see). A failure,
 * marked as one, and said plainly rather than as Node's ENOENT, which it gives for a missing working folder too. The
 * keeper sets the server up again (server-repair.ts).
 */
export class ProgramMissing extends AcceleratorDown {}

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

export async function probe(baseUrl: string, ms = PROBE_MS, o: { listsWhenLoaded?: boolean } = {}): Promise<ServerState> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(ms) });
    if (!res.ok || !o.listsWhenLoaded) {
      await res.body?.cancel();
      return res.ok ? 'ready' : res.status === 503 ? 'busy' : 'down';
    }
    const j: any = await res.json().catch(() => null);
    return Array.isArray(j?.data) && j.data.length === 0 ? 'busy' : 'ready';
  } catch (e: any) {
    return e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'busy' : 'down';
  }
}

/**
 * Whether a server, by its program, answers /v1/models before its model is loaded and lists none until it is: OpenVINO
 * Model Server opens its REST port within a second of starting and answers `{"data":[]}` while it loads (and, on the
 * NPU, compiles) its model, refusing a request then with a 404 (measured 2026-10-12, 2026.4.1). For such a server an
 * empty list is `busy`. Every other server is ready once it answers, as before.
 */
export function listsWhenLoaded(startCommand: string[] | undefined): boolean {
  const exe = startCommand?.[0];
  return !!exe && /^ovms(\.exe)?$/i.test(path.win32.basename(expandEnv(exe)));
}

/**
 * Whether a server, by its program, says which model it holds at /api/ps (as Ollama does): FastFlowLM loads its model
 * before it opens its port, and serves anyway when the load fails, /v1/models listing every model it knows either way.
 * Its /api/ps lists the model it holds, and answers an error when it holds none (1.0.7, 2026-10-15).
 */
export function reportsLoaded(startCommand: string[] | undefined): boolean {
  const exe = startCommand?.[0];
  return !!exe && /^flm(\.exe)?$/i.test(path.win32.basename(expandEnv(exe)));
}

/**
 * Whether a server this kit starts has its working set handed back to Windows once its model has loaded (working-set.ts,
 * kit 2.80.1): FastFlowLM's, which keeps its model's lookup tables in ordinary private memory and reads one row
 * of them a token. qwen3.5:2b's working set went from 3,814 MB to 171 MB, decoding as fast as before.
 */
export function trimmedOnceLoaded(startCommand: string[] | undefined): boolean {
  const exe = startCommand?.[0];
  return !!exe && /^flm(\.exe)?$/i.test(path.win32.basename(expandEnv(exe)));
}

/**
 * Trims a started server's working set (trimmedOnceLoaded) and says what it held, or why it couldn't: in the server's
 * log when it keeps one (the keeper's restarts), else on stderr, never stdout, which an MCP server answers on. Never
 * throws.
 */
async function trimLoaded(pid: number, program: string, base: string, logFile: string | undefined): Promise<void> {
  const said = await trimWorkingSet(pid);
  if (said === null) return;
  const held = /^trimmed (\d+)$/.exec(said);
  const line = `${new Date().toISOString()} kit: ${program} at ${base}: ${held ? `its working set handed back to Windows once loaded (it held ${Number(held[1]).toLocaleString('en-US')} MB)` : `its working set stays as it was (${said})`}`;
  try {
    if (logFile) return appendFileSync(logFile, `${line}\n`);
  } catch {}
  console.error(line);
}

/**
 * Once a llama-server is ready, the processor variants its folder holds beside the one it loaded are removed (kit
 * 2.90.0), so no later start loads them all again to choose: what setup's keepCpuVariant does where the build says its
 * choice, read from the running server where it doesn't. Asked once a folder: then it holds one.
 */
async function keepLoadedVariant(pid: number, folder: string, base: string, logFile: string | undefined): Promise<void> {
  const chosen = await loadedCpuVariant(pid);
  const removed = keepCpuVariant(folder, chosen);
  if (!removed.length) return;
  const line = `${new Date().toISOString()} kit: llama-server at ${base} runs ${chosen} on this processor; its ${removed.length} other processor variants are removed, so no start loads them again`;
  try {
    if (logFile) return appendFileSync(logFile, `${line}\n`);
  } catch {}
  console.error(line);
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

/** A model server the manor started: which process, its program, where it serves, and when (ms). */
export interface StartedServer {
  pid: number;
  program: string;
  base: string;
  atMs: number;
}

/** Where a started server's record is kept: `started.<pid>.json` in the accelerators' shared folder. */
export const startedFile = (pid: number) => path.join(acceleratorsDir, `started.${pid}.json`);

/**
 * Records a server the manor started, so the keeper knows it for the manor's own (keeper.ts' manorOwns) wherever its
 * program is, and never mistakes someone else's for it. A courtesy: a record that can't be written costs nothing but
 * the keeper's leave to stop it as an orphan.
 */
export function noteStarted(r: StartedServer): void {
  try {
    writeWhole(startedFile(r.pid), r);
  } catch {}
}

/** The servers the manor started, as recorded; records older than 30 days are dropped (their processes are long gone, or their pids reused). */
export function readStarted(now = Date.now()): StartedServer[] {
  let names: string[];
  try {
    names = readdirSync(acceleratorsDir);
  } catch {
    return [];
  }
  const out: StartedServer[] = [];
  for (const n of names.filter((x) => /^started\.\d+\.json$/.test(x))) {
    const f = path.join(acceleratorsDir, n);
    try {
      const r = JSON.parse(readFileSync(f, 'utf8'));
      if (typeof r?.pid !== 'number' || typeof r.program !== 'string' || typeof r.atMs !== 'number') continue;
      if (now - r.atMs > 30 * 86_400_000) {
        rmSync(f, { force: true });
        continue;
      }
      out.push({ pid: r.pid, program: r.program, base: String(r.base ?? ''), atMs: r.atMs });
    } catch {}
  }
  return out;
}

/**
 * A server's environment: the starter's, with the endpoint's own `env` over it, each value's `%NAME%` expanded from the
 * starter's (so `%PATH%` keeps the PATH it had). A name is matched in any case, as Windows does.
 */
export function serverEnv(ep: Pick<Endpoint, 'env'>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!ep.env) return base;
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [k, v] of Object.entries(ep.env)) {
    for (const old of Object.keys(out)) if (old.toLowerCase() === k.toLowerCase()) delete out[old];
    out[k] = expandEnv(v, base);
  }
  return out;
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
 * `logFile` takes what a server it starts prints (appended), and `env` is that server's environment: the keeper's
 * restarts (keeper.ts) keep a log per server; a request's start keeps none, as before.
 * `onWaking` is told, before any waiting, that the server is being started (it wasn't running: the keeper stopped it
 * when nobody used it) or is busy loading: the request will wait for its model to load. A throw from it is ignored.
 */
export async function ensureServer(ep: Endpoint, opts: { start?: boolean; waitMs?: number; readyMs?: number; logFile?: string; env?: NodeJS.ProcessEnv; onWaking?: (how: 'starting' | 'loading') => void; readBlocks?: ReadLog } = {}): Promise<ServerReady> {
  const readyMs = opts.readyMs ?? READY_WAIT_MS;
  const lists = { listsWhenLoaded: listsWhenLoaded(ep.startCommand) };
  const state = await probe(ep.baseUrl, PROBE_MS, lists);
  if (state === 'ready') return { started: false, waited: false };
  const waking = (how: 'starting' | 'loading') => {
    try {
      opts.onWaking?.(how);
    } catch {}
  };
  if (state === 'busy') {
    waking('loading');
    await untilReady(ep.baseUrl, readyMs, lists);
    return { started: false, waited: true };
  }
  if (opts.start === false) throw new ServerNotRunning(core.say.serverNotRunning(ep.baseUrl));
  // Stopped from Manor's Settings: the owner wants the PC quiet (a benchmark, a game) until they start the manor again.
  if (manorStopped()) throw new ManorStopped(`${core.say.serverNotRunning(ep.baseUrl)}, and ${core.say.manorStopped()}`);
  if (!ep.startCommand?.length) throw new AcceleratorDown(core.say.noStartCommand(ep.baseUrl));
  waking('starting');
  let pending = starting.get(ep.baseUrl);
  if (!pending) {
    pending = start(ep, opts.waitMs ?? START_WAIT_MS, readyMs, opts).finally(() => starting.delete(ep.baseUrl));
    starting.set(ep.baseUrl, pending);
  }
  return pending;
}

/** Waits until a busy server answers /v1/models; AcceleratorDown when it stops answering, or is still busy after `ms`. */
async function untilReady(baseUrl: string, ms: number, o: { listsWhenLoaded?: boolean } = {}): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const state = await probe(baseUrl, Math.max(250, Math.min(PROBE_MS, deadline - Date.now())), o);
    if (state === 'ready') return;
    if (state === 'down') throw new AcceleratorDown(core.say.connectionRefused('/v1/models', baseUrl, 'it stopped answering while busy'));
    if (Date.now() >= deadline) throw new AcceleratorDown(core.say.stillBusy(baseUrl, Math.round(ms / 1000)));
  }
}

/** How a server is started: where its output goes, its environment, and (for tests) the log its blocks are read from. */
interface StartOptions {
  logFile?: string;
  env?: NodeJS.ProcessEnv;
  readBlocks?: ReadLog;
}

/** A start that Smart App Control (or another application control policy) blocked part of. */
class BlockedStart extends AcceleratorDown {}

/** How long a start that was blocked waits before its one more try. */
export const BLOCKED_AGAIN_MS = 2_000;

/**
 * Starts a server, once more when Smart App Control blocked part of it (kit 2.91.0): on the PC where its blocks were
 * seen, each was a one-off, the same file running when it was started again, so a second try costs a few seconds and
 * can spare the asker a failure. When it's blocked again, that's said as before.
 */
async function start(ep: Endpoint, waitMs: number, readyMs: number, o: StartOptions = {}): Promise<ServerReady> {
  try {
    return await startOnce(ep, waitMs, readyMs, o);
  } catch (e) {
    if (!(e instanceof BlockedStart)) throw e;
    const line = `${new Date().toISOString()} kit: ${e.message} It's started once more in ${BLOCKED_AGAIN_MS / 1000} s.`;
    try {
      if (o.logFile) appendFileSync(o.logFile, `${line}
`);
      else console.error(line);
    } catch {}
    await new Promise((r) => setTimeout(r, BLOCKED_AGAIN_MS));
    return startOnce(ep, waitMs, readyMs, o);
  }
}

async function startOnce(ep: Endpoint, waitMs: number, readyMs: number, o: StartOptions): Promise<ServerReady> {
  const [cmd, ...args] = ep.startCommand!.map((a) => expandEnv(a));
  const program = path.win32.basename(cmd);
  // Its program looked for first (kit 2.113.5): a program on PATH (no folder named) is left to the spawn.
  if (path.win32.isAbsolute(cmd) && !existsSync(cmd)) throw new ProgramMissing(core.say.notInstalled(program, cmd));
  const startedAt = Date.now();
  let spawnError: Error | undefined;
  let exited: number | null | undefined;
  let log: number | undefined;
  /** Started apart (apart.ts): its process id, watched for an early exit rather than its exit event. */
  let apart: number | null = null;
  /** The server's process id, whichever way it started: its working set is trimmed once it's ready (trimmedOnceLoaded). */
  let pid: number | undefined;
  try {
    if (o.logFile) {
      mkdirSync(path.dirname(o.logFile), { recursive: true });
      log = openSync(o.logFile, 'a');
    }
    const env = serverEnv(ep, o.env ?? process.env);
    // Apart from the asker's job (apart.ts, kit 2.73.0): it serves every agent, at no asker's cap, in the servers' job at
    // the manor's ceiling (kit 2.78.3).
    const apartPid = await startApart(cmd, args, { cwd: os.homedir(), env, ...(log === undefined ? {} : { out: log }) });
    if (apartPid) {
      apart = pid = apartPid;
      noteStarted({ pid: apartPid, program: cmd, base: ep.baseUrl, atMs: Date.now() });
    } else {
      const child = spawn(cmd, args, { detached: true, stdio: log === undefined ? 'ignore' : ['ignore', log, log], windowsHide: true, cwd: os.homedir(), env });
      child.on('error', (e) => (spawnError = e));
      child.on('exit', (code) => (exited = code));
      child.unref();
      pid = child.pid;
      if (child.pid) noteStarted({ pid: child.pid, program: cmd, base: ep.baseUrl, atMs: Date.now() });
    }
  } catch (e) {
    spawnError = e as Error;
  } finally {
    if (log !== undefined) closeSync(log);
  }
  const deadline = Date.now() + waitMs;
  const lists = { listsWhenLoaded: listsWhenLoaded(ep.startCommand) };
  // Once its model has loaded, in the background: the request that started it goes on at once (working-set.ts).
  const loaded = () => {
    if (pid && trimmedOnceLoaded(ep.startCommand)) void trimLoaded(pid, program, ep.baseUrl, o.logFile);
    if (pid && /^llama-server\.exe$/i.test(program) && cpuVariants(path.dirname(cmd)) > 1) void keepLoadedVariant(pid, path.dirname(cmd), ep.baseUrl, o.logFile);
  };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (spawnError) throw await blockedFirst(cmd, startedAt, core.say.couldNotStart(cmd, spawnError.message), o.readBlocks, null);
    const state = await probe(ep.baseUrl, 2000, lists);
    if (state === 'ready') {
      loaded();
      return { started: true, waited: false };
    }
    if (state === 'busy') {
      await untilReady(ep.baseUrl, readyMs, lists);
      loaded();
      return { started: true, waited: true };
    }
    // GenieX exits at once (code 0) when another server holds its port: it is down only if nothing answers.
    if (apart && exited === undefined && !alive(apart)) exited = null;
    if (exited !== undefined) throw await blockedFirst(cmd, startedAt, core.say.exitedWhileStarting(program, exited, ep.baseUrl), o.readBlocks, exited);
  }
  throw new AcceleratorDown(core.say.didNotAnswer(program, ep.baseUrl, Math.round(waitMs / 1000)));
}

/**
 * A server that couldn't start, with what Windows' Smart App Control (or another application control policy) blocked of
 * it said first, when its log names a file in the server's folder since the start (app-control.ts, kit 2.88.4): then a
 * BlockedStart, which start() tries once more. An exit of 0xC0E90002 (BLOCKED_EXIT, kit 2.104.0) is a block too, said
 * so where the log names nothing (it can't be read, or the server started apart, whose exit code isn't known).
 */
async function blockedFirst(cmd: string, since: number, said: string, read: ReadLog | undefined, code: number | null): Promise<AcceleratorDown> {
  const program = path.win32.basename(cmd);
  const why = blockedSay(await blockedIn(path.dirname(cmd), Date.now() - since + 5_000, read), program) ?? (blockedExit(code) ? blockedExitSay(program, smartAppControlOutsideTests()) : null);
  return why ? new BlockedStart(`${why}. ${said}`) : new AcceleratorDown(said);
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
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(core.say.notJson(text.slice(0, 120)));
  }
  if (failedWithOk(json)) throw new AcceleratorDown(core.say.serverFailed(route, ep.baseUrl, res.status, text.slice(0, 200)));
  return { json, ms };
}

/**
 * A 200 that carries only an error: the server failing, not answering. FastFlowLM answers so when its model didn't load
 * (`{"error":"Failed to load qwen3-it:4b model!"}`, 1.0.7 on an XDNA 2 whose NPU couldn't hold the model, 2026-10-15),
 * and tries the load again on every request; a request it won't take is a 400 ("Max length reached!"). Read as an
 * answer, it was an empty one, and the work took it.
 */
export function failedWithOk(json: any): boolean {
  return !!json && typeof json === 'object' && !Array.isArray(json) && json.error !== undefined && json.choices === undefined && json.data === undefined;
}

// ---------------------------------------------------------------- the servers' quirks

const nonce = () => `[req ${Math.random().toString(36).slice(2, 10)}]`;

/** Room the estimate keeps for a nonce and Qwen3's /no_think, whichever accelerator takes the request. */
export const QUIRK_ROOM_CHARS = RULES.tokens.quirkRoomChars;

/**
 * Qwen3 thinks by default and spends the output budget on it; its Instruct models never do (Qwen3-4B-Instruct-2507,
 * Qwen3-VL-4B-Instruct), and /no_think only costs them: the VL model answered one question in ten fewer with it
 * (measured 2026-10-04, the Auditor's suite and ten more). So only a Qwen3 that isn't an Instruct model is told.
 */
export const thinks = (model: string) => /(^|\/)qwen3(?!\.5)(?!.*instruct)/i.test(model);

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

/**
 * A picture's width and height from its header (PNG, JPEG, GIF, BMP), or null for another format (WebP) or one it can't
 * read. Pure.
 */
export function pictureSize(b: Buffer): { width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 26 && b.toString('latin1', 0, 2) === 'BM') {
    // BITMAPCOREHEADER (12 bytes) has 16-bit sides; every later header 32-bit ones, the height negative when top-down.
    return b.readUInt32LE(14) === 12 ? { width: b.readUInt16LE(18), height: b.readUInt16LE(20) } : { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: its segments up to the first frame header (SOF0 to SOF15, which aren't DHT, JPG or DAC), which holds the sides.
    let i = 2;
    while (i + 9 <= b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) i += 1;
      else if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) i += 2;
      else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      else if (m === 0xd9 || m === 0xda) return null;
      else i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/**
 * The size a server with `sides-of-32` should get a picture at, or null when it reads it right as it is. FastFlowLM (1.0.7,
 * and 1.0.10 still) misreads a picture with a side of a whole number of 32 px (its models' patches, 16 px merged in twos) when it doesn't
 * shrink the picture itself, which its --img-pre-resize 2 (the default, the AMD route's) does only above 720 px tall.
 * Made a pixel longer, such a side is resampled by the model's own resize, and read right: spec/NPU-VENDORS.md has the
 * measurements. Pure.
 */
export function sidesOff32(size: { width: number; height: number }): { width: number; height: number } | null {
  if (size.width < 1 || size.height < 1 || size.height > 720) return null;
  const off = (n: number) => (n % 32 ? n : n + 1);
  const to = { width: off(size.width), height: off(size.height) };
  return to.width === size.width && to.height === size.height ? null : to;
}

/** A side of this many pixels is one token's, on a server that reads a picture at its own size: Qwen-VL's 16 px patches, merged in twos. */
export const PICTURE_TOKEN_PX = 32;

/**
 * The tokens a picture is on a server that reads it at its own size (a vision endpoint's pictureTokens): llama.cpp's
 * Qwen-VL rounds each side to the nearest PICTURE_TOKEN_PX, at least one, and reads a token per square. Measured on the
 * Snapdragon X2's Qwen3-VL-2B (GenieX 0.8.0, 2026-10-17), each with about 36 for the question: 448 × 448 232 tokens,
 * 1,920 × 1,080 2,075, 2,560 × 1,440 3,636. Pure.
 */
export function pictureTokensOf(size: { width: number; height: number }): number {
  const squares = (n: number) => Math.max(1, Math.round(n / PICTURE_TOKEN_PX));
  return squares(size.width) * squares(size.height);
}

/**
 * The size a picture should be redrawn at so a server that reads it at its own size makes it `tokens` at most, or null
 * when it is already: scaled down evenly (never up), each side a whole number of PICTURE_TOKEN_PX, so the server's own
 * resize leaves it as it is. Its shape is kept to within a square a side. Pure.
 */
export function pictureFit(size: { width: number; height: number }, tokens: number): { width: number; height: number } | null {
  if (size.width < 1 || size.height < 1 || pictureTokensOf(size) <= tokens) return null;
  const scale = Math.min(1, Math.sqrt((tokens * PICTURE_TOKEN_PX * PICTURE_TOKEN_PX) / (size.width * size.height)));
  const squares = (n: number) => Math.max(1, Math.floor((n * scale) / PICTURE_TOKEN_PX));
  let w = squares(size.width);
  let h = squares(size.height);
  // A side of a single square (a picture far wider than tall) leaves the other the whole count.
  if (w * h > tokens) (w > h ? (w = Math.floor(tokens / h)) : (h = Math.floor(tokens / w)));
  return { width: w * PICTURE_TOKEN_PX, height: h * PICTURE_TOKEN_PX };
}

/**
 * Redraws the picture `from` at `size` as a PNG at `to`: System.Drawing's high-quality bicubic, its edges not faded.
 * PowerShell gets 30 s, or `o.timeoutMs` (a test on a busy PC, under a kit trial's load).
 */
export async function redrawPicture(from: string, to: string, size: { width: number; height: number }, o: { timeoutMs?: number } = {}): Promise<void> {
  const w = Math.round(size.width);
  const h = Math.round(size.height);
  await powershell(
    `Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile(${psQuote(from)})
try {
  $bmp = New-Object System.Drawing.Bitmap ${w}, ${h}
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $edges = New-Object System.Drawing.Imaging.ImageAttributes
      $edges.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
      $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, ${w}, ${h}), 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $edges)
    } finally { $g.Dispose() }
    $bmp.Save(${psQuote(to)}, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bmp.Dispose() }
} finally { $src.Dispose() }`,
    { timeoutMs: o.timeoutMs ?? 30_000 },
  );
}

/**
 * The size `acc`'s server should get a picture at, or null when it reads it right as it is: within its vision's
 * pictureTokens (pictureFit), and then, on a server with `sides-of-32`, sidesOff32's. Pure.
 */
export function pictureSizeFor(acc: Pick<Accelerator, 'quirks'> & Partial<Pick<Accelerator, 'vision'>>, size: { width: number; height: number }): { width: number; height: number } | null {
  const fit = acc.vision?.pictureTokens ? pictureFit(size, acc.vision.pictureTokens) : null;
  return (acc.quirks.includes('sides-of-32') ? sidesOff32(fit ?? size) : null) ?? fit;
}

/**
 * The picture as `acc`'s server should get it (a local path, a `data:` URL or a URL): as it is, except where
 * pictureSizeFor gives it another size: larger than its vision's pictureTokens (the Snapdragon X2's Qwen3-VL-2B), or a
 * side of 32 px on a server with `sides-of-32` (FastFlowLM). Then it's redrawn at that size and goes as a PNG `data:`
 * URL. A URL, a format whose size it can't read (WebP), and a picture it couldn't redraw go as they are.
 */
export async function fitPicture(acc: Pick<Accelerator, 'quirks'> & Partial<Pick<Accelerator, 'vision'>>, image: string, redraw: typeof redrawPicture = redrawPicture): Promise<string> {
  if ((!acc.quirks.includes('sides-of-32') && !acc.vision?.pictureTokens) || /^https?:/i.test(image)) return image;
  const data = /^data:[^,]*;base64,/i.exec(image);
  if (!data && /^data:/i.test(image)) return image;
  let bytes: Buffer;
  try {
    bytes = data ? Buffer.from(image.slice(data[0].length), 'base64') : readFileSync(image);
  } catch {
    return image; // the request says what's wrong with it, as before
  }
  const size = pictureSize(bytes);
  const to = size && pictureSizeFor(acc, size);
  if (!to) return image;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kit-picture-'));
  try {
    const from = data ? path.join(dir, 'from') : image;
    if (data) writeFileSync(from, bytes);
    const out = path.join(dir, 'to.png');
    await redraw(from, out, to);
    return `data:image/png;base64,${readFileSync(out).toString('base64')}`;
  } catch {
    return image;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One question about one image: a local path the server reads itself (`image-path`), else a `data:` URL. The image is
 * the one fitPicture gives for `acc`, which the caller awaits first.
 */
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
