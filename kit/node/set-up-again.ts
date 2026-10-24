import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Accelerator, acceleratorConfigFile, type AcceleratorEntry, type AcceleratorKind, configuredAccelerators, type Endpoint, ENDPOINT_KINDS, type EndpointKind, isSharedTools, readConfigFile, serverLogsDir, serves, toolsHome } from './accelerator-config.ts';
import { expandEnv } from './accelerators.ts';
import * as core from './core/index.js';
import type { Detection } from './detect.ts';
import { gpuWithNpu, manorStopped } from './manor.ts';
import { LockTimeout, QueueFull } from './npu-queue.ts';
import { servers, stillAnswering, whatAnswers } from './npu-refresh.ts';
import { type Pace, pace } from './pace.ts';
import { inside } from './real-path.ts';
import { bytesOf, configStrings, RETIRED_GRACE_MS, removeAside } from './retired.ts';
import { download, type HfFile, installSignedBuild, type NpuRefreshRecord, pinnedHfFiles, pinnedRelease, planSetup, readNpuRefresh, type Release, type SetupIo, sizing, specFor, testNpuEmbed, testNpuEntry, testNpuRerank } from './setup.ts';

/**
 * An accelerator set up again by the keeper when the kit's pins move on (kit 2.115.0). Setup writes an entry once, so a
 * kit that pins another llama.cpp build, another model for the graphics card or the processor, or another server or model
 * for the NPU (AMD's FastFlowLM 1.0.7 to 1.0.10) reached only the PCs set up after it, until someone pressed Set up
 * again. The owner's words (2026-10-24): "when the kit's card model or llama.cpp pin changes, the manor sets the card up
 * again by itself in the background (gently, outside the Claude app), with no action from the person", and the same for
 * the NPU's server and models.
 *
 * - **What is behind.** A graphics card's or the processor's entry whose servers run from the kit's llama.cpp folder and
 *   load models from its models folder, where setup now would start another build or load other files (behindPins: a
 *   plan made from the pins alone, nothing asked of the network). An entry of the person's own (another program, a model
 *   file of theirs) is theirs, and never set up again. The NPU's, where the keeper's look at it found this kit's command
 *   needs a download (npu-refresh.ts' `needs-setup`): its server's version, its models, its embedding server.
 * - **What its work order adds** (kit 2.135.2). A graphics card the PC's work order puts first for a work it doesn't
 *   serve yet (today AMD xdna2's pictures on the Radeon: a card set up before kit 2.111.0 serves only embeddings) is
 *   behind too, and gains that work the same way, when a plan from the pins gives the card it (orderAdds). The person's
 *   choices stand: a card they turned off, an acceleratorOrder of their own, and Manor's gpuWithNpu off (the card kept
 *   out of the NPU's work) add nothing.
 * - **Gently.** One accelerator a look, once nobody has used it for AGAIN_QUIET_MS, never while the manor is stopped, in
 *   the background (the Smith's own pace). At the manor's gentle pace, downloads go at GENTLE_BYTES_PER_SECOND at most
 *   (pacedFetch); a model the NPU's own server pulls (GenieX's, FastFlowLM's) comes at that server's pace. Setup runs as
 *   `local-ai` would, with --yes, and outside a packaged app where the keeper runs in one (outside.ts).
 * - **The old serves until the new has answered.** New builds and models go beside the old ones (a build's folder is
 *   named by its tag, a model by its file); config.json keeps the old entry meanwhile. Only then, in the accelerator's
 *   turn (the keeper's: background, only into an empty line), its old servers are stopped and the new ones asked their
 *   test questions (stage): only an entry whose every server answered properly is written, and it must serve all the
 *   NPU did. A server the NPU's route installs in one place (GenieX's) is put together beside it first, and swapped in
 *   that turn, the old folder kept aside (`.kept`) and put back if the new one fails.
 * - **Then the old files go.** The build folders and model files the switch left unnamed, and a `.kept` folder, are
 *   removed once nothing has named them for RETIRED_GRACE_MS (removeReplaced), as retired models are (retired.ts).
 * - **Quietly.** A failure keeps the old entry, goes in the keeper's log, and is tried again after AGAIN_RETRY_MS; an
 *   accelerator in use when it was to be switched, after AGAIN_BUSY_MS, with what was downloaded kept. What Windows'
 *   Smart App Control blocks (FastFlowLM's unsigned libraries on AMD) is said once, plainly, and not tried again until
 *   another kit: the PC keeps what it has.
 */

