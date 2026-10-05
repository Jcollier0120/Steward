import { existsSync } from 'node:fs';
import { gh, showFile } from '../git.ts';
import { compareVersions } from '../kitfiles.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import type { Employee } from '../settings.ts';
import { bump } from './bump.ts';
import { checkoutOf, freshBranch, glanceOf, networkFailure, NOT_ON_KIT, result, type Ctx, type EmployeeResult } from './common.ts';
import { push } from './push.ts';
import { parsePrs, prListArgs, readPin } from './staff.ts';

/**
 * The rollout, in a round: a new kit reaches every employee without anyone running `steward bump` and `steward push`.
 * When the newest kit release (from the round's glance at GitHub: no call of its own) is newer than the kit an
 * employee's branch pins, and it has no kit PR of the Steward's open (steward/kit-…) and no bump to that kit that
 * failed at its branch's head, the round bumps it (a worktree of its branch, the new pin and the next patch version,
 * its checks run, committed) and pushes the PR, a few employees at a time (Settings' parallel). Later rounds merge
 * the PR and release it, as any PR of the Steward's.
 *
 * A bump or a push that fails is kept in rollout-failed.json, with the kit and the branch's head it failed at: an
 * alarm at once, and the rounds don't try that kit again until a new commit lands on the employee's branch, or a
 * person presses Bump or Push (or runs `steward bump` / `steward push`), which clears it.
 *
 * Nothing is rolled out while this Steward carries a kit older than the newest release: a bump hands out the
 * Steward's own tools/kit.ts, and that is the one released with the kit it carries. Manor installs the Steward's new
 * release (stages/self.ts releases it), and the rounds roll the kit out then.
 */

export const rolloutFailedFile = () => dataFile('rollout-failed.json');

/** A bump or push that failed in a round: for which kit, at which head of the employee's branch, and what it said. */
export interface RolloutHold {
  kit: string;
  head: string;
  stage: 'bump' | 'push';
  message: string;
  at: string;
}

export const loadRolloutFailures = (): Record<string, RolloutHold> => readJson<Record<string, RolloutHold>>(rolloutFailedFile(), {});

/** What the decision needs of one employee: read from its checkout's origin/<branch> and the glance's PRs. */
export interface RolloutFacts {
  /** Its checkout is on this PC. */
  checkout: boolean;
  /** Its branch's head on origin, or null when there's none. */
  head: string | null;
  /** The kit its branch's kit.json pins, or null when it has none. */
  pin: string | null;
  /** Its open kit PRs of the Steward's (#12 steward/kit-2.9.0). */
  kitPrs: string[];
}

export interface RolloutPlan {
  /** The kit rolled out, or null when nothing is (off, no kit release, or the Steward waits for its own update). */
  kit: string | null;
  /** Why nothing is rolled out, when nothing is: one line for the log. */
  why: string | null;
  /** True when it waits only for this Steward to carry the kit: an alarm once that lasts. */
  waitsForSteward: boolean;
  /** Bumped and pushed now, each with its branch's head. */
  bump: { employee: Employee; head: string }[];
  /** Not now, and why; `held` for one whose bump failed at this head. */
  skip: { employee: Employee; why: string; held?: boolean }[];
}

/** Whether a round's rollout can do anything at all: Settings, a kit release, the Steward carrying it. Pure. */
export function rolloutGate(o: { on: boolean; kit: string | null; ownKit: string | null }): { kit: string } | { why: string; waitsForSteward: boolean } {
  if (!o.on) return { why: '"Rolls out a new kit by itself" is off in Settings', waitsForSteward: false };
  if (!o.kit) return { why: 'no kit release to roll out', waitsForSteward: false };
  if (o.ownKit && compareVersions(o.ownKit, o.kit) < 0) {
    return { why: `kit ${o.kit} waits for this Steward to carry it (it carries ${o.ownKit}, and a bump hands out its tools/kit.ts): Manor installs the Steward's next release`, waitsForSteward: true };
  }
  return { kit: o.kit };
}

/** Which employees a round bumps to the newest kit, and why the others aren't. Pure. */
export function planRollout(o: { on: boolean; kit: string | null; ownKit: string | null; employees: Employee[]; facts: Record<string, RolloutFacts>; failed: Record<string, RolloutHold> }): RolloutPlan {
  const gate = rolloutGate(o);
  if ('why' in gate) return { kit: null, why: gate.why, waitsForSteward: gate.waitsForSteward, bump: [], skip: [] };
  const kit = gate.kit;
  const plan: RolloutPlan = { kit, why: null, waitsForSteward: false, bump: [], skip: [] };
  for (const e of o.employees) {
    const f = o.facts[e.id];
    const skip = (why: string, held?: boolean) => void plan.skip.push({ employee: e, why, ...(held ? { held } : {}) });
    if (!e.usesKit) skip(NOT_ON_KIT);
    else if (!f) skip('not looked at');
    else if (!f.checkout) skip(`no checkout at ${checkoutOf(e)}`);
    else if (!f.head) skip(`no ${e.branch} on origin`);
    else if (!f.pin) skip(`no kit.json on origin/${e.branch}`);
    else if (compareVersions(f.pin, kit) >= 0) skip(`on kit ${f.pin} already`);
    else if (f.kitPrs.length) skip(`its kit PR ${f.kitPrs.join(', ')} is open: the rounds merge it once it is ready`);
    else {
      const h = o.failed[e.id];
      if (h && h.kit === kit && h.head === f.head) skip(`its ${h.stage} to kit ${kit} failed at ${f.head.slice(0, 7)} (${h.message}), so the rounds leave it until a new commit lands on ${e.branch}, or you press ${h.stage === 'bump' ? 'Bump' : 'Push'}`, true);
      else plan.bump.push({ employee: e, head: f.head });
    }
  }
  return plan;
}

