import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A release's PowerShell scripts, signed (kit 2.121.0). Smart App Control, and any Windows that enforces App Control for
 * scripts, runs a script it can't trust in Constrained Language Mode, where most of what the staff's scripts do (Add-Type,
 * .NET calls) stops; a script signed with a certificate Windows trusts runs as written. So a published release signs
 * every .ps1, .psm1 and .psd1 it ships, as it signs its native files (sign.ts): Authenticode, SHA-256, timestamped
 * (RFC 3161), with the Windows SDK's x64 signtool and the release's certificate.
 *
 * Signing appends a signature block to the script and changes nothing before it, so what ships is the script as the
 * checkout has it, then its block; a change after signing (a byte of it) breaks the signature. The release checks that
 * the zip carries each script exactly as it was signed (changedSinceSigning), and an install and the kit's copy into
 * src\kit copy files as they are.
 *
 * Most releases change none of their scripts (the kit's are the same in every agent), so each signed script is kept, by
 * its certificate and its text, in one store for every agent on this PC (scriptsStoreOf): a release whose scripts are
 * all kept takes their signed copies, checked again (Valid, this certificate's, timestamped), and needs no key. The
 * Steward reads the same keys (scriptKey) to know whether a release will sign at all. A kept copy no release takes for
 * UNUSED_DAYS goes.
 */

/** The scripts a release signs: PowerShell's scripts, modules and module manifests. */
export const SCRIPTS = /\.(ps1|psm1|psd1)$/i;
export const isScript = (file: string): boolean => SCRIPTS.test(file);

/** A kept copy no release has taken for this long is removed. */
export const UNUSED_DAYS = 90;

/** What signing appends, before its base64 lines and its end. */
const BEGIN = '\r\n# SIG # Begin signature block\r\n';
const BLOCK = /^(?:# [A-Za-z0-9+/=]+\r\n)+# SIG # End signature block\r\n$/;

/**
 * Where every agent's signed scripts are kept on this PC (KIT_SIGNED_SCRIPTS, else %USERPROFILE%\.steward\signed-scripts,
 * beside the kits the Steward keeps): the kit's scripts are the same in every agent, so one signing serves them all.
 */
export function scriptsStoreOf(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.KIT_SIGNED_SCRIPTS || path.join(home, '.steward', 'signed-scripts');
}

/**
 * A script's key in the store: its certificate and its text with plain line ends, so a checkout's CRLF and git's LF
 * name the same script (the Steward reads it from git). Pure.
 */
export function scriptKey(text: Buffer | string, thumbprint: string): string {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  return createHash('sha256').update(`${thumbprint.toUpperCase()}\n`).update(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1').digest('hex').slice(0, 32);
}

/** A kept copy's file in the store: its key, and the script's own extension (lower case). */
export const keptScriptFile = (store: string, key: string, file: string): string => path.join(store, `${key}${path.extname(file).toLowerCase()}`);

/**
 * The script before its signature block, as signing appended it (CRLF, "# SIG # Begin signature block", base64 lines,
 * "# SIG # End signature block"); null when it carries none. Pure.
 */
export function scriptBody(bytes: Buffer): Buffer | null {
  const at = bytes.lastIndexOf(BEGIN, undefined, 'latin1');
  if (at < 0) return null;
  return BLOCK.test(bytes.subarray(at + BEGIN.length).toString('latin1')) ? bytes.subarray(0, at) : null;
}

/** The signed copy kept for exactly these bytes (a script as it will ship, unsigned), or null when there's none. */
export function keptScript(store: string, file: string, bytes: Buffer, thumbprint: string): Buffer | null {
  const kept = keptScriptFile(store, scriptKey(bytes, thumbprint), file);
  try {
    const signed = readFileSync(kept);
    if (!scriptBody(signed)?.equals(bytes)) return null;
    const now = new Date();
    utimesSync(kept, now, now);
    return signed;
  } catch {
    return null;
  }
}

/** Keeps a script's signed copy, when it is these bytes and a signature block. Never throws: a copy not kept is signed again. */
export function keepScript(store: string, file: string, bytes: Buffer, thumbprint: string, signed: Buffer): void {
  if (!scriptBody(signed)?.equals(bytes)) return;
  try {
    mkdirSync(store, { recursive: true });
    const kept = keptScriptFile(store, scriptKey(bytes, thumbprint), file);
    const part = `${kept}.${process.pid}.part`;
    writeFileSync(part, signed);
    renameSync(part, kept);
  } catch {
    // The store isn't writable: the next release signs it again.
  }
}

/** Removes the kept copies no release has taken for UNUSED_DAYS. Never throws. */
export function pruneScripts(store: string, now = Date.now()): number {
  let gone = 0;
  try {
    for (const f of readdirSync(store)) {
      const p = path.join(store, f);
      try {
        if (now - statSync(p).mtimeMs > UNUSED_DAYS * 86_400_000) {
          rmSync(p, { force: true });
          gone++;
        }
      } catch {
        // Gone already, or in use.
      }
    }
  } catch {
    // No store yet.
  }
  return gone;
}

/** Every file under `dir` (forward slashes, relative to it). */
function filesIn(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesIn(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** The scripts under a staged release (forward slashes, relative to it), sorted. */
export const scriptsIn = (dir: string): string[] => filesIn(dir).filter(isScript).sort();

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** How a release's scripts are signed: sign.ts's, given by release.ts (a test gives its own). */
export interface ScriptSigner {
  thumbprint: string;
  store: string;
  /** Signs these files in place, timestamped, and checks each (sign.ts's signFiles); throws with why it couldn't. */
  sign(files: string[]): void;
  /** Of these files, those whose signature isn't Valid, this certificate's and timestamped: "<file>|<status>" lines, '' when none. */
  wrong(files: string[]): string;
  /** Of these files, those whose signature isn't Valid at all (sign.ts's unsignedOf). */
  invalid(files: string[]): string[];
  log(line: string): void;
}

/** What signing a staged release's scripts did. */
export interface ScriptsSigned {
  /** Signed here, now. */
  signed: string[];
  /** Taken from the store, signed before. */
  reused: string[];
  /** Signed by their makers already (Valid), shipped as they came. */
  theirs: string[];
  /** Each script's SHA-256 as signed: what the zip must carry (changedSinceSigning). */
  hashes: Record<string, string>;
  /** The staged .json files whose SHA-256 of a script were the unsigned one's, and now are the signed one's. */
  rewritten: string[];
}

/**
 * Signs every script in a staged release (`stage`), or takes its signed copy from the store, and returns what each one
 * ships as. A script that carries a Valid signature already is its maker's and stays; one whose signature no longer
 * checks out loses it and is signed again. Copies taken from the store are checked (Valid, this certificate's,
 * timestamped); one that isn't is signed again. Those signed here are checked by `sign` and kept. Last, a staged .json
 * that lists a script's SHA-256 (a guard's manifest.json, which its install checks each script against) gets the
 * signed script's. Throws when a script can't be signed.
 */
export function signStagedScripts(stage: string, s: ScriptSigner): ScriptsSigned {
  const out: ScriptsSigned = { signed: [], reused: [], theirs: [], hashes: {}, rewritten: [] };
  const files = scriptsIn(stage);
  if (!files.length) return out;
  const abs = (f: string) => path.join(stage, ...f.split('/'));
  // As the checkout has them, and as they are signed (a signature that didn't check out taken off).
  const original = new Map<string, Buffer>(files.map((f) => [f, readFileSync(abs(f))]));
  const before = new Map(original);
  // A signature already there: its maker's when it checks out, else it goes and the script is signed as it is.
  const carried = files.filter((f) => scriptBody(before.get(f)!));
  const bad = new Set(carried.length ? s.invalid(carried.map(abs)) : []);
  for (const f of carried) {
    if (!bad.has(abs(f))) {
      out.theirs.push(f);
      continue;
    }
    const body = scriptBody(before.get(f)!)!;
    writeFileSync(abs(f), body);
    before.set(f, body);
    s.log(`  ${f}: its signature didn't check out, so it's signed again`);
  }
  const ours = files.filter((f) => !out.theirs.includes(f));
  const todo: string[] = [];
  for (const f of ours) {
    const kept = keptScript(s.store, f, before.get(f)!, s.thumbprint);
    if (!kept) {
      todo.push(f);
      continue;
    }
    writeFileSync(abs(f), kept);
    out.reused.push(f);
  }
  if (out.reused.length) {
    const wrong = s.wrong(out.reused.map(abs));
    for (const line of wrong.split(/\r?\n/).filter(Boolean)) {
      const f = out.reused.find((r) => abs(r) === line.slice(0, line.lastIndexOf('|')));
      if (!f) throw new Error(`couldn't check the scripts' kept signatures: ${line}`);
      out.reused.splice(out.reused.indexOf(f), 1);
      writeFileSync(abs(f), before.get(f)!);
      todo.push(f);
      s.log(`  ${f}: its kept signature doesn't check out (${line.slice(line.lastIndexOf('|') + 1)}), so it's signed again`);
    }
  }
  if (todo.length) {
    s.sign(todo.map(abs));
    for (const f of todo) keepScript(s.store, f, before.get(f)!, s.thumbprint, readFileSync(abs(f)));
    out.signed.push(...todo.sort());
  }
  const swap = new Map<string, string>();
  for (const f of files) {
    out.hashes[f] = sha256(readFileSync(abs(f)));
    for (const h of [sha256(original.get(f)!), sha256(before.get(f)!)]) if (h !== out.hashes[f]) swap.set(h, out.hashes[f]);
  }
  if (swap.size) out.rewritten = rewriteHashes(stage, swap);
  pruneScripts(s.store);
  return out;
}

/** In every staged .json, each SHA-256 (hex, either case) in `swap` replaced by its new one, in the same case. The files changed. */
export function rewriteHashes(stage: string, swap: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const f of filesIn(stage).filter((x) => /\.json$/i.test(x))) {
    const file = path.join(stage, ...f.split('/'));
    const text = readFileSync(file, 'utf8');
    let next = text;
    for (const [was, now] of swap) next = next.replaceAll(was.toLowerCase(), now.toLowerCase()).replaceAll(was.toUpperCase(), now.toUpperCase());
    if (next !== text) {
      writeFileSync(file, next);
      changed.push(f);
    }
  }
  return changed.sort();
}

/**
 * The scripts the zip doesn't carry exactly as they were signed (`hashes`, signStagedScripts'), each "<file>: <why>";
 * [] when every one is. Unpacks them with Windows' tar.exe (`tar`) to look.
 */
export function changedSinceSigning(zip: string, hashes: Record<string, string>, tar: string): string[] {
  const files = Object.keys(hashes);
  if (!files.length) return [];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kit-scripts-'));
  try {
    try {
      execFileSync(tar, ['-x', '-f', zip, '-C', dir, ...files], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      // A file missing from the zip: said below.
    }
    return files.flatMap((f) => {
      const p = path.join(dir, ...f.split('/'));
      if (!existsSync(p)) return [`${f}: not in the zip`];
      return sha256(readFileSync(p)) === hashes[f] ? [] : [`${f}: changed after it was signed`];
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
