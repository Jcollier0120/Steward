#!/usr/bin/env node
/**
 * Every program file the staff's local models run, signed by its maker or by Castellan (kit 2.108.0):
 *
 *   node tools/sign-binaries.ts             artifacts\signing\: LIST.md and list.json, each file the sitting signs or lists in
 *                                           a catalog (its version, licence, size, SHA-256, and where it will be hosted)
 *   node tools/sign-binaries.ts --sign      the signing sitting, once the owner has approved the list and connected
 *                                           SimplySign Desktop: everything signed, then each signature checked
 *   node tools/sign-binaries.ts --publish   the signed copies' releases in the public releases repository, as drafts: only
 *                                           after the owner's OK on the list
 *
 * Windows' Smart App Control blocks a program file that isn't signed and that Microsoft's cloud doesn't know (the kit's
 * app-control.ts). What the kit takes from a maker who signs nothing gets one of two things:
 *
 * - a signed copy, where the licence lets anyone pass it on changed: llama.cpp's builds for a route's server
 *   (sign-llama.ts --variants), hosted with their notices beside them in the releases repository, as b11734's are;
 * - Castellan's signed catalog of it, where it doesn't (FastFlowLM's NPU kernels may be passed on only unmodified, and
 *   NVIDIA's and Qualcomm's terms let no one else host them): the SHA-256 of each of its unsigned files, signed. The kit
 *   carries it (kit\node\catalogs\), and setup adds it to Windows' catalogs where Smart App Control is on or weighing it
 *   (catalogs.ts), so the maker's own download runs as it is.
 *
 * Signing runs in one sitting: the catalog helper (sign-helpers.ts), the signed copies, the catalogs, then `signtool verify
 * /pa` on every file signed and on each catalog's every file. SimplySign Desktop must be connected, by the owner alone; it's
 * never driven from here. The x64 signtool alone can reach its key (sign-llama.ts).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NPU_CATALOG, type NpuCatalog, type NpuSignedCatalog } from '../src/kit/npu-vendors.ts';
import { CUDART_ZIP, download, LLAMA_PIN, signedLlamaTag, SIGNED_LLAMA_REPO, unpack } from '../src/kit/setup.ts';
import { peFilesIn, readSignatures, type PeSignature } from '../src/kit/signatures.ts';
import { draftRelease, sign, SIGNTOOL } from './sign-llama.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(root, 'artifacts', 'signing');
export const MAKECAT = path.join(path.dirname(SIGNTOOL), 'makecat.exe');

export interface Pinned {
  file: string;
  url: string;
  size: number;
  sha256: string;
}

/** Something the kit takes from a maker who doesn't sign it all, and what the sitting does about it. */
export interface Source {
  id: string;
  name: string;
  version: string;
  /** What the staff run it for. */
  what: string;
  licence: string;
  how: 'signed-copy' | 'catalog';
  download: Pinned;
  /** signed-copy: sign-llama.ts' build and variant. */
  build?: string;
  variant?: string;
  /** catalog: catalogs.ts' castellan-<route>-<server>-<version>.cat. */
  route?: string;
  catalog?: string;
  /**
   * catalog: the download's own unsigned program files are listed (a zip's), or the download itself and what it installs
   * (an installer, whose files are read where it's installed: --installed <version>=<folder>).
   */
  installs?: boolean;
}

/** A program file of a source, as found. */
export interface ListedFile {
  path: string;
  size: number;
  sha256: string;
  version: string | null;
  /** Its maker's signer, or null when it has no signature. */
  signer: string | null;
  status: string;
  /** What the sitting does: signs it, lists it in the catalog, or leaves it (signed by its maker). */
  action: 'sign' | 'catalog' | 'as-is';
}

export interface Listed extends Source {
  host: string;
  files: ListedFile[];
  /** Why its files couldn't be listed (an installer not installed here). */
  missing?: string;
}

const DL = 'https://github.com';

