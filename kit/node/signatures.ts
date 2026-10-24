import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDPOINT_KINDS, readConfigFile } from './accelerator-config.ts';
import { acceleratorConfigFile, expandEnv } from './accelerators.ts';
import { type SacState, smartAppControlOutsideTests } from './app-control.ts';
import { acceleratorsDir } from './lock.ts';

/**
 * Who signed the programs the staff's local models run (kit 2.108.0): every .exe, .dll, .pyd and .node in the folder of
 * each model server the accelerators start, with the signature Windows finds on it (its maker's, Castellan's, one a
 * catalog Windows holds vouches for, or none) and its signer. Windows' Smart App Control blocks an unsigned one it
 * doesn't know, so this is what a round of signing works from: npu-check shows it, setup keeps it (signatures.json,
 * beside blocked.json), and `node <kit>\signatures.ts` prints this PC's. A developer's and a diagnostic view, never a
 * notice for the staff: nothing here is an alarm.
 *
 *   node <agent>\src\kit\signatures.ts [--all] [--json]   this PC's servers' program files: the unsigned ones, or --all
 */

/** The files Windows runs as programs or loads as code: what Smart App Control judges. */
export const PE_FILE = /\.(exe|dll|pyd|node)$/i;

/** The most files one server's folder is read for: a server never has near this many, a folder it shouldn't read has more. */
export const MAX_FILES = 5000;

/** One program file and its signature, as Get-AuthenticodeSignature finds it. */
export interface PeSignature {
  file: string;
  size: number;
  /** Valid, NotSigned, HashMismatch, NotTrusted, UnknownError… */
  status: string;
  /** Where the signature is: in the file (Authenticode), in a catalog Windows holds (Catalog), or None. */
  type: string;
  /** The signer's name (its certificate's CN), or null when it has none. */
  signer: string | null;
  /** The file's own version (its version resource), or null when it has none. */
  version: string | null;
}

/** One model server's folder: the accelerators' endpoints that start it, its program, and every program file there. */
export interface ServerFiles {
  /** The endpoints whose startCommand runs it: `npu chat`, `npu embed`, `gpu-… embed`. */
  who: string[];
  program: string;
  folder: string;
  files: PeSignature[];
  /** Why its files couldn't be read, when they couldn't. */
  problem?: string;
}

/** What signatures.json keeps: when, Smart App Control's state then, and each server's files. */
export interface SignatureInventory {
  at: string;
  smartAppControl: SacState | null;
  servers: ServerFiles[];
}

/** A file whose signature Windows doesn't accept: it has none, or one that doesn't check out. */
export const unsigned = (s: PeSignature) => s.status !== 'Valid';

/** A certificate's subject's name: its CN, else the whole subject. */
export function signerName(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const m = /(?:^|,\s*)CN=("(?:[^"]|"")*"|[^,]+)/.exec(subject);
  return m ? m[1].replace(/^"|"$/g, '').replace(/""/g, '"').trim() : subject.trim();
}

/** The programs config.json's endpoints start, each with the endpoints that start it, the %VARIABLES% expanded. */
export function serverPrograms(raw: Record<string, any>, env: Record<string, string | undefined> = process.env): { who: string[]; program: string }[] {
  const byProgram = new Map<string, { who: string[]; program: string }>();
  const list: any[] = Array.isArray(raw?.accelerators) ? raw.accelerators : [];
  for (const a of list) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string') continue;
    for (const kind of ENDPOINT_KINDS) {
      const words = a[kind]?.startCommand ?? (kind === 'embed' ? a.embed?.start : undefined);
      if (!Array.isArray(words) || typeof words[0] !== 'string' || !words[0]) continue;
      const program = path.win32.resolve(expandEnv(words[0], env));
      const key = program.toLowerCase();
      const had = byProgram.get(key) ?? { who: [], program };
      had.who.push(`${a.id} ${kind}`);
      byProgram.set(key, had);
    }
  }
  return [...byProgram.values()];
}

/**
 * A folder too wide to read for one server's files: a drive's root, Windows' own, Program Files, a profile or AppData as
 * a whole. A server installed there (none of the kit's is) is read for its program alone.
 */
