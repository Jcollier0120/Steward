import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * An agent's native files (kit 2.62.0, spec/RELEASES.md "Native files"): a program of its own that isn't Node (Envoy's
 * media host, envoy-media.exe), built for each Windows processor, carried in the agent's release, and found by the
 * installed copy where the checkout has it. kit.json says so:
 *
 *   "native": {"build": "native/build.ps1", "out": "native/build", "thumbprint": "6B65…8D33"}
 *
 * - `build`: a PowerShell script in the repository, run once per processor as `-Arch arm64` / `-Arch x64`; it leaves
 *   that processor's files in `<out>\<arch>\`. Its folder is the native sources: a change there makes a release dirty.
 * - `out`: the folder it builds into (git-ignores it). The release carries `<out>\<arch>\` for each processor, and the
 *   installed copy has them at the same place under its app folder (nativeFolder), keeping only its own processor's.
 * - `arch`: which processors (default both, ["arm64", "x64"]).
 * - `notices`: files in the repository that go with them, into `<out>\notices\` (the licenses of runtimes they carry,
 *   which an MIT or similar license asks to keep with the copies).
 * - `thumbprint`: the code-signing certificate (SHA-1, Cert:\CurrentUser\My) a published release's files are signed
 *   with; `timestamp` its RFC 3161 server (default Certum's). A release is never published unsigned: Smart App Control
 *   won't run an unsigned program, and the person deserves to know whose it is.
 *
 * Carrying both processors' files in the one zip means every Manor, the Exchequer and Castellan's setup take them as
 * they take any release, with nothing new to learn; the installed copy drops the other processor's.
 */

export type Arch = 'arm64' | 'x64';
export const ARCHES: readonly Arch[] = ['arm64', 'x64'];
export const CERTUM_TIMESTAMP = 'http://time.certum.pl';

export interface Native {
  build: string;
  out: string;
  arch: Arch[];
  notices: string[];
  thumbprint: string | null;
  timestamp: string;
}

/** A path inside the repository, as kit.json gives one: relative, forward slashes, never out of it. */
const inside = (p: unknown): p is string => typeof p === 'string' && p.trim() !== '' && !path.isAbsolute(p) && !/^[a-z]:/i.test(p) && !p.replace(/\\/g, '/').split('/').includes('..');
const tidy = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** kit.json's "native", checked: null when it has none, else the spec or an error in words. */
export function nativeOf(pin: unknown): Native | null | { error: string } {
  const n = (pin as Record<string, unknown> | null)?.native;
  if (n === undefined || n === null) return null;
  const bad = (why: string) => ({ error: `kit.json's "native" ${why} (spec/RELEASES.md, "Native files")` });
  if (typeof n !== 'object' || Array.isArray(n)) return bad('should be an object: {"build": "native/build.ps1", "out": "native/build"}');
  const o = n as Record<string, unknown>;
  if (!inside(o.build) || !/\.ps1$/i.test(o.build)) return bad('"build" should be a PowerShell script in the repository (native/build.ps1)');
  if (!inside(o.out)) return bad('"out" should be a folder in the repository (native/build)');
  const arch = o.arch === undefined ? [...ARCHES] : o.arch;
  if (!Array.isArray(arch) || !arch.length || !arch.every((a) => ARCHES.includes(a)) || new Set(arch).size !== arch.length) return bad(`"arch" should list processors from ${ARCHES.join(' and ')}`);
  const notices = o.notices === undefined ? [] : o.notices;
  if (!Array.isArray(notices) || !notices.every(inside)) return bad('"notices" should list files in the repository');
  if (o.thumbprint !== undefined && !(typeof o.thumbprint === 'string' && /^[0-9a-f]{40}$/i.test(o.thumbprint))) return bad('"thumbprint" should be a certificate\'s SHA-1 thumbprint (40 hex digits)');
  if (o.timestamp !== undefined && !(typeof o.timestamp === 'string' && /^https?:\/\/\S+$/.test(o.timestamp))) return bad('"timestamp" should be a timestamp server\'s URL');
  return {
    build: tidy(o.build),
    out: tidy(o.out),
    arch: arch as Arch[],
    notices: (notices as string[]).map(tidy),
    thumbprint: typeof o.thumbprint === 'string' ? o.thumbprint.toUpperCase() : null,
    timestamp: typeof o.timestamp === 'string' ? o.timestamp : CERTUM_TIMESTAMP,
  };
}

/** A copy's kit.json's native spec (a checkout's, or the one an installed copy carries), or null when it has none or it's wrong. */
export function nativeIn(root: string): Native | null {
  try {
    const n = nativeOf(JSON.parse(readFileSync(path.join(root, 'kit.json'), 'utf8').replace(/^\uFEFF/, '')));
    return n && !('error' in n) ? n : null;
  } catch {
    return null;
  }
}

/** This PC's processor as the native files name it: an Arm PC's Node is arm64; anything else runs the x64 build. */
export const archOf = (arch: string = process.arch): Arch => (arch === 'arm64' ? 'arm64' : 'x64');

/**
 * Where this copy's native files for this PC are: `<root>\<out>\<arch>`, in a checkout once built and in an installed
 * copy as its release brought them. Null when the agent declares none, or they aren't there.
 */
export function nativeFolder(root: string, arch: string = process.arch, exists: (p: string) => boolean = existsSync): string | null {
  const n = nativeIn(root);
  if (!n) return null;
  const dir = path.join(root, ...n.out.split('/'), archOf(arch));
  return exists(dir) ? dir : null;
}

