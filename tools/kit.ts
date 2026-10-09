#!/usr/bin/env node
/**
 * Fills src\kit\ with the Steward's kit (https://github.com/Jcollier0120/Steward), at the version and with
 * the parts kit.json pins: {"kit": "2.0.0", "parts": ["node", "web", "spec"]}. The node part lands in
 * src\kit\, web in src\kit\web\, spec in src\kit\spec\, core in src\kit\core\, dotnet in src\kit\dotnet\ and
 * react in src\kit\react\. A part brings the parts it needs, so a pin needn't name them: node runs the core, and
 * the core (and dotnet's C#, which runs it too) takes its timings from the spec's rules.json; react, a page drawn
 * in the browser, is served by node with web's Settings panel. A kit from before 2.0.0
 * has no core, and then none is filled. The kit's MIT license comes beside its VERSION, as src\kit\LICENSE (a kit
 * from before 2.43.4 may have none). src\kit\ is git-ignored: never edit it here.
 *
 *   node tools/kit.ts                  the pinned kit; nothing to do when src\kit\VERSION already says it
 *   node tools/kit.ts --from <dir>     a kit tree on this PC (a Steward checkout's kit\), copied every time;
 *                                      or set STEWARD_KIT to one
 *
 * Without --from, the pinned version comes from the first of: a sibling checkout ..\Steward\kit at that
 * version; %USERPROFILE%\.steward\kits\<version>; the Steward's kit release kit-v<version> over HTTPS
 * (no sign-in), or through gh if that fails, checked against its SHA256SUMS.txt and kept in that cache.
 * The same file in every agent; the Steward's tools/kit.ts is the original. Node 22.18+, no dependencies.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.STEWARD_REPO ?? 'Jcollier0120/Steward';
/** Where the kit releases are downloaded from (a test serves its own). */
const RELEASES = process.env.STEWARD_RELEASES ?? `https://github.com/${REPO}/releases/download`;
const PARTS: Record<string, string> = { node: '', web: 'web', spec: 'spec', core: 'core', dotnet: 'dotnet', react: 'react' };
/**
 * What each part needs: node runs the core, the core takes its rules from the spec, dotnet runs the core, and a React
 * page (react) is served by node's server with web's Settings panel and themes.
 */
