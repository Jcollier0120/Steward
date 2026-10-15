import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { gitMaybe, showFile } from '../git.ts';
import { lf } from '../kitfiles.ts';
import { TOOL } from '../kitsource.ts';
import { dataFile, readJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import { checkoutOf, type Ctx } from './common.ts';

/**
 * What a kit's trial (trial.ts) leaves for its rollout (bump.ts): each agent that passed, and the commit of its branch
 * it was bumped from, with the kit's tree and tools/kit.ts the trial filled it with. An agent the trial passed is bumped
 * again once the kit is released, the same way, from the same commit if its branch hasn't moved: the same checks on the
 * same files, but for the version number. So where its branch is still at that commit, and the released kit and the
 * tools/kit.ts it gets are the ones tried, its checks aren't run a second time. Kept apart from trial.ts, which imports
 * bump.ts.
 */

export const kitTrialsFile = () => dataFile('kit-trials.json');

/** The part of a kept trial (trial.ts's KitTrial) a rollout reads. */
export interface TrialPasses {
  kit: string;
  /** The git tree of the PR's kit\ at the head tried. */
  tree?: string;
  /** The git blob of the PR's tools/kit.ts at that head, or null when it has none. */
  tool?: string | null;
  /** By employee id: the commit of its branch on origin it was bumped from, for each one whose checks passed. */
  mains?: Record<string, string>;
}

/** The git blob id of a file's text, as the rollout writes it (LF): what `git hash-object` says. Pure. */
export const blobOf = (text: string): string => {
  const body = Buffer.from(lf(text), 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};

/**
 * The kept trial (by its key, "<PR>@<head>") that passed this employee bumped from `base` with kit `kit`, where the
 * kit released is the tree it tried (`tree`) and the tools/kit.ts handed out (`tool`: its blob, or undefined for an
 * agent that fills its kit otherwise) is the one it tried. Null when there is none. Pure.
 */
export function passedInTrial(trials: Record<string, TrialPasses>, o: { id: string; kit: string; base: string; tree: string; tool?: string }): string | null {
  for (const [key, t] of Object.entries(trials).reverse()) {
    if (t.kit !== o.kit || !t.tree || t.tree !== o.tree || t.mains?.[o.id] !== o.base) continue;
    if (o.tool !== undefined && t.tool !== o.tool) continue;
    return key;
  }
  return null;
}

/** The Steward's own clone here: its employee's checkout, else Settings' stewardCheckout; null when there's none. */
export function stewardClone(ctx: Ctx): string | null {
  const me = ctx.settings.employees.find((e) => e.id === APP.id);
  const dirs = [me ? checkoutOf(me) : null, ctx.settings.stewardCheckout || null];
  return dirs.find((d): d is string => !!d && existsSync(path.join(d, '.git'))) ?? null;
}

const releasedTrees = new WeakMap<Ctx, Map<string, Promise<string | null>>>();

/** The git tree of kit\ in the kit's release (the tag kit-v<kit> in the Steward's repository), fetched once a stage. */
export function releasedTree(ctx: Ctx, kit: string): Promise<string | null> {
  let trees = releasedTrees.get(ctx);
  if (!trees) releasedTrees.set(ctx, (trees = new Map()));
  let tree = trees.get(kit);
  if (!tree) {
    tree = (async () => {
      const repo = stewardClone(ctx);
      if (!repo) return null;
      const tag = `refs/tags/kit-v${kit}`;
      if ((await gitMaybe(ctx.run, repo, 'fetch', '--quiet', 'origin', `+${tag}:${tag}`)) === null) return null;
      return (await gitMaybe(ctx.run, repo, 'rev-parse', `${tag}:kit`))?.trim() || null;
    })();
    trees.set(kit, tree);
  }
  return tree;
}

/**
 * The tools/kit.ts released with `kit` (at the tag kit-v<kit> in the Steward's repository, fetched as releasedTree
 * fetches it), or null when it can't be read: what a bump hands out while this Steward carries an older kit, so the
 * rollout needn't wait for Manor to install the Steward's new release (rollout.ts).
 */
export async function releasedTool(ctx: Ctx, kit: string): Promise<string | null> {
  if (!(await releasedTree(ctx, kit))) return null;
  const repo = stewardClone(ctx);
  const text = repo ? await showFile(ctx.run, repo, `refs/tags/kit-v${kit}`, TOOL) : null;
  return text ? lf(text) : null;
}

/**
 * Why the rollout's bump of `e` to `kit`, from `base`, needn't run its checks again ("kit 1.2.0's trial passed it from
 * abc1234, in #7"), or null when it must: no trial passed it from that commit, or the kit released or the tools/kit.ts
 * handed out (`tool`, its text; undefined for an agent that fills its kit otherwise) isn't the one tried.
 */
export async function trialPassOf(ctx: Ctx, e: Employee, o: { kit: string; base: string; tool?: string }): Promise<string | null> {
  const trials = readJson<Record<string, TrialPasses>>(kitTrialsFile(), {});
  if (!Object.values(trials).some((t) => t.kit === o.kit && t.mains?.[e.id] === o.base)) return null;
  const tree = await releasedTree(ctx, o.kit);
  if (!tree) return null;
  const key = passedInTrial(trials, { id: e.id, kit: o.kit, base: o.base, tree, ...(o.tool !== undefined ? { tool: blobOf(o.tool) } : {}) });
  return key ? `kit ${o.kit}'s trial passed it from ${o.base.slice(0, 7)}, in #${key.split('@')[0]}` : null;
}
