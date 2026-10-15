import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredAccelerators, endpointFor, readConfigFile } from './accelerator-config.ts';
import { parseAccelerators, readableConfigFile, readHardware } from './accelerators.ts';
import * as core from './core/index.js';
import { cardOnDemand, pcReaper, type ReapedServer, type ReapOutcome, serverProcesses, serversToReap } from './keeper.ts';
import { Npu, type NpuAnswer } from './npu.ts';
import { testImage } from './npu-vendors.ts';

/**
 * The card on demand, checked on a real PC (kit 2.69.0): an NPU that serves chat but not vision (Intel's, whose NPU
 * can't run Qwen3-VL) and a graphics card set up for vision. With Manor's "Use the graphics card for models when
 * there's an NPU" off, as by default, it asks the NPU a chat question, then a vision question, and sees the card's
 * vision server start for it; then it looks as the keeper does, with gpuIdleStopMinutes set short, until that server
 * is stopped for being unused (not sooner); then chat again, still on the NPU. The card's other servers must never
 * start. It changes nothing in config.json: the short idle time is the check's own. PASS or FAIL, and 0 or 1.
 *
 *   node <agent>\src\kit\card-check.ts [--idle-minutes 1] [--out <file>]
 */

export interface CardCheckStep {
  step: string;
  ok: boolean;
  say: string;
}

export interface CardCheckIo {
  /** config.json as it is. */
  config: () => Record<string, any>;
  /** The requests, with Manor's switch off whatever Manor says. */
  npu: (raw: Record<string, any>) => Pick<Npu, 'chat' | 'vision'>;
  /** Whether a server runs at its base. */
  running: (s: ReapedServer) => Promise<boolean>;
  /** The keeper's look at one server. */
  look: (s: ReapedServer) => Promise<ReapOutcome>;
  now: () => number;
  /** Waits between looks (a test's moves its clock). */
  pause: (ms: number) => Promise<void>;
  image: () => string;
}

export interface CardCheckOptions {
  idleMinutes?: number;
  /** How often it looks while it waits for the idle stop. */
  lookEveryMs?: number;
  io?: Partial<CardCheckIo>;
  log?: (line: string) => void;
}

const MIN = 60_000;

function defaultIo(): CardCheckIo {
  const reaper = pcReaper({ who: 'card-check', logFile: path.join(os.tmpdir(), 'card-check-keeper.log') });
  return {
    config: () => readConfigFile(readableConfigFile()).raw,
    npu: (raw) => {
      const cfg = parseAccelerators(raw, readHardware());
      return new Npu(cfg, { gpuWithNpu: () => false });
    },
    running: async (s) => (await serverProcesses(s.program, s.base)).length > 0,
    look: async (s) => (await reaper.look([s]))[0],
    now: Date.now,
    pause: (ms) => new Promise((r) => setTimeout(r, ms)),
    image: () => testImage(path.join(os.tmpdir(), 'card-check')),
  };
}