export function tooWide(folder: string, env: Record<string, string | undefined> = process.env): boolean {
  const f = path.win32.resolve(folder).replace(/\\+$/, '').toLowerCase();
  if (/^[a-z]:$/.test(f)) return true;
  const wide = [env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.USERPROFILE, env.LOCALAPPDATA, env.APPDATA, env.ProgramData]
    .filter((p): p is string => !!p)
    .map((p) => path.win32.resolve(p).replace(/\\+$/, '').toLowerCase());
  return wide.includes(f);
}

/** The program files in a folder and its subfolders, sorted; at most MAX_FILES. None when it can't be read. */
export function peFilesIn(folder: string, list: (dir: string) => string[] = listFiles): string[] {
  try {
    return list(folder).filter((f) => PE_FILE.test(f)).sort().slice(0, MAX_FILES);
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

/** Reads files' signatures: PowerShell's Get-AuthenticodeSignature, all in one run. */
export type ReadSignatures = (files: string[]) => Promise<PeSignature[]>;

const quotedPs = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Get-AuthenticodeSignature for each file, in one Windows PowerShell; its version and size beside. Rejects when it can't run. */
export const readSignatures: ReadSignatures = async (files) => {
  if (!files.length) return [];
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-signatures-'));
  try {
    const list = path.join(dir, 'files.txt');
    writeFileSync(list, files.join('\n'), 'utf8');
    const ps = [
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      `@(Get-Content -LiteralPath ${quotedPs(list)} -Encoding UTF8 | Where-Object { $_ } | ForEach-Object {`,
      '  $s = Get-AuthenticodeSignature -LiteralPath $_ -ErrorAction SilentlyContinue',
      '  $i = Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue',
      '  [pscustomobject]@{ file = [string]$_; size = [int64]$i.Length; status = [string]$s.Status; type = [string]$s.SignatureType; signer = [string]$s.SignerCertificate.Subject; version = [string]$i.VersionInfo.FileVersion }',
      '}) | ConvertTo-Json -Compress -Depth 2',
    ].join('\n');
    const out = await new Promise<string>((resolve, reject) =>
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 }, (e, stdout, stderr) =>
        e ? reject(new Error(`couldn't read the files' signatures: ${(stderr || e.message).trim().split(/\r?\n/)[0]}`)) : resolve(stdout),
      ),
    );
    return parseSignatures(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** readSignatures' JSON (one object for one file, a list for more), as PeSignatures. */
export function parseSignatures(out: string): PeSignature[] {
  const text = out.trim();
  if (!text) return [];
  const j = JSON.parse(text);
  return (Array.isArray(j) ? j : [j]).map((r: any) => ({
    file: String(r.file ?? ''),
    size: Number(r.size) || 0,
    status: String(r.status || 'UnknownError'),
    type: String(r.type || 'None'),
    signer: signerName(r.signer || null),
    version: r.version ? String(r.version).trim() : null,
  }));
}

export interface InventoryOptions {
  env?: Record<string, string | undefined>;
  read?: ReadSignatures;
  list?: (dir: string) => string[];
  exists?: (p: string) => boolean;
  /** Smart App Control's state, for the record (smartAppControlOutsideTests when left out). */
  sac?: SacState | null;
}

/**
 * Every program file of each server `programs` names, by its folder (and the folders below it), with its signature: a
 * folder two endpoints start a program in is read once. A program whose folder is too wide (tooWide) is read alone; one
 * that isn't there gives a server with no files and the problem.
 */
export async function signatureInventory(programs: { who: string[]; program: string }[], o: InventoryOptions = {}): Promise<SignatureInventory> {
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const read = o.read ?? readSignatures;
  const byFolder = new Map<string, ServerFiles>();
  for (const p of programs) {
    const folder = path.win32.dirname(p.program);
    const key = folder.toLowerCase();
    const had = byFolder.get(key);
    if (had) {
      had.who.push(...p.who.filter((w) => !had.who.includes(w)));
      continue;
    }
    byFolder.set(key, { who: [...p.who], program: p.program, folder, files: [] });
  }
  const servers = [...byFolder.values()];
  for (const s of servers) {
    if (!exists(s.program)) {
      s.problem = `${s.program} isn't there`;
      continue;
    }
    const files = tooWide(s.folder, env) ? [s.program] : peFilesIn(s.folder, o.list);
    try {
      const sigs = await read(files.length ? files : [s.program]);
      s.files = sigs.sort((a, b) => a.file.localeCompare(b.file));
    } catch (e: any) {
      s.problem = String(e?.message ?? e);
    }
  }
  return { at: new Date().toISOString(), smartAppControl: o.sac !== undefined ? o.sac : smartAppControlOutsideTests(), servers };
}

/** signatures.json, beside blocked.json (kit 2.108.0): who signed each program file the servers setup set up run. */
export const signaturesFile = () => path.join(acceleratorsDir, 'signatures.json');

/**
 * Keeps the inventory of what config.json's servers run (setup, once it has written config.json), written whole so a
 * reader never sees half of it. Never throws: without it, the next setup keeps one.
 */
export async function rememberSignatures(raw: Record<string, any>, file: string, o: InventoryOptions = {}): Promise<SignatureInventory | null> {
  try {
    const inv = await signatureInventory(serverPrograms(raw, o.env), o);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(inv, null, 2) + '\n');
    renameSync(tmp, file);
    return inv;
  } catch {
    return null;
  }
}

/** What setup last kept, or null when it kept none (or it can't be read). */
export function readSignatureRecord(file = signaturesFile()): SignatureInventory | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(j?.servers) ? j : null;
  } catch {
    return null;
  }
}

