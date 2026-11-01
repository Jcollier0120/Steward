import os from 'node:os';
import { APP } from '../app.ts';
import * as core from './core/index.js';
import {
  AcceleratorDown,
  candidates,
  chatBody,
  clearFailure,
  currentGames,
  embeddedAt,
  ensureServer,
  expandEnv,
  fitPicture,
  gamesStale,
  lineLook,
  loadAccelerators,
  lockDirsOf,
  ManorStopped,
  markFailed,
  noteEmbedded,
  MAX_AHEAD,
  ModelLoading,
  NoRoomToLoad,
  noteServed,
  parseAccelerators,
  pick as pickFrom,
  postJson,
  probe,
  npuCallNow,
  readFailure,
  readGames,
  READY_WAIT_MS,
  refOf,
  ServerNotRunning,
  servedRecently,
  serves,
  serversUp,
  theAccelerator,
  turnFor,
  turnsWithoutEntry,
  visionBody,
  type Accelerator,
  type AcceleratorConfig,
  type AcceleratorRef,
  type ChatMessage,
  type Endpoint,
  type Skipped,
  type Work,
} from './accelerators.ts';
import { npuLockDir } from './lock.ts';
import { gpuWithNpu } from './manor.ts';
import { noteSpeed } from './boot-speed.ts';
import { tallyRequest } from './token-tally.ts';
import { LockTimeout, lineSnapshot, QueueFull, queueSnapshot, withAcceleratorTurn, type Lane } from './npu-queue.ts';
import { RULES } from './rules.ts';
import { coldStartMsOf, routeOfServer, smallPc } from './npu-vendors.ts';

export { npuLockDir };
export { noteLabel, reeveHome, theAccelerator, theName, type Accelerator, type AcceleratorConfig, type AcceleratorRef, type ChatMessage } from './accelerators.ts';

/**
 * The manor's models, wherever they run: the NPU, a graphics card or the processor (Manor's
 * docs/ACCELERATORS.md, and the kit's accelerators.ts). The accelerators are Reeve's, in its config.json, so
 * a change there reaches every agent; their servers, locks and lines are shared with Reeve, Heiward and
 * the other agents. Each request goes to one accelerator by the contract's rules, and its answer says
 * which.
 *
 * What a 4B model is good for here: reading a short passage and labelling, naming or explaining it.
 * It is not good at deciding. Code decides; every model answer is shown as UNVERIFIED, next to the
 * facts code computed, and says where it ran.
 */

/** The older config's shape, still taken by `new Npu(...)`: one server, read as one accelerator. */
export interface NpuConfig {
  baseUrl: string;
  model: string;
  device: string;
  startCommand?: string[];
  visionModel?: string;
  /** Prompt plus output, in pessimistic tokens (chars / 3). An ~8K-token prompt bluescreened this PC. */
  maxContextTokens: number;
  requestTimeoutMs: number;
}

export interface NpuAnswer {
  text: string;
  model: string;
  ms: number;
  truncated: boolean;
  /** Token counts as the server reports them (0 when it reports none). */
  promptTokens: number;
  completionTokens: number;
  /** How fast it wrote the answer, in tokens a second, where the server says (FastFlowLM's usage.decoding_speed_tps). */
  tokensPerSecond?: number;
  /** The accelerator it ran on. */
  accelerator: AcceleratorRef;
  /** The accelerator tried first, when it failed and the request went to this one. */
  fellBackFrom?: AcceleratorRef & { reason: string };
}

export interface Embeddings {
  vectors: number[][];
  model: string;
  ms: number;
  accelerator: AcceleratorRef;
  fellBackFrom?: AcceleratorRef & { reason: string };
}

export interface AskOptions {
  maxTokens?: number;
  /** How long to wait in an accelerator's line (default 10 minutes). */
  maxWaitMs?: number;
  /** Default background: the agents are background staff. */
  lane?: Lane;
  /** Only this accelerator, and no fallback (the Auditor audits each one). */
  accelerator?: string;
  /**
   * false: use a server only if it is already running. One that isn't is passed over for the next
   * candidate, and isn't counted as failed.
   */
  start?: boolean;
  /** How long the server may take to answer (default Reeve's requestTimeoutMs): shorter for a person waiting. */
  timeoutMs?: number;
  /**
   * Told, before the request waits, that its model was resting and is being woken: its server had stopped (the keeper
   * stops one nobody used for a while: npuIdleStopMinutes) and is starting, or is busy loading its model. For a person
   * waiting (a chat, a caption), say so plainly with its `line`, as a setting-up card would, rather than a bare spinner.
   * The request then waits for the model: a server just started is given its cold load, whatever `timeoutMs` says.
   */
  onWaking?: (w: Waking) => void;
  /**
   * How many requests of this kind the caller is sending together, this one included, when it knows: a folder of
   * screenshots, say. They count with those already waiting toward the work's order's batchAt (kit 2.111.0), which no
   * generation's order has since kit 2.135.1 (until then, on AMD's Ryzen AI 300, 4 or more pictures went to the Radeon
   * even while only FastFlowLM was up).
   */
  batch?: number;
}