/** Runs the check: its steps, and whether every one passed. */
export async function cardCheck(o: CardCheckOptions = {}): Promise<{ ok: boolean; steps: CardCheckStep[] }> {
  const io: CardCheckIo = { ...defaultIo(), ...o.io } as CardCheckIo;
  const log = o.log ?? console.log;
  const idleMs = Math.max(1, Math.round(o.idleMinutes ?? 1)) * MIN;
  const every = o.lookEveryMs ?? 10_000;
  const steps: CardCheckStep[] = [];
  const add = (step: string, ok: boolean, say: string) => {
    steps.push({ step, ok, say });
    log(`${ok ? 'ok  ' : 'FAIL'} ${step}: ${say}`);
    return ok;
  };
  const done = () => {
    const ok = steps.length > 0 && steps.every((s) => s.ok);
    log(ok ? 'PASS: the card served vision on demand and was stopped once unused; chat stayed on the NPU' : 'FAIL');
    return { ok, steps };
  };

  // 1. This PC's shape: an NPU that chats and doesn't see, and a card that sees on demand.
  const raw = { ...io.config(), gpuIdleStopMinutes: idleMs / MIN };
  const accs = configuredAccelerators(raw);
  const npuDoes = core.npuServes(accs);
  const card = cardOnDemand(accs, false).find((c) => c.kinds.includes('vision'));
  if (!add('config', npuDoes.includes('chat') && !npuDoes.includes('vision') && !!card,
    !npuDoes.length ? 'no NPU serves anything in config.json: set the NPU up first'
      : npuDoes.includes('vision') ? `the NPU serves vision itself (${npuDoes.join(', ')}): the card isn't needed on this PC`
        : !npuDoes.includes('chat') ? `the NPU doesn't chat (${npuDoes.join(', ')})`
          : !card ? "no graphics card in config.json is set up for vision: set the card up for vision (Settings → Set up)"
            : `the NPU serves ${npuDoes.join(', ')}; ${card.id} serves ${card.kinds.join(', ')} on demand`)) return done();

  const servers = serversToReap(raw, { withNpu: false });
  const cardAcc = accs.find((a) => a.id === card!.id)!;
  const visionBase = endpointFor(cardAcc, 'vision').baseUrl;
  const vision = servers.find((s) => s.base === visionBase);
  const others = servers.filter((s) => s.acc.id === card!.id && s.base !== visionBase);
  if (!add('keeper', !!vision && !vision.keptOut && vision.idleMs === idleMs && others.every((s) => s.keptOut),
    !vision ? `the keeper has no server for ${card!.id}'s vision at ${visionBase} (no startCommand?)`
      : vision.keptOut ? `the keeper would keep ${card!.id}'s vision server out: it would never serve`
        : others.some((s) => !s.keptOut) ? `the keeper would keep ${others.filter((s) => !s.keptOut).map((s) => s.base).join(', ')} running on the card`
          : `vision at ${visionBase} is stopped after ${idleMs / MIN} min unused${others.length ? `; the card's other servers (${others.map((s) => s.base).join(', ')}) are kept out` : ''}`)) return done();

  // 2. Nothing of the card's running yet: it must be seen to start. One left from earlier is stopped as the keeper would.
  if (await io.running(vision!)) {
    log(`-- ${card!.id}'s vision server is running from earlier: waiting for the keeper's idle stop first`);
    const r = await untilStopped(vision!, io, idleMs + 3 * MIN, every);
    if (!add('before', r.did === 'stopped' || r.did === 'not-running', r.did === 'stopped' || r.did === 'not-running' ? 'stopped, as unused' : `still running (${r.did})`)) return done();
  }
  const othersRanBefore = new Map<string, boolean>();
  for (const s of others) othersRanBefore.set(s.base, await io.running(s));

  // 3. Chat: the NPU's, never the card's.
  const model = io.npu(raw);
  const kindOf = (a: NpuAnswer) => accs.find((x) => x.id === a.accelerator.id)?.kind ?? '?';
  const asked = async (what: () => Promise<NpuAnswer>) => what().then((a) => ({ a }), (e: Error) => ({ e: String(e?.message ?? e) }));
  const chat = await asked(() => model.chat([{ role: 'user', content: 'Reply with the single word: ready' }], { maxTokens: 16, lane: 'interactive' }));
  if (!add('chat', 'a' in chat && kindOf(chat.a) === 'npu', 'e' in chat ? `failed: ${chat.e}` : `answered on ${chat.a.accelerator.id} (${kindOf(chat.a)}) in ${(chat.a.ms / 1000).toFixed(1)} s`)) return done();

  // 4. Vision: the card's, its server started for it.
  const t0 = io.now();
  const seen = await asked(() => model.vision(io.image(), 'What colour is this image? One word.', { maxTokens: 16, lane: 'interactive' }));
  if (!add('vision', 'a' in seen && seen.a.accelerator.id === card!.id && !!seen.a.text, 'e' in seen ? `failed: ${seen.e}` : `answered "${seen.a.text.slice(0, 40)}" on ${seen.a.accelerator.id} in ${((io.now() - t0) / 1000).toFixed(1)} s (the card's server started for it)`)) return done();
  const answeredAt = io.now();
  const up = await io.running(vision!);
  if (!add('started', up, `${card!.id}'s vision server ${up ? 'is running' : "isn't running after the request"}`)) return done();

  // 5. The idle stop: not before idleMs unused, and by the keeper's idle rule.
  const r = await untilStopped(vision!, io, idleMs + 3 * MIN, every);
  const after = io.now() - answeredAt;
  const stoppedOk = r.did === 'stopped' && after >= idleMs - every;
  add('idle-stop', stoppedOk,
    r.did === 'stopped' ? `stopped after ${(after / 1000).toFixed(0)} s unused (${idleMs / MIN} min allowed)${stoppedOk ? '' : ': too soon'}`
      : r.did === 'not-running' ? "it stopped, but not by the keeper's idle stop: an installed keeper older than kit 2.69.0 stops the card's servers beside the NPU as soon as they're unused; update the staff first"
        : r.did === 'stopped-kept-out' ? 'the keeper stopped it as kept out, not as unused'
          : `still running after ${(after / 1000).toFixed(0)} s (last look: ${r.did})`);
  const still = await io.running(vision!);
  add('stopped', !still, still ? 'its process is still there' : 'its process is gone, and nothing started it again');

  // 6. Chat again: still the NPU's; the card's other servers never started.
  const again = await asked(() => model.chat([{ role: 'user', content: 'Reply with the single word: ready' }], { maxTokens: 16, lane: 'interactive' }));
  add('chat-again', 'a' in again && kindOf(again.a) === 'npu', 'e' in again ? `failed: ${again.e}` : `answered on ${again.a.accelerator.id} (${kindOf(again.a)})`);
  const startedOthers: string[] = [];
  for (const s of others) if (!othersRanBefore.get(s.base) && (await io.running(s))) startedOthers.push(s.base);
  add('card-otherwise-idle', !startedOthers.length, startedOthers.length ? `the card's ${startedOthers.join(', ')} started` : "none of the card's other servers started");
  return done();
}

/** Looks at the server until it's stopped or gone, or `limitMs` passes: the last look. */
async function untilStopped(s: ReapedServer, io: CardCheckIo, limitMs: number, every: number): Promise<ReapOutcome> {
  const end = io.now() + limitMs;
  let r: ReapOutcome = { base: s.base, did: 'answering' };
  while (io.now() < end) {
    r = await io.look(s);
    if (r.did === 'stopped' || r.did === 'not-running' || r.did === 'stopped-kept-out') return r;
    await io.pause(every);
  }
  return r;
}

// ------------------------------------------------------------------------------------------------
// As a command

export function parseCardCheckArgs(argv: string[]): (CardCheckOptions & { out?: string }) | { error: string } {
  const o: CardCheckOptions & { out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--idle-minutes') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 60) return { error: '--idle-minutes takes a whole number from 1 to 60' };
      o.idleMinutes = v;
    } else if (a === '--out') o.out = argv[++i];
    else return { error: `unknown argument ${a}` };
  }
  return o;
}

// Run as itself, compared by real paths: a folder reached through a junction or a Dev Drive mount spells argv[1] one way
// and import.meta.url (always the real path) another, and a plain comparison would do nothing (spec/DEV-DRIVES.md).
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const o = parseCardCheckArgs(process.argv.slice(2));
  if ('error' in o) {
    console.error(`${o.error}\nUsage: node card-check.ts [--idle-minutes 1] [--out <file>]`);
    process.exit(2);
  }
  const r = await cardCheck(o);
  if (o.out) {
    mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    writeFileSync(o.out, JSON.stringify({ at: new Date().toISOString(), ...r }, null, 2) + '\n');
  }
  process.exit(r.ok ? 0 : 1);
}