/** This PC's inventory: the servers config.json starts. */
export async function pcInventory(o: InventoryOptions & { configFile?: string } = {}): Promise<SignatureInventory> {
  const file = readConfigFile(o.configFile ?? acceleratorConfigFile());
  return signatureInventory(file.error ? [] : serverPrograms(file.raw, o.env), o);
}

/** A file's path below its server's folder (`qairt\geniex_core.dll`), for lines a person reads. */
const below = (s: ServerFiles, f: PeSignature) => path.win32.relative(s.folder, f.file) || path.win32.basename(f.file);

/** A count of files, said. */
const files = (n: number) => `${n} program file${n === 1 ? '' : 's'}`;

/**
 * The inventory in lines: each server's folder, who starts it, and how many of its files are signed, by whom; then its
 * unsigned files one a line (every file with `all`), each with its size and version.
 */
export function inventorySay(inv: SignatureInventory, o: { all?: boolean } = {}): string[] {
  const out: string[] = [];
  const sac = inv.smartAppControl;
  out.push(`Smart App Control: ${sac ?? 'unknown'}${sac === 'on' ? ' (it blocks unsigned files it doesn\'t know)' : sac === 'evaluation' ? ' (Windows may turn it on at any time)' : ''}`);
  for (const s of inv.servers) {
    out.push(`${s.folder} (${s.who.join(', ')})`);
    if (s.problem) {
      out.push(`  ${s.problem}`);
      continue;
    }
    const bad = s.files.filter(unsigned);
    const by = new Map<string, number>();
    for (const f of s.files.filter((x) => !unsigned(x))) {
      const name = `${f.signer ?? 'someone'}${f.type === 'Catalog' ? ' (by catalog)' : ''}`;
      by.set(name, (by.get(name) ?? 0) + 1);
    }
    const signed = [...by].map(([name, n]) => `${n} ${name}`).join(', ');
    out.push(`  ${files(s.files.length)}: ${bad.length ? `${bad.length} unsigned` : 'every one signed'}${signed ? `; signed: ${signed}` : ''}`);
    for (const f of o.all ? s.files : bad)
      out.push(`  ${unsigned(f) ? f.status.padEnd(9) : 'Valid    '} ${below(s, f)}  ${f.size.toLocaleString('en-US')} bytes${f.version ? `, ${f.version}` : ''}${!unsigned(f) ? `, ${f.signer ?? '?'}${f.type === 'Catalog' ? ' (catalog)' : ''}` : ''}`);
  }
  if (!inv.servers.length) out.push('No model server is set up (config.json starts none).');
  return out;
}

/** The inventory's count: program files, and how many aren't signed. */
export function inventoryCount(inv: SignatureInventory): { files: number; unsigned: number } {
  const all = inv.servers.flatMap((s) => s.files);
  return { files: all.length, unsigned: all.filter(unsigned).length };
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !['--all', '--json'].includes(a));
  if (unknown.length) {
    console.error(`Unknown: ${unknown.join(' ')}. Usage: node signatures.ts [--all] [--json]`);
    process.exit(2);
  }
  pcInventory().then(
    (inv) => {
      if (args.includes('--json')) console.log(JSON.stringify(inv, null, 2));
      else for (const l of inventorySay(inv, { all: args.includes('--all') })) console.log(l);
      process.exit(0);
    },
    (e) => {
      console.error(String(e?.message ?? e));
      process.exit(1);
    },
  );
}

