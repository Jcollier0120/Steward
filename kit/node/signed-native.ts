import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filesUnder, nativeSources, signable, type Arch, type Native } from './native.ts';

/**
 * A release's signed native files, kept for the releases after it (kit 2.92.0). A published release signs its native
 * files (native.ts, sign.ts), and signing needs the code-signing key: for a key in Certum's cloud, only while SimplySign
 * Desktop is connected, and its session drops by itself. Most releases don't change their native files (Envoy's carry
 * the same media host release after release), yet each one built them and signed them again: on 2026-10-20 Envoy 0.1.25
 * failed for a dropped session, though its media host was 0.1.24's.
 *
 * So once a processor's files are signed, a copy is kept, by a key of what they were built from: the native sources
 * (nativeSources: the build script's folder and kit.json's "inputs") as git has them at the commit released, the
 * processor, the certificate, and the build and out folder kit.json names. A release whose key is kept takes that copy
 * instead of building, once each file's SHA-256 is the one kept and signtool verify /pa still accepts them (sign.ts's
 * verifySigned): it needs neither the build nor the key. Only a release whose native sources are its commit's (not dirty)
 * takes or keeps one. The Steward reads the same keys (signedKey, keptSigned) to know whether a release will sign at all.
 *
 * Kept in the agent's checkout data folder (its <ID>_HOME, else %USERPROFILE%\.<id>-dev), signed-native\<key>\: kept.json
 * and files\, the newest KEEP_PER_ARCH for each processor.
 */

/** How a kept copy is keyed and written; a new form keys every copy afresh. */
export const KEPT_FORM = 1;
/** Copies kept for each processor: the newest, and the one before it (a release that goes back). */
export const KEEP_PER_ARCH = 2;

/** What kept.json says of a kept copy. */
export interface KeptSigned {
  form: number;
  key: string;
  arch: Arch;
  thumbprint: string;
  /** Each native source's git object id at the commit the files were built from. */
  sources: Record<string, string>;
  /** The release they were signed for. */
  version: string;
  commit: string;
  at: string;
  /** Each file under <out>\<arch>, forward slashes: its SHA-256. */
  files: Record<string, string>;
  /** The files signed here (the rest are their makers', or aren't programs). */
  signed: string[];
}

/** Where an agent's signed native files are kept: its checkout's data folder (<ID>_HOME, else %USERPROFILE%\.<id>-dev). */
export function signedStoreOf(id: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const own = env[`${id.toUpperCase().replace(/-/g, '_')}_HOME`];
  return path.join(own || path.join(home, `.${id}-dev`), 'signed-native');
}

/** The native sources' git object ids (`objectOf`: `git rev-parse <commit>:<path>`), or null when one can't be read. */
export function sourcesAt(n: Native, objectOf: (p: string) => string | null): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const p of nativeSources(n)) {
    const id = objectOf(p)?.trim();
    if (!id || !/^[0-9a-f]{40,64}$/i.test(id)) return null;
    out[p] = id.toLowerCase();
  }
  return out;
}

/** The key a processor's signed files are kept by. Pure. */
export function signedKey(n: Native, arch: Arch, sources: Record<string, string>): string {
  const what = JSON.stringify({ form: KEPT_FORM, build: n.build, out: n.out, arch, thumbprint: n.thumbprint, sources: Object.keys(sources).sort().map((p) => [p, sources[p]]) });
  return createHash('sha256').update(what).digest('hex').slice(0, 32);
}

/** The copy kept by this key, or null when there's none (or kept.json isn't one). */
export function keptSigned(store: string, key: string): KeptSigned | null {
  try {
    const k = JSON.parse(readFileSync(path.join(store, key, 'kept.json'), 'utf8')) as KeptSigned;
    return k && k.form === KEPT_FORM && k.key === key && k.files && typeof k.files === 'object' && Array.isArray(k.signed) ? k : null;
  } catch {
    return null;
  }
}

const sha256Of = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Puts the copy kept by `key` into `dir` (emptied first), checked: the files kept, each with its SHA-256, then
 * `verify(programs, signedHere)` (sign.ts's verifySigned). The copy kept, or why it can't be used (`dir` emptied
 * again), or null when none is kept. A copy whose files aren't the ones kept is let go; one whose signatures don't
 * check out now is kept (a check that couldn't be made now may be made later), and the release signs afresh.
 */
export function takeSigned(store: string, key: string, dir: string, verify: (programs: string[], signedHere: string[]) => string | null): { kept: KeptSigned } | { why: string } | null {
  const kept = keptSigned(store, key);
  if (!kept) return null;
  const refuse = (why: string, letGo: boolean) => {
    rmSync(dir, { recursive: true, force: true });
    if (letGo) rmSync(path.join(store, key), { recursive: true, force: true });
    return { why };
  };
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.dirname(dir), { recursive: true });
    cpSync(path.join(store, key, 'files'), dir, { recursive: true });
    const want = Object.keys(kept.files).sort();
    const have = filesUnder(dir).sort();
    if (have.length !== want.length || have.some((f, i) => f !== want[i])) return refuse(`the copy kept has ${have.length} files, not the ${want.length} it should`, true);
    const changed = want.find((f) => sha256Of(path.join(dir, f)) !== kept.files[f]);
    if (changed) return refuse(`${changed} isn't the file kept`, true);
    const why = verify(
      signable(want).map((f) => path.join(dir, f)),
      kept.signed.map((f) => path.join(dir, f)),
    );
    return why ? refuse(why, false) : { kept };
  } catch (e) {
    return refuse((e as Error).message, false);
  }
}

/**
 * Keeps a processor's signed files (`dir`) by `key`, with what kept.json says of them, replacing a copy kept by it
 * before; then lets go of that processor's older copies beyond KEEP_PER_ARCH. Throws when it can't (the release goes on).
 */
export function keepSigned(store: string, key: string, dir: string, o: { arch: Arch; thumbprint: string; sources: Record<string, string>; version: string; commit: string; signed: string[]; now?: Date }): void {
  mkdirSync(store, { recursive: true });
  const tmp = path.join(store, `${key}.${process.pid}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  try {
    cpSync(dir, path.join(tmp, 'files'), { recursive: true });
    const files = Object.fromEntries(
      filesUnder(path.join(tmp, 'files'))
        .sort()
        .map((f) => [f, sha256Of(path.join(tmp, 'files', f))]),
    );
    const signed = o.signed.map((f) => path.relative(dir, f).replace(/\\/g, '/')).sort();
    const kept: KeptSigned = { form: KEPT_FORM, key, arch: o.arch, thumbprint: o.thumbprint, sources: o.sources, version: o.version, commit: o.commit, at: (o.now ?? new Date()).toISOString(), files, signed };
    writeFileSync(path.join(tmp, 'kept.json'), `${JSON.stringify(kept, null, 2)}\n`);
    rmSync(path.join(store, key), { recursive: true, force: true });
    renameSync(tmp, path.join(store, key));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const same = readdirSync(store, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.endsWith('.tmp'))
    .flatMap((e) => {
      const k = keptSigned(store, e.name);
      return k && k.arch === o.arch ? [k] : [];
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  for (const old of same.slice(KEEP_PER_ARCH)) rmSync(path.join(store, old.key), { recursive: true, force: true });
}
