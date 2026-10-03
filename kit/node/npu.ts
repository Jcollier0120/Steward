import { APP } from '../app.ts';
import * as core from './core/index.js';
import {
  AcceleratorDown,
  candidates,
  chatBody,
  clearFailure,
  currentGames,
  ensureServer,
  gamesStale,
  lineLook,
  loadAccelerators,
  lockDirsOf,
  markFailed,
  MAX_AHEAD,
  parseAccelerators,
  pick as pickFrom,
  ping,
  postJson,
  readFailure,
  readGames,
  refOf,
  ServerNotRunning,
  serves,
  theAccelerator,
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
import { LockTimeout, lineSnapshot, QueueFull, queueSnapshot, withAcceleratorTurn, type Lane } from './npu-queue.ts';
import { RULES } from './rules.ts';

export { npuLockDir };
export { noteLabel, reeveHome, theAccelerator, type Accelerator, type AcceleratorConfig, type AcceleratorRef, type ChatMessage } from './accelerators.ts';

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

/** Every accelerator's holders (per slot) and line, for a status line on the page. */
export function acceleratorLines(cfg: AcceleratorConfig | { error: string } = loadAccelerators()) {
  if ('error' in cfg) return [];
  return cfg.accelerators.map((a) => ({ ...refOf(a), slots: a.slots, ...lineSnapshot(lockDirsOf(a)) }));
}

/**
 * Runs `fn` holding one of an accelerator's slots, after waiting its turn in its line (above). Every
 * request this agent runs on an accelerator goes through here: chat(), vision() and embed() do, and so
 * must any other, such as a request to npu-embed's server, which leaves the locking to its callers.
 */
export function acceleratorTurn<T>(
  acc: { id: string; name?: string; slots?: number },
  fn: () => Promise<T>,
  opts: { maxWaitMs?: number; maxAhead?: number; lane?: Lane } = {},
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

function answerOf(json: any, model: string, ms: number) {
  const choice = json?.choices?.[0];
  return {
    text: String(choice?.message?.content ?? '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim(),
    model,
    ms,
    truncated: choice?.finish_reason === 'length',
    promptTokens: Number(json?.usage?.prompt_tokens) || 0,
    completionTokens: Number(json?.usage?.completion_tokens) || 0,
  };
}

/** Why no accelerator could take a request: busy (deferred) while any is only resting or held by a game. */
function noCandidate(skipped: Skipped[], first: { acc: Accelerator; reason: string } | null): NpuError {
  const why = core.whyNone(skipped, first);
  return why.busy ? new NpuBusy(why.message) : new NpuError(why.message);
}

export class Npu {
  private cfg: AcceleratorConfig | { error: string };

  constructor(cfg: AcceleratorConfig | NpuConfig | { error: string } = loadAccelerators()) {
    this.cfg = 'error' in cfg || 'accelerators' in cfg ? cfg : fromNpuConfig(cfg);
    if (!('error' in this.cfg)) for (const a of this.cfg.accelerators) known.add(a.id);
  }

  /** Why no model can be used, or null when Reeve's config lists at least one accelerator. */
  get problem(): string | null {
    return 'error' in this.cfg ? this.cfg.error : null;
  }

  /** The accelerators, in the order requests try them (none when there is a problem). */
  get accelerators(): Accelerator[] {
    return 'error' in this.cfg ? [] : this.cfg.accelerators;
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
    const { list } = candidates(serving, { work, tokens: 0, lane: 'background' }, { failure: readFailure, games: gamesStale(games) ? null : games, deferredMs });
    return Math.max(...(list.length ? list : serving).map((a) => a.maxContextTokens)) - maxTokens;
  }

  /** Whether any chat server answers, without starting one. */
  async reachable(): Promise<boolean> {
    for (const a of this.accelerators) if (serves(a, 'chat') && (await ping(a.chat!.baseUrl))) return true;
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
    return this.ask('chat', promptTokens, maxTokens, opts, async (acc, ep, timeoutMs) => {
      const { json, ms } = await postJson(ep, '/v1/chat/completions', chatBody(acc, ep, messages, maxTokens), timeoutMs);
      return answerOf(json, ep.model, ms);
    });
  }

  /**
   * One question about one image, by a vision model. Small vision models perceive well and reason
   * badly: ask what is there ("what text is the title", "is there a chart"), and leave conclusions to
   * code. `image` is a local path: GenieX reads it itself, other servers get it as a data: URL.
   */
  async vision(image: string, question: string, opts: AskOptions = {}): Promise<NpuAnswer> {
    const maxTokens = opts.maxTokens ?? 64;
    // The image is a fixed 256 tokens in the NPU's bundle; count 400 to be safe (the spec's rules.json).
    return this.ask('vision', core.visionTokens(RULES, question), maxTokens, opts, async (acc, ep, timeoutMs) => {
      const { json, ms } = await postJson(ep, '/v1/chat/completions', visionBody(acc, ep, image, question, maxTokens), timeoutMs);
      return answerOf(json, ep.model, ms);
    });
  }

  /** Embeddings for `texts`, in their order, from one accelerator's embedding model. */
  async embed(texts: string[], opts: AskOptions = {}): Promise<Embeddings> {
    const longest = Math.max(0, ...texts.map(estimateTokens));
    const r = await this.route('embed', longest, 0, opts, async (acc, ep, timeoutMs) => {
      const { json, ms } = await postJson(ep, '/v1/embeddings', { model: ep.model, input: texts }, timeoutMs);
      const vectors: number[][] = [];
      for (const row of (json?.data ?? []) as { index: number; embedding: number[] }[]) vectors[row.index] = row.embedding;
      if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v))) throw new Error(core.say.tooFewVectors());
      return { vectors, model: ep.model, ms };
    });
    return { ...r.value, accelerator: refOf(r.acc), ...(r.fellBackFrom ? { fellBackFrom: r.fellBackFrom } : {}) };
  }

  private async ask(
    work: Work,
    promptTokens: number,
    maxTokens: number,
    opts: AskOptions,
    send: (acc: Accelerator, ep: Endpoint, timeoutMs: number) => Promise<Omit<NpuAnswer, 'accelerator' | 'fellBackFrom'>>,
  ): Promise<NpuAnswer> {
    const r = await this.route(work, promptTokens, maxTokens, opts, send);
    return { ...r.value, accelerator: refOf(r.acc), ...(r.fellBackFrom ? { fellBackFrom: r.fellBackFrom } : {}) };
  }

  /**
   * The contract's choosing (Manor's docs/ACCELERATORS.md): the candidates, the pick, the turn, and one
   * fallback when the accelerator fails the request.
   */
  private async route<T>(
    work: Work,
    promptTokens: number,
    maxTokens: number,
    opts: AskOptions,
    send: (acc: Accelerator, ep: Endpoint, timeoutMs: number) => Promise<T>,
  ): Promise<{ value: T; acc: Accelerator; fellBackFrom?: AcceleratorRef & { reason: string } }> {
    if ('error' in this.cfg) throw new NpuError(this.cfg.error);
    const cfg = this.cfg;
    const lane = opts.lane ?? 'background';
    const serving = cfg.accelerators.filter((a) => serves(a, work) && (!opts.accelerator || a.id === opts.accelerator));
    if (!serving.length) {
      throw new NpuError(opts.accelerator ? core.say.notServing(opts.accelerator, work) : work === 'vision' ? core.say.noVisionModel() : core.say.noneServes(work));
    }
    const tokens = promptTokens + maxTokens;
    const refused = core.tooBig(serving, promptTokens, maxTokens);
    if (refused) throw new NpuError(refused);
    const games = lane === 'background' && serving.some((a) => a.kind === 'gpu') ? await currentGames(cfg.accelerators) : null;
    let first: { acc: Accelerator; reason: string } | null = null;
    const tried = new Set<string>();
    const notRunning: Accelerator[] = [];
    for (;;) {
      const { list, skipped } = candidates(
        serving.filter((a) => !tried.has(a.id)),
        { work, tokens, lane },
        { failure: readFailure, games, deferredMs: lane === 'background' ? deferredMs : undefined },
      );
      if (!list.length) {
        if (notRunning.length && !first) {
          const also = skipped.map((s) => s.detail).join('; ');
          throw new NpuError(core.say.serversNotRunning(notRunning, also));
        }
        throw noCandidate(skipped, first);
      }
      const choice = pick(list, lane);
      if ('deferred' in choice) {
        for (const a of list) busyUntil.set(a.id, Date.now() + BACK_OFF_MS);
        throw new NpuBusy(core.say.modelWorkDeferred(choice.deferred, BACK_OFF_MS / 60_000));
      }
      const acc = choice.acc;
      tried.add(acc.id);
      const ep = acc[work]!;
      try {
        // In its turn, the server is started if it isn't running; one that won't start fails the request,
        // which leaves its turn (the contract's fallback).
        const value = await acceleratorTurn(
          acc,
          async () => {
            await ensureServer(ep, { start: opts.start });
            return send(acc, ep, opts.timeoutMs ?? cfg.requestTimeoutMs);
          },
          { maxWaitMs: opts.maxWaitMs, lane },
        );
        clearFailure(acc.id);
        return { value, acc, ...(first ? { fellBackFrom: { ...refOf(first.acc), reason: first.reason } } : {}) };
      } catch (e) {
        if (e instanceof NpuError) throw e;
        // Not running, and not to be started: the next candidate, with nothing marked.
        if (e instanceof ServerNotRunning) {
          notRunning.push(acc);
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

/** The pick (accelerators.ts), seeing this process's own requests already headed to each line. */
function pick(list: Accelerator[], lane: Lane) {
  return pickFrom(list, lane, (a) => lineLook(a, headed.get(a.id) ?? 0));
}
