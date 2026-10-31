import { existsSync, readFileSync, type renameSync } from 'node:fs';
import path from 'node:path';
import { acceleratorConfigFile, type AcceleratorKind, configuredAccelerators, ENDPOINT_KINDS, type EndpointKind, readConfigFile, serves, toolsHome } from './accelerator-config.ts';
import { expandEnv } from './accelerators.ts';
import { manorStopped } from './manor.ts';
import { NPU_CATALOG, serverExe } from './npu-vendors.ts';
import { writeJson } from './store.ts';

/**
 * A model server whose program is gone from where config.json starts it, set up again by the keeper (kit 2.113.5).
 *
 * On 2026-10-24 the X2's GenieX was found only in the Claude desktop app's own AppData: setup had run from a session in
 * that app, which is packaged, so Windows kept what it wrote to AppData to the app alone (outside.ts). The staff, started
 * by Task Scheduler, couldn't see geniex.exe, and every request to the NPU failed with ENOENT. Setup now runs outside
 * such an app; this puts right a PC that was set up before it did, or whose server's files were removed since.
 *
 * Only a program setup puts there is set up again: one in the tools home, or in the folder an NPU route installs its
 * server in (GenieX's, in %LOCALAPPDATA%). A startCommand of the person's own (a script, a program elsewhere) is theirs,
 * and never run or replaced. A program is set up again once it has been missing for REPAIR_AFTER_MS across the keeper's
 * looks (a setup or an update replacing it meanwhile isn't taken for a loss), one server at a time, and at most every
 * REPAIR_AGAIN_MS when setting it up doesn't bring it back. Setup runs as `local-ai` would, with --yes: what was set up
 * once is set up again, its downloads included, and outside a packaged app where the keeper runs in one.
 */

/** How long a server's program must be missing, across looks, before it's set up again. */
export const REPAIR_AFTER_MS = 5 * 60_000;
/** How long after setting a server up again it's tried again, while its program is still missing. */
export const REPAIR_AGAIN_MS = 6 * 3600_000;

/** Where the repairs are remembered: beside config.json. */
export const repairFile = (configFile = acceleratorConfigFile()) => path.join(path.dirname(configFile), 'server-repair.json');

/** A configured server whose program isn't there. */
export interface MissingServer {
  /** The accelerator's id, as setup takes it (`npu`, `cpu`, `gpu-…`). */
  id: string;
  kind: AcceleratorKind;
  /** The program its startCommand starts, %NAME% expanded. */
  program: string;
  /** What it serves, for setup to set up again. */
  kinds: EndpointKind[];
}

/** Whether `p` is inside `folder`, by its spelling alone (a missing file has no real path), as Windows compares. */
function inside(p: string, folder: string): boolean {
  const rel = path.win32.relative(folder, p);
  return !!rel && !rel.startsWith('..') && !path.win32.isAbsolute(rel);
}

/**
 * The folders setup puts servers' programs in: the tools home, and each NPU route's install folder (GenieX's is
 * %LOCALAPPDATA%\GenieX CLI; Intel's and AMD's are in the tools home already).
 */
export function setupFolders(tools: string, env: Record<string, string | undefined> = process.env): string[] {
  const routes = Object.values(NPU_CATALOG.routes).map((r) => path.win32.dirname(serverExe(r, tools, env)));
  return [tools, ...routes].filter((f, i, all) => all.findIndex((g) => g.toLowerCase() === f.toLowerCase()) === i && !all.some((g) => inside(f, g)));
}

/** The enabled servers in config.json whose program, one setup puts there (setupFolders), isn't there. One per accelerator. */
export function missingServers(raw: Record<string, any>, o: { tools?: string; env?: Record<string, string | undefined>; exists?: (p: string) => boolean } = {}): MissingServer[] {
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const folders = setupFolders(o.tools ?? toolsHome(), env);
  const out: MissingServer[] = [];
  for (const a of configuredAccelerators(raw)) {
    if (a.enabled === false) continue;
    for (const k of ENDPOINT_KINDS) {
      const cmd = a[k]?.startCommand?.[0];
      if (!cmd) continue;
      const program = expandEnv(cmd, env);
      if (!path.win32.isAbsolute(program) || !folders.some((f) => inside(program, f)) || exists(program)) continue;
      out.push({ id: a.id, kind: a.kind, program, kinds: ENDPOINT_KINDS.filter((x) => serves(a, x)) });
      break;
    }
  }
  return out;
}

/** What server-repair.json keeps of each server: since when its program was missing, and when it was last set up again. */
interface RepairRecord {
  program: string;
  missingSince: string;
  triedAt?: string;
  /** setup's exit code that time. */
  code?: number;
}