/** A resting model being woken for a request (AskOptions.onWaking). */
export interface Waking {
  accelerator: AcceleratorRef;
  /** 'starting': its server had stopped and is starting; 'loading': it is up, loading its model. */
  how: 'starting' | 'loading';
  /** About how long waking takes (an NPU route's measured cold start, npu-vendors.json's idleStop), or null when unknown. */
  aboutMs: number | null;
  /** In plain words, for the person waiting: "Waking the local AI on the NPU: it rests when nobody uses it, so the first answer takes about 15 s longer." */
  line: string;
}

/** What a request waking `acc`'s model is told: how, about how long (an NPU route's cold start), and a line saying so. */
export function wakingOf(acc: Accelerator, work: Work, ep: Pick<Endpoint, 'startCommand'>, how: Waking['how']): Waking {
  const aboutMs = acc.kind === 'npu' ? coldStartMsOf(routeOfServer(expandEnv(ep.startCommand?.[0] ?? ''), work), work) : null;
  const longer = aboutMs ? `about ${Math.max(1, Math.round(aboutMs / 1000))} s longer` : 'a little longer';
  const where = theAccelerator(refOf(acc));
  const line = how === 'starting' ? `Waking the local AI on ${where}: it rests when nobody uses it, so the first answer takes ${longer}.` : `The local AI on ${where} is loading its model: the first answer takes ${longer}.`;
  return { accelerator: refOf(acc), how, aboutMs, line };
}

export class NpuError extends Error {}

/**
 * Every line was too long, or too slow, or the accelerators that could take it are busy (a game) or
 * resting. Not a fault: leave the rest of the round's model work for a later round, and don't cache it
 * as an answer.
 */
export class NpuBusy extends NpuError {}

// ---------------------------------------------------------------- manners
//
// Turns on an accelerator come through its line, which every program on this PC that uses it shares
// (npu-queue.ts, a copy of Reeve's; Reeve's docs/NPU-QUEUE.md): first come, first served, and a
// free slot passes straight to the next in line. The agents are background staff, so a request a
// person is waiting on (Claude asking Reeve) goes ahead of theirs, until they have waited two minutes.
// On top of that, an agent:
// - has one ticket in each line at a time, however many requests it has queued there, and takes a new
//   ticket for each request: a long round is a series of turns, and everyone else's come in between;
//   it can wait in two lines (the NPU's and a graphics card's) at once;
// - doesn't join a line that already has 4 or more waiting: the request goes to a shorter line, or,
//   when every line is that long, is deferred (NpuBusy) for a quieter round;
// - gives up after 10 minutes in line (NpuBusy), and then leaves that accelerator alone for a while.
// The cap is per request, not shared: a request over every candidate's cap is refused at once, before
// any waiting. A request a person is waiting on (lane 'interactive', a search say) is none of that
// background work: it takes its own ticket at once, always joins, and a short wait that runs out
// defers nothing else.

const MAX_WAIT_MS = RULES.manners.maxWaitMs;
const BACK_OFF_MS = RULES.manners.backOffMs;

/** Per accelerator: this process's serial line, its requests headed there, and its back-off. */
const lines = new Map<string, Promise<unknown>>();
const headed = new Map<string, number>();
const busyUntil = new Map<string, number>();
/** Per accelerator: when this process last wrote that the NPU answered an embedding (noteEmbedded), so a busy index writes it every few seconds, not after each request. */
const embedNoted = new Map<string, number>();
const EMBED_NOTE_MS = 5_000;
const known = new Set<string>();

const deferredMs = (id: string) => Math.max(0, (busyUntil.get(id) ?? 0) - Date.now());

/**
 * How long this agent still leaves model work alone after lines were too long or too slow: 0 while any
 * accelerator it knows can be tried.
 */
export const npuDeferredFor = () => (known.size ? Math.min(...[...known].map(deferredMs)) : 0);

/** For tests: forget the back-off. */
export function resetNpuManners(): void {
  busyUntil.clear();
}

/** Who holds the NPU and who is waiting, in order: for a status line on the page. */
export const npuLine = () => queueSnapshot(npuLockDir);

/**
 * Every accelerator's holders (per slot) and line, for a status line on the page; and the line of a device an entry's
 * server takes the turn of without an entry of its own (the NPU 3720's graphics, its embeddings').
 */
