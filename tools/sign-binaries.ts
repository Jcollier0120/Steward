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
 *   --installed <version>=<folder>          GenieX installed at that version on another PC: its geniex.exe, which Qualcomm's
 *                                           SDK zip lacks (this PC's own install is found by itself)
 *
 * Windows' Smart App Control blocks a program file that isn't signed and that Microsoft's cloud doesn't know (the kit's
 * app-control.ts). What the kit takes from a maker who signs nothing gets one of three things:
 *
 * - a signed copy, where the licence lets anyone pass it on changed: llama.cpp's builds for a route's server
 *   (sign-llama.ts --variants), hosted with their notices beside them in the releases repository, as b11734's are;
 * - a signed build, where the maker's zip carries signed files of someone else's terms beside its own unsigned ones:
 *   GenieX, whose own files (BSD-3-Clause, and llama.cpp's MIT) are signed copies hosted with their notices, laid by
 *   setup over Qualcomm's own SDK zip, whose QAIRT runtime Qualcomm signs and only Qualcomm hosts. Its installer, which
 *   Smart App Control blocks as it unpacks its own setup program, never runs;
 * - Castellan's signed catalog of it, where its terms let no one change it (FastFlowLM's NPU kernels may be passed on
 *   only unmodified, and NVIDIA's runtime is NVIDIA's to host): the SHA-256 of each of its unsigned files, signed. The
 *   kit carries it (kit\node\catalogs\), and setup adds it to Windows' catalogs where Smart App Control is on or weighing
 *   it (catalogs.ts), so the maker's own download runs as it is.
 *
 * Signing runs in one sitting: the catalog helper (sign-helpers.ts), the signed copies, the signed builds, the catalogs,
 * then `signtool verify /pa` on every file signed and on each catalog's every file. SimplySign Desktop must be connected,
 * by the owner alone; it's never driven from here. The x64 signtool alone can reach its key (sign-llama.ts).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NPU_CATALOG, type NpuCatalog, type NpuSignedBuild, type NpuSignedCatalog } from '../src/kit/npu-vendors.ts';
import { CUDART_ZIP, download, LLAMA_PIN, signedLlamaTag, SIGNED_LLAMA_REPO, unpack } from '../src/kit/setup.ts';
import { peFilesIn, readSignatures, type PeSignature } from '../src/kit/signatures.ts';
import { draftRelease, sign, SIGNTOOL } from './sign-llama.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(root, 'artifacts', 'signing');
export const MAKECAT = path.join(path.dirname(SIGNTOOL), 'makecat.exe');
const tarExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

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
  how: 'signed-copy' | 'signed-build' | 'catalog';
  /** The maker's download: a signed build's is the zip setup lays the signed copies over. */
  download: Pinned;
  /** signed-copy: sign-llama.ts' build and variant. */
  build?: string;
  variant?: string;
  /** catalog: catalogs.ts' castellan-<route>-<server>-<version>.cat. */
  route?: string;
  catalog?: string;
  /**
   * signed-build: the folder in the maker's zip that is the server's folder, the program its zip lacks (taken from the
   * maker's installed copy of that version), and the signed copies' zip and its release.
   */
  folder?: string;
  exe?: string;
  signed?: { tag: string; zip: string };
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
  /** Why its files couldn't be listed (GenieX's program, at a version not installed here). */
  missing?: string;
}

const DL = 'https://github.com';

/**
 * Qualcomm's SDK zips of GenieX, by version, pinned by their release's digests: its lib folder is the folder GenieX's
 * installer fills, file for file, but for geniex.exe. 0.8.0, the route's own version, is none: no generation installs
 * it new (each pins a 0.9 release), and a PC on it keeps the copy it has.
 */
