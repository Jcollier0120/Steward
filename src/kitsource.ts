import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appRoot, devCheckout } from './app.ts';
import { compareVersions, KIT_VERSION, kitVersionOf } from './kitfiles.ts';
import type { Runner } from './run.ts';
import { hostFor, must } from './hosts/index.ts';

/**
 * Which kit the Steward hands out. A kit version is released as kit-v<version> in the Steward's repository
 * (tools/kit-release.ts); that release is what every employee's tools/kit.ts fetches. A development checkout
 * of the Steward also has its own kit\ folder, which may be ahead of the releases.
 */
export interface KitInfo {
  /** The released kit versions, newest first (empty when GitHub couldn't be asked, or there are none). */
  released: string[];
  /** Why the releases couldn't be listed, if they couldn't. */
  releasesError: string | null;
  /** This checkout's kit\VERSION, when the Steward runs from a checkout. */
  local: string | null;
  /** The kit\ folder of this checkout, when there is one. */
  localDir: string | null;
}

export const latestKit = (k: KitInfo) => k.released[0] ?? null;

/**
 * The canonical tools/kit.ts, the one file every Node agent keeps beside the kit: this repository's own,
 * which a checkout has and a release carries (the kit's release.ts packs it). bump copies it into each
 * agent with the new pin, so a change to it rolls out like any kit change.
 */
export const TOOL = 'tools/kit.ts';
export const stewardToolFile = () => path.join(appRoot, 'tools', 'kit.ts');

/** The canonical tools/kit.ts's text, or null when this copy has none. */
export const stewardTool = () => (existsSync(stewardToolFile()) ? readFileSync(stewardToolFile(), 'utf8') : null);

/**
 * The kit this Steward carries: its own kit.json's pin (a checkout's, or the one its release carries), or null when it
 * has none. Its tools/kit.ts, the one a bump hands out, is the one released with that kit.
 */
export function ownKit(root = appRoot): string | null {
  try {
    const kit = JSON.parse(readFileSync(path.join(root, 'kit.json'), 'utf8').replace(/^﻿/, '')).kit;
    return typeof kit === 'string' && KIT_VERSION.test(kit) ? kit : null;
  } catch {
    return null;
  }
}

/** Whether an employee fills its kit with tools/kit.ts (the Node agents), and so takes the Steward's. */
export const takesTool = (fill: string) => /(^|[\s"'])tools[\\/]kit\.ts\b/.test(fill);

/** The kit-v<version> releases in a `gh release list --json tagName,isDraft` answer, newest version first. */
export function kitReleasesIn(json: string): string[] {
  const list = JSON.parse(json || '[]') as { tagName?: string; isDraft?: boolean }[];
  return list
    .filter((r) => !r.isDraft)
    .map((r) => /^kit-v(\d+\.\d+\.\d+)$/.exec(r.tagName ?? '')?.[1])
    .filter((v): v is string => !!v)
    .sort((a, b) => compareVersions(b, a));
}

const localKitDir = () => (devCheckout && existsSync(path.join(appRoot, 'kit', 'VERSION')) ? path.join(appRoot, 'kit') : null);

/** The kit releases from a glance at GitHub (glance.ts), which reads the Steward's releases with the employees'. */
export function kitInfoFrom(stewardReleases: { tagName: string; isDraft: boolean }[]): KitInfo {
  const localDir = localKitDir();
  return { released: kitReleasesIn(JSON.stringify(stewardReleases)), releasesError: null, local: localDir ? kitVersionOf(localDir) : null, localDir };
}

/** The kit releases, asked of GitHub on their own (when there's no glance to read them from). */
export async function kitInfo(run: Runner, cwd: string, stewardRepo: string): Promise<KitInfo> {
  const localDir = localKitDir();
  let released: string[] = [];
  let releasesError: string | null = null;
  if (!stewardRepo) return { released, releasesError: "Settings name no Steward repository (The Steward's repository), so no kit releases are looked for", local: localDir ? kitVersionOf(localDir) : null, localDir };
  try {
    released = kitReleasesIn(must(await hostFor({ run, neutralDir: cwd }).listReleases(stewardRepo, 'tagName,isDraft')));
  } catch (e) {
    releasesError = (e as Error).message;
  }
  return { released, releasesError, local: localDir ? kitVersionOf(localDir) : null, localDir };
}

/**
 * The kit version a stage works with: the one asked for, else the newest release, else (in a checkout, with
 * no release yet) this checkout's kit\VERSION. Null with a reason when there's none.
 */
export function chooseKit(k: KitInfo, asked?: string | null): { version: string; note: string | null } | { error: string } {
  if (asked) {
    if (!KIT_VERSION.test(asked)) return { error: `--kit ${asked}: a kit version is x.y.z` };
    return { version: asked, note: k.released.includes(asked) ? null : `kit ${asked} has no release kit-v${asked}` };
  }
  if (k.released.length) return { version: k.released[0], note: null };
  if (k.local) return { version: k.local, note: `no kit release on GitHub yet${k.releasesError ? ` (${k.releasesError})` : ''}; this checkout's kit\\VERSION is ${k.local}` };
  return { error: `no kit release found${k.releasesError ? ` (${k.releasesError})` : ''}; name one with --kit` };
}

/** CHANGELOG.md of this checkout's kit, when there is one. */
export function localChangelog(k: KitInfo): string | null {
  const f = k.localDir ? path.join(k.localDir, 'CHANGELOG.md') : null;
  return f && existsSync(f) ? readFileSync(f, 'utf8') : null;
}
