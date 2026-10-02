import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.ts';
import { newPathOfOld, oldKitFilesIn, OLD_KIT_PATHS, pinText } from './kitfiles.ts';
import { relocate } from './relocate.ts';
import type { Runner } from './run.ts';
import { agreedVersion, setVersion } from './versions.ts';

/**
 * Turns a hire that carries its own copy of the kit into one that takes the Steward's (tools/convert.ts):
 * the old kit files go, imports of them point into src/kit/, src/kit/ is ignored, and kit.json,
 * tools/kit.ts and test/agent.test.ts come in; npm's scripts fill the kit first; the version is raised;
 * the README says where the kit is. Everything is staged, nothing committed: the caller fills the kit,
 * runs the checks, then commits.
 */

export const STEWARD_URL = 'https://github.com/Jcollier0120/Steward';
const KIT_URL = `${STEWARD_URL}/blob/main/kit`;

export interface ConvertOptions {
  dir: string;
  kit: string;
  parts: string[];
  version: string;
  /** The text of the Steward's tools/kit.ts, the same in every agent. */
  kitTool: string;
  run: Runner;
}

export interface Converted {
  removed: string[];
  rewritten: { file: string; changes: [string, string][] }[];
  from: string;
  notes: string[];
}

const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/;

/** package.json's scripts with the kit filled first: kit, pretest, pretypecheck, serve and release. */
export function kitScripts(scripts: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { kit: 'node tools/kit.ts' };
  for (const [k, v] of Object.entries(scripts)) {
    if (k === 'kit' || k === 'pretest' || k === 'pretypecheck') continue;
    if (k === 'test') out.pretest = 'node tools/kit.ts';
    if (k === 'typecheck') out.pretypecheck = 'node tools/kit.ts';
    if (k === 'serve') out[k] = v.startsWith('node tools/kit.ts') ? v : `node tools/kit.ts && ${v}`;
    else if (k === 'release') out[k] = 'node tools/kit.ts && node src/kit/release.ts';
    else out[k] = v;
  }
  return out;
}

/** The README's references to the old kit, pointed at the Steward's. */
export function readmeLinks(text: string): string {
  const kitNames = OLD_KIT_PATHS.filter((p) => newPathOfOld(p)).map((p) => p);
  let out = text;
  for (const old of kitNames) {
    const now = newPathOfOld(old)!;
    const inKit = now.replace(/^src\/kit\/(web\/|spec\/)?/, (_m, sub: string | undefined) => (sub ? sub : 'node/'));
    const esc = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\[\`?${esc}\`?\\]\\(${esc}\\)`, 'g'), `[${now}](${KIT_URL}/${inKit})`);
    out = out.replace(new RegExp(`\`${esc}\``, 'g'), `\`${now}\``);
  }
  out = out.replace(/Manor's \[docs\/ACCELERATORS\.md\]\(https:\/\/github\.com\/Jcollier0120\/Manor\/blob\/main\/docs\/ACCELERATORS\.md\)/g, `the kit's [spec/ACCELERATORS.md](${KIT_URL}/spec/ACCELERATORS.md)`);
  out = out.replace(/Reeve's `docs\/NPU-QUEUE\.md`/g, `the kit's [spec/NPU-QUEUE.md](${KIT_URL}/spec/NPU-QUEUE.md)`);
  return out;
}

/** The README's section on the kit, for a hire called `name`. */
export function kitSection(name: string): string {
  return `## The kit

The parts every agent shares (the page and its server, Settings, install and release, the accelerators and the NPU queue) are the Steward's kit, kept once in [Jcollier0120/Steward](${STEWARD_URL}). ${name} doesn't carry the kit's code: \`kit.json\` pins a kit version and its parts, and \`npm run kit\` (\`node tools/kit.ts\`) fills \`src/kit/\`, which git ignores. \`npm test\`, \`npm run typecheck\`, \`npm run serve\` and \`npm run release\` fill it first. A release carries \`src/kit/\`, so an installed ${name} needs neither the Steward nor GitHub.

\`tools/kit.ts\` takes the pinned version from a Steward checkout beside this one (\`..\\Steward\\kit\`) when it is at that version, or else downloads the kit release \`kit-v<version>\` from GitHub (no sign-in; through \`gh\` if that fails), checks it against its SHA256SUMS.txt and keeps it in \`%USERPROFILE%\\.steward\\kits\`. To try a kit change before it's released: \`node tools/kit.ts --from ..\\Steward\\kit\` (or set \`STEWARD_KIT\`). Never edit \`src/kit/\`: change the kit in the Steward, and a new version arrives here as the Steward's PR, which changes \`kit.json\` and the version and nothing else. \`test/agent.test.ts\` runs the kit's checks of ${name} (its \`src/app.ts\`, \`src/settings.ts\`, \`package.json\` and icon, the agent interface in the Steward's README).

`;
}