export function acceleratorLines(cfg: AcceleratorConfig | { error: string } = loadAccelerators()) {
  if ('error' in cfg) return [];
  return [
    ...cfg.accelerators.map((a) => ({ ...refOf(a), slots: a.slots, ...lineSnapshot(lockDirsOf(a)) })),
    ...turnsWithoutEntry(cfg.accelerators).map((t) => ({ id: t.id, name: t.name, slots: t.slots, ...lineSnapshot(lockDirsOf(t)) })),
  ];
}

/**
 * Runs `fn` holding one of an accelerator's slots, after waiting its turn in its line (above). Every
 * request this agent runs on an accelerator goes through here: chat(), vision() and embed() do, and so
 * must any other, such as a request to npu-embed's server, which leaves the locking to its callers.
 */
export function acceleratorTurn<T>(
  acc: { id: string; name?: string; slots?: number },
  fn: () => Promise<T>,
  opts: { maxWaitMs?: number; maxAhead?: number; lane?: Lane; work?: Work } = {},
): Promise<T> {
  known.add(acc.id);
  const where = theAccelerator({ id: acc.id, name: acc.name ?? (acc.id === 'npu' ? 'NPU' : acc.id) });
  const lane = opts.lane ?? 'background';
  const background = lane === 'background';
  const run = async (): Promise<T> => {
    const rest = background ? deferredMs(acc.id) : 0;
    if (rest > 0) throw new NpuBusy(core.say.restingFor(where, Math.ceil(rest / 60_000)));
    try {
      return await withAcceleratorTurn(lockDirsOf(acc), () => fn(), {
        lane,
        who: APP.id,
        waitMs: opts.maxWaitMs ?? MAX_WAIT_MS,
        maxAhead: opts.maxAhead ?? (background ? MAX_AHEAD : undefined),
        ...(opts.work ? { work: opts.work } : {}),
      });
    } catch (e) {
      const deferred = background ? core.say.deferredFor(BACK_OFF_MS / 60_000) : '';
      if (background && (e instanceof QueueFull || e instanceof LockTimeout)) busyUntil.set(acc.id, Date.now() + BACK_OFF_MS);
      if (e instanceof QueueFull) throw new NpuBusy(core.say.lineTooLong(where, e.message, deferred));
      if (e instanceof LockTimeout) throw new NpuBusy(core.say.noTurnWithin(where, Math.round((opts.maxWaitMs ?? MAX_WAIT_MS) / 1000), deferred));
      throw e;
    }
  };
  // A person waiting doesn't queue behind this agent's own background work.
  if (!background) return run();
  headed.set(acc.id, (headed.get(acc.id) ?? 0) + 1);
  const prev = lines.get(acc.id) ?? Promise.resolve();
  const turn = prev.then(run, run);
  lines.set(acc.id, turn.catch(() => undefined));
  return turn.finally(() => headed.set(acc.id, (headed.get(acc.id) ?? 1) - 1));
}

/** This process's requests of each kind that haven't started their turn yet (routed, or waiting in a line), for batchAt. */
const waitingHere = new Map<Work, number>();

/** Counts a request of `work` as waiting until the function returned is called (its turn starts, or it ends): once. */
function joinWaiting(work: Work): () => void {
  waitingHere.set(work, (waitingHere.get(work) ?? 0) + 1);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    waitingHere.set(work, (waitingHere.get(work) ?? 1) - 1);
  };
}

/**
 * How many requests of `work` wait (kit 2.111.0): this process's that haven't started their turn (a request counts from
 * when it's asked, so a batch sent at once counts itself whole), and other processes' tickets in these turns' lines that
 * say they're of it (a ticket's `work`; one that doesn't say counts as none). For the work's order's batchAt.
 */
export function waitingFor(work: Work, turns: { id: string; slots: number }[]): number {
  let others = 0;
  for (const id of new Set(turns.map((t) => t.id))) {
    const t = turns.find((x) => x.id === id)!;
    others += queueSnapshot(lockDirsOf(t)[0]).waiting.filter((w) => w.work === work && w.pid !== process.pid).length;
  }
  return (waitingHere.get(work) ?? 0) + others;
}

/** Runs `fn` holding the NPU (above): for NPU work that isn't a chat or vision request. */
export function npuTurn<T>(fn: () => Promise<T>, opts: { maxWaitMs?: number; maxAhead?: number } = {}): Promise<T> {
  return acceleratorTurn({ id: 'npu', name: 'NPU', slots: 1 }, fn, opts);
}

/** Reeve's config.json's accelerators, or why none can be used (accelerators.ts). */
export const loadNpuConfig = loadAccelerators;

/** The pessimistic estimate Reeve uses for its cap: one token per 3 characters (the core's, and the spec's rules.json). */
export const estimateTokens = (text: string) => core.estimateTokens(RULES, text);

/**
 * Splits text into pieces whose estimated size fits `budgetTokens`, at line breaks where it can, so a
 * long input is asked about piece by piece (map-reduce) and never sent whole.
 */
