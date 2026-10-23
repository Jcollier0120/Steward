import { existsSync } from 'node:fs';
import path from 'node:path';
import { type AcceleratorEntry, readConfigFile, validateKeeperConfig, writeConfigFile } from './accelerator-config.ts';
import { expandEnv } from './accelerators.ts';
import type { Detection } from './detect.ts';
import { LockTimeout, QueueFull } from './npu-queue.ts';
import { atVersion, compareVersions, expandRoute, installedVersion, NPU_CATALOG, type NpuCatalog, npuEntry, npuMemoryFit, type NpuRoute, pinnedRoute, planNpu, routeFor, runsRoute, serverExe, smallPc } from './npu-vendors.ts';
import { mergeEntries, type NpuEmbedOffer, type NpuRefreshRecord, overlayFiles, portablePath, readNpuRefresh, rememberNpuRefresh } from './setup.ts';

/**
 * The NPU's servers brought up to this kit's command on a PC set up by an older one. Setup writes the
 * NPU's entry once, so a kit that changed the route's command (a server argument, its cap, a plugin option: on Intel's
 * NPU 3720, prompts read 128 tokens at a time, a short answer in 0.5 s rather than 3.1 s) reached only the PCs set up
 * after it, until someone pressed Set up again. The keeper (the Smith, else Reeve) now looks once for each kit version:
 * what setup would write on this PC's NPU, beside what config.json has. When they differ and nothing has to be
 * downloaded, it waits until nobody uses the NPU, then, holding the NPU's turn, stops its servers and asks the new
 * command the test question (and a test embedding, when the NPU makes them), once nothing answers on its ports. Only when
 * it answers properly is the new command written; otherwise the old one stays, the next request starts it again, and
 * this kit doesn't try again, unless the test failed for its server (serverFailed): then a look an hour later tests it
 * again, NPU_REFRESH_TRIES tests in all. A command written by a newer kit is never taken back, and an entry a person
 * pointed at another server is left alone.
 *
 * Since kit 2.86.0 it also offers the NPU its own embeddings, where its entry has none (set up before the route made
 * them, as a Snapdragon set up before kit 2.63.0, or by a setup whose test of them failed): when the PC has room for
 * them beside its chat (npuMemoryFit, as setup decides) and their server and model are already here, so nothing is
 * downloaded. They're tested after the chat, in the same turn, and taken up only when they answer; refused, the chat's
 * new command (if any) is written without them, and the record says so (embedOffer): a later kit offers them again,
 * NPU_REFRESH_TRIES kits in all, then not until the route's embedding server changes.
 */

/** The tests one kit makes of a new command whose server keeps failing it, the first included. */
export const NPU_REFRESH_TRIES = 3;

/** How long after such a test the next look tests again. */
export const NPU_REFRESH_RETRY_MS = 60 * 60_000;

/**
 * How long a port may go on answering once its server is stopped, and how often it's asked meanwhile. Gone from the
 * process list isn't always gone from the port (stopServer gives up after 10 s), and a test asked of a server still
 * answering is the old command's answer: the new one would be written untested.
 */
export const NPU_REFRESH_PORT_WAIT_MS = 30_000;
export const NPU_REFRESH_PORT_STEP_MS = 500;

/** The problem when an old server still answers: the new command isn't tested. */
export const stillAnswered = (base: string, what: string) => `${base} still answered ${NPU_REFRESH_PORT_WAIT_MS / 1000} s after its server was stopped (${what}), so the new command wasn't tested`;

/**
 * Whether a test failed for its server, not its answers: it refused the connection (nothing listening, or it went away
 * mid-request), it exited while starting (the core's connectionRefused and exitedWhileStarting), or the old server still
 * answered on its port (stillAnswered). That may be the PC's moment rather than the command (memory short while the
 * model loaded, an old server slow to go), and one such failure kept a PC on its old command for the whole kit. An
 * answer that doesn't make sense ("chat answered nonsense", vectors that don't) is the command's own, and stays final.
 */
