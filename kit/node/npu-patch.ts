import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AcceleratorEntry, readConfigFile } from './accelerator-config.ts';
import type { Detection } from './detect.ts';
import { LockTimeout, QueueFull } from './npu-queue.ts';
import { NPU_REFRESH_RETRY_MS, NPU_REFRESH_TRIES, serverFailed, servers, stillAnswering } from './npu-refresh.ts';
import { atVersion, compareVersions, expandRoute, hostedPatchFile, installedVersion, NPU_CATALOG, type NpuCatalog, type NpuPluginPatch, type NpuRoute, pinnedRoute, pluginPatchOf, runsRoute, sameFile, sha256File } from './npu-vendors.ts';

/**
 * A file of the NPU's server replaced with the kit's own build of it (npu-vendors.ts' NpuPluginPatch): on the Snapdragon
 * X2, Castellan's build of GenieX's llama.cpp plugin, which holds about 2 GB less (qualcomm/GenieX#1557), until Qualcomm
 * ships the fixes. The build is for the version on the PC (the route's `versions`, pluginPatchOf): 0.8.0's, or 0.9.1's
 * once setup or the Smith's Use it put GenieX 0.9.1 or 0.9.3 in place. The keeper (the Smith, else Reeve) looks once for each kit version, after the NPU's refresh,
 * and again whenever the file changes (GenieX installed or updated since). The patch goes in only over the very file
 * GenieX's pinned version installs, while the files it is built against are that version's too, and only when nobody
 * uses the NPU: holding the NPU's turn, it stops the NPU's servers, keeps GenieX's own file beside it (`<file>.stock`),
 * puts the kit's in, and asks the NPU's entry its test (a picture and a chat). Only when that answers properly does the
 * patch stay; otherwise GenieX's own file goes back, quietly, and this kit doesn't try again, unless the test failed
 * for its server (npu-refresh.ts' serverFailed): then a look an hour later tests it again, NPU_REFRESH_TRIES tests in all.
 *
 * GenieX's own file goes back too when config.json's `npuPatch` is false, or a later kit no longer patches this PC. A
 * file that is neither GenieX's pinned one nor the kit's (a GenieX update) is never touched: the update stands, and the
 * old `.stock` copy goes. A newer kit's look is never taken back.
 *
 * On Intel, the kit's build of OpenVINO GenAI (kit 2.103.0), without which Qwen3-VL fails on the NPU (the patch is
 * `required`): setup downloads it and puts it in before it tests the model, and npuPatch: false leaves it in. A look
 * puts it in again where OpenVINO Model Server's own came back (setup unpacking the server again), but it never
 * downloads: until setup has, it finds nothing to do (`not-downloaded`).
 */

/** What a look did: written to `npu-patch.json` beside config.json, except `looked`, `newer-kit`, `busy` and `unreadable`. */
export type NpuPatchDid = NpuPatchRecord['did'] | 'looked' | 'newer-kit' | 'busy' | 'unreadable';

export interface NpuPatchRecord {
  kit: string;
  at: string;
  did: 'patched' | 'current' | 'restored' | 'failed' | 'stock' | 'off' | 'hands-off' | 'not-installed' | 'not-downloaded' | 'no-npu' | 'not-here';
  /** The server's file the patch is for. */
  path?: string;
  /** That file as the look left it, or null when there was none: a look whose file changed since looks again. */
  file?: { size: number; mtimeMs: number } | null;
  /** The kit's build this look put in (its SHA-256), and GenieX's own: a later kit puts GenieX's back by them. */
  patched?: string;
  stock?: string;
  /** config.json's npuPatch was false. */
  off?: boolean;
  problems?: string[];
  /** A `failed` look's: the tests this kit has made of the patch. */
  tries?: number;
  /** A `failed` look whose test failed for its server: a look from then on tests again. */
  retryAt?: string;
}

export interface NpuPatchOutcome {
  did: NpuPatchDid;
  problems?: string[];
  retryAt?: string;
}

