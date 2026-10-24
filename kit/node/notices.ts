/**
 * THIRD-PARTY-NOTICES.txt (kit 2.128.0): the licenses of what others made that a staff member's release carries, kept
 * with every copy as their makers ask (an MIT license's "this permission notice shall be included"), as Manor's release
 * keeps its own (Manor's tools/notices.ts). release.ts writes it at the zip's top level, made from what the zip carries:
 *
 * - the npm packages bundled into the agent's page (react-page.ts' releasePage: esbuild's own list of what it took from
 *   node_modules), each with its license files from node_modules. The bundle leaves their license comments out
 *   (legalComments 'none'), so this file is where they're kept;
 * - each folder the zip carries that holds license or notice files of its own (the kit's build of GenieX's plugin in
 *   src\kit\geniex, OpenVINO GenAI's notice in src\kit\openvino): those files;
 * - the native files' notices (kit.json's "native" "notices", spec/RELEASES.md).
 *
 * A release that carries something of others' with no notice for it isn't built (unnoticed): a bundled package with no
 * license file; a program, library or font (BINARY) outside the kit's own builds (src\kit\prebuilt) with no license or
 * notice file in its folder or one above it; or native files whose kit.json lists no notices.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const NOTICES = 'THIRD-PARTY-NOTICES.txt';

/** A license or notice file, by its name: LICENSE, LICENSE.txt, NOTICE, COPYING, third-party-programs.txt... */
export const isLicenseFile = (name: string) => /^(licen[cs]e|notice|copying|third[-_]party[-_](notices|programs))(\.(txt|md))?$/i.test(name);

/** What runs or draws from a file, which someone made: a program, a library, a module, a font. */
export const BINARY = /\.(dll|exe|node|wasm|woff2?|ttf|otf)$/i;

/** The folders of the kit's own builds, in a release (paths from its root, with /): built from the kit's own sources. */
export const OWN_BUILDS = ['src/kit/prebuilt'];

/** Folders whose license is the release's own, not a part's: the agent's (its root) and the kit's (MIT). */
const OWN_LICENSES = ['', 'src/kit'];

/** One thing a release carries that someone else made: the heading its notice is under, where it is, and its texts. */
export interface Part {
  /** "react 19.3.0": its name and version; or its folder. */
  heading: string;
  where: string;
  license: string;
  texts: { file: string; text: string }[];
}

/** An npm package a page's bundle took from node_modules. */
export interface BundledPackage {
  dir: string;
  name: string;
  version: string;
  license: string;
}

const RULE = '='.repeat(100);

/** A bundled file's package folder: the last node_modules/<name> (or @scope/name) in its path; null for the agent's own. */
export function packageDir(input: string): string | null {
  const p = input.replaceAll('\\', '/');
  const at = p.lastIndexOf('node_modules/');
  if (at < 0) return null;
  const rest = p.slice(at + 'node_modules/'.length).split('/');
  return `${p.slice(0, at)}node_modules/${rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0]}`;
}

/** The npm packages a bundle carries, by esbuild's metafile inputs (paths from `base`, its working folder). */
export function bundledPackages(inputs: string[], base: string): BundledPackage[] {
  const dirs = new Set<string>();
  for (const input of inputs) {
    const d = packageDir(input);
    if (d) dirs.add(path.resolve(base, d));
  }
  return [...dirs].sort().map((dir) => {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')) as { name?: string; version?: string; license?: unknown };
    return { dir, name: pkg.name ?? path.basename(dir), version: pkg.version ?? '', license: typeof pkg.license === 'string' ? pkg.license : 'see its license files, below' };
  });
}

/** A folder's license and notice files, licenses first, with their text. */
function licenseTexts(dir: string): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && isLicenseFile(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(/notice|third/i.test(a)) - Number(/notice|third/i.test(b)) || a.localeCompare(b))
    .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '') }));
}

