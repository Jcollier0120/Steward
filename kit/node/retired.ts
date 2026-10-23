import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isSharedTools, readConfigFile, toolsHome } from './accelerator-config.ts';
import { expandEnv } from './accelerators.ts';
import { expandRoute, NPU_CATALOG, type NpuCatalog, type NpuRetired, type NpuRoute, runsRoute, serverExe } from './npu-vendors.ts';
import { inside } from './real-path.ts';

/**
 * The model files and folders the NPU's routes no longer run (npu-vendors.json's `retired`, kit 2.101.0), removed from
 * a PC once nothing uses them: the Snapdragon's Qwen3-VL-4B where its generations run Qwen3-VL-2B, the graphics' Q4_K_M
 * where they read GenieX's Q4_0 instead. A route's list applies on a PC that has its server installed, or whose NPU entry
 * runs it. A file or folder there counts as used while config.json or a running model server's command line names it
 * (its path, its name, or the id its server serves it by): a PC that never moved off it keeps it, and so does one a
 * person points at it again. One nothing has named for RETIRED_GRACE_MS is removed at the keeper's next look, a folder
 * first renamed aside, so a server never finds half of it; one Windows won't let go of yet (a program has it open) is
 * tried again at a later look. Never in the PC's shared folder (an Everyone install), whose files other accounts read.
 */

/** When each retired file or folder was first seen unnamed: `retired-models.json`, beside config.json. */
export interface RetiredRecord {
  unnamed: Record<string, string>;
}

export const retiredModelsFile = (configFile: string) => path.join(path.dirname(configFile), 'retired-models.json');

/**
 * How long a retired file nothing names is kept: an agent that read config.json before still starts its server with it,
 * and setup pulls a model before config.json names it (the first-generation X Elite's 4B, when its 2B fails).
 */
export const RETIRED_GRACE_MS = 3 * 24 * 60 * 60_000;

/** Where a folder goes while it is removed; one left by a removal cut short goes at the next look. */
const ASIDE = '.removing';

export function readRetiredRecord(configFile: string): RetiredRecord {
  try {
    const r = JSON.parse(readFileSync(retiredModelsFile(configFile), 'utf8').replace(/^﻿/, ''));
    const unnamed = r?.unnamed && typeof r.unnamed === 'object' ? Object.fromEntries(Object.entries(r.unnamed).filter(([, v]) => typeof v === 'string' && !Number.isNaN(Date.parse(v as string)))) : {};
    return { unnamed: unnamed as Record<string, string> };
  } catch {
    return { unnamed: {} };
  }
}

/** Every string in config.json, its %VARIABLES% expanded, in lower case: the servers' commands, their models' ids. */
function configStrings(v: unknown, env: Record<string, string | undefined>, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(expandEnv(v, env).toLowerCase());
  else if (Array.isArray(v)) for (const x of v) configStrings(x, env, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) configStrings(x, env, out);
  return out;
}

/** The routes whose retired lists apply here: their server installed, or the NPU entry running it. */
export function retiredRoutes(raw: Record<string, any>, o: { tools: string; env?: Record<string, string | undefined>; exists?: (p: string) => boolean; catalog?: NpuCatalog }): NpuRoute[] {
  const exists = o.exists ?? existsSync;
  const list: any[] = Array.isArray(raw.accelerators) ? raw.accelerators : [];
  const npu = list.find((a) => a && typeof a === 'object' && a.id === 'npu');
  return Object.values((o.catalog ?? NPU_CATALOG).routes).filter((r) => r.retired?.length && (runsRoute(npu, r, o.tools) || exists(serverExe(r, o.tools, o.env))));
}

/** A retired entry's files or folder on this PC, found now: the folder itself, or the files in it its `match` names. */
function found(r: NpuRetired, at: string): string[] {
  try {
    if (!r.match) return existsSync(at) ? [at] : [];
    const re = new RegExp(r.match, 'i');
    return readdirSync(at, { withFileTypes: true })
      .filter((d) => d.isFile() && re.test(d.name))
      .map((d) => path.join(at, d.name));
  } catch {
    return [];
  }
}

function bytesOf(p: string): number {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    return readdirSync(p).reduce((n, f) => n + bytesOf(path.join(p, f)), 0);
  } catch {
    return 0;
  }
}