export const serverFailed = (problems: string[]) =>
  problems.length > 0 && problems.every((p) => /refused the connection|exited \(code [^)]*\) and .* isn't answering|still answered \d+ s after its server was stopped/.test(p));

/** What a look did: written to `npu-refresh.json` (setup's `set-up` included), except `looked`, `newer-kit`, `busy`, `unreadable` and `unknown-version` (a server that can't say which of its generation's two versions it is). */
export type NpuRefreshDid = NpuRefreshRecord['did'] | 'looked' | 'newer-kit' | 'busy' | 'unreadable' | 'unknown-version';

export interface NpuRefreshOutcome {
  did: NpuRefreshDid;
  problems?: string[];
  /** The arguments that changed, for the keeper's log: `--plugin_config {…} added`. */
  changes?: string[];
  /** A test that failed for its server (serverFailed): a look from then on tests again. */
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
  /** What answers at `base` now, in words (its /v1/models answer); null when nothing takes the connection. Without it, ports aren't waited on. */
  answering?: (base: string) => Promise<string | null>;
  /** The wait between asks of a port (a test's own clock). */
  sleep?: (ms: number) => Promise<void>;
  /** The test question, in the turn the caller holds: the problems, none when it answered properly. */
  testChat: (e: AcceleratorEntry) => Promise<string[]>;
  /** A test embedding, the same way. */
  testEmbed: (e: AcceleratorEntry, dims?: number) => Promise<string[]>;
  /** Copies the route's server's files over its embedding server's (setup's overlayFiles), before embeddings offered to the NPU are tested. */
  overlay?: (from: string, into: string, files: string[]) => number;
  /** The version of the route's server installed here (npu-vendors.ts' installedVersion by default): a later one the Smith's Use it left is run as that version runs. */
  serverVersion?: (route: NpuRoute) => Promise<string | null>;
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
const served = (e: Record<string, any>) => stable({ maxContextTokens: e.maxContextTokens, quirks: e.quirks ?? [], chat: e.chat, vision: e.vision, embed: e.embed, rerank: e.rerank });

/**
 * The NPU's reranker as its entry has it (setup's npuRerank, kit 2.100.0): its model's file, its id and its port, so it
 * is made again on the embedding server written now. Undefined for none, or one setup didn't write.
 */
function rerankOf(ep: any): { file: string; model: string; port?: number } | undefined {
  const cmd: unknown[] = Array.isArray(ep?.startCommand) ? ep.startCommand : [];
  const m = cmd.indexOf('-m');
  if (m < 1 || typeof cmd[m + 1] !== 'string' || typeof ep.model !== 'string' || !cmd.includes('--reranking')) return undefined;
  return { file: cmd[m + 1] as string, model: ep.model, ...(portOf(ep.baseUrl) ? { port: portOf(ep.baseUrl) } : {}) };
}

/** Each server the entry starts, once (an embedding server of its own beside the chat's, and its reranker). */
export function servers(e: Record<string, any>): { program: string; base: string }[] {
  const out = new Map<string, string>();
  for (const k of ['chat', 'vision', 'embed', 'rerank']) {
    const ep = e[k];
    if (ep?.baseUrl && Array.isArray(ep.startCommand) && ep.startCommand.length && !out.has(ep.baseUrl)) out.set(ep.baseUrl, expandEnv(ep.startCommand[0]));
  }
  return [...out].map(([base, program]) => ({ base, program }));
}

/**
 * What answers at `base` now (its /v1/models), in words for the log: any answer at all is something on the port, a 404
 * included (accelerators.ts' probe calls that `down`). Null when nothing takes the connection.
 */
export async function whatAnswers(base: string, ms = 2_000): Promise<string | null> {
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(ms) });
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim();
    return `${res.status}${body ? `: ${body.length > 120 ? `${body.slice(0, 120)}…` : body}` : ''}`;
  } catch (e: any) {
    return e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `it took the connection but gave no answer in ${ms / 1000} s` : null;
  }
}