/** How often the keeper looks for an accelerator behind the kit's pins (in its own process). */
export const AGAIN_LOOK_MS = 10 * 60_000;
/** How long after a try that failed it's tried again. */
export const AGAIN_RETRY_MS = 6 * 3600_000;
/** How long after a try that found its accelerator in use, or a turn it couldn't take. */
export const AGAIN_BUSY_MS = 10 * 60_000;
/** How long nobody may have used an accelerator before its servers are switched (as the NPU refresh's wait). */
export const AGAIN_QUIET_MS = 2 * 60_000;
/** The most a download takes at the manor's gentle pace: 4 MB a second, a small share of most connections. None at a full pace. */
export const GENTLE_BYTES_PER_SECOND = 4 * 1024 * 1024;

/** Where its tries and the files it replaced are kept: beside config.json. */
export const againFile = (configFile = acceleratorConfigFile()) => path.join(path.dirname(configFile), 'set-up-again.json');

/** What the new servers print while they're tested, beside the keeper's log. */
export const againServerLog = (env: NodeJS.ProcessEnv = process.env) => path.join(serverLogsDir(env), 'set-up-again.log');

export type AgainDid = 'set-up' | 'busy' | 'failed' | 'blocked';

/** An accelerator's last try: what the pins made it then (Behind's key), when, and how it went. */
export interface AgainTry {
  key: string;
  at: string;
  did: AgainDid;
  /** setup's exit code. */
  code?: number;
}

export interface AgainRecord {
  tries: Record<string, AgainTry>;
  /** The build folders, model files and `.kept` folders a switch left unnamed, each since when. */
  replaced: Record<string, string>;
}

export function readAgain(file: string): AgainRecord {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
    const tries = Object.fromEntries(Object.entries(obj(r?.tries)).filter(([, t]) => typeof t?.key === 'string' && typeof t?.at === 'string' && typeof t?.did === 'string'));
    const replaced = Object.fromEntries(Object.entries(obj(r?.replaced)).filter(([, v]) => typeof v === 'string' && !Number.isNaN(Date.parse(v))));
    return { tries, replaced } as AgainRecord;
  } catch {
    return { tries: {}, replaced: {} };
  }
}