export interface NpuPatchDeps {
  /** This kit's version. */
  kit: string;
  configFile: string;
  /** The tools home. */
  tools: string;
  env?: Record<string, string | undefined>;
  now: () => number;
  detect: () => Promise<Detection>;
  catalog?: NpuCatalog;
  /** The version of the route's server on the PC, null when it can't say (the route's own then): installedVersion. */
  serverVersion?: (route: NpuRoute) => Promise<string | null>;
  /** The kit's node part, which holds the patched files (`patched.from`): this file's folder. */
  kitDir?: string;
  hash?: (file: string) => Promise<string>;
  /** Whether nobody holds, waits for or has just used the NPU. */
  idle: () => boolean;
  /** The NPU's turn, holding every slot, so no request reaches a server whose file is being changed. */
  withTurn: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Stops whatever `program` serves `base`, and waits until it's gone. */
  stopServer: (program: string, base: string) => Promise<void>;
  /** What answers at `base` now; null when nothing takes the connection. Without it, ports aren't waited on. */
  answering?: (base: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  /** The NPU entry's test (a picture and a chat), in the turn the caller holds: the problems, none when it answered properly. */
  test: (e: AcceleratorEntry) => Promise<string[]>;
  log: (line: string) => void;
}

export const npuPatchFile = (configFile: string) => path.join(path.dirname(configFile), 'npu-patch.json');

export function readNpuPatch(configFile: string): NpuPatchRecord | null {
  try {
    const r = JSON.parse(readFileSync(npuPatchFile(configFile), 'utf8').replace(/^﻿/, ''));
    return r && typeof r.kit === 'string' ? r : null;
  } catch {
    return null;
  }
}

/** Never throws: without the record, the next look only looks again. */
function rememberNpuPatch(configFile: string, r: NpuPatchRecord): void {
  try {
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(npuPatchFile(configFile), JSON.stringify(r, null, 2) + '\n');
  } catch {}
}

/** A file's size and modified time, or null when it isn't there. */
function stateOf(file: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(file);
    return { size: s.size, mtimeMs: Math.round(s.mtimeMs) };
  } catch {
    return null;
  }
}

const sameState = (a: NpuPatchRecord['file'], b: NpuPatchRecord['file']) => (a?.size ?? -1) === (b?.size ?? -1) && (a?.mtimeMs ?? -1) === (b?.mtimeMs ?? -1);

/** The server's file the patch replaces. */
export const patchTarget = (p: NpuPluginPatch, tools: string, env?: Record<string, string | undefined>) => path.join(expandRoute(p.folder, { tools, env }), p.file);

/** Where GenieX's own file is kept while the kit's is in its place. */
export const stockCopy = (target: string) => `${target}.stock`;

/** The server that loads the file: the entry's chat server (GenieX), not its embeddings' own (llama-server, over copies of GenieX's libraries). */
const chatServer = (entry: AcceleratorEntry) => servers(entry).filter((s) => s.base === entry.chat?.baseUrl);

/** A file set aside to be removed: one still loaded by a server can't be until it exits, so a later look removes it. */
const setAside = (target: string) => `${target}.old`;

function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {}
}

/**
 * The kit's build put in the target's place: copied in beside it and checked, the target moved to `.stock` (GenieX's
 * own) or set aside (an older kit's build), then the copy renamed in. Renames, not overwrites: Windows lets a loaded DLL
 * be renamed, not replaced, so a GenieX nobody stopped (a person's own) keeps running on the file it loaded.
 */
export async function putPatchIn(target: string, from: string, want: string, isStock: boolean, hash: (f: string) => Promise<string>): Promise<void> {
  const fresh = `${target}.new`;
  copyFileSync(from, fresh);
  const sum = await hash(fresh);
  if (sum !== want) {
    removeQuietly(fresh);
    throw new Error(`the kit's copy of ${path.basename(target)} is ${sum}, not the pinned ${want}`);
  }
  const keep = isStock ? stockCopy(target) : setAside(target);
  removeQuietly(keep);
  renameSync(target, keep);
  try {
    renameSync(fresh, target);
  } catch (e) {
    renameSync(keep, target);
    removeQuietly(fresh);
    throw e;
  }
  if (!isStock) removeQuietly(keep);
}

/** GenieX's own file put back from `.stock`: the kit's set aside (removed once nothing has it loaded). */
function putStockBack(target: string): void {
  const aside = setAside(target);
  removeQuietly(aside);
  renameSync(target, aside);
  try {
    renameSync(stockCopy(target), target);
  } catch (e) {
    renameSync(aside, target);
    throw e;
  }
  removeQuietly(aside);
}