/** Each port the test will ask, waited on until nothing answers there (NPU_REFRESH_PORT_WAIT_MS): what still answers, as problems. */
export async function stillAnswering(d: Pick<NpuRefreshDeps, 'answering' | 'sleep'>, bases: string[]): Promise<string[]> {
  if (!d.answering) return [];
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out: string[] = [];
  for (const base of bases) {
    for (let waited = 0; ; waited += NPU_REFRESH_PORT_STEP_MS) {
      const what = await d.answering(base);
      if (what === null) break;
      if (waited >= NPU_REFRESH_PORT_WAIT_MS) {
        out.push(stillAnswered(base, what));
        break;
      }
      await sleep(NPU_REFRESH_PORT_STEP_MS);
    }
  }
  return out;
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

/** The variables one environment sets that the other doesn't, or sets otherwise, as `NAME=value added` and `NAME=value removed`. */
export function envChanges(from: Record<string, string> | undefined, to: Record<string, string> | undefined): string[] {
  const a = Object.entries(from ?? {}).map(([k, v]) => `${k}=${v}`);
  const b = Object.entries(to ?? {}).map(([k, v]) => `${k}=${v}`);
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
  // This kit's test that failed for its server is made again once its time comes; anything else this kit found stands.
  const again = had?.kit === d.kit && had.did === 'failed' && typeof had.retryAt === 'string';
  if (had?.kit === d.kit && !(again && d.now() >= Date.parse(had.retryAt!))) return { did: 'looked' };
  if (had?.kit && compareVersions(had.kit, d.kit) > 0) return { did: 'newer-kit' };
  // The NPU's own embeddings, refused at an earlier look: carried in every record until they're taken up.
  let embedOffer: NpuEmbedOffer | undefined = had?.embedOffer;
  const done = (did: NpuRefreshRecord['did'], more: Omit<NpuRefreshOutcome, 'did'> = {}, tries?: number): NpuRefreshOutcome => {
    rememberNpuRefresh(d.configFile, { kit: d.kit, at: new Date(d.now()).toISOString(), did, ...(more.problems?.length ? { problems: more.problems } : {}), ...(tries ? { tries } : {}), ...(more.retryAt ? { retryAt: more.retryAt } : {}), ...(embedOffer ? { embedOffer } : {}) });
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

  // What setup would write now, on the same ports, and the models this PC's generation and memory take (a Snapdragon
  // X2's Qwen3-VL-2B: pulled by setup, so a model not here yet is needs-setup). Its embeddings as they were, unless the
  // NPU makes none and may now: room for them beside its chat (npuMemoryFit, as setup decides), not refused
  // NPU_REFRESH_TRIES times already by this embedding server, and their server and model here (nothing downloaded).
  // At the server's version on this PC: a later GenieX the Smith's Use it left keeps that version's command, and its
  // embedding server is the llama.cpp build that loads its libraries.
  const small = smallPc(detected.ramBytes);
  const version = await (d.serverVersion ?? ((r: NpuRoute) => installedVersion(r, { tools: d.tools, env: d.env, exists: d.exists })))(route);
  // A generation whose pin isn't the route's version (the X2's GenieX 0.9.1, from kit 2.88.1) may run either: the route's
  // where an older kit set it up, the pin's where this one did. A server that is there but can't say which keeps its
  // command, not written, so a later look asks again.
  if (version === null && pinnedRoute(route, npu.generation).version !== route.version && (d.exists ?? existsSync)(serverExe(route, d.tools, d.env))) return { did: 'unknown-version' };
  const generation =routeFor(atVersion(pinnedRoute(route, npu.generation), version), npu.generation, small);
  const own = generation.embedServer ? `${generation.embedServer.server} ${generation.embedServer.version}` : null;
  const hadEmbed = !!entry.embed?.startCommand?.length;
  const refusedTries = own && embedOffer?.server === own ? embedOffer.tries : 0;
  const mayOffer = !hadEmbed && !!own && npuMemoryFit(generation, detected.ramBytes).embed && refusedTries < NPU_REFRESH_TRIES;
  const planFor = (noEmbed: boolean) =>
    planNpu({ support: npu, tools: d.tools, downloadsDir: path.join(d.tools, 'servers', 'downloads'), env: d.env, exists: d.exists, catalog, port: portOf(entry.chat.baseUrl), noEmbed, cards, small, serverVersion: version });
  let plan = planFor(!hadEmbed && !mayOffer);
  // Their server or model not here yet: left for setup (Set up local AI), and the rest goes on without them.
  if (mayOffer && plan && plan.downloadBytes > 0) plan = planFor(true);
  if (!plan) return done('no-npu');
  if (!plan.installed || plan.runtime || plan.downloadBytes > 0) return done('needs-setup');
  const offered = !hadEmbed && !!plan.embed;
  // The graphics' turn its embeddings take (embedTurn); a detection that listed no cards keeps the entry's.
  const turn = plan.embed?.turn ?? (cards.length || typeof entry.embed?.turn !== 'string' ? undefined : entry.embed.turn);
  const fresh = npuEntry(plan.route, { tools: d.tools, exe: plan.exe, port: plan.port, portable: (p) => portablePath(p, d.home), embed: plan.embed ? { exe: plan.embed.exe, model: plan.embed.model, ...(turn ? { turn } : {}) } : undefined, rerank: rerankOf(entry.rerank) });
  // Its slots, timeouts (measured on this PC, or a person's) and switch stay as they are; its reranker too, unless it's
  // setup's, made again on the embedding server written now.
  const { chat: _chat, vision: _vision, embed: _embed, ...kept } = entry;
  let next: AcceleratorEntry = { ...kept, maxContextTokens: fresh.maxContextTokens, quirks: fresh.quirks, chat: fresh.chat, ...(fresh.vision ? { vision: fresh.vision } : {}), ...(fresh.embed ? { embed: fresh.embed } : {}), ...(fresh.rerank ? { rerank: fresh.rerank } : {}) };
  if (served(entry) === served(next)) return done('current');

  const offerWords = offered ? `embeddings: on the NPU's own server (${own}, ${next.embed!.model})${next.embed!.turn ? ` in ${next.embed!.turn}'s turn` : ''}` : null;
  let changes = [
    // Another model (its generation's own, once setup has pulled it: a Snapdragon X2's Qwen3-VL-2B).
    ...(entry.chat.model !== next.chat!.model ? [`model ${next.chat!.model} in ${entry.chat.model}'s place`] : []),
    ...argChanges(entry.chat.startCommand, next.chat!.startCommand ?? []),
    ...envChanges(entry.chat.env, next.chat!.env),
    ...(entry.embed?.startCommand && next.embed?.startCommand ? argChanges(entry.embed.startCommand, next.embed.startCommand).map((c) => `embeddings: ${c}`) : []),
    ...(entry.rerank?.startCommand && next.rerank?.startCommand ? argChanges(entry.rerank.startCommand, next.rerank.startCommand).map((c) => `reranker: ${c}`) : []),
    ...(offerWords ? [offerWords] : []),
    ...(!offered && next.embed && (entry.embed?.turn ?? null) !== (next.embed.turn ?? null) ? [`embeddings: in ${next.embed.turn ? `${next.embed.turn}'s` : "the NPU's"} turn`] : []),
    ...(stable(entry.quirks ?? []) !== stable(next.quirks ?? []) ? [`quirks: ${next.quirks?.length ? next.quirks.join(', ') : 'none'}`] : []),
    // A picture fitted within its vision's count (the X2's Qwen3-VL-2B), or sent at its own size again.
    ...((entry.vision?.pictureTokens ?? null) !== (next.vision?.pictureTokens ?? null) ? [next.vision?.pictureTokens ? `pictures: at most ${next.vision.pictureTokens} tokens` : 'pictures: at their own size'] : []),
  ];
  if (!d.idle()) return { did: 'busy' };
  // Embeddings offered whose test failed: the rest is written without them.
  let refused: string[] = [];
  // The route's server's files copied over the embedding server's, as setup does, once its servers are stopped (a loaded DLL can't be replaced).
  const overlaid = (): string[] => {
    const o = plan.embed?.server.overlay;
    if (!o) return [];
    try {
      (d.overlay ?? overlayFiles)(expandRoute(o.from, { tools: d.tools, env: d.env }), plan.embed!.folder, o.files);
      return [];
    } catch (e: any) {
      return [`${own}'s files couldn't be copied from ${o.from}: ${String(e?.message ?? e).split(/\r?\n/)[0]}`];
    }
  };
  let problems: string[];
  try {
    problems = await d.withTurn(async () => {
      for (const s of servers(entry)) await d.stopServer(s.program, s.base);
      // An old server that outlived its stop would answer the test itself, and the new command would be written untested.
      const stayed = await stillAnswering(d, servers(next).map((s) => s.base));
      if (stayed.length) return stayed;
      const p = await d.testChat(next);
      if (!p.length && next.embed?.startCommand?.length) {
        const e = offered ? overlaid() : [];
        if (!e.length) e.push(...(await d.testEmbed(next, plan.embed?.server.model.dims)));
        if (offered) refused = e;
        else p.push(...e);
      }
      // The old command starts again at the next request; a refused embedding server isn't left running beside the chat that answered.
      const stopping = p.length ? servers(next) : refused.length ? servers(next).filter((s) => s.base !== next.chat?.baseUrl) : [];
      for (const s of stopping) await d.stopServer(s.program, s.base);
      return p;
    });
  } catch (e) {
    if (e instanceof QueueFull || e instanceof LockTimeout) return { did: 'busy' };
    throw e;
  }
  if (problems.length) {
    const tries = (again ? (had!.tries ?? 1) : 0) + 1;
    const retryAt = serverFailed(problems) && tries < NPU_REFRESH_TRIES ? new Date(d.now() + NPU_REFRESH_RETRY_MS).toISOString() : undefined;
    const then = retryAt ? `; that's its server's failure, so a look from ${retryAt} tests it again (test ${tries} of ${NPU_REFRESH_TRIES})` : tries > 1 ? ` (test ${tries} of ${NPU_REFRESH_TRIES}: this kit doesn't try again)` : '';
    d.log(`the NPU's servers keep their command: this kit's (${d.kit}: ${changes.join('; ') || 'its caps'}) didn't answer its test: ${problems.join('; ')}${then}${d.serverLog ? `. What its servers printed: ${d.serverLog}` : ''}`);
    return done('failed', { problems, changes, ...(retryAt ? { retryAt } : {}) }, tries);
  }
  if (refused.length) {
    const tries = refusedTries + 1;
    embedOffer = { server: own!, tries, at: new Date(d.now()).toISOString(), problems: refused };
    const then = tries < NPU_REFRESH_TRIES ? `a later kit offers them again (${tries} of ${NPU_REFRESH_TRIES})` : `not offered again until the route's embedding server is another (${tries} of ${NPU_REFRESH_TRIES})`;
    d.log(`the NPU's own embeddings (${own}) weren't taken up, their test failed: ${refused.join('; ')}; they go where they went before, and ${then}${d.serverLog ? `. What its servers printed: ${d.serverLog}` : ''}`);
    const { embed: _offered, ...without } = next;
    next = without;
    changes = changes.filter((c) => c !== offerWords);
    if (served(entry) === served(next)) return done('current', { problems: refused });
  } else if (offered) embedOffer = undefined;
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