/**
 * One employee's facts for the decision: its branch fetched only when the glance says it moved (the round's release
 * step has fetched it already); its PRs from the glance, and asked of GitHub only when it is behind `kit` and the
 * glance no longer says (a merge this round).
 */
export async function rolloutFacts(ctx: Ctx, e: Employee, kit: string): Promise<RolloutFacts> {
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return { checkout: false, head: null, pin: null, kitPrs: [] };
  const head = await freshBranch(ctx, e, repo);
  const pin = head ? (readPin(await showFile(ctx.run, repo, `origin/${e.branch}`, 'kit.json'))?.kit ?? null) : null;
  if (!pin || compareVersions(pin, kit) >= 0) return { checkout: true, head, pin, kitPrs: [] };
  const g = glanceOf(ctx, e);
  const prs = parsePrs(g ? JSON.stringify(g.prs) : await gh(ctx.run, ctx.neutralDir, ...prListArgs(e.repo)), []);
  const kitPrs = prs.filter((p) => p.whose === 'steward' && p.head.startsWith('steward/kit-')).map((p) => `#${p.number} (${p.head})`);
  return { checkout: true, head, pin, kitPrs };
}

/** A manual Bump or Push (the page's button, or the command) lets the rounds try those employees again. */
export function clearRolloutHolds(ids: string[]): void {
  const failed = loadRolloutFailures();
  let changed = false;
  for (const id of ids) if (id in failed) (delete failed[id], (changed = true));
  if (changed) writeJson(rolloutFailedFile(), failed);
}

/**
 * The round's rollout, for the employees it looks at: each one's facts, the decision, then bump and push for those
 * behind the newest kit. One result for each employee it did something for (prefixed "rollout: "); a held one says so,
 * skipped. What failed is kept, and what no longer holds is let go.
 */
export async function rollout(ctx: Ctx, employees: Employee[], o: { kit: string | null; ownKit: string | null; changelog: (kit: string) => Promise<string | null> }): Promise<{ results: EmployeeResult[]; plan: RolloutPlan }> {
  const failed = loadRolloutFailures();
  const before = JSON.stringify(failed);
  const gate = rolloutGate({ on: ctx.settings.rollout, kit: o.kit, ownKit: o.ownKit });
  const facts: Record<string, RolloutFacts> = {};
  if (!('why' in gate)) {
    for (const e of employees.filter((x) => x.usesKit)) {
      try {
        facts[e.id] = await rolloutFacts(ctx, e, gate.kit);
      } catch (err) {
        ctx.log(`[${e.id}] rollout: couldn't read its branch: ${(err as Error).message}`);
      }
    }
  }
  const plan = planRollout({ on: ctx.settings.rollout, kit: o.kit, ownKit: o.ownKit, employees, facts, failed });
  if (plan.why) {
    if (plan.waitsForSteward) ctx.log(`rollout: ${plan.why}`);
    return { results: [], plan };
  }
  const kit = plan.kit!;
  const results: EmployeeResult[] = [];
  // An employee no longer in Settings is forgotten.
  for (const id of Object.keys(failed)) if (!ctx.settings.employees.some((e) => e.id === id)) delete failed[id];
  // Those it looked at that no longer hold (on the kit now, a newer kit, a new commit): let go.
  for (const s of plan.skip) if (!s.held && s.employee.id in failed) delete failed[s.employee.id];
  for (const s of plan.skip.filter((x) => x.held)) results.push(result(s.employee, 'skipped', `rollout: ${s.why}`));
  if (plan.bump.length) {
    ctx.log(`rollout: kit ${kit} for ${plan.bump.map((b) => b.employee.name).join(', ')}`);
    const heads = new Map(plan.bump.map((b) => [b.employee.id, b.head]));
    const at = new Date().toISOString();
    // The kit's changelog: each bump's entry in the employee's own, and its PR's body.
    let changelog: string | null = null;
    try {
      changelog = await o.changelog(kit);
    } catch {
      // The entry names the kit alone, and the PR's body points at the kit's changelog.
    }
    const bumped = await bump(ctx, plan.bump.map((b) => b.employee), { kit, changelog });
    const ready = bumped.filter((r) => r.outcome === 'done');
    for (const r of bumped.filter((x) => x.outcome !== 'done' && x.outcome !== 'skipped')) {
      // One the network cut short (the kit's net.ts) is tried again next round, not held until the branch moves.
      if (!(await networkFailure(ctx, r.message))) failed[r.id] = { kit, head: heads.get(r.id)!, stage: 'bump', message: r.message, at };
      results.push({ ...r, outcome: 'failed', message: `rollout: bump to kit ${kit}: ${r.message}` });
    }
    for (const r of bumped.filter((x) => x.outcome === 'skipped')) results.push({ ...r, message: `rollout: ${r.message}` });
    if (ready.length) {
      const pushed = await push(ctx, plan.bump.map((b) => b.employee).filter((e) => ready.some((r) => r.id === e.id)), { kit, changelog });
      for (const p of pushed) {
        const b = ready.find((r) => r.id === p.id)!;
        if (p.outcome === 'done') {
          delete failed[p.id];
          results.push({ ...p, message: `rollout: kit ${kit}: ${b.message}; ${p.message}`, version: b.version ?? p.version });
        } else {
          if (!(await networkFailure(ctx, p.message))) failed[p.id] = { kit, head: heads.get(p.id)!, stage: 'push', message: p.message, at };
          results.push({ ...p, outcome: 'failed', message: `rollout: push of kit ${kit}: ${p.message} (the bump is ready: ${b.message})` });
        }
      }
    }
  }
  if (JSON.stringify(failed) !== before) writeJson(rolloutFailedFile(), failed);
  return { results, plan };
}