export function pieces(text: string, budgetTokens: number): string[] {
  return core.pieces(RULES, text, budgetTokens);
}

/** An older config's one server as an accelerator config. */
function fromNpuConfig(c: NpuConfig): AcceleratorConfig | { error: string } {
  const cfg = parseAccelerators({
    chatEndpoint: { baseUrl: c.baseUrl, model: c.model, device: c.device, startCommand: c.startCommand },
    visionModel: c.visionModel,
    npuMaxContextTokens: c.maxContextTokens,
    requestTimeoutMs: c.requestTimeoutMs,
  });
  return cfg;
}

/** A request's prompt by the estimate: the same on every accelerator, or each one's own (a picture's, by its pictureTokens). */
type PromptTokens = number | ((a: Accelerator) => number);
const tokensOn = (p: PromptTokens, a: Accelerator) => (typeof p === 'number' ? p : p(a));

function answerOf(json: any, model: string, ms: number) {
  const choice = json?.choices?.[0];
  const tps = Number(json?.usage?.decoding_speed_tps);
  return {
    text: String(choice?.message?.content ?? '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim(),
    model,
    ms,
    truncated: choice?.finish_reason === 'length',
    promptTokens: Number(json?.usage?.prompt_tokens) || 0,
    completionTokens: Number(json?.usage?.completion_tokens) || 0,
    ...(Number.isFinite(tps) && tps > 0 ? { tokensPerSecond: tps } : {}),
  };
}

/** Why no accelerator could take a request: busy (deferred) while any is only resting or held by a game. */
function noCandidate(skipped: Skipped[], first: { acc: Accelerator; reason: string } | null): NpuError {
  const why = core.whyNone(skipped, first);
  return why.busy ? new NpuBusy(why.message) : new NpuError(why.message);
}

export class Npu {
  private cfg: AcceleratorConfig | { error: string };
  private withNpu: () => boolean;
  private embedGivesWay: (acc: Accelerator) => Promise<unknown>;
  private serversUp: typeof serversUp;

  /**
   * `o.gpuWithNpu`: Manor's switch as a check gives it, in place of Manor's settings read afresh each time.
   * `o.embedGivesWay`: what a chat or vision request on the NPU does first, in its turn (embedGivesWay below; tests give their own).
   * `o.serversUp`: whose servers are up, for a work whose order goes by it (accelerators.ts' serversUp; tests give their own).
   */
  constructor(cfg: AcceleratorConfig | NpuConfig | { error: string } = loadAccelerators(), o: { gpuWithNpu?: () => boolean; embedGivesWay?: (acc: Accelerator) => Promise<unknown>; serversUp?: typeof serversUp } = {}) {
    this.cfg = 'error' in cfg || 'accelerators' in cfg ? cfg : fromNpuConfig(cfg);
    this.withNpu = o.gpuWithNpu ?? (() => gpuWithNpu().on);
    this.embedGivesWay = o.embedGivesWay ?? ((acc) => embedGivesWay(acc));
    this.serversUp = o.serversUp ?? serversUp;
    if (!('error' in this.cfg)) for (const a of this.cfg.accelerators) known.add(a.id);
  }

  /** Why no model can be used, or null when Reeve's config lists at least one accelerator. */
  get problem(): string | null {
    return 'error' in this.cfg ? this.cfg.error : null;
  }

  /**
   * The accelerators, in the order requests try them (none when there is a problem). With Manor's "Use the graphics
   * card for models when there's an NPU" off and an NPU here, a graphics card only for the work no NPU here serves
   * (manor.ts's gpuWithNpu(), read afresh each time, and the core's withoutGpuBesideNpu): the NPU's own work never
   * goes to one, not even as a fallback, but for the work config.json's work order puts the card first for (AMD's
   * pictures, kit 2.135.3; never chat); the rest (vision, beside Intel's NPU and AMD's) starts the card's server on demand.
   */
  get accelerators(): Accelerator[] {
    return 'error' in this.cfg ? [] : core.withoutGpuBesideNpu(this.cfg.accelerators, this.withNpu(), this.cfg.workOrder);
  }

  get hasVision(): boolean {
    return this.accelerators.some((a) => serves(a, 'vision'));
  }

  get hasEmbed(): boolean {
    return this.accelerators.some((a) => serves(a, 'embed'));
  }

  /**
   * The prompt room left when `maxTokens` are kept for the answer: for chunking before an accelerator
   * is chosen, the largest cap among the ones that could take it now (all of them, when none could).
   */
  budget(maxTokens: number, work: Work = 'chat'): number {
    const serving = this.accelerators.filter((a) => serves(a, work));
    if (!serving.length) return 0;
    const games = readGames();
    const workOrder = 'error' in this.cfg ? null : this.cfg.workOrder;
    const { list } = candidates(serving, { work, tokens: 0, lane: 'background' }, { failure: readFailure, games: gamesStale(games) ? null : games, call: npuCallNow(), deferredMs, workOrder });
    return Math.max(...(list.length ? list : serving).map((a) => core.capFor(a, work))) - maxTokens;
  }

  /** Whether any chat server is running (ready, or busy loading or answering), without starting one. */
  async reachable(): Promise<boolean> {
    for (const a of this.accelerators) if (serves(a, 'chat') && (await probe(a.chat!.baseUrl)) !== 'down') return true;
    return false;
  }

  /**
   * One chat request at temperature 0. Refused before anything is sent when it would exceed every
   * candidate's cap. Put the payload first and the question last: the 4B model follows the text
   * nearest the end.
   */
  async chat(messages: ChatMessage[], opts: AskOptions = {}): Promise<NpuAnswer> {
    const maxTokens = opts.maxTokens ?? 300;
    const promptTokens = core.chatTokens(RULES, messages);
    return this.ask('chat', promptTokens, maxTokens, opts, async (acc, ep, timeoutMs, loading) => {
      const { json, ms } = await postJson(ep, '/v1/chat/completions', chatBody(acc, ep, messages, maxTokens), timeoutMs, { loading });
      return answerOf(json, ep.model, ms);
    });
  }

  /**
   * One question about one image, by a vision model. Small vision models perceive well and reason
   * badly: ask what is there ("what text is the title", "is there a chart"), and leave conclusions to
   * code. `image` is a local path: GenieX reads it itself, other servers get it as a data: URL. FastFlowLM gets a picture
   * with a side of a whole number of 32 px that side a pixel longer, which it reads right, and a server that reads a
   * picture at its own size (the Snapdragon X2's Qwen3-VL-2B) a larger one redrawn within its pictureTokens (fitPicture).
   */
  async vision(image: string, question: string, opts: AskOptions = {}): Promise<NpuAnswer> {
    const maxTokens = opts.maxTokens ?? 64;
    // The picture counts what it's fitted to on each accelerator (its vision's pictureTokens), else 400 (rules.json's
    // imageTokens: the Snapdragon X's Qwen3-VL-4B reads every picture as a fixed 256).
    return this.ask('vision', (a) => core.visionTokens(RULES, question, a), maxTokens, opts, async (acc, ep, timeoutMs, loading) => {
      const { json, ms } = await postJson(ep, '/v1/chat/completions', visionBody(acc, ep, await fitPicture(acc, image), question, maxTokens), timeoutMs, { loading });
      return answerOf(json, ep.model, ms);
    });
  }

  /** Embeddings for `texts`, in their order, from one accelerator's embedding model. */
  async embed(texts: string[], opts: AskOptions = {}): Promise<Embeddings> {
    const longest = Math.max(0, ...texts.map(estimateTokens));
    const r = await this.route('embed', longest, 0, opts, async (acc, ep, timeoutMs, loading) => {
      const { json, ms } = await postJson(ep, '/v1/embeddings', { model: ep.model, input: texts }, timeoutMs, { loading });
      const vectors: number[][] = [];
      for (const row of (json?.data ?? []) as { index: number; embedding: number[] }[]) vectors[row.index] = row.embedding;
      if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v))) throw new Error(core.say.tooFewVectors());
      return { vectors, model: ep.model, ms };
    });
    // Counted for the accelerator's day (token-tally.ts' busyToday, kit 2.85.0): the texts' tokens, by the kit's estimate.
    tallyRequest(APP.id, { work: 'embed', lane: opts.lane ?? 'background', kind: r.acc.kind, acc: r.acc.id, promptTokens: texts.reduce((n, t) => n + estimateTokens(t), 0), answerTokens: 0, ms: r.value.ms });
    return { ...r.value, accelerator: refOf(r.acc), ...(r.fellBackFrom ? { fellBackFrom: r.fellBackFrom } : {}) };
  }

  private async ask(
    work: Work,
    promptTokens: PromptTokens,
    maxTokens: number,
    opts: AskOptions,
    send: (acc: Accelerator, ep: Endpoint, timeoutMs: number, loading: boolean) => Promise<Omit<NpuAnswer, 'accelerator' | 'fellBackFrom'>>,
  ): Promise<NpuAnswer> {
    const r = await this.route(work, promptTokens, maxTokens, opts, send);
    // The server's count where it gives one, the kit's estimate where it doesn't.
    tallyRequest(APP.id, { work, lane: opts.lane ?? 'background', kind: r.acc.kind, acc: r.acc.id, promptTokens: r.value.promptTokens || tokensOn(promptTokens, r.acc), answerTokens: r.value.completionTokens, ms: r.value.ms });
    // Chat's decode speed, for a slow start (boot-speed.ts): vision's answers are too short, and a picture's encoding may count in.
    if (work === 'chat' && r.value.tokensPerSecond) noteSpeed(APP.id, { acc: r.acc.id, model: r.value.model, answerTokens: r.value.completionTokens, tokensPerSecond: r.value.tokensPerSecond });
    return { ...r.value, accelerator: refOf(r.acc), ...(r.fellBackFrom ? { fellBackFrom: r.fellBackFrom } : {}) };
  }

  /**
   * The contract's choosing (Manor's docs/ACCELERATORS.md): the candidates, the pick, the turn, and one
   * fallback when the accelerator fails the request. The request counts as waiting from now until its turn starts
   * (waitingFor, for a work order's batchAt).
   */
  private async route<T>(
    work: Work,
    prompt: PromptTokens,
    maxTokens: number,
    opts: AskOptions,
    send: (acc: Accelerator, ep: Endpoint, timeoutMs: number, loading: boolean) => Promise<T>,
  ): Promise<{ value: T; acc: Accelerator; fellBackFrom?: AcceleratorRef & { reason: string } }> {
    const leave = joinWaiting(work);
    try {
      return await this.routeWaiting(work, prompt, maxTokens, opts, send, leave);
    } finally {
      leave();
    }
  }

  /** route's own, the request counted as waiting until `leave` is called. */
  private async routeWaiting<T>(
    work: Work,
    prompt: PromptTokens,
    maxTokens: number,
    opts: AskOptions,
    send: (acc: Accelerator, ep: Endpoint, timeoutMs: number, loading: boolean) => Promise<T>,
    leave: () => void,
  ): Promise<{ value: T; acc: Accelerator; fellBackFrom?: AcceleratorRef & { reason: string } }> {
    if ('error' in this.cfg) throw new NpuError(this.cfg.error);
    const cfg = this.cfg;
    const lane = opts.lane ?? 'background';
    const asked = (a: Accelerator) => serves(a, work) && (!opts.accelerator || a.id === opts.accelerator);
    const usable = this.accelerators;
    const serving = usable.filter(asked);
    if (!serving.length) {
      // Only a graphics card set aside beside the NPU would do: say so, rather than that nothing serves it.
      const aside = cfg.accelerators.find((a) => asked(a) && !usable.some((u) => u.id === a.id && asked(u)));
      if (aside) throw new NpuError(core.say.gpuSetAside(aside));
      throw new NpuError(opts.accelerator ? core.say.notServing(opts.accelerator, work) : work === 'vision' ? core.say.noVisionModel() : core.say.noneServes(work));
    }
    // A prompt whose size depends on the accelerator (a picture's) is counted at its most among those that could take it.
    const promptTokens = Math.max(...serving.map((a) => tokensOn(prompt, a)));
    const tokens = promptTokens + maxTokens;
    const refused = core.tooBig(serving, promptTokens, maxTokens, work);
    if (refused) throw new NpuError(refused);
    const games = lane === 'background' && serving.some((a) => a.kind === 'gpu') ? await currentGames(cfg.accelerators) : null;
    // A call captioned on the NPU (npu-call.json, Envoy's): background work leaves the NPU to it (kit 2.143.1).
    const call = lane === 'background' && serving.some((a) => a.kind === 'npu') ? npuCallNow() : null;
    // The work's own order, where its NPU's generation has one (config.json's workOrder): by whose servers are up, when it
    // goes by that (its runningFirst: AMD's pictures until kit 2.135.1; they go to the Radeon whoever's is up now).
    const running = await this.serversUp(serving, work, cfg.workOrder);
    // Unless as many of the work wait as its batchAt: then the order is kept whoever's server is up, and a batch starts the
    // first device's and waits in its line (AMD's pictures until kit 2.135.1: 4 went to the Radeon), not shared out to a
    // free NPU by the pick. The caller's own batch counts, when it says.
    const batchAt = cfg.workOrder?.[work]?.batchAt;
    const waiting = batchAt && running ? Math.max(opts.batch ?? 1, waitingFor(work, serving.map((a) => turnFor(a, work, cfg.accelerators)))) : undefined;
    // Each candidate's turn for this work: its own, or another device's its server runs on (an endpoint's `turn`).
    const turnOn = (a: Accelerator) => turnFor(a, work, cfg.accelerators);
    const turnIdOf = (id: string) => {
      const a = serving.find((x) => x.id === id);
      return a ? turnOn(a).id : id;
    };
    let first: { acc: Accelerator; reason: string } | null = null;
    const tried = new Set<string>();
    const notRunning: Accelerator[] = [];
    /** One of them wasn't started because the manor is stopped (Manor's Settings): said, so nobody waits for it. */
    let manorWasStopped = false;
    let loadingOn: { acc: Accelerator; reason: string } | null = null;
    for (;;) {
      const { list, skipped, npuFirst } = candidates(
        serving.filter((a) => !tried.has(a.id)),
        { work, tokens, lane },
        { failure: readFailure, games, call, deferredMs: lane === 'background' ? (id) => deferredMs(turnIdOf(id)) : undefined, workOrder: cfg.workOrder, running, waiting },
      );
      if (!list.length) {
        if (loadingOn && !first) {
          const deferred = lane === 'background' ? core.say.deferredFor(BACK_OFF_MS / 60_000) : '';
          throw new NpuBusy(core.say.modelLoading(theAccelerator(loadingOn.acc), loadingOn.reason, deferred));
        }
        if (notRunning.length && !first) {
          const also = [...(manorWasStopped ? [core.say.manorStopped()] : []), ...skipped.map((s) => s.detail)].join('; ');
          throw new NpuError(core.say.serversNotRunning(notRunning, also));
        }
        throw noCandidate(skipped, first);
      }
      const choice = pick(list, lane, turnOn);
      if ('deferred' in choice) {
        for (const a of list) busyUntil.set(turnOn(a).id, Date.now() + BACK_OFF_MS);
        throw new NpuBusy(core.say.modelWorkDeferred(choice.deferred, BACK_OFF_MS / 60_000));
      }
      const acc = choice.acc;
      tried.add(acc.id);
      const ep = acc[work]!;
      const turn = turnOn(acc);
      try {
        // In its turn, the server is started if it isn't running; one that won't start fails the request,
        // which leaves its turn (the contract's fallback). One that is busy is waited on, not started again.
        // The turn is the device's its server runs on: the NPU 3720's embeddings take the graphics', beside its chat.
        const value = await acceleratorTurn(
          turn,
          async () => {
            leave();
            // On a PC with little memory, the NPU's own embedding server stops first, so the chat has its memory.
            if (acc.kind === 'npu' && (work === 'chat' || work === 'vision')) await this.embedGivesWay(acc).catch(() => undefined);
            // A server loading its model is waited on as long as its accelerator's cold load allows (an NPU compiling it).
            const onWaking = opts.onWaking;
            const timeouts = core.timeoutsFor(acc, work);
            // Background work steps back when there's no room to load its model (memory-guard.ts); a person's starts it anyway.
            const server = await ensureServer(ep, { start: opts.start, readyMs: Math.max(READY_WAIT_MS, timeouts?.coldLoadMs ?? 0), whenShort: lane === 'background' ? 'defer' : 'start', ...(onWaking ? { onWaking: (how) => onWaking(wakingOf(acc, work, ep, how)) } : {}) });
            // No warm-up when the server, already up, answered this same model within its keepalive: it has it loaded.
            const fresh = server.started || server.waited;
            const warmed = warmsUp(acc, work) && (fresh || !servedRecently(acc.id, ep));
            // A server just started (the keeper stopped it, unused), or found still loading, loads its model now: the
            // first request waits for that, given at least the cold-load allowance, rather than failing on a person's
            // short timeout.
            if (warmed) await warmUp(acc, ep, fresh ? Math.max(opts.timeoutMs ?? 0, coldAllowanceMs(acc)) : opts.timeoutMs);
            // With no warm-up, a server just started or found busy may still be loading the model.
            const loading = !warmed && fresh;
            // The accelerator's own timeouts (a slower NPU's, or what its check measured), and this kind's over those
            // (vision encoding pictures on the processor), take the rules' place.
            const timeoutMs = opts.timeoutMs ?? core.requestTimeoutMs(RULES, { lane, work, maxTokens, ceilingMs: cfg.requestTimeoutMs, coldLoad: loading, timeouts });
            const answer = await send(acc, ep, timeoutMs, loading);
            if (warmsUp(acc, work)) noteServed(acc.id, ep);
            // A chat's turn reads it: embeddings answered moments ago keep their server (embedGivesWay).
            if (acc.kind === 'npu' && work === 'embed' && Date.now() - (embedNoted.get(acc.id) ?? 0) >= EMBED_NOTE_MS) {
              embedNoted.set(acc.id, Date.now());
              noteEmbedded(acc.id);
            }
            return answer;
          },
          { maxWaitMs: opts.maxWaitMs, lane, work },
        );
        clearFailure(acc.id);
        return { value, acc, ...(first ? { fellBackFrom: { ...refOf(first.acc), reason: first.reason } } : {}) };
      } catch (e) {
        if (e instanceof NpuError) throw e;
        // Not running, and not to be started: the next candidate, with nothing marked.
        if (e instanceof ServerNotRunning) {
          notRunning.push(acc);
          if (e instanceof ManorStopped) manorWasStopped = true;
          continue;
        }
        // No room under the manor's memory ceiling to load its model (memory-guard.ts, kit 2.138.0): background work
        // steps back, this accelerator left alone a while, and comes again when there's room. Nothing is marked.
        if (e instanceof NoRoomToLoad) {
          busyUntil.set(turn.id, Date.now() + BACK_OFF_MS);
          throw new NpuBusy(core.say.modelWorkDeferred(e.message, BACK_OFF_MS / 60_000));
        }
        // Its model was still loading: slow, not failed. Nothing is marked; this agent leaves it alone a
        // while (a background request), and the request goes to the next candidate, if there is one.
        if (e instanceof ModelLoading) {
          if (lane === 'background') busyUntil.set(turn.id, Date.now() + BACK_OFF_MS);
          loadingOn ??= { acc, reason: e.message };
          if (opts.accelerator) throw new NpuBusy(core.say.modelLoading(theAccelerator(acc), e.message, ''));
          // The NPU first (the core's candidates): loading is slow, not something it can't do, so the request
          // waits for it rather than going to a graphics card or the processor.
          if (npuFirst) throw new NpuBusy(core.say.modelLoading(theAccelerator(acc), e.message, lane === 'background' ? core.say.deferredFor(BACK_OFF_MS / 60_000) : ''));
          continue;
        }
        if (!(e instanceof AcceleratorDown)) throw new NpuError(core.say.onAccelerator(acc, (e as Error).message));
        markFailed(acc.id, `${work}: ${e.message}`, APP.id);
        if (first) throw new NpuError(core.say.failedTwice(first.acc, first.reason, acc, e.message));
        if (opts.accelerator) throw new NpuError(core.say.acceleratorFailed(acc, e.message));
        first = { acc, reason: e.message };
      }
    }
  }
}