/** The README with the old kit's paths pointed at the Steward, and the kit's section before Development. */
export function convertReadme(text: string, name: string): string {
  let out = readmeLinks(text);
  if (/^## The kit$/m.test(out)) return out;
  const dev = /^## Develop(ment)?\b/m.exec(out);
  if (dev) out = out.slice(0, dev.index) + kitSection(name) + out.slice(dev.index);
  else out = `${out.trimEnd()}\n\n${kitSection(name).trimEnd()}\n`;
  return out;
}

export async function convert(o: ConvertOptions): Promise<Converted> {
  const { dir, run } = o;
  const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');
  const write = (f: string, t: string) => {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), t);
  };
  const notes: string[] = [];
  const tracked = (await git(run, dir, 'ls-files')).split('\n').filter(Boolean);
  const removed = oldKitFilesIn(tracked);
  if (!removed.length) throw new Error(`${dir} tracks none of the old kit's files: is it converted already?`);
  if (existsSync(path.join(dir, 'kit.json'))) throw new Error(`${dir} has a kit.json already`);

  // 1. The old kit goes.
  await git(run, dir, 'rm', '--quiet', '--', ...removed);

  // 2. The agent's own code reaches the kit in src/kit/.
  const rewritten: Converted['rewritten'] = [];
  for (const f of tracked) {
    if (removed.includes(f) || !CODE.test(f) || !/^(src|test|tools)\//.test(f) || !existsSync(path.join(dir, f))) continue;
    const r = relocate(read(f), f, f, (t) => newPathOfOld(t) ?? t);
    if (r.changed.length) {
      write(f, r.text);
      rewritten.push({ file: f, changes: r.changed });
    }
  }

  // 3. src/kit/ is filled, not tracked; kit.json pins it; tools/kit.ts fills it; the kit checks the agent.
  const gi = existsSync(path.join(dir, '.gitignore')) ? read('.gitignore') : '';
  if (!/^\/?src\/kit\/?\s*$/m.test(gi)) write('.gitignore', `${gi.replace(/\s*$/, '\n')}src/kit/\n`);
  write('kit.json', pinText({ kit: o.kit, parts: o.parts }));
  write(path.join('tools', 'kit.ts'), o.kitTool);
  write(path.join('test', 'agent.test.ts'), "// The kit's checks of this agent: that it gives the kit what it needs (the agent interface).\nimport '../src/kit/agent-checks.ts';\n");

  // 4. npm fills the kit first.
  const pkg = JSON.parse(read('package.json'));
  pkg.scripts = kitScripts(pkg.scripts ?? {});
  write('package.json', JSON.stringify(pkg, null, 2) + '\n');

  // 5. The new version, everywhere it's kept.
  const files = ['package.json', 'package-lock.json', 'src/app.ts'].filter((f) => existsSync(path.join(dir, f)));
  const agreed = agreedVersion(files.map((f) => [f, read(f)] as [string, string]));
  if ('error' in agreed) throw new Error(agreed.error);
  for (const f of files) write(f, setVersion(f, read(f), agreed.version, o.version));

  // 6. The README says where the kit is.
  if (existsSync(path.join(dir, 'README.md'))) write('README.md', convertReadme(read('README.md'), pkg.name.charAt(0).toUpperCase() + pkg.name.slice(1)));

  await git(run, dir, 'add', '-A');
  const left = (await git(run, dir, 'grep', '-n', '-E', `from '(\\./|\\.\\./)+(${OLD_KIT_PATHS.filter((p) => p.startsWith('src/')).map((p) => p.slice(4).replace(/\./g, '\\.')).join('|')})'`, '--', 'src', 'test').catch(() => '')).trim();
  if (left) notes.push(`imports that may still reach the old kit:\n${left}`);
  return { removed, rewritten, from: agreed.version, notes };
}
