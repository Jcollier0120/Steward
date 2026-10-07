import { HIRE_KIT_DIR, PART_DIRS } from '../../src/kitfiles.ts';

/**
 * The kit as every hire carried it before kit 1.0.0: a copy in each repo, at these paths. History, kept for the tools
 * that turned those hires into ones that take the Steward's kit (tools/convert.ts, tools/kit-from.ts): every hire has
 * been converted, so the Steward itself no longer looks for them. Only in the hires that carried it (OLD_KIT_HIRES):
 * another agent's files at these paths are its own.
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
 * The hires that carried that copy of the kit, by id (their package.json's name): the kit was seeded from them. History,
 * so a fixed list. Only in these do OLD_KIT_PATHS mean the old kit: Reeve, say, has src/accelerators.ts, src/duty.ts,
 * src/install.ts, tools/release.ts and their tests of its own, which tools/convert.ts never removes.
 */
export const OLD_KIT_HIRES = ['porter', 'auditor', 'clerk', 'herald', 'warrener', 'aletaster', 'miller', 'pinder'];

/** Whether an agent (by id, or a package.json's name) is one of the hires that carried the old kit. */
export const carriedOldKit = (id: string | null | undefined) => !!id && OLD_KIT_HIRES.includes(id);
