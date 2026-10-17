import path from 'node:path';
import { type AcceleratorEntry, readConfigFile, validateKeeperConfig, writeConfigFile } from './accelerator-config.ts';
import { expandEnv } from './accelerators.ts';
import type { Detection } from './detect.ts';
import { LockTimeout, QueueFull } from './npu-queue.ts';
import { compareVersions, NPU_CATALOG, type NpuCatalog, npuEntry, planNpu, runsRoute, smallPc } from './npu-vendors.ts';
import { mergeEntries, portablePath, type NpuRefreshRecord, readNpuRefresh, rememberNpuRefresh } from './setup.ts';

/**
 * The NPU's servers brought up to this kit's command on a PC set up by an older one. Setup writes the
 * NPU's entry once, so a kit that changed the route's command (a server argument, its cap, a plugin option: on Intel's
 * NPU 3720, prompts read 128 tokens at a time, a short answer in 0.5 s rather than 3.1 s) reached only the PCs set up
 * after it, until someone pressed Set up again. The keeper (the Smith, else Reeve) now looks once for each kit version:
 * what setup would write on this PC's NPU, beside what config.json has. When they differ and nothing has to be
 * downloaded, it waits until nobody uses the NPU, then, holding the NPU's turn, stops its servers and asks the new
 * command the test question (and a test embedding, when the NPU makes them). Only when it answers properly is the new
 * command written; otherwise the old one stays, the next request starts it again, and this kit doesn't try again,
 * unless the test's server went away (serverWentAway): then a look an hour later tests it again, NPU_REFRESH_TRIES
 * tests in all. A command written by a newer kit is never taken back, and an entry a person pointed at another server
 * is left alone.
 */

/** The tests one kit makes of a new command whose server keeps going away, the first included. */
export const NPU_REFRESH_TRIES = 3;

/** How long after such a test the next look tests again. */
export const NPU_REFRESH_RETRY_MS = 60 * 60_000;

/**
 * Whether a test failed for its server, not its answers: it refused the connection (nothing listening, or it went away
 * mid-request), or it exited while starting (the core's connectionRefused and exitedWhileStarting). That may be the PC's
 * moment rather than the command (memory short while the model loaded, say), and one such failure kept a PC on its old
 * command for the whole kit. An answer that doesn't make sense ("chat answered nonsense", vectors that don't) is the
 * command's own, and stays final.
 */
export const serverWentAway = (problems: string[]) => problems.length > 0 && problems.every((p) => /refused the connection|exited \(code [^)]*\) and .* isn't answering/.test(p));

/** What a look did: written to `npu-refresh.json` (setup's `set-up` included), except `looked`, `newer-kit`, `busy` and `unreadable`. */
export type NpuRefreshDid = NpuRefreshRecord['did'] | 'looked' | 'newer-kit' | 'busy' | 'unreadable';

export interface NpuRefreshOutcome {
  did: NpuRefreshDid;
  problems?: string[];
  /** The arguments that changed, for the keeper's log: `--plugin_config {…} added`. */
  changes?: string[];
  /** A failed test's server went away (serverWentAway): a look from then on tests again. */
  retryAt?: string;
}

export interface NpuRefreshDeps {
  /** This kit's version. */
  kit: string;
  configFile: string;
  /** The tools home (servers and models). */
  tools: string;
  /** The user's folder, for the portable paths setup writes (%USERPROFILE%). */
  home?: string;
  env?: Record<string, string | undefined>;
  now: () => number;
  detect: () => Promise<Detection>;
  catalog?: NpuCatalog;
  exists?: (p: string) => boolean;
  validate?: (raw: unknown) => string[];
  /** Whether nobody holds, waits for or has just used the NPU. */
  idle: () => boolean;
  /** The NPU's turn, holding every slot, so no request reaches a server being changed. */
  withTurn: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Stops whatever `program` serves `base`, and waits until it's gone. */
  stopServer: (program: string, base: string) => Promise<void>;
  /** The test question, in the turn the caller holds: the problems, none when it answered properly. */
  testChat: (e: AcceleratorEntry) => Promise<string[]>;
  /** A test embedding, the same way. */
  testEmbed: (e: AcceleratorEntry, dims?: number) => Promise<string[]>;
  /** Where the test's servers print, named in the log when a test fails. */
  serverLog?: string;
  log: (line: string) => void;
}

