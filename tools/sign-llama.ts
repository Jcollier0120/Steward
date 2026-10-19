#!/usr/bin/env node
/**
 * Signs llama.cpp's Windows builds for the kit, and publishes them (kit 2.90.0):
 *
 *   node tools/sign-llama.ts [b<number>]             artifacts\llama\<build>\: the kit's builds of ggml-org's release, signed
 *   node tools/sign-llama.ts [b<number>] --publish   and the release llama.cpp-<build> in the public releases repository, as a
 *                                                    draft: setup takes it once it's published (gh release edit --draft=false),
 *                                                    after a PC with Smart App Control on has run it
 *
 * ggml-org signs none of its builds, and Windows' Smart App Control blocks unsigned files it doesn't know (the kit's
 * app-control.ts): on 2026-10-19 the gaming desktop's blocked one of b11734's processor variants. Setup takes llama.cpp
 * only from these signed copies (setup.ts' llamaReleases), so a newer build reaches the PCs only once it's signed here,
 * after the Smith's checks on it.
 *
 * For each build the kit uses (setup.ts' LLAMA_VARIANTS) it downloads ggml-org's zip, checked against GitHub's digest,
 * signs each .exe and .dll in it that has no signature, checks that every one is then signed, and zips it again under its
 * own name. A file someone else signed stays as it is, and nothing else in a build changes. Signing takes the owner's
 * Certum certificate, whose key is in Certum's cloud: SimplySign Desktop must be connected, and only the x64 signtool
 * can reach it (SimplySign's provider has no Arm64 build). NVIDIA's CUDA runtime (CUDART_ZIP) is neither signed nor
 * copied: its files are NVIDIA's, unsigned as NVIDIA ships them and the same in every build (Smart App Control let them
 * run on the desktop where it blocked ggml's), so the kit takes it from ggml-org's release as it is.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetName, CUDART_ZIP, download, LLAMA_REPO, LLAMA_VARIANTS, parseReleases, signedLlamaTag, SIGNED_LLAMA_REPO, unpack, type Release, type ReleaseAsset } from '../src/kit/setup.ts';

export const SIGNTOOL = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe';
/** The owner's code-signing certificate (Certum, 2026-10-11 to 2027-10-11), in Cert:\CurrentUser\My. */
export const THUMBPRINT = '6B654D9C34800D4307D42ACD63B925EDA5CE8D33';
export const TIMESTAMP = 'http://time.certum.pl';

export interface Signature {
  path: string;
  /** Get-AuthenticodeSignature's Status: Valid, NotSigned, HashMismatch… */
  status: string;
  thumbprint: string;
}

/** Every .exe and .dll in a folder, its subfolders' too. */
export function peFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(exe|dll)$/i.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

/** What signing does with each file: a file with no signature is signed, a signed one stays, any other is a stop. */
export function toSign(sigs: Signature[]): { sign: string[]; signedBefore: Signature[]; bad: Signature[] } {
  return {
    sign: sigs.filter((s) => s.status === 'NotSigned').map((s) => s.path),
    signedBefore: sigs.filter((s) => s.status === 'Valid'),
    bad: sigs.filter((s) => s.status !== 'NotSigned' && s.status !== 'Valid'),
  };
}

/** Files in batches whose paths fit one command line (Windows takes 32,767 characters). */
export function batches(files: string[], maxChars = 24_000): string[][] {
  const out: string[][] = [];
  let at: string[] = [];
  let chars = 0;
  for (const f of files) {
    if (at.length && chars + f.length + 3 > maxChars) {
      out.push(at);
      at = [];
      chars = 0;
    }
    at.push(f);
    chars += f.length + 3;
  }
  if (at.length) out.push(at);
  return out;
}

export interface Built {
  variant: string;
  zip: string;
  sha256: string;
  original: ReleaseAsset;
  signed: number;
  signedBefore: number;
}