function writeAgain(file: string, r: AgainRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(r, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}

// ------------------------------------------------------------------------------------------------
// What is behind

/** An accelerator whose entry isn't what the kit's pins would make it. */
export interface Behind {
  id: string;
  kind: AcceleratorKind;
  /** What it serves, and what its work order adds: it's set up again for these. */
  kinds: EndpointKind[];
  /** What the pins make it, with the kit: a try Windows blocked isn't made again until this changes. */
  key: string;
  /** What changes, in words. */
  why: string[];
}

/** The model files an entry's servers load (`-m`, `--mmproj`), %NAME% expanded. */
export function modelFiles(e: Record<string, any>, env: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>();
  for (const k of ENDPOINT_KINDS) {
    const cmd: unknown[] = Array.isArray(e?.[k]?.startCommand) ? e[k].startCommand : [];
    for (let i = 1; i < cmd.length - 1; i++) if ((cmd[i] === '-m' || cmd[i] === '--mmproj') && typeof cmd[i + 1] === 'string') out.add(expandEnv(cmd[i + 1] as string, env));
  }
  return [...out];
}

const lower = (p: string) => p.toLowerCase();

/**
 * The work config.json's `workOrder` puts a graphics card first for that no card serves yet, by the card that gains it:
 * the first enabled card in the core's order (the one its requests would go to). The order as the core reads it, so none
 * with an acceleratorOrder of the person's own; none for a work Manor's gpuWithNpu (off) keeps the card out of (the core's
 * cardWorkBesideNpu, the one rule requests follow). That rule keeps a card the work its order puts it first for (kit
 * 2.135.3), so with the switch off too, an AMD PC set up before gains the Radeon's vision, run on demand.
 */
export function orderAdds(raw: Record<string, any>, accs: Accelerator[], withNpu: boolean): Map<string, EndpointKind[]> {
  const out = new Map<string, EndpointKind[]>();
  const order = core.workOrderIn(raw);
  const cards = accs.filter((a) => a.kind === 'gpu' && a.enabled !== false);
  if (!order || !cards.length) return out;
  const npu = core.npuServes(accs);
  for (const w of core.WORKS) {
    if (order[w]?.devices[0] !== 'gpu' || cards.some((c) => serves(c, w))) continue;
    if (!withNpu && !core.cardWorkBesideNpu([w], npu, order).length) continue;
    out.set(cards[0].id, [...(out.get(cards[0].id) ?? []), w]);
  }
  return out;
}

/**
 * The accelerators in config.json behind the kit's pins (see above): a card's or the processor's whose program or model
 * files aren't the ones a plan from the pins gives them, for all it serves (a plan that would leave some of it out, or
 * can't be made, leaves the entry as it is), or a card its work order adds work to (orderAdds) that such a plan gives
 * it; the NPU's when the keeper's look at it, this kit's, left it for setup. `gpuWithNpu` is Manor's switch (on, when
 * left out).
 */
export async function behindPins(o: {
  raw: Record<string, any>;
  detection: Detection;
  kit: string;
  tools: string;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  npuRefresh?: NpuRefreshRecord | null;
  releases?: Release[];
  hfFiles?: (repo: string) => Promise<HfFile[] | null>;
  gpuWithNpu?: boolean;
}): Promise<Behind[]> {
  const env = o.env ?? process.env;
  const builds = path.join(o.tools, 'servers', 'llama.cpp');
  const modelsDir = path.join(o.tools, 'models');
  const out: Behind[] = [];
  const accs = configuredAccelerators(o.raw);
  const adds = orderAdds(o.raw, accs, o.gpuWithNpu ?? true);
  for (const a of accs) {
    const kinds = ENDPOINT_KINDS.filter((k) => serves(a, k));
    if (a.enabled === false || !kinds.length) continue;
    if (a.kind === 'npu') {
      if (o.npuRefresh?.kit === o.kit && o.npuRefresh.did === 'needs-setup') out.push({ id: a.id, kind: a.kind, kinds, key: `${o.kit} npu`, why: ["this kit's server or models for it aren't on this PC yet"] });
      continue;
    }
    const programs = servers(a).map((s) => expandEnv(s.program, env));
    if (!programs.length || !programs.every((p) => inside(p, builds))) continue;
    const planFor = (ks: EndpointKind[]) =>
      planSetup({ detection: o.detection, ids: [a.id], kinds: ks, ...(a.kind === 'cpu' ? { cpuKinds: ks } : {}), raw: o.raw, releases: o.releases ?? [pinnedRelease()], hfFiles: o.hfFiles ?? pinnedHfFiles, home: o.tools, env: o.env, exists: o.exists, skipNpu: true });
    const adding = adds.get(a.id) ?? [];
    let ask = ENDPOINT_KINDS.filter((k) => kinds.includes(k) || adding.includes(k));
    let plan = await planFor(ask);
    let t = plan.targets.find((x) => x.id === a.id);
    // Work it adds that the plan can't give the card, or wouldn't by itself (setup leaves pictures off a card they don't
    // fit on beside the rest, unless asked for by name): left out, and the card planned for the rest.
    const left = t ? (sizing({ kind: t.kind, memoryGb: t.memoryGb, ramGb: o.detection.ramBytes / 1024 ** 3, kinds: ask }).left ?? []) : [];
    const gains = adding.filter((k) => t?.kinds.includes(k) && !left.includes(k));
    if (gains.length < adding.length) {
      ask = ENDPOINT_KINDS.filter((k) => kinds.includes(k) || gains.includes(k));
      plan = await planFor(ask);
      t = plan.targets.find((x) => x.id === a.id);
    }
    if (!t?.folder || t.problem || ask.some((k) => !t!.kinds.includes(k))) continue;
    const program = path.join(t.folder, 'llama-server.exe');
    const want: string[] = [];
    for (const k of t.kinds) {
      const spec = specFor(k);
      for (const m of plan.models.filter((m) => m.model === spec.model && (m.role === 'model' || k === 'vision'))) {
        const p = m.path ?? path.join(plan.modelsDir, path.basename(m.file));
        if (!want.some((w) => lower(w) === lower(p))) want.push(p);
      }
    }
    const files = modelFiles(a, env);
    // A model file of the person's own (not in the models folder, nor one the plan loads) keeps the entry theirs.
    if (!files.every((f) => inside(f, modelsDir) || want.some((w) => lower(w) === lower(f)))) continue;
    const sameProgram = programs.every((p) => lower(p) === lower(program));
    const added = want.filter((w) => !files.some((f) => lower(f) === lower(w)));
    const gone = files.filter((f) => !want.some((w) => lower(w) === lower(f)));
    if (sameProgram && !added.length && !gone.length && !gains.length) continue;
    const was = [...new Set(programs.map((p) => path.basename(path.dirname(p))))];
    out.push({
      id: a.id,
      kind: a.kind,
      kinds: ask,
      key: `${o.kit} ${path.basename(t.folder)} ${want.map((w) => path.basename(w)).sort().join(' ')}`,
      why: [
        ...(gains.length ? [`${gains.join(' and ')} added: this PC's work order puts the graphics card first for it`] : []),
        ...(sameProgram ? [] : [`${path.basename(t.folder)} in place of ${was.join(', ')}`]),
        ...(added.length || gone.length ? [`${added.map((f) => path.basename(f)).join(', ') || 'fewer models'} in place of ${gone.map((f) => path.basename(f)).join(', ') || 'none'}`] : []),
      ],
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Gently

/** A clock, so a test's paced download takes no time. */
export interface PaceClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: PaceClock = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * `fetchImpl` with each answer's body read no faster than `bytesPerSecond`: setup's download reads it as it comes, so
 * it takes that much of the connection at most and leaves the rest. The size and SHA-256 are checked as before.
 */
export function pacedFetch(bytesPerSecond: number, fetchImpl: typeof fetch = fetch, clock: PaceClock = realClock): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await fetchImpl(input, init);
    if (!res.ok || !res.body || !(bytesPerSecond > 0)) return res;
    const start = clock.now();
    let read = 0;
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, out) {
          read += chunk.byteLength;
          const wait = start + (read / bytesPerSecond) * 1000 - clock.now();
          if (wait > 0) await clock.sleep(wait);
          out.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

// ------------------------------------------------------------------------------------------------
// The old serves until the new has answered

/** The PC as a staged setup sees it: the keeper's by default (stageDefaults), a test's own. */
export interface StageDeps {
  /** The accelerator's turn, background, holding every slot (keeper.ts' reaperTurn): QueueFull or LockTimeout when it's in use. */
  turn: <T>(dirs: string[], fn: () => Promise<T>) => Promise<T>;
  /** A turn that waits for its place (the old server put back after a failure must be). */
  turnWaiting: <T>(dirs: string[], fn: () => Promise<T>) => Promise<T>;
  lockDirs: (a: { id: string; kind: AcceleratorKind; slots: number }) => string[];
  /** When the accelerator's lock was last taken or its line joined (keeper.ts' ownActivityMs). */
  lastUse: (dirs: string[]) => number;
  /** Stops whatever `program` serves `base`, and waits until it's gone (keeper.ts' stopServerAt). */
  stopServer: (program: string, base: string) => Promise<void>;
  /** What answers at `base` now; null for nothing (npu-refresh.ts' whatAnswers). Without it, ports aren't waited on. */
  answering?: (base: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pace?: () => Pace;
  fetch?: typeof fetch;
  clock?: PaceClock;
}

/** The keeper's: its turns, its lock folders, its stop, and Manor's pace. */
export async function stageDefaults(): Promise<StageDeps> {
  const k = await import('./keeper.ts');
  const { withAcceleratorTurn } = await import('./npu-queue.ts');
  return {
    turn: (dirs, fn) => k.reaperTurn(dirs, fn, 'setup', 40 * 60_000),
    turnWaiting: (dirs, fn) => withAcceleratorTurn(dirs, fn, { who: 'setup', lane: 'interactive', waitMs: 10 * 60_000, staleMs: 40 * 60_000 }),
    lockDirs: (a) => k.lockDirsOf(a),
    lastUse: (dirs) => k.ownActivityMs(dirs),
    stopServer: k.stopServerAt,
    answering: (base) => whatAnswers(base),
  };
}

/** A staged setup's hold on its run (setupCommand's, when `staged`). */
export interface Stage {
  /** setup's io: paced downloads, and the NPU's tests (and a server it installs in place) in its turn, its old servers stopped. */
  io: Partial<SetupIo>;
  /**
   * The entries setup made, tested: each card's and the processor's in its turn, its old servers stopped, and the NPU's
   * (tested as setup set it up) kept only when it serves all the old one did. Those that answered; a server put in place
   * of the NPU's old one is put back when the NPU's isn't kept.
   */
  settle: (entries: Accelerator[], npuPlanned: boolean) => Promise<Accelerator[]>;
  /** The NPU's server put back as it was, where it was replaced in place (after config.json couldn't be written). */
  restore: () => Promise<void>;
  /** Whether an accelerator was in use when its servers were to be switched. */
  busy: () => boolean;
}

const basesOf = (e: Record<string, any>, kinds: EndpointKind[]) => [...new Set(kinds.map((k) => e?.[k]?.baseUrl).filter((b): b is string => typeof b === 'string'))];

/**
 * The stage for a run (see above). `old` is config.json's entries as setup found them; `given` is setup's io, whose
 * tests (held: the turn is the stage's) and stop are used where it has them.
 */
export function stage(o: { old: Record<string, any>[]; given: Partial<SetupIo>; log: (line: string) => void; deps: StageDeps }): Stage {
  const d = o.deps;
  const now = d.now ?? Date.now;
  const stop = o.given.stopServer ?? d.stopServer;
  const logFile = againServerLog();
  const testChat: NonNullable<SetupIo['testNpu']> = o.given.testNpu ?? ((e, t) => testNpuEntry(e, { ...t, held: true, logFile }));
  const testEmbed: NonNullable<SetupIo['testEmbed']> = o.given.testEmbed ?? ((e, dims) => testNpuEmbed(e, { held: true, logFile, ...(dims ? { dims } : {}) }));
  const testRerank: NonNullable<SetupIo['testRerank']> = o.given.testRerank ?? ((ep: Endpoint) => testNpuRerank(ep, { held: true, logFile }));
  const oldOf = (id: string) => o.old.find((x) => x?.id === id) ?? null;
  const dirsOf = (id: string, e: Record<string, any> | null) => d.lockDirs({ id, kind: (e?.kind ?? (id === 'npu' ? 'npu' : id === 'cpu' ? 'cpu' : 'gpu')) as AcceleratorKind, slots: typeof e?.slots === 'number' ? e.slots : 1 });
  let busy = false;
  // The accelerators whose servers were switched this run: the wait for a quiet moment is made once.
  const switched = new Set<string>();
  // The NPU's server folder, where its new one was put in place of the old (GenieX's): the old one's place aside.
  let inPlace: { into: string; kept: string } | null = null;

  const IN_USE = "was in use, so its servers weren't switched";
  const inUse = (id: string) => {
    busy = true;
    return [`${id} ${IN_USE}: a quiet look later switches them`];
  };

  /** The new entry's servers stopped, in its turn when it's free (else the keeper stops them once unused): it isn't kept. */
  const stopNew = async (id: string, e: Record<string, any>) => {
    await d.turn(dirsOf(id, oldOf(id) ?? e), async () => {
      for (const s of servers(e)) await stop(s.program, s.base);
    }).catch(() => {});
  };

  /**
   * `fn` in the accelerator's turn, once it has gone unused AGAIN_QUIET_MS: its old servers stopped first (every one, or
   * those on `bases`), nothing left answering on `bases`, and the new entry's servers there stopped again when it fails.
   * An embedding server in another device's turn (`other`) takes that one's too.
   */
  const swap = async (id: string, e: Record<string, any>, bases: string[], all: boolean, fn: () => Promise<string[]>, other?: string): Promise<string[]> => {
    const old = oldOf(id);
    const dirs = dirsOf(id, old ?? e);
    if (!switched.has(id) && now() - d.lastUse(dirs) < AGAIN_QUIET_MS) return inUse(id);
    const otherDirs = other && other !== id ? dirsOf(other, oldOf(other)) : null;
    try {
      return await d.turn(dirs, async () => {
        const inner = async () => {
          switched.add(id);
          for (const s of servers(old ?? {})) if (all || bases.includes(s.base)) await stop(s.program, s.base);
          const stayed = await stillAnswering(d, bases);
          if (stayed.length) return stayed;
          const p = await fn().catch((err: any) => [String(err?.message ?? err).split(/\r?\n/)[0]]);
          if (p.length) for (const s of servers(e)) if (bases.includes(s.base)) await stop(s.program, s.base);
          return p;
        };
        return otherDirs ? d.turn(otherDirs, inner) : inner();
      });
    } catch (err) {
      if (err instanceof QueueFull || err instanceof LockTimeout) return inUse(id);
      throw err;
    }
  };

  const paced = (d.pace ?? (() => pace()))() === 'gentle';
  const io: Partial<SetupIo> = {
    ...(o.given.download || (!paced && !d.fetch) ? {} : { download: (dl, progress) => download(dl, progress, paced ? pacedFetch(GENTLE_BYTES_PER_SECOND, d.fetch, d.clock) : d.fetch) }),
    testNpu: (e, t) => swap('npu', e, basesOf(e, ['chat', 'vision']), true, () => testChat(e, t)),
    testEmbed: (e, dims) => swap('npu', e, basesOf(e, ['embed']), false, () => testEmbed(e, dims), typeof e.embed?.turn === 'string' ? e.embed.turn : undefined),
    testRerank: (ep) => swap('npu', { kind: 'npu', rerank: ep }, ep.baseUrl ? [ep.baseUrl] : [], false, () => testRerank(ep)),
    // A server its route installs in one place, over the one that runs (GenieX's): put together beside it, then swapped
    // in, in the NPU's turn with its old servers stopped; the old kept aside until the new one is kept.
    installBuild: async (server, b, x) => {
      const install = o.given.installBuild ?? installSignedBuild;
      const old = oldOf('npu');
      const runsThere = servers(old ?? {}).some((s) => inside(s.program, b.into));
      if (!runsThere || !existsSync(b.into)) return install(server, b, x);
      const next = `${b.into}.next`;
      const kept = `${b.into}.kept`;
      rmSync(next, { recursive: true, force: true });
      const failed = await install(server, { ...b, into: next }, x);
      if (failed) return failed;
      const p = await swap('npu', old ?? {}, [], true, async () => {
        try {
          rmSync(kept, { recursive: true, force: true });
          renameSync(b.into, kept);
        } catch (err: any) {
          return [`${b.into} couldn't be put aside: ${err?.message ?? err}`];
        }
        try {
          renameSync(next, b.into);
        } catch (err: any) {
          renameSync(kept, b.into);
          return [`${server} couldn't be put in place: ${err?.message ?? err}`];
        }
        inPlace = { into: b.into, kept };
        return [];
      });
      if (!p.length) return null;
      rmSync(next, { recursive: true, force: true });
      return { step: 'install', why: p.join('; ') };
    },
  };

  const restore = async () => {
    const was = inPlace;
    if (!was) return;
    inPlace = null;
    const old = oldOf('npu');
    try {
      await d.turnWaiting(dirsOf('npu', old), async () => {
        for (const s of servers(old ?? {})) if (inside(s.program, was.into)) await stop(s.program, s.base);
        removeAside(was.into);
        renameSync(was.kept, was.into);
      });
      o.log(`the NPU's server is back as it was (${was.into})`);
    } catch (err: any) {
      o.log(`problem: the NPU's server couldn't be put back as it was (${was.kept} to ${was.into}): ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
    }
  };

  const settle = async (entries: Accelerator[], npuPlanned: boolean): Promise<Accelerator[]> => {
    const out: Accelerator[] = [];
    for (const e of entries) {
      // Each must serve all its accelerator served before.
      const old = oldOf(e.id);
      const lost = old ? ENDPOINT_KINDS.filter((k) => serves(old as Accelerator, k) && !serves(e, k)) : [];
      if (lost.length) {
        o.log(`problem: ${e.kind === 'npu' ? "the NPU's" : `${e.id}'s`} new servers don't serve its ${lost.join(' and ')} as its present ones do: it keeps the present ones`);
        if (e.kind === 'npu') await stopNew('npu', e);
        continue;
      }
      if (e.kind === 'npu') {
        // Its tests were setup's own, in its turn (io above).
        out.push(e);
        continue;
      }
      const bases = servers(e).map((s) => s.base);
      const ownVision = !!e.vision?.baseUrl && e.vision.baseUrl !== e.chat?.baseUrl;
      const p = await swap(e.id, e, bases, true, async () => {
        const bad: string[] = [];
        if (e.chat?.startCommand?.length) bad.push(...(await testChat({ ...e, ...(ownVision ? { vision: undefined } : {}) } as AcceleratorEntry)));
        if (!bad.length && ownVision && e.vision?.startCommand?.length) bad.push(...(await testChat({ ...e, chat: e.vision, vision: { model: e.vision.model } } as AcceleratorEntry)));
        if (!bad.length && e.embed?.startCommand?.length) bad.push(...(await testEmbed(e as AcceleratorEntry)));
        if (!bad.length && e.rerank?.startCommand?.length) bad.push(...(await testRerank(e.rerank)));
        return bad;
      });
      if (p.length) o.log(`${p[0].includes(IN_USE) ? 'note' : 'problem'}: ${e.id} keeps the servers it has: ${p.join('; ')}`);
      else out.push(e);
    }
    if (npuPlanned && !out.some((e) => e.kind === 'npu')) await restore();
    return out;
  };

  return { io, settle, restore, busy: () => busy };
}

// ------------------------------------------------------------------------------------------------
// The keeper's look

/** The PC, as a look sees it: swapped in tests. */
export interface AgainDeps {
  /** This kit's version. */
  kit: string;
  configFile?: string;
  /** set-up-again.json (againFile beside config.json). */
  file?: string;
  tools?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  detect: () => Promise<Detection>;
  /** Whether nobody has used the accelerator lately (the keeper's lastUseMs, as the NPU refresh's quiet wait). */
  idle: (a: Pick<Accelerator, 'id' | 'kind' | 'slots'>) => boolean;
  /** Manor's stop (manor.ts' manorStopped): nothing is set up while the manor is stopped. */
  stopped?: () => unknown;
  /** Manor's "Use the graphics card for models when there's an NPU" (manor.ts' gpuWithNpu(), read at each look). */
  gpuWithNpu?: () => boolean;
  /** setup.ts' setupCommand, staged. */
  setup: (o: { ids: string[]; kinds?: EndpointKind[]; cpuKinds?: EndpointKind[]; yes: true; staged: true; configFile?: string }) => Promise<{ code: number; busy?: boolean; blocked?: boolean }>;
  log: (line: string) => void;
  exists?: (p: string) => boolean;
  releases?: Release[];
  hfFiles?: (repo: string) => Promise<HfFile[] | null>;
  /** npu-refresh.json's record (setup.ts' readNpuRefresh beside config.json, by default). */
  npuRefresh?: () => NpuRefreshRecord | null;
}

export type AgainOutcome = { did: 'none' } | { did: 'waiting'; ids: string[] } | { did: 'stopped' } | { did: AgainDid; id: string; code: number };

/** Whether an accelerator behind the pins is due a try, after its last (`t`). */
function isDue(t: AgainTry | undefined, key: string, now: number): boolean {
  if (!t || t.key !== key) return true;
  if (t.did === 'blocked') return false;
  return now - Date.parse(t.at) >= (t.did === 'busy' ? AGAIN_BUSY_MS : AGAIN_RETRY_MS);
}

/** Whether one of `named` (config.json's strings, or the servers' command lines, lower case) names `p`: itself, or a path in it. */
function names(named: string[], p: string): boolean {
  const n = lower(p);
  return named.some((s) => {
    for (let i = s.indexOf(n); i >= 0; i = s.indexOf(n, i + 1)) {
      const next = s[i + n.length];
      if (next === undefined || next === '\\' || next === '/' || next === '"' || next === ' ' || next === ',') return true;
    }
    return false;
  });
}

/** What a switch may leave unused of an entry: its build folders in the tools home, a `.kept` folder beside its program's, its model files there. */
function leftBehind(old: Record<string, any>, tools: string, env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  for (const s of servers(old)) {
    const folder = path.dirname(expandEnv(s.program, env));
    if (inside(folder, path.join(tools, 'servers'))) out.add(folder);
    out.add(`${folder}.kept`);
  }
  for (const f of modelFiles(old, env)) if (inside(f, path.join(tools, 'models'))) out.add(f);
  return [...out];
}

/**
 * One look (see above): the accelerators behind the pins found, and the first that is due (and quiet) set up again,
 * staged, its setup's lines in the log. What its switch left unused is noted for removeReplaced.
 */
export async function setUpAgain(d: AgainDeps): Promise<AgainOutcome> {
  const now = (d.now ?? Date.now)();
  const configFile = d.configFile ?? acceleratorConfigFile();
  const file = d.file ?? againFile(configFile);
  const tools = d.tools ?? toolsHome();
  const env = d.env ?? process.env;
  const read = readConfigFile(configFile);
  if (read.error || !configuredAccelerators(read.raw).length) return { did: 'none' };
  const npuRefresh = d.npuRefresh ? d.npuRefresh() : readNpuRefresh(configFile);
  const withNpu = (d.gpuWithNpu ?? (() => gpuWithNpu().on))();
  const behind = await behindPins({ raw: read.raw, detection: await d.detect(), kit: d.kit, tools, env, exists: d.exists, npuRefresh, releases: d.releases, hfFiles: d.hfFiles, gpuWithNpu: withNpu });
  const had = readAgain(file);
  // Tries of what is no longer behind are forgotten.
  const record: AgainRecord = { tries: Object.fromEntries(Object.entries(had.tries).filter(([id]) => behind.some((b) => b.id === id))), replaced: had.replaced };
  if (JSON.stringify(record.tries) !== JSON.stringify(had.tries)) writeAgain(file, record);
  if (!behind.length) return { did: 'none' };
  const due = behind.filter((b) => isDue(record.tries[b.id], b.key, now));
  if (!due.length) return { did: 'waiting', ids: behind.map((b) => b.id) };
  if ((d.stopped ?? manorStopped)()) return { did: 'stopped' };
  const accs = configuredAccelerators(read.raw);
  const b = due.find((x) => {
    const a = accs.find((y) => y.id === x.id);
    return !!a && d.idle(a);
  });
  if (!b) return { did: 'waiting', ids: due.map((x) => x.id) };
  const old = accs.find((a) => a.id === b.id)!;
  // Remembered before it starts: a look meanwhile (another keeper's), or one after a crash, leaves it AGAIN_RETRY_MS.
  record.tries[b.id] = { key: b.key, at: new Date(now).toISOString(), did: 'failed' };
  writeAgain(file, record);
  d.log(`setting ${b.id} up again with this kit's pins, in the background (${b.why.join('; ')}): its present servers serve until the new ones have answered their test`);
  let r: { code: number; busy?: boolean; blocked?: boolean } = { code: 1 };
  try {
    r = await d.setup({ ids: [b.id], ...(b.kind === 'npu' ? {} : { kinds: b.kinds }), ...(b.kind === 'cpu' ? { cpuKinds: b.kinds } : {}), yes: true, staged: true, ...(d.configFile ? { configFile: d.configFile } : {}) });
  } catch (e: any) {
    d.log(`setting ${b.id} up again stopped: ${String(e?.message ?? e).split(/\r?\n/)[0]}`);
  }
  const did: AgainDid = r.code === 0 ? 'set-up' : r.busy ? 'busy' : r.blocked ? 'blocked' : 'failed';
  const after = readAgain(file);
  after.tries[b.id] = { key: b.key, at: new Date(now).toISOString(), did, code: r.code };
  if (did === 'set-up') {
    const fresh = readConfigFile(configFile);
    const named = fresh.error ? null : configStrings(fresh.raw, env);
    for (const p of named ? leftBehind(old, tools, env) : []) if (!names(named!, p) && existsSync(p)) after.replaced[p] ??= new Date(now).toISOString();
  }
  writeAgain(file, after);
  const days = Math.round(RETIRED_GRACE_MS / 86_400_000);
  if (did === 'set-up') d.log(`${b.id} is set up again with this kit's pins: what it ran before is removed in ${days} days unless something names it`);
  else if (did === 'busy') d.log(`${b.id} was in use, so it keeps its present servers for now: a quiet look in ${Math.round(AGAIN_BUSY_MS / 60_000)} minutes or more switches them, and nothing is downloaded again`);
  else if (did === 'blocked')
    d.log(`${b.id} keeps what it has: Windows' Smart App Control blocks the new server this kit pins for it, as its maker doesn't sign it. It isn't tried again until a later kit, and the staff carry on as they are.`);
  else d.log(`${b.id} keeps its present servers: setting it up again didn't work this time (setup's code ${r.code}). It's tried again in ${Math.round(AGAIN_RETRY_MS / 3600_000)} hours`);
  return { did, id: b.id, code: r.code };
}

/**
 * The files and folders a switch left unused (set-up-again.json's `replaced`), removed once nothing has named them for
 * RETIRED_GRACE_MS: config.json, and the model servers' command lines (`running`, asked only when one is due). A folder
 * goes by way of its aside name; one Windows won't let go of yet is tried at a later look. Never in the PC's shared
 * folder (an Everyone install), whose files other accounts' servers read. What it removed.
 */
export async function removeReplaced(o: { configFile?: string; file?: string; tools?: string; env?: Record<string, string | undefined>; now?: () => number; running?: () => Promise<string[]>; log: (line: string) => void }): Promise<{ removed: string[] }> {
  const configFile = o.configFile ?? acceleratorConfigFile();
  const file = o.file ?? againFile(configFile);
  const env = o.env ?? process.env;
  const tools = o.tools ?? toolsHome(env as NodeJS.ProcessEnv);
  const now = (o.now ?? Date.now)();
  const had = readAgain(file);
  if (!Object.keys(had.replaced).length) return { removed: [] };
  const cfg = readConfigFile(configFile);
  if (cfg.error) return { removed: [] };
  const named = configStrings(cfg.raw, env);
  const shared = isSharedTools(tools, env as NodeJS.ProcessEnv);
  const replaced = { ...had.replaced };
  const due: string[] = [];
  for (const [p, since] of Object.entries(replaced)) {
    if (!existsSync(p) || (shared && inside(p, tools))) delete replaced[p];
    else if (names(named, p)) {
      delete replaced[p];
      o.log(`${path.win32.basename(p)} is named in config.json again: kept`);
    } else if (now - Date.parse(since) >= RETIRED_GRACE_MS) due.push(p);
  }
  const lines = due.length ? await (o.running ?? (async () => []))().then((ls) => ls.map((l) => expandEnv(l, env).toLowerCase())).catch(() => null) : null;
  const removed: string[] = [];
  // Windows' process list unread: nothing is removed this look.
  for (const p of lines ? due : []) {
    if (names(lines!, p)) continue;
    const bytes = bytesOf(p);
    try {
      removeAside(p);
      removed.push(p);
      delete replaced[p];
      o.log(`removed ${path.win32.basename(p)}${bytes > 0 ? ` (${(bytes / 1024 ** 3).toFixed(2)} GB)` : ''}: it was replaced when its accelerator was set up again with this kit's pins, and nothing has used it since`);
    } catch (e: any) {
      if (e?.code === 'ENOENT') delete replaced[p];
    }
  }
  if (JSON.stringify(replaced) !== JSON.stringify(had.replaced)) {
    try {
      writeAgain(file, { ...readAgain(file), replaced });
    } catch {}
  }
  return { removed };
}