const NEEDS: Record<string, string[]> = { node: ['core'], core: ['spec'], dotnet: ['core'], react: ['node', 'web'] };
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const root = path.resolve(opt('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const into = path.join(root, 'src', 'kit');
const text = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim() : null);
const pinFile = path.join(root, 'kit.json');
const pin: { kit?: string; parts?: string[] } = existsSync(pinFile) ? JSON.parse(text(pinFile)!) : {};
/** The pinned parts (a Node agent's three when kit.json names none), then the parts they need. */
const pinned = pin.parts ?? ['node', 'web', 'spec'];
const parts = [...pinned];
for (let i = 0; i < parts.length; i++) for (const need of NEEDS[parts[i]] ?? []) if (!parts.includes(need)) parts.push(need);
const from = opt('--from') ?? process.env.STEWARD_KIT;

function fill(tree: string, how: string): void {
  const version = text(path.join(tree, 'VERSION'));
  if (!version) throw new Error(`${tree} isn't a kit tree: it has no VERSION`);
  rmSync(into, { recursive: true, force: true });
  const filled: string[] = [];
  for (const part of parts) {
    if (!(part in PARTS)) throw new Error(`kit.json: no kit part "${part}" (the parts are ${Object.keys(PARTS).join(', ')})`);
    if (!existsSync(path.join(tree, part))) {
      if (!pinned.includes(part)) continue; // needed by another part, but a kit from before 2.0.0 has none
      throw new Error(`${tree} has no ${part} part`);
    }
    cpSync(path.join(tree, part), path.join(into, PARTS[part]), { recursive: true });
    filled.push(part);
  }
  // PARTS says what kit.json pins, as it always has (an agent's tests may compare them); the log says what came.
  writeFileSync(path.join(into, 'PARTS'), `${pinned.join(' ')}\n`);
  writeFileSync(path.join(into, 'VERSION'), `${version}\n`);
  // The kit's own license (MIT), so an agent's release carries it with the kit; a kit tree without one fills as before.
  if (existsSync(path.join(tree, 'LICENSE'))) cpSync(path.join(tree, 'LICENSE'), path.join(into, 'LICENSE'));
  console.log(`src\\kit: the Steward's kit ${version} (${filled.join(', ')}), from ${how}`);
  if (pin.kit && version !== pin.kit) console.warn(`  kit.json pins ${pin.kit}: this is for development, and a release refuses it`);
}

/** The kit release, downloaded and checked, in the cache; its folder. */
async function download(version: string): Promise<string> {
  const cache = path.join(process.env.STEWARD_KITS ?? path.join(os.homedir(), '.steward', 'kits'), version);
  if (text(path.join(cache, 'VERSION')) === version) return cache;
  const zipName = `kit-${version}.zip`;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-kit-'));
  try {
    try {
      for (const name of [zipName, 'SHA256SUMS.txt']) {
        const res = await fetch(`${RELEASES}/kit-v${version}/${name}`, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
        writeFileSync(path.join(tmp, name), Buffer.from(await res.arrayBuffer()));
      }
    } catch (e) {
      const https = (e as Error).message;
      const gh = ['gh', 'C:\\tools\\gh\\bin\\gh.exe'].find((g) => {
        try {
          execFileSync(g, ['--version'], { stdio: 'ignore', windowsHide: true });
          return true;
        } catch {
          return false;
        }
      });
      try {
        if (!gh) throw new Error('no gh to try');
        execFileSync(gh, ['release', 'download', `kit-v${version}`, '--repo', REPO, '--pattern', zipName, '--pattern', 'SHA256SUMS.txt', '--dir', tmp, '--clobber'], { stdio: 'pipe', windowsHide: true });
      } catch (e2) {
        const why = String((e2 as { stderr?: Buffer }).stderr ?? '').trim() || (e2 as Error).message;
        throw new Error(
          `couldn't get the Steward's kit ${version}: the release kit-v${version} of ${REPO} didn't download (HTTPS: ${https}; gh: ${why}).\n` +
            `  Publish it from the Steward (npm run kit-release -- --publish), or fill from a kit tree: node tools/kit.ts --from <Steward checkout>\\kit`,
        );
      }
    }
    const zip = path.join(tmp, zipName);
    const listed = readFileSync(path.join(tmp, 'SHA256SUMS.txt'), 'utf8')
      .split(/\r?\n/)
      .map((l) => /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(l.trim()))
      .find((m) => m?.[2] === zipName)?.[1];
    const got = createHash('sha256').update(readFileSync(zip)).digest('hex');
    if (!listed || listed.toLowerCase() !== got) throw new Error(`${zipName} doesn't match its SHA256SUMS.txt`);
    const out = path.join(tmp, 'kit');
    mkdirSync(out);
    execFileSync(TAR, ['-x', '-f', zip, '-C', out], { stdio: 'ignore', windowsHide: true });
    if (text(path.join(out, 'VERSION')) !== version) throw new Error(`${zipName} holds no kit ${version}`);
    // Into place whole, by a rename: the Steward fills two agents at once, and both may download the same kit.
    // Whoever renames first wins; the other uses that copy. A folder left without its VERSION is replaced.
    mkdirSync(path.dirname(cache), { recursive: true });
    const staged = `${cache}.${process.pid}.${Date.now()}`;
    cpSync(out, staged, { recursive: true });
    if (existsSync(cache) && text(path.join(cache, 'VERSION')) !== version) rmSync(cache, { recursive: true, force: true });
    try {
      renameSync(staged, cache);
    } catch (e) {
      rmSync(staged, { recursive: true, force: true });
      if (text(path.join(cache, 'VERSION')) !== version) throw e;
    }
    return cache;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  if (from) fill(path.resolve(from), path.resolve(from));
  else {
    const version = pin.kit;
    if (!version) throw new Error(`${pinFile} pins no kit: it needs {"kit": "<version>"}`);
    const sibling = path.join(root, '..', 'Steward', 'kit');
    if (text(path.join(into, 'VERSION')) === version && text(path.join(into, 'PARTS')) === pinned.join(' ')) {
      // Already filled at the pinned version.
    } else if (text(path.join(sibling, 'VERSION')) === version) fill(sibling, sibling);
    else fill(await download(version), `the kit release kit-v${version}`);
  }
} catch (e) {
  console.error(`tools/kit.ts: ${(e as Error).message}`);
  process.exitCode = 1;
}
