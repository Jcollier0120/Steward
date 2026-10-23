import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Block, blockedIn, type SacState, smartAppControlOutsideTests } from './app-control.ts';
import { castellanPath, elevatedCommand, POWERSHELL, run, type Runner } from './guard.ts';
import { acceleratorsDir } from './lock.ts';
import type { NpuSignedCatalog } from './npu-vendors.ts';
import { signedHelper } from './prebuilt.ts';
import { psQuote } from './ps.ts';
import { peFilesIn } from './signatures.ts';

/**
 * Castellan's catalogs (kit 2.108.0): a server whose maker signs none of its program files is blocked by Smart App
 * Control, and some can't be signed by anyone else either: FastFlowLM's NPU build may be passed on only unmodified, so
 * no signed copy of it can be hosted. A catalog lists files' hashes and is itself signed; once Windows holds it in its
 * catalog database, each file it lists counts as signed by its signer (Castellan), wherever the file is, as its maker
 * built it. So the kit carries a signed catalog for each server version that needs one (kit\node\catalogs\, pinned by
 * the route: npu-vendors.json's `catalogs`), and setup installs it before anything of the server runs, where Smart App
 * Control is on or Windows is weighing turning it on: never where it's off, which it then stays. Installing and
 * removing one takes an administrator: setup asks Windows once for every change (catalog.cs, signed, elevated), and
 * removes the route's older catalogs in the same prompt. The staff go on downloading the server from its maker.
 *
 *   node <agent>\src\kit\catalogs.ts                          the catalogs of Castellan's Windows holds, and the kit's
 *   node <agent>\src\kit\catalogs.ts remove [<name.cat>...]   removes them (all of Castellan's, unless named): one prompt
 *   node <agent>\src\kit\catalogs.ts test <file.cat> <folder> [--helper <catalog.exe>]
 *       whether a catalog lets Windows load what Smart App Control blocks: the folder's program files it blocks now,
 *       loaded again with the catalog installed, then the catalog removed (one prompt). Exit 0 when it did.
 */

/** Windows' database of the system's components and drivers (DRIVER_ACTION_VERIFY): the catalogs code integrity reads. */
export const CATALOG_DB = '{F750E6C3-38EE-11D1-85E5-00C04FC295EE}';

/** That database's catalogs, as files anyone may read. */
export const catroot = (env: Record<string, string | undefined> = process.env) => path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'CatRoot', CATALOG_DB);

/** Where the kit keeps its signed catalogs: beside this file. */
export const CATALOGS_DIR = fileURLToPath(new URL('./catalogs/', import.meta.url));

/** Castellan's catalogs, by name: castellan-<route>-<server>-<version>.cat, so the kit knows its own from Windows' and others'. */
export const OURS = /^castellan-[a-z0-9][a-z0-9.-]*\.cat$/i;

/** The route a catalog of Castellan's is for (castellan-amd-… is AMD's), lower case; null for anyone else's. */
export const routeOf = (name: string): string | null => (OURS.test(name) ? (/^castellan-([a-z0-9]+)-/i.exec(name)?.[1]?.toLowerCase() ?? null) : null);

