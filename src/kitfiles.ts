import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The kit's layout. The kit tree (the Steward's kit\) holds:
 * - VERSION and CHANGELOG.md;
 * - src\: the files a hire gets, each at src\kit\<the same name> (kit\src\npu.ts is a hire's src\kit\npu.ts);
 * - test\: the kit's own tests, run here against a fixture agent (test\fixture). Hires never get them.
 */

/** The kit tree's own files, beside src\ and test\. */
export const KIT_META = ['VERSION', 'CHANGELOG.md'];

/** Where a hire keeps the kit: filled by its tools/kit.ts, git-ignored. */
export const HIRE_KIT_DIR = 'src/kit';

/** The fixture agent the kit's tests run against, inside the kit tree. */
export const FIXTURE_DIR = 'test/fixture';

/** Where a kit-tree file lands in a hire (src/npu.ts is src/kit/npu.ts), or null for one that stays here. */
export function hirePathOf(kitPath: string): string | null {
  const p = kitPath.replace(/\\/g, '/');
  return p.startsWith('src/') ? `${HIRE_KIT_DIR}/${p.slice(4)}` : null;
}

/**
 * The kit as every hire carried it before kit 1.0.0: a copy in each repo, at these paths. History, so a
 * fixed list: `steward status` flags a hire that still tracks any of them, and tools/convert.ts removes them.
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

/** Where an old kit file's code is now, in a hire: src/npu.ts is src/kit/npu.ts, tools/release.ts is src/kit/release.ts. Null for the old kit tests. */
export function newPathOfOld(oldPath: string): string | null {
  const p = oldPath.replace(/\\/g, '/');
  if (p === 'tools/release.ts') return `${HIRE_KIT_DIR}/release.ts`;
  if (p.startsWith('src/') && OLD_KIT_PATHS.includes(p)) return `${HIRE_KIT_DIR}/${p.slice(4)}`;
  return null;
}

/** The old kit files among a hire's tracked files. */
export const oldKitFilesIn = (tracked: string[]) => tracked.map((f) => f.replace(/\\/g, '/')).filter((f) => OLD_KIT_PATHS.includes(f)).sort();

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

/** The files a hire gets from a kit tree (paths in the tree: src/npu.ts, ...). */
export const shippedFiles = (kitDir: string) => (existsSync(path.join(kitDir, 'src')) ? filesUnder(path.join(kitDir, 'src')).map((f) => `src/${f}`) : []);

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