function readRecords(file: string): Record<string, RepairRecord> {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  } catch {
    return {};
  }
}

/**
 * Through store.ts' writeJson (kit 2.146.5): a rename Windows refuses for a moment (an antivirus, the indexer holding
 * the file) is tried again for up to half a second, where a bare rename failed the look with EPERM.
 */
function writeRecords(file: string, records: Record<string, RepairRecord>, d: Pick<RepairDeps, 'rename' | 'sleep'>): void {
  writeJson(file, records, { rename: d.rename, sleep: d.sleep });
}

/** The PC, as a repair sees it: swapped in tests. */
export interface RepairDeps {
  /** config.json now. */
  raw?: () => Record<string, any>;
  configFile?: string;
  /** server-repair.json (repairFile beside config.json). */
  file?: string;
  tools?: string;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  now?: () => number;
  /** Manor's stop (manor.ts' manorStopped): nothing is set up while the manor is stopped. */
  stopped?: () => unknown;
  /** setup.ts' setupCommand, as local-ai runs it. */
  setup: (o: { ids: string[]; kinds?: EndpointKind[]; yes: true; configFile?: string }) => Promise<{ code: number }>;
  log: (line: string) => void;
  /** server-repair.json's rename, and the wait between its tries (writeJson's): for tests. */
  rename?: typeof renameSync;
  sleep?: (ms: number) => void;
}

/** What one look did: set a server up again (its setup's code), or why it didn't. */
export type RepairOutcome = { did: 'none' } | { did: 'waiting'; ids: string[] } | { did: 'stopped' } | { did: 'set-up'; id: string; code: number };

/**
 * One look: each missing program noted, and the first that has been missing long enough (and wasn't set up again
 * lately) set up again, its setup's lines in the log. A program that's back is forgotten.
 */
export async function repairMissing(d: RepairDeps): Promise<RepairOutcome> {
  const now = (d.now ?? Date.now)();
  const configFile = d.configFile ?? acceleratorConfigFile();
  const file = d.file ?? repairFile(configFile);
  const missing = missingServers((d.raw ?? (() => readConfigFile(configFile).raw))(), { tools: d.tools, env: d.env, exists: d.exists });
  const before = readRecords(file);
  const records: Record<string, RepairRecord> = {};
  for (const m of missing) {
    const had = before[m.id];
    records[m.id] = had && had.program.toLowerCase() === m.program.toLowerCase() ? had : { program: m.program, missingSince: new Date(now).toISOString() };
    if (!had || records[m.id] !== had) d.log(`${m.id}'s server program isn't installed where the staff look for it (${m.program}): it's set up again if it's still missing in ${Math.round(REPAIR_AFTER_MS / 60_000)} minutes`);
  }
  for (const id of Object.keys(before)) if (!records[id]) d.log(`${id}'s server program is back (${before[id].program})`);
  const changed = JSON.stringify(records) !== JSON.stringify(before);
  if (changed) writeRecords(file, records, d);
  if (!missing.length) return { did: 'none' };
  const due = missing.find((m) => {
    const r = records[m.id];
    return now - Date.parse(r.missingSince) >= REPAIR_AFTER_MS && (!r.triedAt || now - Date.parse(r.triedAt) >= REPAIR_AGAIN_MS);
  });
  if (!due) return { did: 'waiting', ids: missing.map((m) => m.id) };
  if ((d.stopped ?? manorStopped)()) return { did: 'stopped' };
  // Remembered before it starts: another keeper's look meanwhile (the Smith's, Reeve's) leaves it to this one.
  records[due.id] = { ...records[due.id], triedAt: new Date(now).toISOString() };
  writeRecords(file, records, d);
  d.log(`setting up ${due.id} again: its server program isn't installed where the staff look for it (${due.program})`);
  let code = 1;
  try {
    code = (await d.setup({ ids: [due.id], ...(due.kind === 'npu' ? {} : { kinds: due.kinds }), yes: true, ...(d.configFile ? { configFile: d.configFile } : {}) })).code;
  } catch (e: any) {
    d.log(`setting up ${due.id} again stopped: ${String(e?.message ?? e).split(/\r?\n/)[0]}`);
  }
  const after = readRecords(file);
  if (after[due.id]) writeRecords(file, { ...after, [due.id]: { ...after[due.id], code } }, d);
  d.log(code === 0 ? `${due.id} is set up again` : `${due.id} couldn't be set up again (setup's code ${code}): tried again in ${Math.round(REPAIR_AGAIN_MS / 3600_000)} hours`);
  return { did: 'set-up', id: due.id, code };
}