/** The release's notes, as the releases repository's FFmpeg builds have them. */
export function releaseNotes(build: string, built: Built[], cudart: ReleaseAsset | undefined, license: string): string {
  const hex = (d?: string) => (d ?? '').replace(/^sha256:/, '');
  return [
    `llama.cpp ${build}: ggml-org's Windows builds, signed. Castellan's staff fetch the one for each graphics card and processor when their local AI is set up, and check each zip by its SHA-256 below.`,
    '',
    `**What's changed:** nothing but signatures. Each .exe and .dll ggml-org left unsigned carries Castellan's Authenticode signature (Certum, timestamped), so Windows' Smart App Control lets it run; files that were signed already are as ggml-org shipped them. ${built.map((b) => `${b.variant}: ${b.signed} signed, ${b.signedBefore} already signed`).join('; ')}.`,
    '',
    `**Source:** ggml-org's release https://github.com/${LLAMA_REPO}/releases/tag/${build}, its source at https://github.com/${LLAMA_REPO}/tree/${build}.${cudart ? ` The CUDA build's runtime (${cudart.name}) is NVIDIA's, and isn't here: the staff take it from that release as it is.` : ''}`,
    '',
    `**License:** llama.cpp and ggml are MIT licensed: ${license === 'LICENSE-llama.cpp.txt' ? `${license}, beside the zips` : `${license}, in each zip`}.`,
    '',
    '**SHA-256**',
    '```',
    ...built.map((b) => `${b.sha256}  ${path.basename(b.zip)}`),
    '```',
    '',
    "<details><summary>ggml-org's zips, as published</summary>",
    '',
    '```',
    ...built.map((b) => `${hex(b.original.digest)}  ${b.original.name}`),
    ...(cudart ? [`${hex(cudart.digest)}  ${cudart.name}`] : []),
    '```',
    '',
    '</details>',
    '',
  ].join('\n');
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tarExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** Each file's Authenticode signature, all in one PowerShell (Arm64's own can read signatures; only signing needs x64). */
function signatures(files: string[], work: string): Signature[] {
  if (!files.length) return [];
  const list = path.join(work, 'files.txt');
  writeFileSync(list, files.join('\n'));
  const ps = `Get-Content -LiteralPath '${list}' | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; [pscustomobject]@{ path = [string]$_; status = [string]$s.Status; thumbprint = [string]$s.SignerCertificate.Thumbprint } } | ConvertTo-Json -Compress`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const j = JSON.parse(out);
  return Array.isArray(j) ? j : [j];
}

/** Signs the files, the first alone, so a SimplySign that isn't connected stops it at once. */
function sign(files: string[]): void {
  if (!existsSync(SIGNTOOL)) throw new Error(`no x64 signtool at ${SIGNTOOL} (the Windows SDK's signing tools)`);
  for (const batch of [files.slice(0, 1), ...batches(files.slice(1))].filter((b) => b.length)) {
    const r = spawnSync(SIGNTOOL, ['sign', '/sha1', THUMBPRINT, '/fd', 'SHA256', '/tr', TIMESTAMP, '/td', 'SHA256', '/q', ...batch], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`signtool couldn't sign ${batch.length === 1 ? path.basename(batch[0]) : `${batch.length} files`}: ${(r.stderr || r.stdout || r.error?.message || '').trim()}. Is SimplySign Desktop connected?`);
  }
}