export const GENIEX_SDK: Record<string, Pinned> = {
  '0.9.1': { file: 'geniex-sdk-windows-arm64-v0.9.1.zip', url: `${DL}/qualcomm/GenieX/releases/download/v0.9.1/geniex-sdk-windows-arm64-v0.9.1.zip`, size: 91542153, sha256: '2ed2bf63f042086c525b442081ed8d7ad4ff76bcce8bad6eeabe1cf38cc0a1b5' },
  '0.9.3': { file: 'geniex-sdk-windows-arm64-v0.9.3.zip', url: `${DL}/qualcomm/GenieX/releases/download/v0.9.3/geniex-sdk-windows-arm64-v0.9.3.zip`, size: 91519631, sha256: '3edffa6e64878dfb68ea45116c37550a286e01d0c5066c28e8673cdfd4840446' },
};

/** GenieX's signed copies, by version: their zip, in the server's folder's layout, and its release. */
export const geniexSigned = (version: string) => ({ tag: `geniex-${version}-castellan`, zip: `geniex-cli-windows-arm64-v${version}-castellan.zip` });

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
    // GenieX at each version a generation installs (its serverPin): Qualcomm's SDK zip, and signed copies of GenieX's own files.
    const versions = [...new Set(Object.values(q.generations ?? {}).map((g) => g.serverPin?.version).filter((v): v is string => !!v))].sort();
    for (const v of versions) {
      const sdk = GENIEX_SDK[v];
      if (!sdk) throw new Error(`GenieX ${v}: a generation installs it, and GENIEX_SDK has no pin of its SDK zip`);
      out.push({
        id: `geniex-${v}`,
        name: 'GenieX CLI',
        version: v,
        what: "the Snapdragon NPU's server",
        licence:
          "BSD-3-Clause (GenieX, its QAIRT plugin and geniex-proc, Qualcomm's) and MIT (llama.cpp's libraries in it), which let anyone pass it on, with the notices: each source's, at the commit GenieX's tag builds from, go in the zip. The QAIRT runtime, under Qualcomm's own terms, isn't copied: setup takes it from Qualcomm's SDK zip, signed by Qualcomm.",
        how: 'signed-build',
        download: sdk,
        folder: 'lib',
        exe: 'geniex.exe',
        signed: geniexSigned(v),
      });
    }
  }
  return out;
}

function pinned(d: { file?: string; url: string; size?: number; sha256?: string }): Pinned {
  return { file: d.file ?? path.basename(new URL(d.url).pathname), url: d.url, size: d.size ?? 0, sha256: (d.sha256 ?? '').toLowerCase() };
}