/**
 * Whether a turn starts with a warm-up: chat and vision on the NPU. GenieX keeps one model loaded at a
 * time, unloads it after 5 idle minutes, and takes 9 to 15 s to load one (measured 2026-10-03; a chat
 * request after a vision one loads the chat model again). Graphics cards' servers each keep their model.
 * A turn skips it when the server, already up, answered this same model within its keepalive (servedRecently).
 */
const warmsUp = (acc: Accelerator, work: Work) => acc.kind === 'npu' && work !== 'embed';

/**
 * Loads the turn's model with a one-token request, given the cold-load allowance; its timeout is
 * ModelLoading, not a failure. The request after it runs warm, on its own timeout, so a timeout there is
 * the server failing. A warm model answers it in about 0.15 s.
 */
async function warmUp(acc: Accelerator, ep: Endpoint, timeoutMs?: number): Promise<void> {
  await postJson(ep, '/v1/chat/completions', chatBody(acc, ep, [{ role: 'user', content: 'Hi' }], 1), timeoutMs ?? coldAllowanceMs(acc), { loading: true });
}

/**
 * A chat or vision request's first step on the NPU: on a PC with little memory (npu-vendors.ts' smallPc), the NPU's own
 * embedding server, when it has one apart from chat (Qualcomm's, Intel's), gives way to it (keeper.ts' yieldEmbedServer).
 * A bigger PC, or an NPU without one, never loads the keeper for it. `o` stands in for this PC's memory, config.json's
 * word, the NPU's last embedding (noteEmbedded) and the keeper's log, for a check that runs it as a small PC would.
 */