/** JSON with its keys in order, so two entries compare by what they say, not how they were written. */
function stable(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(stable).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().filter((k) => (x as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((x as any)[k])}`).join(',')}}`;
  return JSON.stringify(x);
}

/** What setup decides about the NPU's servers: their commands and environments, its caps and quirks. Its timeouts, slots and switch are the PC's. */
const served = (e: Record<string, any>) => stable({ maxContextTokens: e.maxContextTokens, quirks: e.quirks ?? [], chat: e.chat, vision: e.vision, embed: e.embed });

/** Each server the entry starts, once (an embedding server of its own beside the chat's). */
function servers(e: Record<string, any>): { program: string; base: string }[] {
  const out = new Map<string, string>();
  for (const k of ['chat', 'vision', 'embed']) {
    const ep = e[k];
    if (ep?.baseUrl && Array.isArray(ep.startCommand) && ep.startCommand.length && !out.has(ep.baseUrl)) out.set(ep.baseUrl, expandEnv(ep.startCommand[0]));
  }
  return [...out].map(([base, program]) => ({ base, program }));
}

/** The arguments one command has that the other hasn't, as `--flag value added` and `--flag value removed`. */
export function argChanges(from: string[], to: string[]): string[] {
  const pairs = (cmd: string[]) => {
    const out: string[] = [];
    for (let i = 1; i < cmd.length; i++) {
      if (cmd[i].startsWith('--') && i + 1 < cmd.length && !cmd[i + 1].startsWith('--')) out.push(`${cmd[i]} ${cmd[++i]}`);
      else out.push(cmd[i]);
    }
    return out;
  };
  const a = pairs(from);
  const b = pairs(to);
  return [...b.filter((x) => !a.includes(x)).map((x) => `${x} added`), ...a.filter((x) => !b.includes(x)).map((x) => `${x} removed`)];
}

const portOf = (url: string | undefined) => {
  try {
    const p = Number(new URL(url ?? '').port);
    return Number.isInteger(p) && p > 0 ? p : undefined;
  } catch {
    return undefined;
  }
};

/** One look (refreshNpu above). Never throws for a PC that can't be looked at: the outcome says why. */
export async function refreshNpu(d: NpuRefreshDeps): Promise<NpuRefreshOutcome> {
  const had = readNpuRefresh(d.configFile);
  // This kit's test whose server went away is made again once its time comes; anything else this kit found stands.
  const again = had?.kit === d.kit && had.did === 'failed' && typeof had.retryAt === 'string';
  if (had?.kit === d.kit && !(again && d.now() >= Date.parse(had.retryAt!))) return { did: 'looked' };
  if (had?.kit && compareVersions(had.kit, d.kit) > 0) return { did: 'newer-kit' };
  const done = (did: NpuRefreshRecord['did'], more: Omit<NpuRefreshOutcome, 'did'> = {}, tries?: number): NpuRefreshOutcome => {
    rememberNpuRefresh(d.configFile, { kit: d.kit, at: new Date(d.now()).toISOString(), did, ...(more.problems?.length ? { problems: more.problems } : {}), ...(tries ? { tries } : {}), ...(more.retryAt ? { retryAt: more.retryAt } : {}) });
    return { did, ...more };
  };

  const file = readConfigFile(d.configFile);
  if (file.error) return { did: 'unreadable', problems: [file.error] };
  const list: any[] = Array.isArray(file.raw.accelerators) ? file.raw.accelerators : [];
  const entry = list.find((a) => a && typeof a === 'object' && a.id === 'npu' && a.kind === 'npu');
  if (!entry?.chat?.startCommand?.length) return done('no-npu');
  const detected = await d.detect();
  const npu = detected.npu;
  const cards = detected.cards ?? [];
  if (!npu?.supported || !npu.vendor) return done('no-npu');
  const catalog = d.catalog ?? NPU_CATALOG;
  const route = catalog.routes[npu.vendor];
  if (!route || !runsRoute(entry, route, d.tools)) return done('not-route');

  // What setup would write now, on the same ports, with or without its embeddings as before, and the models this PC's
  // generation and memory take (a Snapdragon X2's Qwen3-VL-2B: pulled by setup, so a model not here yet is needs-setup).
  const plan = planNpu({ support: npu, tools: d.tools, downloadsDir: path.join(d.tools, 'servers', 'downloads'), env: d.env, exists: d.exists, catalog, port: portOf(entry.chat.baseUrl), noEmbed: !entry.embed?.startCommand?.length, cards, small: smallPc(detected.ramBytes) });
  if (!plan) return done('no-npu');
  if (!plan.installed || plan.runtime || plan.downloadBytes > 0) return done('needs-setup');
  // The graphics' turn its embeddings take (embedTurn); a detection that listed no cards keeps the entry's.
  const turn = plan.embed?.turn ?? (cards.length || typeof entry.embed?.turn !== 'string' ? undefined : entry.embed.turn);
  const fresh = npuEntry(plan.route, { tools: d.tools, exe: plan.exe, port: plan.port, portable: (p) => portablePath(p, d.home), embed: plan.embed ? { exe: plan.embed.exe, model: plan.embed.model, ...(turn ? { turn } : {}) } : undefined });
  // Its slots, timeouts (measured on this PC, or a person's) and switch stay as they are.
  const { chat: _chat, vision: _vision, embed: _embed, ...kept } = entry;
  const next: AcceleratorEntry = { ...kept, maxContextTokens: fresh.maxContextTokens, quirks: fresh.quirks, chat: fresh.chat, ...(fresh.vision ? { vision: fresh.vision } : {}), ...(fresh.embed ? { embed: fresh.embed } : {}) };
  if (served(entry) === served(next)) return done('current');

  const changes = [
    // Another model (its generation's own, once setup has pulled it: a Snapdragon X2's Qwen3-VL-2B).
    ...(entry.chat.model !== next.chat!.model ? [`model ${next.chat!.model} in ${entry.chat.model}'s place`] : []),
    ...argChanges(entry.chat.startCommand, next.chat!.startCommand ?? []),
    ...(entry.embed?.startCommand && next.embed?.startCommand ? argChanges(entry.embed.startCommand, next.embed.startCommand).map((c) => `embeddings: ${c}`) : []),
    ...(next.embed && (entry.embed?.turn ?? null) !== (next.embed.turn ?? null) ? [`embeddings: in ${next.embed.turn ? `${next.embed.turn}'s` : "the NPU's"} turn`] : []),
    ...(stable(entry.quirks ?? []) !== stable(next.quirks ?? []) ? [`quirks: ${next.quirks?.length ? next.quirks.join(', ') : 'none'}`] : []),
  ];
  if (!d.idle()) return { did: 'busy' };
  let problems: string[];
  try {
    problems = await d.withTurn(async () => {
      for (const s of servers(entry)) await d.stopServer(s.program, s.base);
      const p = await d.testChat(next);
      if (!p.length && next.embed?.startCommand?.length) p.push(...(await d.testEmbed(next, plan.embed?.server.model.dims)));
      // The old command starts again at the next request.
      if (p.length) for (const s of servers(next)) await d.stopServer(s.program, s.base);
      return p;
    });
  } catch (e) {
    if (e instanceof QueueFull || e instanceof LockTimeout) return { did: 'busy' };
    throw e;
  }
  if (problems.length) {
    const tries = (again ? (had!.tries ?? 1) : 0) + 1;
    const retryAt = serverWentAway(problems) && tries < NPU_REFRESH_TRIES ? new Date(d.now() + NPU_REFRESH_RETRY_MS).toISOString() : undefined;
    const then = retryAt ? `; its server went away, so a look from ${retryAt} tests it again (test ${tries} of ${NPU_REFRESH_TRIES})` : tries > 1 ? ` (test ${tries} of ${NPU_REFRESH_TRIES}: this kit doesn't try again)` : '';
    d.log(`the NPU's servers keep their command: this kit's (${d.kit}: ${changes.join('; ') || 'its caps'}) didn't answer its test: ${problems.join('; ')}${then}${d.serverLog ? `. What its servers printed: ${d.serverLog}` : ''}`);
    return done('failed', { problems, changes, ...(retryAt ? { retryAt } : {}) }, tries);
  }
  // Written over config.json as it is now, unless the NPU's entry changed while the test ran: then the next kit's look decides.
  const now = readConfigFile(d.configFile);
  const still = (Array.isArray(now.raw.accelerators) ? now.raw.accelerators : []).find((a: any) => a?.id === 'npu');
  if (now.error || !still || stable(still) !== stable(entry)) return { did: 'busy' };
  const saved = writeConfigFile(d.configFile, mergeEntries(now.raw, [next]), d.validate ?? validateKeeperConfig);
  if (saved.problems.length) {
    d.log(`the NPU's new command answered, but config.json wasn't written: ${saved.problems.join('; ')}`);
    return done('failed', { problems: saved.problems, changes });
  }
  d.log(`the NPU's servers now start with this kit's command (${d.kit}): ${changes.join('; ') || 'its caps changed'}`);
  return done('refreshed', { changes });
}