/** Where a source's signed form will be: the signed copy's or signed build's release, or the kit. */
export function hostOf(s: Source): string {
  if (s.how === 'signed-copy') return `${DL}/${SIGNED_LLAMA_REPO}/releases/download/${signedLlamaTag(s.build!)}/${s.download.file}`;
  if (s.how === 'signed-build') return `${DL}/${SIGNED_LLAMA_REPO}/releases/download/${s.signed!.tag}/${s.signed!.zip}`;
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
      action: g.status === 'Valid' ? ('as-is' as const) : s.how === 'catalog' ? ('catalog' as const) : ('sign' as const),
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

/**
 * The route's pin of a signed build (npu-vendors.json's `signedBuilds`): the maker's zip, the signed copies' zip, and
 * each file signed, by its path in the server's folder, as it was and as it is signed (`signed`, by that path).
 */
export function signedBuildPin(s: Listed, zip: { size: number; sha256: string }, signed: Record<string, { size: number; sha256: string }>, made: string): NpuSignedBuild {
  const copies: NpuSignedBuild['copies'] = {};
  for (const f of s.files.filter((x) => x.action === 'sign')) {
    const now = signed[f.path];
    if (!now) throw new Error(`${s.id}: ${f.path} wasn't signed`);
    copies[f.path] = { stock: { size: f.size, sha256: f.sha256 }, signed: now };
  }
  return {
    serverVersion: s.version,
    files: { ...s.download, folder: s.folder! },
    signed: { file: s.signed!.zip, url: hostOf(s), size: zip.size, sha256: zip.sha256 },
    copies,
    basis: `tools/sign-binaries.ts, ${made}: ${s.name} ${s.version}'s ${Object.keys(copies).length} unsigned files (${s.exe} from its installer, the rest from ${s.download.file}), signed by Castellan and otherwise unchanged`,
  };
}

const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const howSaid = (s: Source) => (s.how === 'signed-copy' ? 'signed copy' : s.how === 'signed-build' ? 'signed build' : `catalog ${s.catalog}`);

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
      return `| ${s.name} | ${s.version} | ${howSaid(s)} | ${s.missing ? 'not read yet' : `${n} to ${s.how === 'catalog' ? 'list' : 'sign'}, ${s.files.length - n} its maker signed`} | ${hostOf(s)} |`;
    }),
    '',
    '## Signed by their makers, or by Castellan already: as they are',
    '',
    ...asIs.map((a) => `- ${a.what}: ${a.signer}`),
    '',
  ];
  for (const s of listed) {
    const title = s.how === 'signed-copy' ? 'a signed copy' : s.how === 'signed-build' ? "Castellan's signed copies of its own files, over its maker's zip" : `Castellan's catalog ${s.catalog}`;
    lines.push(`## ${s.name} ${s.version}: ${title}`, '');
    lines.push(`- For: ${s.what}`, `- Licence: ${s.licence}`, `- From: ${s.download.url} (${mb(s.download.size)}, SHA-256 ${s.download.sha256})`, `- Hosted: ${hostOf(s)}`, '');
    if (s.how === 'signed-build')
      lines.push(
        `Setup downloads ${s.download.file} from Qualcomm's release, unchanged, takes its ${s.folder} folder as GenieX's folder, and lays the signed copies over it: no installer runs, and no administrator is asked. ${s.exe}, which the zip lacks, is the installer's copy of it, signed. The files its maker signed (Qualcomm's QAIRT runtime, Microsoft's) stay as Qualcomm ships them and aren't copied. The zip carries the notices of GenieX (LICENSE, NOTICE), its QAIRT plugin (LICENSE.txt, THIRD_PARTY_NOTICES.md), geniex-proc (LICENSE.txt, NOTICE, THIRD_PARTY_NOTICES.md) and llama.cpp (LICENSE, licenses\\LICENSE-jsonhpp), each at the commit GenieX's tag builds from.`,
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

/**
 * The files a source's catalog or signed copy is made from, its zip unpacked; a signed build's put together as setup
 * puts it (the zip's server folder, its program from the maker's installed copy of the version).
 */
async function filesOf(s: Source, installed: Map<string, string>): Promise<{ dir: string; files: string[] } | { missing: string }> {
  const dl = await fetched(s);
  const dir = path.join(OUT, 'unpacked', s.id);
  rmSync(dir, { recursive: true, force: true });
  if (s.how !== 'signed-build') {
    unpack(dl, dir);
    return { dir, files: peFilesIn(dir) };
  }
  const from = installed.get(s.version);
  if (!from) return { missing: `its ${s.exe} is the installer's: a PC with ${s.name} ${s.version} installed gives its folder (--installed ${s.version}=<its folder>)` };
  const zip = `${dir}.zip`;
  rmSync(zip, { recursive: true, force: true });
  unpack(dl, zip);
  if (!existsSync(path.join(zip, s.folder!))) throw new Error(`${s.download.file} has no ${s.folder} folder`);
  cpSync(path.join(zip, s.folder!), dir, { recursive: true });
  rmSync(zip, { recursive: true, force: true });
  copyFileSync(path.join(from, s.exe!), path.join(dir, s.exe!));
  return { dir, files: peFilesIn(dir) };
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
    listed.push({ ...s, host: hostOf(s), files: files.map((f) => ({ ...f, path: path.relative(got.dir, f.path), sha256: sha256(f.path) })) });
    console.log(`${s.name} ${s.version}: ${files.length} program files, ${files.filter((f) => f.action !== 'as-is').length} to ${s.how === 'catalog' ? 'list' : 'sign'}`);
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

/**
 * The notices GenieX's signed copies carry: its own, and those of the sources it builds, each at the commit the one
 * before it names (a submodule: GenieX's tag names its QAIRT plugin's and llama.cpp's, the plugin's names geniex-proc's).
 */
export const GENIEX_NOTICES: { name: string; repo: string; from?: { repo: string; path: string }; files: string[] }[] = [
  { name: 'GenieX', repo: 'qualcomm/GenieX', files: ['LICENSE', 'NOTICE'] },
  { name: 'geniex-qairt-plugin', repo: 'qualcomm/geniex-qairt-plugin', from: { repo: 'qualcomm/GenieX', path: 'third-party/geniex-qairt' }, files: ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md'] },
  { name: 'geniex-proc', repo: 'qualcomm/geniex-proc', from: { repo: 'qualcomm/geniex-qairt-plugin', path: 'third-party/geniex-proc' }, files: ['LICENSE.txt', 'NOTICE', 'THIRD_PARTY_NOTICES.md'] },
  { name: 'llama.cpp', repo: 'ggml-org/llama.cpp', from: { repo: 'qualcomm/GenieX', path: 'third-party/llama.cpp' }, files: ['LICENSE', 'licenses/LICENSE-jsonhpp'] },
];

/** GenieX's notices at `version`, from GitHub, into `into`\<name>\: each source and the commit they're from. */
function fetchNotices(gh: string, version: string, into: string): { name: string; repo: string; ref: string }[] {
  const api = (...args: string[]) => execFileSync(gh, ['api', ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const refs = new Map([['qualcomm/GenieX', `v${version}`]]);
  return GENIEX_NOTICES.map((n) => {
    if (n.from) {
      const sub = JSON.parse(api(`repos/${n.from.repo}/contents/${n.from.path}?ref=${refs.get(n.from.repo)}`).toString('utf8'));
      if (sub.type !== 'submodule' || !/^[0-9a-f]{40}$/.test(sub.sha)) throw new Error(`${n.from.repo}'s ${n.from.path} at ${refs.get(n.from.repo)} isn't a submodule`);
      refs.set(n.repo, sub.sha);
    }
    const ref = refs.get(n.repo)!;
    for (const f of n.files) {
      const dest = path.join(into, n.name, ...f.split('/'));
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, api('-H', 'Accept: application/vnd.github.raw', `repos/${n.repo}/contents/${f}?ref=${ref}`));
    }
    return { name: n.name, repo: n.repo, ref };
  });
}

/** The notices folder's README: what the copies are, and where each notice is from. */
export function noticesReadme(s: Source, from: { name: string; repo: string; ref: string }[]): string {
  return [
    `Castellan's signed copies of ${s.name} ${s.version}'s own program files.`,
    '',
    `Each file is ${s.name} ${s.version}'s as Qualcomm builds it, with Castellan's Authenticode signature added and nothing else changed, so that Windows' Smart App Control lets it run. ${s.exe} is from GenieX's installer; the rest from Qualcomm's ${s.download.file}, over which the Steward's kit lays them. Qualcomm's QAIRT runtime isn't here: the kit takes it from Qualcomm's own zip, signed by Qualcomm.`,
    '',
    'Their sources, and the notices that come with them:',
    '',
    ...from.map((n) => `- ${n.name}: https://github.com/${n.repo} at ${n.ref}, in ${n.name}\\`),
    '',
  ].join('\r\n');
}

/**
 * A signed build's files signed and zipped (the server's folder's layout, in one wrapping folder, with the notices), its
 * release's notes, checksums and licences beside it: each signed file's pin, by its path, as the route pins it.
 */
function zipSignedBuild(s: Listed, dir: string, out: string, notices: string): { zip: string; signed: Record<string, { size: number; sha256: string }> } {
  rmSync(out, { recursive: true, force: true });
  const stem = s.signed!.zip.replace(/\.zip$/, '');
  const stage = path.join(out, 'stage', stem);
  const signed: Record<string, { size: number; sha256: string }> = {};
  for (const f of s.files.filter((x) => x.action === 'sign')) {
    const from = path.join(dir, f.path);
    mkdirSync(path.dirname(path.join(stage, f.path)), { recursive: true });
    copyFileSync(from, path.join(stage, f.path));
    signed[f.path] = { size: statSync(from).size, sha256: sha256(from) };
  }
  cpSync(notices, path.join(stage, 'notices'), { recursive: true });
  const zip = path.join(out, s.signed!.zip);
  const r = spawnSync(tarExe, ['-a', '-c', '-f', zip, '-C', path.dirname(stage), stem], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar couldn't zip ${s.signed!.zip}: ${r.stderr || r.error?.message}`);
  rmSync(path.join(out, 'stage'), { recursive: true, force: true });
  // Each source's licence beside the zip too, as the release shows it.
  for (const n of GENIEX_NOTICES) {
    const lic = n.files.find((f) => /^LICENSE(\.txt)?$/i.test(f));
    if (lic) copyFileSync(path.join(notices, n.name, lic), path.join(out, `LICENSE-${n.name}${path.extname(lic)}`));
  }
  writeFileSync(path.join(out, 'checksums.sha256'), `${sha256(zip)}  ${s.signed!.zip}\n`);
  writeFileSync(
    path.join(out, 'notes.md'),
    [
      `${s.name} ${s.version}'s own program files (${Object.keys(signed).length}), signed by Castellan so that Windows' Smart App Control lets them run: the staff's local models on a Snapdragon's NPU, with the Steward's kit 2.108.0 and later.`,
      '',
      `Each is GenieX's file, unchanged but for the signature. The kit lays them over Qualcomm's own [${s.download.file}](${s.download.url}), downloaded from Qualcomm's release, whose QAIRT runtime Qualcomm signs; GenieX's installer never runs.`,
      '',
      "Licences: BSD-3-Clause (GenieX, its QAIRT plugin, geniex-proc) and MIT (llama.cpp's libraries in it). Each source's notices, at the commit GenieX's tag builds from, are in the zip's notices folder, and their licences beside it.",
      '',
    ].join('\n'),
  );
  return { zip, signed };
}

/** The signing sitting: helpers, signed copies, signed builds, catalogs, then every signature checked. */
async function sitting(installed: Map<string, string>): Promise<void> {
  const listed = await makeList(installed);
  const missing = listed.filter((s) => s.missing);
  if (missing.length) throw new Error(`not every source's files are read: ${missing.map((s) => `${s.id} (${s.missing})`).join('; ')}`);
  const node = process.execPath;
  const run = (script: string, args: string[]) => {
    const r = spawnSync(node, [path.join(root, 'tools', script), ...args], { stdio: 'inherit', windowsHide: true, cwd: root });
    if (r.status !== 0) throw new Error(`${script} ${args.join(' ')} failed`);
  };
  // 0. GenieX's notices, before anything is signed: a source GitHub can't give stops the sitting with nothing spent.
  const builds = listed.filter((s) => s.how === 'signed-build');
  const notices = new Map<string, { dir: string; from: { name: string; repo: string; ref: string }[] }>();
  for (const s of builds) {
    const dir = path.join(OUT, 'notices', s.id);
    rmSync(dir, { recursive: true, force: true });
    const from = fetchNotices(gh(), s.version, dir);
    writeFileSync(path.join(dir, 'README.txt'), noticesReadme(s, from));
    notices.set(s.id, { dir, from });
  }
  // 1. The kit's helpers, the catalog helper among them: its first file stops it at once if SimplySign isn't connected.
  run('sign-helpers.ts', []);
  // 2. The signed copies.
  const copies = listed.filter((s) => s.how === 'signed-copy');
  for (const build of [...new Set(copies.map((s) => s.build!))]) run('sign-llama.ts', [build, `--variants=${copies.filter((s) => s.build === build).map((s) => s.variant).join(',')}`]);
  // 3. The signed builds: each put together again as listed, its unsigned files signed.
  const assembled = new Map<string, string>();
  for (const s of builds) {
    const got = await filesOf(s, installed);
    if ('missing' in got) throw new Error(`${s.id}: ${got.missing}`);
    for (const f of s.files.filter((x) => x.action === 'sign')) {
      const now = sha256(path.join(got.dir, f.path));
      if (now !== f.sha256) throw new Error(`${s.id}: ${f.path} is ${now}, not the listed ${f.sha256}`);
    }
    sign(s.files.filter((x) => x.action === 'sign').map((f) => path.join(got.dir, f.path)));
    assembled.set(s.id, got.dir);
  }
  // 4. The catalogs, made and signed.
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
  // 5. Every signature checked: the helpers', each signed copy's and signed build's files', each catalog's and its every file's.
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
  // A signed build's files Castellan signed (Qualcomm's own are signed in Microsoft's catalogs, which verify /pa doesn't look in).
  for (const s of builds) for (const f of s.files.filter((x) => x.action === 'sign')) check(path.join(assembled.get(s.id)!, f.path));
  for (const m of made) {
    check(m.cat);
    for (const f of m.members) check(f, m.cat);
  }
  if (failed.length) throw new Error(`${failed.length} of ${checked} not valid:\n${failed.join('\n')}`);
  console.log(`signtool verify /pa: all ${checked} valid`);
  // 6. The signed builds zipped with their notices, the catalogs into the kit, and every pin.
  const day = new Date().toISOString().slice(0, 10);
  const buildPins = builds.map((s) => {
    const out = path.join(root, 'artifacts', 'geniex', s.version);
    const z = zipSignedBuild(s, assembled.get(s.id)!, out, notices.get(s.id)!.dir);
    return { route: 'qualcomm', signedBuild: signedBuildPin(s, { size: statSync(z.zip).size, sha256: sha256(z.zip) }, z.signed, day) };
  });
  const kitCats = path.join(root, 'kit', 'node', 'catalogs');
  mkdirSync(kitCats, { recursive: true });
  const catPins = made.map((m) => {
    copyFileSync(m.cat, path.join(kitCats, m.s.catalog!));
    return { route: m.s.route, pin: catalogPin(m.s, { size: statSync(m.cat).size, sha256: sha256(m.cat) }) };
  });
  writeFileSync(path.join(OUT, 'pins.json'), `${JSON.stringify([...catPins, ...buildPins], null, 2)}\n`);
  console.log(`Signed and checked. The catalogs are in ${kitCats}; GenieX's signed builds in artifacts\\geniex\\<version>\\; every pin in ${path.join(OUT, 'pins.json')}; the signed copies' download pins in artifacts\\llama\\<build>\\downloads.json.`);
  console.log("To publish the signed copies and builds, after the owner's OK on the list: node tools/sign-binaries.ts --publish");
}

const gh = () => (spawnSync('gh', ['--version'], { windowsHide: true }).status === 0 ? 'gh' : 'C:\\tools\\gh\\bin\\gh.exe');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const installed = installedHere();
  for (const a of args.filter((x, i) => args[i - 1] === '--installed')) {
    const [v, folder] = a.split(/=(.*)/s);
    if (!v || !folder || !existsSync(folder)) throw new Error(`--installed ${a}: give <version>=<its folder>`);
    installed.set(v, folder);
  }
  if (args.includes('--publish')) {
    const all = sources();
    for (const build of [...new Set(all.filter((s) => s.how === 'signed-copy').map((s) => s.build!))]) draftRelease(gh(), build, path.join(root, 'artifacts', 'llama', build));
    for (const s of all.filter((x) => x.how === 'signed-build'))
      draftRelease(gh(), s.version, path.join(root, 'artifacts', 'geniex', s.version), { tag: s.signed!.tag, title: `${s.name} ${s.version} (Castellan's signed copies)`, first: 'node tools/sign-binaries.ts --sign' });
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