/** Every file under `dir`, as paths from it with /. */
function filesUnder(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

const within = (f: string, dir: string) => dir === '' || f.startsWith(`${dir}/`);
const windows = (p: string) => p.replaceAll('/', '\\');

/**
 * What a staged release carries of others' with no notice for it, in words: its programs, libraries and fonts outside
 * the kit's own builds, with no license or notice file in their folder or one above it (`licensed`); native files
 * (under `native.out`) when kit.json lists no notices for them. Empty when everything has one.
 */
export function unnoticed(files: string[], o: { licensed: string[]; native: { out: string; notices: string[] } | null }): string[] {
  const out: string[] = [];
  for (const f of files.filter((f) => BINARY.test(f))) {
    if (OWN_BUILDS.some((d) => within(f, d))) continue;
    if (o.native && within(f, o.native.out)) {
      if (!o.native.notices.length) out.push(`${windows(f)}, a native file, with no notices in kit.json's "native"`);
      continue;
    }
    if (!o.licensed.some((d) => within(f, d))) out.push(`${windows(f)}, with no license or notice file beside it`);
  }
  return out;
}

/**
 * The parts a staged release carries, with their texts: the page's bundled packages, each folder (but the agent's own
 * and the kit's) with license or notice files of its own, and the native files' notices (`native.staged`, their paths
 * in the stage). Throws, in words, when one has no notice.
 */
export function partsOf(stage: string, o: { name: string; packages: BundledPackage[]; native: { out: string; notices: string[]; staged: string[] } | null }): Part[] {
  const parts: Part[] = [];
  const missing: string[] = [];
  for (const p of o.packages) {
    const texts = licenseTexts(p.dir);
    if (!texts.length) missing.push(`the npm package ${p.name} ${p.version}, bundled into its page, with no license file in ${p.dir}`);
    else parts.push({ heading: `${p.name} ${p.version}`, where: `Bundled into ${o.name}'s page (src\\web\\page.js in its app folder).`, license: p.license, texts });
  }
  const files = filesUnder(stage);
  const nativeNotices = o.native ? `${o.native.out}/notices` : null;
  const licensed = [...new Set(files.filter((f) => isLicenseFile(path.posix.basename(f))).map((f) => path.posix.dirname(f).replace(/^\.$/, '')))]
    .filter((d) => !OWN_LICENSES.includes(d) && d !== nativeNotices)
    .sort();
  for (const d of licensed) {
    const texts = licenseTexts(path.join(stage, d));
    parts.push({ heading: windows(d), where: `In ${windows(d)} in ${o.name}'s app folder.`, license: `as in its ${texts.map((t) => t.file).join(' and ')}, below`, texts });
  }
  if (o.native?.staged.length) {
    const texts = o.native.staged.map((f) => ({ file: path.posix.basename(f), text: readFileSync(path.join(stage, f), 'utf8').replace(/^﻿/, '') }));
    parts.push({ heading: `${o.name}'s native files`, where: `In ${windows(o.native.out)} in ${o.name}'s app folder, with these notices in ${windows(o.native.out)}\\notices.`, license: 'as in its notices, below', texts });
  }
  missing.push(...unnoticed(files, { licensed, native: o.native }));
  if (missing.length) throw new Error(`Not built: it carries what others made with no notice for it: ${missing.join('; ')}.`);
  return parts;
}

/** The headings in a notices file: each line between two rules. */
export function headings(text: string): string[] {
  const lines = text.split(/\r?\n/);
  return lines.flatMap((l, i) => (l === RULE && lines[i + 2] === RULE && lines[i + 1] ? [lines[i + 1].trim()] : []));
}

/** The file's text: a heading between two rules for each part, where it is, its license, then its files. */
export function noticesText(name: string, parts: Part[]): string {
  const head = [
    'THIRD-PARTY NOTICES',
    '',
    `${name} carries software that others made. Each part is below, under its name: where ${name} carries it, its license,`,
    'and the license and notice files its maker asks to be kept with every copy.',
    ...(parts.length ? [] : ['', 'This release carries none.']),
    '',
    `${name}'s own code is under the LICENSE beside this file. The parts all the staff share, the kit (src\\kit), are under`,
    'the MIT license, in src\\kit\\LICENSE.',
    '',
    'Made by its release (the Steward\'s kit, notices.ts) from what it carries; do not edit it by hand.',
  ];
  const body = parts.flatMap((p) => [
    '',
    RULE,
    p.heading,
    RULE,
    p.where,
    `License: ${p.license}`,
    ...p.texts.flatMap((t) => ['', `--- ${t.file} ---`, '', t.text.replace(/\r\n/g, '\n').trimEnd()]),
  ]);
  return [...head, ...body].join('\n').replace(/\n/g, '\r\n') + '\r\n';
}

/** Writes THIRD-PARTY-NOTICES.txt at the stage's top level (partsOf, noticesText): its parts' headings. */
export function writeNotices(stage: string, o: Parameters<typeof partsOf>[1]): string[] {
  const parts = partsOf(stage, o);
  writeFileSync(path.join(stage, NOTICES), noticesText(o.name, parts));
  return parts.map((p) => p.heading);
}