export async function embedGivesWay(acc: Accelerator, o: { ramBytes?: number; given?: () => boolean; embeddedAt?: () => number | null; logFile?: string } = {}): Promise<unknown> {
  const ramBytes = o.ramBytes ?? os.totalmem();
  if (!smallPc(ramBytes)) return null;
  const keeper = await import('./keeper.ts');
  if (!keeper.ownEmbedServer(acc)) return null;
  const pc = keeper.pcYield({ logFile: o.logFile });
  return keeper.yieldEmbedServer(acc, { ramBytes, given: o.given ?? pc.given, embeddedAt: o.embeddedAt ?? (() => embeddedAt(acc.id)) }, pc.deps);
}

/** How long a model being loaded may take: the request's base and the cold load, the accelerator's own where longer. */
const coldAllowanceMs = (acc: Accelerator) => RULES.accelerators.requestBaseMs + Math.max(RULES.accelerators.coldLoadMs, acc.timeouts?.coldLoadMs ?? 0);

/**
 * The pick (accelerators.ts), seeing this process's own requests already headed to each line: the line of the turn
 * each would take for `work` (turnFor), its own or another device's.
 */
function pick(list: Accelerator[], lane: Lane, turn: (a: Accelerator) => { id: string; slots: number }) {
  return pickFrom(list, lane, (a) => {
    const t = turn(a);
    return lineLook(t, headed.get(t.id) ?? 0);
  });
}