/** One look (above). Never throws for a PC that can't be looked at: the outcome says why. */
export async function patchNpu(d: NpuPatchDeps): Promise<NpuPatchOutcome> {
  const hash = d.hash ?? sha256File;
  const had = readNpuPatch(d.configFile);
  const file = readConfigFile(d.configFile);
  if (file.error) return { did: 'unreadable', problems: [file.error] };
  const off = file.raw.npuPatch === false;
  const list: any[] = Array.isArray(file.raw.accelerators) ? file.raw.accelerators : [];
  const entry: AcceleratorEntry | undefined = list.find((a) => a && typeof a === 'object' && a.id === 'npu' && a.kind === 'npu');
  // This kit's test that failed for its server is made again once its time comes; anything else this kit found stands
  // while the file is as it left it, and the switch is too (and the NPU's entry, when there was none to test with).
  const again = had?.kit === d.kit && had.did === 'failed' && typeof had.retryAt === 'string';
  const due = again && d.now() >= Date.parse(had!.retryAt!);
  const entryCame = had?.did === 'no-npu' && !!entry?.chat?.startCommand?.length;
  if (had?.kit === d.kit && !!had.off === off && !due && !entryCame && (!had.path || sameState(had.file, stateOf(had.path)))) return { did: 'looked' };
  if (had?.kit && compareVersions(had.kit, d.kit) > 0) return { did: 'newer-kit' };

  const detected = await d.detect();
  const npu = detected.npu;
  const catalog = d.catalog ?? NPU_CATALOG;
  const generic = npu?.supported && npu.vendor ? catalog.routes[npu.vendor] : undefined;
  // The build is the one for the version on the PC: 0.9.1's on GenieX 0.9.1 or 0.9.3, whoever put it in place.
  const version = generic ? await (d.serverVersion ?? ((r: NpuRoute) => installedVersion(r, { tools: d.tools, env: d.env })))(generic) : null;
  const route = generic ? atVersion(pinnedRoute(generic, npu!.generation), version) : undefined;
  const patch = route ? pluginPatchOf(route, npu!.generation) : undefined;
  // Whose file it is, in what the look says: GenieX's, OpenVINO Model Server's.
  const server = route?.server ?? 'the server';
  // This PC's file: this kit's patch's, else the one an older kit's look patched (which this kit may have to put back).
  const target = patch ? patchTarget(patch, d.tools, d.env) : had?.path;
  const keepOf = (more: Partial<NpuPatchRecord>): Partial<NpuPatchRecord> => ({ ...(target ? { path: target, file: stateOf(target) } : {}), ...(off ? { off } : {}), ...more });
  const done = (did: NpuPatchRecord['did'], more: Partial<NpuPatchRecord> = {}): NpuPatchOutcome => {
    const r: NpuPatchRecord = { kit: d.kit, at: new Date(d.now()).toISOString(), did, ...keepOf(more) };
    rememberNpuPatch(d.configFile, r);
    return { did, ...(r.problems?.length ? { problems: r.problems } : {}), ...(r.retryAt ? { retryAt: r.retryAt } : {}) };
  };
  if (!target) return done(npu?.supported ? 'not-here' : 'no-npu');
  removeQuietly(setAside(target));
  if (!existsSync(target)) return done('not-installed');

  const now = await hash(target);
  const stockSum = patch?.stock.sha256 ?? had?.stock;
  const ownBuild = !!patch && now === patch.patched.sha256;
  const olderBuild = !ownBuild && !!had?.patched && now === had.patched;
  // GenieX's own file, or Castellan's signed copy of it (kit 2.108.0: a GenieX put together from its signed build, NpuSignedBuild).
  const isStock = !!stockSum && sameFile(route, stockSum, now);
  const backup = stockCopy(target);
  const backupGood = async () => !!stockSum && existsSync(backup) && sameFile(route, stockSum, await hash(backup));
  const sums = { ...(patch ? { patched: patch.patched.sha256 } : had?.patched ? { patched: had.patched } : {}), ...(stockSum ? { stock: stockSum } : {}) };

  // A file that is neither GenieX's pinned one nor a kit's build: GenieX updated, or someone's own. Left as it is.
  if (!ownBuild && !olderBuild && !isStock) {
    if (existsSync(backup)) removeQuietly(backup);
    return done('hands-off');
  }

  // Why this kit wouldn't have its build there: switched off, no patch for this PC, or GenieX not as the build needs.
  const why = async (): Promise<string | null> => {
    // A build the route's models need stays: without it, they fail on the NPU.
    if (off && !patch?.required) return 'config.json says npuPatch: false';
    if (!patch || !route) return "this kit doesn't patch this PC's NPU server";
    if (patch.serverVersion !== route.version) return `the patch is for ${route.server} ${patch.serverVersion}, and this PC's is ${route.version}`;
    for (const [name, want] of Object.entries(patch.needs)) {
      const f = path.join(path.dirname(target), name);
      if (!stateOf(f) || !sameFile(route, want.sha256, await hash(f))) return `${route.server}'s ${path.basename(name)} isn't ${patch.serverVersion}'s`;
    }
    return null;
  };
  const notWanted = await why();

  if (ownBuild && !notWanted) return done('current', sums);
  if (isStock && notWanted) return done(off ? 'off' : 'stock', { ...sums, ...(patch && !off ? { problems: [notWanted] } : {}) });
  // The kit's build: in the kit's node part, or one setup downloads (OpenVINO GenAI's), which isn't here until setup has run.
  const from = patch ? (patch.patched.url ? hostedPatchFile(patch, d.tools) : path.resolve(d.kitDir ?? path.dirname(fileURLToPath(import.meta.url)), patch.patched.from!)) : '';
  if (isStock && patch?.patched.url && !existsSync(from)) return done('not-downloaded', sums);

  if (!entry?.chat?.startCommand?.length || !route || !runsRoute(entry, route, d.tools)) {
    // Nothing of the manor's runs on it to test with: put GenieX's own back if a build is there, else leave it.
    if (!isStock && (await backupGood())) {
      putStockBack(target);
      d.log(`${path.basename(target)}: ${server}'s own is back (${notWanted ?? "the NPU's entry doesn't run " + server})`);
      return done('restored', sums);
    }
    return done('no-npu', sums);
  }
  if (!d.idle()) return { did: 'busy' };

  // A build there that isn't wanted: GenieX's own goes back, in the NPU's turn, its servers stopped first.
  if (notWanted) {
    if (!(await backupGood())) {
      d.log(`${path.basename(target)} is a build this kit doesn't want (${notWanted}), but ${server}'s own copy (${path.basename(backup)}) isn't there as it was, so it stays`);
      return done('hands-off', { ...sums, problems: [`no good ${path.basename(backup)}`] });
    }
    try {
      await d.withTurn(async () => {
        for (const s of chatServer(entry)) await d.stopServer(s.program, s.base);
        putStockBack(target);
      });
    } catch (e) {
      if (e instanceof QueueFull || e instanceof LockTimeout) return { did: 'busy' };
      throw e;
    }
    d.log(`${path.basename(target)}: ${server}'s own is back (${notWanted})`);
    return done(off ? 'off' : 'restored', sums);
  }

  // The kit's build in, in the NPU's turn, and tested; GenieX's own back if it doesn't answer.
  if (!existsSync(from)) return done('failed', { ...sums, problems: [patch!.patched.from ? `the kit has no ${patch!.patched.from}` : `the kit's ${path.basename(from)} isn't downloaded`] });
  if (olderBuild && !(await backupGood())) return done('hands-off', { ...sums, problems: [`an older kit's build is there without ${server}'s own copy (${path.basename(backup)})`] });
  let problems: string[];
  try {
    problems = await d.withTurn(async () => {
      for (const s of chatServer(entry)) await d.stopServer(s.program, s.base);
      const stayed = await stillAnswering(d, chatServer(entry).map((s) => s.base));
      if (stayed.length) return stayed;
      try {
        await putPatchIn(target, from, patch!.patched.sha256, isStock, hash);
      } catch (e: any) {
        return [`${path.basename(target)} couldn't be put in: ${e?.message ?? e}`];
      }
      const p = await d.test(entry);
      if (p.length) {
        for (const s of chatServer(entry)) await d.stopServer(s.program, s.base);
        try {
          putStockBack(target);
        } catch (e: any) {
          p.push(`${server}'s own ${path.basename(target)} couldn't be put back: ${e?.message ?? e}`);
        }
      }
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
    d.log(`${server} keeps its own ${path.basename(target)}: Castellan's build (kit ${d.kit}) didn't answer its test: ${problems.join('; ')}${then}`);
    return done('failed', { ...sums, problems, tries, ...(retryAt ? { retryAt } : {}) });
  }
  d.log(`${path.basename(target)} is now Castellan's build (kit ${d.kit}), ${server}'s own kept as ${path.basename(backup)}: ${patch!.what.split(':')[0]}`);
  return done('patched', sums);
}
