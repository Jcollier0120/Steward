import type { Held } from '../alarms.ts';
import { hostFor } from '../hosts/index.ts';
import type { Employee } from '../settings.ts';
import { glanceOf, result, type Ctx, type EmployeeResult } from './common.ts';
import { heldOf, mergeOne, TESTED_BESIDE } from './merge.ts';
import { notePrepared, prepareKey, preparedFor, type GlancedPr } from './prepare.ts';
import { apart, withRepo } from './slots.ts';
import { openPrs, parsePrs } from './staff.ts';

/**
 * The Steward's own PRs tested beside a build's rounds (Steward 0.36.71). Since 0.36.69 a build's round merges the
 * employees' PRs beside the Steward's own, but the round still lasted as long as the Steward's PR tests, ten minutes a
 * run: a rollout's PRs opened meanwhile, an agent's PR gone ready, waited for that round to end, and the build couldn't
 * close until it had.
 *
 * Now a build's round that finds the Steward's ready PRs moved since they were tested for this build (prepare.ts's key,
 * in build-prepared.json) starts their tests apart from it, as prepare.ts runs them between builds (merge.ts's mergeOne
 * with ctx.prepare: each tested at its head, stacked as its train or batch, a kit PR's trial started; nothing merged,
 * pushed or released), and goes on without them. While they run, the rounds leave the Steward's own repository alone,
 * its merges and its releases, and its ready PRs wait as TESTED_BESIDE, which merge.ts's waitsBriefly counts: the build
 * stays open for them, and a kit PR among them is a kit coming in this build (buildkit.ts), which the rollout waits for.
 * Once they end, a round comes at once (agent.ts: selfTestsBeside's `ended`), and merges what passed without testing it
 * again: a PR's test is kept by its head (prtest.ts), a train's or batch's pass by its tree (standin.ts).
 *
 * Only on the Steward's page (selfTestsBeside): a round in a terminal, and the tests that don't ask for it, test the
 * Steward's PRs inside the round, beside the employees' merges.
 */

let beside: { ended?: () => void; log?: (line: string) => void } | null = null;
export const selfTestsBeside = (o: typeof beside): void => void (beside = o);

/** The work's name (slots.ts's apart): heldBy(APP.id) says it while it holds the Steward's repository. */
export const SELF_TESTS = 'self tests';

/** The tests going on beside the rounds in this process: one at a time. */
type Going = { started: number; numbers: number[]; done: Promise<void> };
let going: Going | null = null;

/** Settles once the Steward's PR tests beside the rounds have ended (at once when none run). */
export const selfTestsDone = (): Promise<void> => going?.done ?? Promise.resolve();

/** What a round says of the Steward's own while its PRs are tested beside it: its line, and its ready PRs' holds. */
export interface SelfTests {
  line: EmployeeResult;
  held: Held[];
}

/**
 * In a build's round, the Steward's ready PRs' tests started beside the rounds, as the module's comment says, or going
 * on there: then the round leaves the Steward's own repository alone, and this is what it says of it. Null when the
 * round merges them itself: outside a build, not on the Steward's page, nothing moved since they were tested for this
 * build, or they couldn't be listed (the round then lists them again, as before).
 */
export async function selfTestBeside(ctx: Ctx, self: Employee, o: { kit: string | null }): Promise<SelfTests | null> {
  const build = ctx.build;
  if (!beside || !build) return null;
  const log = beside.log ?? ctx.log;
  let listed: GlancedPr[];
  const g = glanceOf(ctx, self);
  try {
    listed = (g ? g.prs : JSON.parse(await openPrs(hostFor(ctx, self), self.repo))) as GlancedPr[];
  } catch {
    return null;
  }
  const ready = parsePrs(JSON.stringify(listed), ctx.settings.team).filter((p) => !p.draft);
  const waits = (line: string, numbers: number[]): SelfTests => {
    const why = `${TESTED_BESIDE} for ${build.name}: a round merges it once its tests end`;
    return { line: result(self, 'skipped', line, ready[0] ? { url: ready[0].url } : {}), held: ready.filter((p) => numbers.includes(p.number)).map((p) => heldOf(p, why)) };
  };
  if (going) {
    const ago = Math.max(0, Math.round((Date.now() - going.started) / 60_000));
    return waits(`its PRs' tests go on beside the rounds (started ${ago} min ago): a round merges what passed once they end`, ready.map((p) => p.number));
  }
  const key = prepareKey({ head: g?.head ?? null, prs: listed, kit: o.kit });
  if (!key || preparedFor(self.id, key, build.due)) return null;
  // As the build looks, with nothing merged: a ready PR merges at once in a build (merge.ts's ageHold), and nothing releases merge by merge.
  const prep: Ctx = { ...ctx, log, settings: { ...ctx.settings, mergeMinAgeMinutes: 0, releaseAfterMerge: false }, build: null, prepare: { due: build.due, name: build.name, inBuild: true } };
  const numbers = ready.map((p) => p.number);
  const ended = beside.ended;
  const run: Going = { started: Date.now(), numbers, done: Promise.resolve() };
  going = run;
  run.done = apart(SELF_TESTS, () => withRepo(log, self.id, () => mergeOne(prep, self, { yes: true, team: true })))
    .then((r) => {
      log(`[${self.id}] tested beside the rounds of ${build.name}: ${r.message}`);
      notePrepared(self.id, { key, due: build.due, line: r.message });
    })
    .catch((err: Error) => {
      // Kept as done all the same: the next round merges them itself, testing what it must, rather than starting this again.
      log(`[${self.id}] couldn't test its PRs beside the rounds of ${build.name} (the next round tests them itself): ${err.message}`);
      notePrepared(self.id, { key, due: build.due, line: `couldn't: ${err.message}` });
    })
    .finally(() => {
      if (going === run) going = null;
      try {
        ended?.();
      } catch (err) {
        log(`couldn't ask for a round after the Steward's PR tests: ${(err as Error).message}`);
      }
    });
  const list = numbers.map((n) => `#${n}`).join(', ');
  return waits(`${list || 'its PRs'} tested beside the rounds of ${build.name}, which go on without waiting: a round merges what passed once the tests end`, numbers);
}