/** The catalogs of Castellan's Windows holds, sorted; none when the database can't be read. Never throws. */
export function installedCatalogs(dir = catroot(), list: (d: string) => string[] = (d) => readdirSync(d)): string[] {
  try {
    return list(dir)
      .filter((n) => OURS.test(n))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** What one prompt changes: the kit's catalogs to install (their files), the installed ones to remove (their names), and why any wanted can't be. */
export interface CatalogChange {
  add: { name: string; file: string }[];
  remove: string[];
  problems: string[];
}

/**
 * The change that leaves Windows holding the route's `wanted` catalogs: each it lacks, from the kit's folder, but only
 * the very file that was signed (its pinned size and SHA-256); the route's other catalogs of Castellan's (an older
 * version's) removed. Another route's, and everyone else's, are left alone.
 */
export function catalogChange(wanted: NpuSignedCatalog[], route: string, o: { installed: string[]; from?: string; read?: (file: string) => Buffer | null }): CatalogChange {
  const from = o.from ?? CATALOGS_DIR;
  const read =
    o.read ??
    ((f: string) => {
      try {
        return readFileSync(f);
      } catch {
        return null;
      }
    });
  const have = new Set(o.installed.map((n) => n.toLowerCase()));
  const want = new Set(wanted.map((c) => c.file.toLowerCase()));
  const change: CatalogChange = { add: [], remove: [], problems: [] };
  for (const c of wanted) {
    if (have.has(c.file.toLowerCase())) continue;
    const file = path.join(from, c.file);
    const body = read(file);
    if (!body) change.problems.push(`the kit has no ${c.file}`);
    else if (body.length !== c.size || createHash('sha256').update(body).digest('hex') !== c.sha256) change.problems.push(`${c.file} isn't the catalog that was signed`);
    else change.add.push({ name: c.file, file });
  }
  change.remove = o.installed.filter((n) => routeOf(n) === route.toLowerCase() && !want.has(n.toLowerCase()));
  return change;
}

/** The catalog helper's steps for a change: each install, then each removal. */
export const changeSteps = (c: CatalogChange): string[] => [...c.add.flatMap((a) => ['add', a.file]), ...c.remove.flatMap((n) => ['remove', n])];

/** The signed catalog helper (catalog.cs, prebuilt.ts), copied into the shared kit folder; null when the kit has none for its source. */
export function catalogHelper(): string | null {
  try {
    return signedHelper('catalog', readFileSync(new URL('./catalog.cs', import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}

/** What the helper's lines said: each catalog installed, removed (or gone already), each load and block, and each failure. */
export interface HelperSaid {
  added: string[];
  removed: string[];
  loaded: string[];
  blocked: { file: string; error: number }[];
  failed: string[];
}

export function parseHelper(lines: string[]): HelperSaid {
  const said: HelperSaid = { added: [], removed: [], loaded: [], blocked: [], failed: [] };
  for (const l of lines.map((x) => x.trim()).filter(Boolean)) {
    let m: RegExpExecArray | null;
    if ((m = /^added (.+)$/.exec(l))) said.added.push(m[1]);
    else if ((m = /^(?:removed|not there) (.+)$/.exec(l))) said.removed.push(m[1]);
    else if ((m = /^loaded (.+)$/.exec(l))) said.loaded.push(m[1]);
    else if ((m = /^blocked (.+) (\d+)$/.exec(l))) said.blocked.push({ file: m[1], error: Number(m[2]) });
    else if (/^failed /.test(l)) said.failed.push(l.replace(/^failed /, ''));
  }
  return said;
}

/**
 * Windows PowerShell's arguments that run the helper with `steps`, its lines to `log`, and exit with its exit code:
 * what elevatedCommand asks Windows to run elevated. Every path is single-quoted (psQuote): none is ever a command.
 */
export function helperCommand(helper: string, steps: string[], log: string): string {
  const call = `& ${[helper, '--log', log, ...steps].map(psQuote).join(' ')}; exit $LASTEXITCODE`;
  return `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${call}"`;
}

/** Everything the helper's elevated run reaches outside itself, so a test can stand in for each. */
export interface ElevatedHelperOptions {
  /** The helper (catalogHelper() when left out; null: there's none). */
  helper?: string | null;
  /** Where its lines go (made afresh), read once it ends. */
  log: string;
  runner?: Runner;
  /** Manor's Castellan.exe, so the prompt names Castellan (castellanPath() when left out; null: Windows PowerShell's). */
  castellan?: string | null;
  /** How long the prompt may wait for the person: 15 minutes. */
  timeoutMs?: number;
  read?: (file: string) => string | null;
}

/**
 * The helper's steps run elevated, through one administrator prompt: its exit code (1223: the prompt was turned down or
 * couldn't open; -2: there's no signed helper) and what its lines said.
 */
export async function runHelperElevated(steps: string[], o: ElevatedHelperOptions): Promise<{ code: number; said: HelperSaid; lines: string[] }> {
  const helper = o.helper !== undefined ? o.helper : catalogHelper();
  if (!helper) return { code: -2, said: parseHelper([]), lines: [] };
  const read =
    o.read ??
    ((f: string) => {
      try {
        return readFileSync(f, 'utf8');
      } catch {
        return null;
      }
    });
  rmSync(o.log, { force: true });
  const outer = elevatedCommand(helperCommand(helper, steps, o.log), o.castellan === undefined ? castellanPath() : o.castellan);
  const r = await (o.runner ?? run)(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', outer], { timeoutMs: o.timeoutMs ?? 15 * 60_000 });
  const lines = (read(o.log) ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  return { code: r.code, said: parseHelper(lines), lines };
}

/** How setup's catalogs ended: Smart App Control off (nothing asked), all there already, changed, or why not. */
export interface CatalogsDone {
  done: 'off' | 'there' | 'changed' | 'declined' | 'failed' | 'no-helper' | 'not-in-kit';
  added: string[];
  removed: string[];
  problems: string[];
}

export interface EnsureCatalogsOptions extends Omit<ElevatedHelperOptions, 'log'> {
  /** The route they're for (npu-vendors.json's key: amd), whose older catalogs go. */
  route: string;
  sac: SacState | null;
  log: (line: string) => void;
  /** Where the helper's lines go (the accelerators' folder's catalogs.log). */
  logFile?: string;
  /** The catalogs of Castellan's Windows holds (installedCatalogs()). */
  installed?: string[];
  from?: string;
  readCatalog?: (file: string) => Buffer | null;
}

/**
 * Leaves Windows holding the route's `wanted` catalogs where Smart App Control is on or Windows is weighing it, through
 * one administrator prompt when anything changes: the missing ones installed, the route's older ones removed. Nothing
 * where it's off or unknown, or when every one is there. Never throws: a server it couldn't cover is blocked as before,
 * and setup says so.
 */
export async function ensureCatalogs(wanted: NpuSignedCatalog[], o: EnsureCatalogsOptions): Promise<CatalogsDone> {
  const none: CatalogsDone = { done: 'off', added: [], removed: [], problems: [] };
  if (o.sac !== 'on' && o.sac !== 'evaluation') return none;
  try {
    const change = catalogChange(wanted, o.route, { installed: o.installed ?? installedCatalogs(), from: o.from, read: o.readCatalog });
    if (!change.add.length && !change.remove.length) return { ...none, done: change.problems.length ? 'not-in-kit' : 'there', problems: change.problems };
    const covers = wanted.filter((c) => change.add.some((a) => a.name === c.file)).map((c) => c.covers);
    o.log(
      covers.length
        ? `Windows asks once for an administrator, to add Castellan's signed list of ${covers.join(' and ')} to its catalogs, so Smart App Control lets them run`
        : `Windows asks once for an administrator, to remove Castellan's older catalogs (${change.remove.join(', ')})`,
    );
    const r = await runHelperElevated(changeSteps(change), { ...o, log: o.logFile ?? path.join(acceleratorsDir, 'catalogs.log') });
    const out: CatalogsDone = { done: 'changed', added: r.said.added, removed: r.said.removed, problems: [...change.problems] };
    if (r.code === -2) return { ...out, done: 'no-helper', problems: [...out.problems, 'the kit has no signed catalog helper'] };
    if (r.code === 1223) return { ...out, done: 'declined', problems: [...out.problems, "the administrator prompt was turned down or couldn't open"] };
    if (r.code !== 0) return { ...out, done: 'failed', problems: [...out.problems, ...(r.said.failed.length ? r.said.failed.map((f) => `couldn't ${f}`) : [`the catalog helper ended with ${r.code}`])] };
    return out;
  } catch (e) {
    return { ...none, done: 'failed', problems: [String((e as Error)?.message ?? e)] };
  }
}

/** Setup's line for how its catalogs ended; null when there's nothing to say (off, or all there). */
export function catalogsSay(d: CatalogsDone): string | null {
  if (d.done === 'off' || (d.done === 'there' && !d.problems.length)) return null;
  if (d.done === 'changed') return `Castellan's catalogs: ${[d.added.length ? `added ${d.added.join(', ')}` : '', d.removed.length ? `removed ${d.removed.join(', ')}` : ''].filter(Boolean).join('; ') || 'nothing changed'}${d.problems.length ? ` (${d.problems.join('; ')})` : ''}`;
  return `Castellan's catalogs weren't added: ${d.problems.join('; ')}. Smart App Control may block the server's files`;
}

// ---------------------------------------------------------------- the test

/** What the catalog test found: the files Smart App Control blocked without it, which loaded with it, and whether it went again. */
export interface CatalogTest {
  ok: boolean;
  blockedBefore: string[];
  loadedWith: string[];
  blockedWith: string[];
  /** The Code Integrity log's blocks of the folder's files before the catalog (3033 and 3077). */
  logged: Block[];
  installed: boolean;
  removed: boolean;
  lines: string[];
  why: string | null;
}

export interface CatalogTestOptions {
  helper?: string | null;
  runner?: Runner;
  castellan?: string | null;
  logFile?: string;
  list?: (dir: string) => string[];
  read?: (file: string) => string | null;
  blocks?: (folder: string, withinMs: number) => Promise<Block[]>;
  now?: () => number;
  /** How long a file may take to load once the catalog is in: Windows reads a new catalog within moments. */
  loadSeconds?: number;
}

/**
 * Whether `catalog` lets Windows load files Smart App Control blocks: each program file in `folder` loaded as it is (the
 * helper, unelevated); the blocked ones (with their Code Integrity events) loaded again after the catalog is installed,
 * waiting up to `loadSeconds` for each; then the catalog removed, all in one prompt. It passes when at least one was
 * blocked, every one of those loaded with it, and it was removed again.
 */
export async function catalogTest(catalog: string, folder: string, o: CatalogTestOptions = {}): Promise<CatalogTest> {
  const helper = o.helper !== undefined ? o.helper : catalogHelper();
  const t: CatalogTest = { ok: false, blockedBefore: [], loadedWith: [], blockedWith: [], logged: [], installed: false, removed: false, lines: [], why: null };
  if (!helper) return { ...t, why: 'the kit has no signed catalog helper (give one with --helper)' };
  const runner = o.runner ?? run;
  const now = o.now ?? Date.now;
  const files = peFilesIn(folder, o.list);
  if (!files.length) return { ...t, why: `${folder} has no program files` };
  const began = now();
  const first = await runner(helper, files.flatMap((f) => ['load', f]), { timeoutMs: 5 * 60_000 });
  const before = parseHelper(first.out.split(/\r?\n/));
  t.lines.push(...first.out.split(/\r?\n/).filter((l) => l.trim()));
  t.blockedBefore = before.blocked.map((b) => b.file);
  t.logged = await (o.blocks ?? blockedIn)(folder, now() - began + 60_000);
  if (!t.blockedBefore.length) return { ...t, why: `Smart App Control blocked none of ${folder}'s ${files.length} program files here, so the test can't tell` };
  const name = path.basename(catalog);
  const steps = ['add', catalog, ...t.blockedBefore.flatMap((f) => ['load', f, String(o.loadSeconds ?? 30)]), 'remove', name];
  const r = await runHelperElevated(steps, { helper, runner, castellan: o.castellan, log: o.logFile ?? path.join(acceleratorsDir, 'catalog-test.log'), read: o.read });
  t.lines.push(...r.lines);
  t.installed = r.said.added.includes(name);
  t.removed = r.said.removed.includes(name);
  t.loadedWith = r.said.loaded;
  t.blockedWith = r.said.blocked.map((b) => b.file);
  if (r.code === -2) t.why = 'the kit has no signed catalog helper';
  else if (r.code === 1223) t.why = "the administrator prompt was turned down or couldn't open";
  else if (!t.installed) t.why = `the catalog wasn't installed (${r.said.failed.join('; ') || `exit ${r.code}`})`;
  else if (t.blockedWith.length) t.why = `with the catalog installed, Windows still blocked ${t.blockedWith.join(', ')}`;
  else if (t.loadedWith.length !== t.blockedBefore.length) t.why = 'not every blocked file was loaded again';
  else if (!t.removed) t.why = `the catalog was left installed (${r.said.failed.join('; ') || `exit ${r.code}`}): remove it with catalogs.ts remove ${name}`;
  t.ok = !t.why;
  return t;
}

export function catalogTestSay(t: CatalogTest, catalog: string): string[] {
  const out = [`Catalog test of ${path.basename(catalog)}: ${t.ok ? 'PASSED' : 'FAILED'}${t.why ? `: ${t.why}` : ''}`];
  out.push(`  without it: ${t.blockedBefore.length} blocked${t.blockedBefore.length ? ` (${t.blockedBefore.map((f) => path.basename(f)).join(', ')})` : ''}`);
  const ev = t.logged.filter((b) => t.blockedBefore.some((f) => path.basename(f).toLowerCase() === path.win32.basename(b.file).toLowerCase()));
  out.push(`  the Code Integrity log: ${ev.length ? `${ev.length} of them blocked${ev.some((b) => b.policy) ? ` by ${[...new Set(ev.map((b) => b.policy).filter(Boolean))].join(', ')}` : ''}` : 'none of them logged'}`);
  if (t.installed) out.push(`  with it: ${t.loadedWith.length} loaded, ${t.blockedWith.length} still blocked`);
  out.push(`  removed again: ${t.removed ? 'yes' : 'no'}`);
  for (const l of t.lines) out.push(`    ${l}`);
  return out;
}

// ---------------------------------------------------------------- the command

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [verb, ...rest] = process.argv.slice(2);
  const usage = 'Usage: node catalogs.ts [remove [<name.cat>...] | test <file.cat> <folder> [--helper <catalog.exe>]]';
  const main = async (): Promise<number> => {
    if (!verb) {
      const there = installedCatalogs();
      console.log(`Smart App Control: ${smartAppControlOutsideTests() ?? 'unknown'}`);
      console.log(`Castellan's catalogs Windows holds: ${there.length ? there.join(', ') : 'none'}`);
      let carried: string[] = [];
      try {
        carried = readdirSync(CATALOGS_DIR).filter((n) => OURS.test(n));
      } catch {}
      console.log(`The kit's: ${carried.length ? carried.join(', ') : 'none'}`);
      console.log(`The signed catalog helper: ${catalogHelper() ?? 'none in this kit'}`);
      return 0;
    }
    if (verb === 'remove') {
      const names = rest.length ? rest.map((n) => path.basename(n)) : installedCatalogs();
      const bad = names.filter((n) => !OURS.test(n));
      if (bad.length) {
        console.error(`Not one of Castellan's catalogs: ${bad.join(', ')}`);
        return 2;
      }
      if (!names.length) {
        console.log("Windows holds none of Castellan's catalogs.");
        return 0;
      }
      console.log(`Windows asks once for an administrator, to remove ${names.join(', ')}`);
      const r = await runHelperElevated(
        names.flatMap((n) => ['remove', n]),
        { log: path.join(acceleratorsDir, 'catalogs.log') },
      );
      for (const l of r.lines) console.log(`  ${l}`);
      if (r.code === -2) console.error('The kit has no signed catalog helper.');
      if (r.code === 1223) console.error("The administrator prompt was turned down or couldn't open, so nothing changed.");
      return r.code === 0 ? 0 : 1;
    }
    if (verb === 'test') {
      const h = rest.indexOf('--helper');
      const helper = h >= 0 ? rest[h + 1] : undefined;
      const [catalog, folder] = rest.filter((_, i) => h < 0 || (i !== h && i !== h + 1));
      if (!catalog || !folder || (h >= 0 && !helper)) {
        console.error(usage);
        return 2;
      }
      const t = await catalogTest(path.resolve(catalog), path.resolve(folder), helper ? { helper: path.resolve(helper) } : {});
      for (const l of catalogTestSay(t, catalog)) console.log(l);
      return t.ok ? 0 : 1;
    }
    console.error(usage);
    return 2;
  };
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e?.message ?? e));
      process.exit(1);
    },
  );
}