/** The files under a folder, relative to it, forward slashes. */
function filesUnder(dir: string, rel = ''): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, r) : e.isFile() ? [r] : [];
  });
}

/** The programs and libraries in a build, which a published release signs when they aren't signed already. */
export const signable = (files: string[]) => files.filter((f) => /\.(exe|dll)$/i.test(f));

export interface NativeSteps {
  /** Runs the build script for one processor in the repository; its exit code and what it said. */
  build(script: string, arch: Arch): { code: number; out: string };
  /** Of these files, the ones not signed already (Authenticode's status isn't Valid). */
  unsigned(files: string[]): string[];
  /** Signs and timestamps these files, and checks each verifies: throws with why when it can't. */
  sign(files: string[]): void;
  log(line: string): void;
}

export interface NativeBuilt {
  /** Per processor, its files (relative to the repository) and their size. */
  arch: { arch: Arch; files: string[]; bytes: number; signed: number }[];
  notices: string[];
}

/**
 * Builds each processor's files afresh (`<out>\<arch>` is emptied first, so nothing stale rides along), checks they are
 * there, and, for a release that is published, signs the programs and libraries that aren't signed already (a
 * runtime's own DLLs keep their maker's signature). Throws with why when a build fails or leaves nothing.
 */
export function buildNative(root: string, n: Native, sign: boolean, s: NativeSteps): NativeBuilt {
  for (const f of [n.build, ...n.notices]) if (!existsSync(path.join(root, f))) throw new Error(`kit.json's "native" names ${f}, which isn't in the repository.`);
  const built: NativeBuilt['arch'] = [];
  for (const arch of n.arch) {
    const dir = path.join(root, ...n.out.split('/'), arch);
    rmSync(dir, { recursive: true, force: true });
    s.log(`  native files for ${arch}: ${n.build} -Arch ${arch}`);
    const r = s.build(n.build, arch);
    if (r.code !== 0) throw new Error(`${n.build} -Arch ${arch} failed (exit ${r.code}):\n${r.out.trim().split(/\r?\n/).slice(-15).join('\n')}`);
    const files = existsSync(dir) ? filesUnder(dir) : [];
    if (!files.length) throw new Error(`${n.build} -Arch ${arch} left nothing in ${n.out}/${arch}: it should build there.`);
    let signed = 0;
    if (sign) {
      const todo = s.unsigned(signable(files).map((f) => path.join(dir, f)));
      if (todo.length) s.sign(todo);
      signed = todo.length;
    }
    const bytes = files.reduce((t, f) => t + statSync(path.join(dir, f)).size, 0);
    built.push({ arch, files: files.map((f) => `${n.out}/${arch}/${f}`), bytes, signed });
  }
  return { arch: built, notices: n.notices.map((f) => `${n.out}/notices/${path.posix.basename(f)}`) };
}

/** Copies the built native files and the notices into a release's staging folder, at the same paths. */
export function stageNative(root: string, stage: string, n: Native, b: NativeBuilt): number {
  let count = 0;
  for (const a of b.arch)
    for (const f of a.files) {
      cpSync(path.join(root, f), path.join(stage, f));
      count++;
    }
  n.notices.forEach((f, i) => {
    cpSync(path.join(root, f), path.join(stage, b.notices[i]));
    count++;
  });
  return count;
}

/** What release.json says of the native files it carries. */
export interface NativeRelease {
  out: string;
  arch: Arch[];
  signed: boolean;
}

/**
 * At install, the other processors' folders go from the copy being put in place: an x64 PC keeps `<out>\x64`, an Arm
 * PC `<out>\arm64`. When the release has none for this PC, all are kept and the line says so. The notices stay.
 */
export function keepOwnArch(app: string, r: NativeRelease | undefined, arch: string = process.arch): string | null {
  if (!r) return null;
  const own = archOf(arch);
  const base = path.join(app, ...r.out.split('/'));
  if (!r.arch.includes(own)) return `This release has no native files for ${own} (it has ${r.arch.join(' and ')}).`;
  for (const a of r.arch) if (a !== own) rmSync(path.join(base, a), { recursive: true, force: true });
  return null;
}

/** release.json's "native", when it's one: anything else is none, never an error. */
export function nativeRelease(v: unknown): NativeRelease | undefined {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || !inside(o.out) || !Array.isArray(o.arch) || !o.arch.every((a) => ARCHES.includes(a))) return undefined;
  return { out: tidy(o.out), arch: o.arch as Arch[], signed: o.signed === true };
}

/** The real build: Windows PowerShell runs the script in the repository, as -Arch <arch>. */
export function runBuild(root: string, script: string, arch: Arch): { code: number; out: string } {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, script), '-Arch', arch], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

/**
 * The processes running a program from under `dir` (an installed copy's native files), by PowerShell's CIM: their ids.
 * An install ends them before it moves the app folder, which Windows won't move while a program in it runs.
 */
export function processesUnder(dir: string): number[] {
  const like = `${dir.replace(/[\\/]+$/, '')}\\*`.replace(/'/g, "''").replace(/\[/g, '`[').replace(/\]/g, '`]');
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ExecutablePath IS NOT NULL" | Where-Object { $_.ExecutablePath -like '${like}' } | ForEach-Object { $_.ProcessId }`],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
  return `${r.stdout ?? ''}`
    .split(/\r?\n/)
    .map((l) => Number(l.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/** Ends processes by id (taskkill /F), each one's whole tree. */
export function endProcesses(ids: number[]): void {
  if (!ids.length) return;
  spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/F', '/T', ...ids.flatMap((id) => ['/PID', String(id)])], { windowsHide: true, timeout: 60_000 });
}
