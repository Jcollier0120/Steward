import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The kit's layout. The kit tree (the Steward's kit\) holds:
 * - VERSION and CHANGELOG.md;
 * - its parts, each a folder, which an agent takes as kit.json's "parts" say:
 *   - node\: the TypeScript modules, at a hire's src\kit\ (kit\node\npu.ts is src\kit\npu.ts);
 *   - web\: browser files any agent's page can use, at src\kit\web\;
 *   - spec\: the language-neutral rules (documents and test vectors), at src\kit\spec\;
 * - test\: the kit's own tests, run here against a fixture agent (test\fixture). Agents never get them.
 */

/** The kit tree's own files, beside its parts and test\. */
export const KIT_META = ['VERSION', 'CHANGELOG.md', 'LICENSE'];

/** The kit's parts, and where each lands in a Node agent. */
export const PARTS = ['node', 'web', 'spec'] as const;
export type Part = (typeof PARTS)[number];
export const PART_DIRS: Record<Part, string> = { node: 'src/kit', web: 'src/kit/web', spec: 'src/kit/spec' };

/** Where a Node agent keeps the kit: filled by its tools/kit.ts, git-ignored. */
export const HIRE_KIT_DIR = 'src/kit';

/** The fixture agent the kit's tests run against, inside the kit tree. */
export const FIXTURE_DIR = 'test/fixture';

/** Where a kit-tree file lands in a Node agent (node/npu.ts is src/kit/npu.ts), or null for one that stays here. */
export function hirePathOf(kitPath: string): string | null {
  const p = kitPath.replace(/\\/g, '/');
  const part = PARTS.find((x) => p.startsWith(`${x}/`));
  return part ? `${PART_DIRS[part]}/${p.slice(part.length + 1)}` : null;
}

/** The kit-tree path of a file a Node agent has under src/kit (src/kit/web/x.js is web/x.js), or null. */
export function kitPathOfHire(hirePath: string): string | null {
  const p = hirePath.replace(/\\/g, '/');
  for (const part of ['spec', 'web', 'node'] as const) {
    const dir = `${PART_DIRS[part]}/`;
    if (p.startsWith(dir)) return `${part}/${p.slice(dir.length)}`;
  }
  return null;
}

/**
 * The kit as every hire carried it before kit 1.0.0: a copy in each repo, at these paths. History, so a
 * fixed list: `steward staff` flags a hire that still tracks any of them, and tools/convert.ts removes them.
 * Only in the hires that carried it (OLD_KIT_HIRES): another employee's files at these paths are its own.
 */
export const OLD_KIT_PATHS = [
  'src/accelerators.ts',
  'src/duty.ts',
  'src/gpu-load.ps1',
  'src/install.ts',
  'src/lock.ts',
  'src/npu-queue.ts',
  'src/npu.ts',
  'src/page.ts',
  'src/ps.ts',
  'src/schedule.ts',
  'src/server.ts',
  'src/service.ts',
  'src/settings-kit.ts',
  'src/settings-panel.js',
  'src/store.ts',
  'tools/release.ts',
  'test/accelerators.test.ts',
  'test/install.test.ts',
  'test/kit.test.ts',
  'test/npu-queue-vectors.json',
  'test/npu-queue.test.ts',
  'test/settings-kit.test.ts',
];

/**
 * Where an old kit file is now, in a hire: src/npu.ts is src/kit/npu.ts, tools/release.ts is
 * src/kit/release.ts, src/settings-panel.js is src/kit/web/settings-panel.js, and the queue's vectors are
 * the spec's. Null for the old kit tests, which run in the Steward now.
 */
export function newPathOfOld(oldPath: string): string | null {
  const p = oldPath.replace(/\\/g, '/');
  if (p === 'tools/release.ts') return `${HIRE_KIT_DIR}/release.ts`;
  if (p === 'src/settings-panel.js') return `${PART_DIRS.web}/settings-panel.js`;
  if (p === 'test/npu-queue-vectors.json') return `${PART_DIRS.spec}/npu-queue-vectors.json`;
  if (p.startsWith('src/') && OLD_KIT_PATHS.includes(p)) return `${HIRE_KIT_DIR}/${p.slice(4)}`;
  return null;
}

/** The old kit files among a hire's tracked files. */
export const oldKitFilesIn = (tracked: string[]) => tracked.map((f) => f.replace(/\\/g, '/')).filter((f) => OLD_KIT_PATHS.includes(f)).sort();

/**
 * The hires that carried that copy of the kit, by id (their Settings id and their package.json's name): the
 * kit was seeded from them. History, so a fixed list. Only in these do OLD_KIT_PATHS mean the old kit: Reeve,
 * say, has src/accelerators.ts, src/duty.ts, src/install.ts, tools/release.ts and their tests of its own,
 * which neither `staff` nor `bump` take for the old kit and tools/convert.ts never removes.
 */
export const OLD_KIT_HIRES = ['porter', 'auditor', 'clerk', 'herald', 'warrener', 'aletaster', 'miller', 'pinder'];

/** Whether an employee (by id, or a package.json's name) is one of the hires that carried the old kit. */
export const carriedOldKit = (id: string | null | undefined) => !!id && OLD_KIT_HIRES.includes(id);

/** Text with CRLF made LF, as git stores it here. */
export const lf = (text: string) => text.replace(/\r\n/g, '\n');

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Every file under `dir`, as forward-slash paths relative to it; folders named in `skip` are left out. */
export function filesUnder(dir: string, skip: string[] = ['node_modules', '.git', 'artifacts'], rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!skip.includes(e.name)) out.push(...filesUnder(dir, skip, r));
    } else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

/** A kit tree's version: its VERSION file, or null when there's none. */
export function kitVersionOf(dir: string): string | null {
  const f = path.join(dir, 'VERSION');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() || null : null;
}

/** The files of a kit tree's parts (paths in the tree: node/npu.ts, web/settings-panel.js, ...): what a kit release carries. */
export const partFiles = (kitDir: string, parts: readonly Part[] = PARTS) =>
  parts.flatMap((p) => (existsSync(path.join(kitDir, p)) ? filesUnder(path.join(kitDir, p)).map((f) => `${p}/${f}`) : []));

/**
 * kit.json's text, as tools/convert.ts writes it and a bump keeps it: one key a line, lists on one line.
 * {"kit": "1.0.0", "parts": ["node", "web", "spec"]}, and any other keys after them, as they were.
 */
export function pinText(pin: Record<string, unknown>): string {
  const { kit, parts, ...rest } = pin;
  const entries = Object.entries({ kit, parts, ...rest }).filter(([, v]) => v !== undefined);
  const one = (v: unknown) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
  return `{\n${entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${one(v)}`).join(',\n')}\n}\n`;
}

/** A kit version: x.y.z. */
export const KIT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * The changelog's entries for the versions after `from` up to and including `to`, newest first: each
 * `## <version>` section of CHANGELOG.md. `from` null takes everything up to `to`.
 */
export function changelogBetween(changelog: string, from: string | null, to: string): string {
  const sections = lf(changelog).split(/^(?=## )/m).filter((s) => s.startsWith('## '));
  const versionOf = (s: string) => /^## \[?v?(\d+\.\d+\.\d+)/.exec(s)?.[1] ?? '';
  return sections
    .filter((s) => {
      const v = versionOf(s);
      return v && compareVersions(v, to) <= 0 && (from === null || compareVersions(v, from) > 0);
    })
    .map((s) => s.trim())
    .join('\n\n');
}

/** -1, 0 or 1, comparing x.y.z versions number by number. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}