/** Removes a file, or a folder by way of its aside name; throws what Windows says when it won't. */
function remove(p: string): void {
  if (!statSync(p).isDirectory()) return rmSync(p);
  const aside = p + ASIDE;
  rmSync(aside, { recursive: true, force: true });
  renameSync(p, aside);
  rmSync(aside, { recursive: true, force: true });
}

/**
 * The keeper's look at the retired model files (each look, after refreshSmallModel): those nothing has named for
 * RETIRED_GRACE_MS removed, and said so in `log`. `running` gives the model servers' command lines, asked only when one
 * is due. What it removed; nothing when config.json couldn't be read (the next look tries).
 */
export async function removeRetiredModels(o: {
  configFile: string;
  home?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  running?: () => Promise<string[]>;
  exists?: (p: string) => boolean;
  catalog?: NpuCatalog;
  log: (line: string) => void;
}): Promise<{ removed: string[] }> {
  const env = o.env ?? process.env;
  const home = o.home ?? toolsHome(env as NodeJS.ProcessEnv);
  const now = (o.now ?? Date.now)();
  const days = (ms: number) => Math.floor(ms / 86_400_000);
  const file = readConfigFile(o.configFile);
  if (file.error) return { removed: [] };
  const shared = isSharedTools(home, env as NodeJS.ProcessEnv);
  const named = configStrings(file.raw, env);
  const had = readRetiredRecord(o.configFile);
  const unnamed: Record<string, string> = {};
  const due: { path: string; r: NpuRetired; since: string; server: string }[] = [];
  const nameOf = (p: string, r: NpuRetired) => [p.toLowerCase(), path.win32.basename(p).toLowerCase(), ...(r.model ? [r.model.toLowerCase()] : [])];
  const isNamed = (p: string, r: NpuRetired, lines: string[]) => nameOf(p, r).some((n) => lines.some((l) => l.includes(n)));

  for (const route of retiredRoutes(file.raw, { tools: home, env, exists: o.exists, catalog: o.catalog })) {
    for (const r of route.retired!) {
      const at = expandRoute(r.path, { tools: home, env });
      if (shared && inside(at, home)) continue;
      // A folder a removal left half done: its name is gone already, so nothing can use it.
      if (!r.match && existsSync(at + ASIDE)) {
        try {
          rmSync(at + ASIDE, { recursive: true, force: true });
        } catch {}
      }
      for (const p of found(r, at)) {
        if (isNamed(p, r, named)) {
          if (had.unnamed[p]) o.log(`${path.win32.basename(p)} is named in config.json again: kept`);
          continue;
        }
        const since = had.unnamed[p] ?? new Date(now).toISOString();
        unnamed[p] = since;
        if (!had.unnamed[p]) o.log(`${path.win32.basename(p)} is no longer used (${route.server} retired it in kit ${r.since}): removed in ${days(RETIRED_GRACE_MS)} days unless something names it`);
        else if (now - Date.parse(since) >= RETIRED_GRACE_MS) due.push({ path: p, r, since, server: route.server });
      }
    }
  }

  const removed: string[] = [];
  const lines = due.length ? await (o.running ?? (async () => []))().then((ls) => ls.map((l) => expandEnv(l, env).toLowerCase())).catch(() => null) : null;
  // Windows' process list unread: nothing is removed this look.
  for (const d of lines ? due : []) {
    if (isNamed(d.path, d.r, lines!)) continue;
    const bytes = bytesOf(d.path);
    try {
      remove(d.path);
      removed.push(d.path);
      delete unnamed[d.path];
      o.log(`removed ${path.win32.basename(d.path)}${bytes > 0 ? ` (${(bytes / 1024 ** 3).toFixed(2)} GB)` : ''}: nothing has used it for ${days(now - Date.parse(d.since))} days (${d.server} retired it in kit ${d.r.since})`);
    } catch (e: any) {
      if (e?.code === 'ENOENT') delete unnamed[d.path];
    }
  }

  if (JSON.stringify(unnamed) !== JSON.stringify(had.unnamed)) {
    try {
      writeFileSync(retiredModelsFile(o.configFile), JSON.stringify({ unnamed }, null, 2) + '\n');
    } catch {}
  }
  return { removed };
}