/** A zip of ggml-org's release, checked against its digest; tried three times, as a download of hundreds of MB can drop. */
async function fetchZip(asset: ReleaseAsset, dest: string): Promise<void> {
  if (!asset.digest) throw new Error(`${asset.name}: ggml-org's release gives no digest to check it by`);
  for (let tries = 1; ; tries++) {
    try {
      return await download({ what: asset.name, url: asset.url, size: asset.size, sha256: asset.digest.replace(/^sha256:/, ''), dest, have: false });
    } catch (e: any) {
      if (tries === 3) throw new Error(`${asset.name}: ${e?.cause?.message ?? e?.message ?? e}`);
      console.log(`${asset.name}: ${e?.cause?.message ?? e?.message ?? e}; again in ${tries * 10} s`);
      await new Promise((r) => setTimeout(r, tries * 10_000));
    }
  }
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const publish = args.includes('--publish');
  const gh = spawnSync('gh', ['--version'], { windowsHide: true }).status === 0 ? 'gh' : 'C:\\tools\\gh\\bin\\gh.exe';
  const asked = args.find((a) => /^b\d+$/.test(a));
  const api = (p: string) => JSON.parse(execFileSync(gh, ['api', p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }));
  const release: Release = parseReleases([api(`repos/${LLAMA_REPO}/releases/${asked ? `tags/${asked}` : 'latest'}`)])[0];
  const build = release.tag;
  const tag = signedLlamaTag(build);
  if (publish && spawnSync(gh, ['release', 'view', tag, '--repo', SIGNED_LLAMA_REPO], { windowsHide: true, stdio: 'ignore' }).status === 0)
    throw new Error(`${SIGNED_LLAMA_REPO} has ${tag} already: a build is signed once`);
  const out = path.join(root, 'artifacts', 'llama', build);
  const work = path.join(out, 'work');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  console.log(`llama.cpp ${build}: ${LLAMA_VARIANTS.length} builds into ${out}`);

  // NVIDIA's runtime first: looked at, not copied.
  const cudart = release.assets.find((a) => a.name === CUDART_ZIP);
  if (!cudart) throw new Error(`${build} has no ${CUDART_ZIP}`);
  await fetchZip(cudart, path.join(work, cudart.name));
  unpack(path.join(work, cudart.name), path.join(work, 'cudart'));
  const runtime = toSign(signatures(peFiles(path.join(work, 'cudart')), work));
  if (runtime.bad.length) throw new Error(`${CUDART_ZIP}: ${runtime.bad.map((b) => `${path.basename(b.path)} (${b.status})`).join(', ')}`);
  console.log(`${CUDART_ZIP}: ${runtime.sign.length + runtime.signedBefore.length} files, ${runtime.sign.length} of them unsigned as NVIDIA ships them; the kit takes it from ggml-org as it is`);

  const built: Built[] = [];
  let license: string | null = null;
  for (const variant of LLAMA_VARIANTS) {
    const name = assetName(build, variant);
    const original = release.assets.find((a) => a.name === name);
    if (!original) throw new Error(`${build} has no ${name}`);
    const zip = path.join(work, name);
    await fetchZip(original, zip);
    const dir = path.join(work, variant);
    unpack(zip, dir);
    license ??= readdirSync(dir).find((f) => /^licen[cs]e(\.txt|\.md)?$/i.test(f)) ?? null;
    const plan = toSign(signatures(peFiles(dir), work));
    if (plan.bad.length) throw new Error(`${name}: ${plan.bad.map((b) => `${path.basename(b.path)} (${b.status})`).join(', ')}`);
    sign(plan.sign);
    const after = signatures(peFiles(dir), work);
    const wrong = after.filter((s) => s.status !== 'Valid' || (plan.sign.includes(s.path) && s.thumbprint.toUpperCase() !== THUMBPRINT));
    if (wrong.length) throw new Error(`${name}: not signed after signing: ${wrong.map((w) => `${path.basename(w.path)} (${w.status})`).join(', ')}`);
    const signedZip = path.join(out, name);
    const entries = readdirSync(dir);
    const r = spawnSync(tarExe, ['-a', '-c', '-f', signedZip, '-C', dir, ...entries], { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tar couldn't zip ${name}: ${r.stderr || r.error?.message}`);
    built.push({ variant, zip: signedZip, sha256: sha256(signedZip), original, signed: plan.sign.length, signedBefore: plan.signedBefore.length });
    console.log(`${name}: ${plan.sign.length} signed, ${plan.signedBefore.length} already signed, ${(statSync(signedZip).size / 1048576).toFixed(0)} MB`);
  }
  // MIT asks for its notice with every copy: llama.cpp's LICENSE at this build, beside the zips (theirs carry none).
  const licenseFile = path.join(out, 'LICENSE-llama.cpp.txt');
  if (!license) {
    const res = await fetch(`https://raw.githubusercontent.com/${LLAMA_REPO}/${build}/LICENSE`);
    if (!res.ok) throw new Error(`llama.cpp's LICENSE at ${build}: ${res.status}`);
    writeFileSync(licenseFile, await res.text());
  }
  const sums = path.join(out, 'checksums.sha256');
  writeFileSync(sums, built.map((b) => `${b.sha256}  ${path.basename(b.zip)}\n`).join(''));
  const notes = path.join(out, 'notes.md');
  writeFileSync(notes, releaseNotes(build, built, cudart, license ?? path.basename(licenseFile)));
  rmSync(work, { recursive: true, force: true });
  if (!publish) {
    console.log(`Signed. To publish: node tools/sign-llama.ts ${build} --publish`);
    return;
  }
  const r = spawnSync(gh, ['release', 'create', tag, ...built.map((b) => b.zip), ...(existsSync(licenseFile) ? [licenseFile] : []), sums, '--repo', SIGNED_LLAMA_REPO, '--title', `llama.cpp ${build} (signed)`, '--notes-file', notes, '--latest=false', '--draft'], { stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error(`gh release create ${tag} failed`);
  console.log(`Drafted ${tag} in ${SIGNED_LLAMA_REPO}. Once a PC with Smart App Control on has run it: gh release edit ${tag} --repo ${SIGNED_LLAMA_REPO} --draft=false --latest=false`);
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(process.env.SIGN_LLAMA_DEBUG ? e?.stack : String(e?.message ?? e));
    process.exit(1);
  });
}