/** The kit's sources that need signing or a catalog, as npu-vendors.json and LLAMA_PIN pin them. */
export function sources(cat: NpuCatalog = NPU_CATALOG, pin: typeof LLAMA_PIN = LLAMA_PIN): Source[] {
  const out: Source[] = [];
  const amd = cat.routes.amd;
  if (amd?.download) {
    out.push({
      id: `fastflowlm-${amd.version}`,
      name: 'FastFlowLM',
      version: amd.version,
      what: "the AMD NPU's server",
      licence: "FastFlowLM's own: its program MIT, its NPU kernels free to use and pass on unmodified only. The catalog copies none of it: the staff download it from ROCm's release, as now.",
      how: 'catalog',
      download: pinned(amd.download),
      route: 'amd',
      catalog: `castellan-amd-fastflowlm-${amd.version}.cat`,
    });
  }
  const cudart = pin.files[CUDART_ZIP];
  if (cudart?.url) {
    const v = /cuda-(\d+\.\d+)/.exec(CUDART_ZIP)?.[1] ?? 'cuda';
    out.push({
      id: `cudart-${v}`,
      name: "NVIDIA's CUDA runtime",
      version: v,
      what: "llama.cpp's CUDA build, on an NVIDIA card",
      licence: "NVIDIA's CUDA EULA. The catalog copies none of it: the staff download it from ggml-org's release, as now.",
      how: 'catalog',
      download: { file: CUDART_ZIP, url: cudart.url, size: cudart.size, sha256: cudart.sha256 },
      route: 'cuda',
      catalog: `castellan-cuda-cudart-${v}.cat`,
    });
  }
  const q = cat.routes.qualcomm;
  if (q) {
    // llama.cpp's builds for the NPU's embedding server, one a GenieX version.
    const embeds = [q.embedServer, ...(q.versions ?? []).map((v) => v.embedServer)].filter((e) => e?.download);
    for (const e of embeds) {
      const m = /^llama-(b\d+)-bin-win-(.+)\.zip$/.exec(e!.download!.file);
      if (!m || out.some((s) => s.id === `llama.cpp-${m[1]}-${m[2]}`)) continue;
      out.push({
        id: `llama.cpp-${m[1]}-${m[2]}`,
        name: 'llama.cpp',
        version: m[1],
        what: "the Snapdragon NPU's embedding server, with GenieX's libraries over it",
        licence: "MIT (llama.cpp's LICENSE, beside the zip), and libomp.dll's Apache-2.0 with LLVM's exception (its LICENSE-LLVM-OpenMP, in the zip). Both let anyone pass it on, changed, with the notices.",
        how: 'signed-copy',
        download: pinned(e!.download!),
        build: m[1],
        variant: m[2],
      });
    }
    // GenieX's installers, and what they install: Qualcomm's QAIRT terms let no one else host them.
    const servers = [{ version: q.version, download: q.download }, ...Object.values(q.generations ?? {}).map((g) => g.serverPin).filter((p) => p?.download)];
    for (const s of servers) {
      if (!s?.download || out.some((o) => o.id === `geniex-${s.version}`)) continue;
      out.push({
        id: `geniex-${s.version}`,
        name: 'GenieX CLI',
        version: s.version,
        what: "the Snapdragon NPU's server (its installer, and the files it installs)",
        licence: "Qualcomm's: GenieX's own, and the QAIRT runtime's terms. The catalog copies none of it: the staff download the installer from Qualcomm's release, as now.",
        how: 'catalog',
        download: pinned(s.download),
        route: 'qualcomm',
        catalog: `castellan-qualcomm-geniex-${s.version}.cat`,
        installs: true,
      });
    }
  }
  return out;
}

function pinned(d: { file?: string; url: string; size?: number; sha256?: string }): Pinned {
  return { file: d.file ?? path.basename(new URL(d.url).pathname), url: d.url, size: d.size ?? 0, sha256: (d.sha256 ?? '').toLowerCase() };
}

/** Where a source's signed form will be: the signed copy's release, or the kit. */
export function hostOf(s: Source): string {
  if (s.how === 'signed-copy') return `${DL}/${SIGNED_LLAMA_REPO}/releases/download/${signedLlamaTag(s.build!)}/${s.download.file}`;
  return `the kit, kit\\node\\catalogs\\${s.catalog} (added to Windows' catalogs where Smart App Control is on)`;
}

/** What the sitting does with each file: an unsigned one signed (or listed), one its maker signed left; a broken one is a stop. */
export function actions(s: Source, sigs: PeSignature[]): { files: Omit<ListedFile, 'sha256'>[]; bad: PeSignature[] } {
  const bad = sigs.filter((g) => g.status !== 'Valid' && g.status !== 'NotSigned');
  const files = sigs
    .filter((g) => g.status === 'Valid' || g.status === 'NotSigned')
    .map((g) => ({
      path: g.file,
      size: g.size,
      version: g.version,
      signer: g.status === 'Valid' ? g.signer : null,
      status: g.status,
      action: g.status === 'Valid' ? ('as-is' as const) : s.how === 'signed-copy' ? ('sign' as const) : ('catalog' as const),
    }));
  return { files, bad };
}

/** MakeCat's definition of a catalog of `members`: SHA-256, as Windows 10 and later read them. */
export function cdf(name: string, resultDir: string, members: string[]): string {
  return [
    '[CatalogHeader]',
    `Name=${name}`,
    `ResultDir=${resultDir}`,
    'PublicVersion=0x00000001',
    'EncodingType=0x00010001',
    'CatalogVersion=2',
    'HashAlgorithms=SHA256',
    '',
    '[CatalogFiles]',
    ...members.map((m, i) => `<HASH>f${String(i + 1).padStart(3, '0')}=${m}`),
    '',
  ].join('\r\n');
}

/** The route's pin of a signed catalog (npu-vendors.json's `catalogs`, setup.ts' LLAMA_CATALOGS). */
export function catalogPin(s: Listed, cat: { size: number; sha256: string }): NpuSignedCatalog {
  const n = s.files.filter((f) => f.action === 'catalog').length;
  return { serverVersion: s.version, file: s.catalog!, covers: `${s.name} ${s.version}'s ${n} unsigned program files`, size: cat.size, sha256: cat.sha256 };
}

const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** LIST.md: what the owner approves before anything is signed or published. */
export function listMarkdown(listed: Listed[], asIs: { what: string; signer: string }[], made: string): string {
  const lines = [
    '# What the sitting signs',
    '',
    `Made ${made} by tools/sign-binaries.ts. Nothing here is signed or published until the owner approves it.`,
    '',
    '| | Version | How | Files | Hosted |',
    '|---|---|---|---|---|',
    ...listed.map((s) => {
      const n = s.files.filter((f) => f.action !== 'as-is').length;
      return `| ${s.name} | ${s.version} | ${s.how === 'signed-copy' ? 'signed copy' : `catalog ${s.catalog}`} | ${s.missing ? 'not read yet' : `${n} to ${s.how === 'signed-copy' ? 'sign' : 'list'}, ${s.files.length - n} its maker signed`} | ${hostOf(s)} |`;
    }),
    '',
    '## Signed by their makers, or by Castellan already: as they are',
    '',
    ...asIs.map((a) => `- ${a.what}: ${a.signer}`),
    '',
  ];
  for (const s of listed) {
    lines.push(`## ${s.name} ${s.version}: ${s.how === 'signed-copy' ? 'a signed copy' : `Castellan's catalog ${s.catalog}`}`, '');
    lines.push(`- For: ${s.what}`, `- Licence: ${s.licence}`, `- From: ${s.download.url} (${mb(s.download.size)}, SHA-256 ${s.download.sha256})`, `- Hosted: ${hostOf(s)}`, '');
    if (s.installs)
      lines.push(
        "Its installer is Inno Setup's: it unpacks a setup program of its own into the temporary folder and runs that, and that file's SHA-256 isn't known without running it. The test PC's Smart App Control log names it, with its hash, if it's blocked: the sitting adds it then.",
        '',
      );
    if (s.missing) {
      lines.push(`Its files aren't listed yet: ${s.missing}`, '');
      continue;
    }
    lines.push('| File | Version | Size | SHA-256 | Signed by | Done |', '|---|---|---|---|---|---|');
    for (const f of s.files) lines.push(`| ${f.path} | ${f.version ?? ''} | ${f.size} | ${f.sha256} | ${f.signer ?? 'nobody'} | ${f.action === 'as-is' ? 'left as it is' : f.action === 'sign' ? 'signed' : 'listed'} |`);
    lines.push('');
  }
  return lines.join('\n');
}

/** What the staff run that's signed already, as the survey of 2026-10-23 found it (kit 2.108.0's npu-check reads it on each PC). */
export const AS_IS: { what: string; signer: string }[] = [
  { what: 'OpenVINO Model Server 2026.4.1 (the Intel NPU)', signer: 'Intel (46 files), the Python Software Foundation (29), Microsoft (2)' },
  { what: "Microsoft's Visual C++ runtime 14.44 (beside OpenVINO Model Server)", signer: 'Microsoft' },
  { what: "Castellan's build of OpenVINO GenAI 2026.4.1.0-castellan.1", signer: 'Castellan' },
  { what: `llama.cpp ${LLAMA_PIN.build}, every build setup takes (the card and the processor)`, signer: 'Castellan (its signed copies)' },
  { what: "ffmpeg n8.1.3-6, x64 and Arm64 (the staff's video and sound)", signer: 'Castellan' },
  { what: "The kit's helpers (kit\\node\\prebuilt\\) and its GenieX plugin (kit\\node\\geniex\\)", signer: 'Castellan' },
  { what: "GenieX's QAIRT runtime (qairt\\htp-files\\) and its Hexagon libraries", signer: 'Qualcomm, and Microsoft for their catalogs' },
  { what: "FastFlowLM's Visual C++ runtime (msvcp140, vcruntime140, vcruntime140_1)", signer: 'Microsoft' },
];

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** A source's download, fetched once and checked against its pin. */
async function fetched(s: Source): Promise<string> {
  const dest = path.join(OUT, 'downloads', s.download.file);
  if (existsSync(dest) && statSync(dest).size === s.download.size && sha256(dest) === s.download.sha256) return dest;
  await download({ what: s.download.file, url: s.download.url, size: s.download.size, sha256: s.download.sha256, dest, have: false });
  return dest;
}

/** The files a source's catalog or signed copy is made from: a zip's unpacked, an installer's where it's installed. */
async function filesOf(s: Source, installed: Map<string, string>): Promise<{ dir: string; files: string[] } | { missing: string }> {
  const dl = await fetched(s);
  if (!s.installs) {
    const dir = path.join(OUT, 'unpacked', s.id);
    rmSync(dir, { recursive: true, force: true });
    unpack(dl, dir);
    return { dir, files: peFilesIn(dir) };
  }
  const folder = installed.get(s.version);
  if (!folder) return { missing: `a PC with ${s.name} ${s.version} installed gives its folder: --installed ${s.version}=<its folder>` };
  return { dir: folder, files: [dl, ...peFilesIn(folder)] };
}

/** GenieX's own folder here, by the version it says it is. */
function installedHere(): Map<string, string> {
  const m = new Map<string, string>();
  const dir = path.join(process.env.LOCALAPPDATA ?? '', 'GenieX CLI');
  try {
    const v = /GenieX CLI Version:\s*v?(\d+\.\d+\.\d+)/.exec(execFileSync(path.join(dir, 'geniex.exe'), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }))?.[1];
    if (v) m.set(v, dir);
  } catch {}
  return m;
}

/** Every source's files read and hashed: list.json and LIST.md. */
export async function makeList(installed: Map<string, string>): Promise<Listed[]> {
  mkdirSync(OUT, { recursive: true });
  const listed: Listed[] = [];
  for (const s of sources()) {
    const got = await filesOf(s, installed);
    if ('missing' in got) {
      listed.push({ ...s, host: hostOf(s), files: [], missing: got.missing });
      continue;
    }
    const sigs = await readSignatures(got.files);
    const { files, bad } = actions(s, sigs);
    if (bad.length) throw new Error(`${s.id}: ${bad.map((b) => `${path.basename(b.file)} (${b.status})`).join(', ')}`);
    // The kit's own files in an installed folder (its GenieX plugin) are Castellan's: left out.
    const own = (f: { signer: string | null }) => f.signer === 'Jeremy Collier';
    listed.push({
      ...s,
      host: hostOf(s),
      files: files.filter((f) => !own(f)).map((f) => ({ ...f, path: s.installs && f.path === got.files[0] ? path.basename(f.path) : path.relative(got.dir, f.path), sha256: sha256(f.path) })),
    });
    console.log(`${s.name} ${s.version}: ${files.length} program files, ${files.filter((f) => f.action !== 'as-is').length} to ${s.how === 'signed-copy' ? 'sign' : 'list'}`);
  }
  const made = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(OUT, 'list.json'), `${JSON.stringify({ made, sources: listed, asIs: AS_IS }, null, 2)}\n`);
  writeFileSync(path.join(OUT, 'LIST.md'), listMarkdown(listed, AS_IS, made));
  console.log(`The list: ${path.join(OUT, 'LIST.md')}`);
  return listed;
}

/** signtool verify /pa, of a file or of a catalog's member; its first line when it fails. */
function verify(file: string, catalog?: string): string | null {
  const args = ['verify', '/pa', '/q', ...(catalog ? ['/hash', 'SHA256', '/c', catalog] : []), file];
  const r = spawnSync(SIGNTOOL, args, { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? null : (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim().split(/\r?\n/)[0];
}

/** The signing sitting: helpers, signed copies, catalogs, then every signature checked. */
async function sitting(installed: Map<string, string>): Promise<void> {
  const listed = await makeList(installed);
  const missing = listed.filter((s) => s.missing);
  if (missing.length) throw new Error(`not every source's files are read: ${missing.map((s) => `${s.id} (${s.missing})`).join('; ')}`);
  const node = process.execPath;
  const run = (script: string, args: string[]) => {
    const r = spawnSync(node, [path.join(root, 'tools', script), ...args], { stdio: 'inherit', windowsHide: true, cwd: root });
    if (r.status !== 0) throw new Error(`${script} ${args.join(' ')} failed`);
  };
  // 1. The kit's helpers, the catalog helper among them: its first file stops it at once if SimplySign isn't connected.
  run('sign-helpers.ts', []);
  // 2. The signed copies.
  const copies = listed.filter((s) => s.how === 'signed-copy');
  for (const build of [...new Set(copies.map((s) => s.build!))]) run('sign-llama.ts', [build, `--variants=${copies.filter((s) => s.build === build).map((s) => s.variant).join(',')}`]);
  // 3. The catalogs, made and signed.
  const cats = path.join(OUT, 'catalogs');
  rmSync(cats, { recursive: true, force: true });
  mkdirSync(cats, { recursive: true });
  const made: { s: Listed; cat: string; members: string[] }[] = [];
  for (const s of listed.filter((x) => x.how === 'catalog')) {
    const got = await filesOf(s, installed);
    if ('missing' in got) throw new Error(`${s.id}: ${got.missing}`);
    const want = new Set(s.files.filter((f) => f.action === 'catalog').map((f) => f.sha256));
    const members = got.files.filter((f) => want.has(sha256(f)));
    if (members.length !== want.size) throw new Error(`${s.id}: ${want.size} files listed, ${members.length} found to list`);
    const def = path.join(cats, `${s.catalog}.cdf`);
    writeFileSync(def, cdf(s.catalog!, cats, members));
    execFileSync(MAKECAT, ['-v', def], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    made.push({ s, cat: path.join(cats, s.catalog!), members });
  }
  sign(made.map((m) => m.cat));
  // 4. Every signature checked: the helpers', each signed copy's files', each catalog's and its every file's.
  const failed: string[] = [];
  let checked = 0;
  const check = (file: string, catalog?: string) => {
    checked++;
    const why = verify(file, catalog);
    if (why) failed.push(`${path.basename(file)}${catalog ? ` in ${path.basename(catalog)}` : ''}: ${why}`);
  };
  const prebuilt = path.join(root, 'kit', 'node', 'prebuilt');
  for (const f of readdirSync(prebuilt)) check(path.join(prebuilt, f));
  for (const s of copies) {
    const zip = path.join(root, 'artifacts', 'llama', s.build!, s.download.file);
    const dir = path.join(OUT, 'verify', s.id);
    rmSync(dir, { recursive: true, force: true });
    unpack(zip, dir);
    for (const f of peFilesIn(dir)) check(f);
  }
  for (const m of made) {
    check(m.cat);
    for (const f of m.members) check(f, m.cat);
  }
  if (failed.length) throw new Error(`${failed.length} of ${checked} not valid:\n${failed.join('\n')}`);
  console.log(`signtool verify /pa: all ${checked} valid`);
  // 5. The catalogs into the kit, and their pins.
  const kitCats = path.join(root, 'kit', 'node', 'catalogs');
  mkdirSync(kitCats, { recursive: true });
  const pins = made.map((m) => {
    copyFileSync(m.cat, path.join(kitCats, m.s.catalog!));
    return { route: m.s.route, pin: catalogPin(m.s, { size: statSync(m.cat).size, sha256: sha256(m.cat) }) };
  });
  writeFileSync(path.join(OUT, 'pins.json'), `${JSON.stringify(pins, null, 2)}\n`);
  console.log(`Signed and checked. The catalogs are in ${kitCats}, their pins in ${path.join(OUT, 'pins.json')}; the signed copies' download pins in artifacts\\llama\\<build>\\downloads.json.`);
  console.log('To publish the signed copies, after the owner\'s OK on the list: node tools/sign-binaries.ts --publish');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const installed = installedHere();
  for (const a of args.filter((x, i) => args[i - 1] === '--installed')) {
    const [v, folder] = a.split(/=(.*)/s);
    if (!v || !folder || !existsSync(folder)) throw new Error(`--installed ${a}: give <version>=<its folder>`);
    installed.set(v, folder);
  }
  if (args.includes('--publish')) {
    const gh = spawnSync('gh', ['--version'], { windowsHide: true }).status === 0 ? 'gh' : 'C:\\tools\\gh\\bin\\gh.exe';
    for (const build of [...new Set(sources().filter((s) => s.how === 'signed-copy').map((s) => s.build!))]) draftRelease(gh, build, path.join(root, 'artifacts', 'llama', build));
    return;
  }
  if (args.includes('--sign')) return sitting(installed);
  await makeList(installed);
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(process.env.SIGN_BINARIES_DEBUG ? e?.stack : String(e?.message ?? e));
    process.exit(1);
  });
}
