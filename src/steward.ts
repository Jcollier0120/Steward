import { appendFileSync, mkdirSync } from 'node:fs';
import { dataDir } from './app.ts';
import { kitInfo, chooseKit, localChangelog, stewardTool, type KitInfo } from './kitsource.ts';
import { withLock } from './kit/lock.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { gh } from './git.ts';
import { run as realRun, type Runner } from './run.ts';
import { loadSettings, type Settings } from './settings.ts';
import { bump } from './stages/bump.ts';
import { pick, type Ctx, type EmployeeResult, type StageName, type StageResult } from './stages/common.ts';
import { afterMerge } from './stages/aftermerge.ts';
import { merge } from './stages/merge.ts';
import { push } from './stages/push.ts';
import { release } from './stages/release.ts';
import { approveMerged } from './stages/jobs.ts';
import { releaseUnreleased, roundDidSomething } from './stages/round.ts';
import { staff, type Staff } from './stages/staff.ts';

/**
 * The stages, as the command line and the page both run them: one at a time on this PC (a lock in the data
 * folder), each recorded in last-stage.json and appended to stages.log, and the staff's table refreshed
 * after each.
 */

export interface StageAsk {
  employees?: string[] | null;
  kit?: string | null;
  /** bump: start from this instead of origin/<branch> (a trial). */
  base?: string | null;
  /** bump: fill from this kit tree instead of the kit release. */
  kitFrom?: string | null;
  /** merge: merge, not only list. */
  yes?: boolean;
  /** merge: the team's PRs too, not only the Steward's. */
  team?: boolean;
}

export const lastStageFile = () => dataFile('last-stage.json');
export const staffFile = () => dataFile('staff.json');
const stageLock = () => dataFile('locks', 'stage');

export const loadLastStage = () => readJson<StageResult | null>(lastStageFile(), null);
export const loadStaff = () => readJson<Staff | null>(staffFile(), null);

export async function context(o: { settings?: Settings; run?: Runner; log?: (line: string) => void } = {}): Promise<Ctx> {
  const settings = o.settings ?? loadSettings();
  const run = o.run ?? realRun;
  mkdirSync(dataDir, { recursive: true });
  const kit = await kitInfo(run, dataDir, settings.stewardRepo);
  return { settings, run, kit, log: o.log ?? (() => {}), neutralDir: dataDir };
}

/** The kit's changelog for a PR's body: this checkout's, or the kit release's notes. */
async function changelogFor(ctx: Ctx, kit: string): Promise<string | null> {
  const local = localChangelog(ctx.kit);
  if (local) return local;
  try {
    const body = JSON.parse(await gh(ctx.run, ctx.neutralDir, 'release', 'view', `kit-v${kit}`, '--repo', ctx.settings.stewardRepo, '--json', 'body')).body as string;
    return body.startsWith('## ') ? body : `## ${kit}\n\n${body}`;
  } catch {
    return null;
  }
}

/** The staff's table, refreshed and kept in staff.json. */
export async function refreshStaff(ctx: Ctx, o: { fetch?: boolean } = {}): Promise<Staff> {
  const chosen = chooseKit(ctx.kit);
  const s = await staff(ctx, { fetch: o.fetch ?? true, kit: 'version' in chosen ? chosen.version : null, kitNote: 'error' in chosen ? chosen.error : chosen.note, tool: stewardTool() });
  writeJson(staffFile(), s);
  return s;
}

/** Runs a stage under the lock, records it, and refreshes the staff's table; a round only when it did something. */
export async function runStage(name: Exclude<StageName, 'staff'>, ask: StageAsk, o: { run?: Runner; log?: (line: string) => void; kitInfo?: KitInfo } = {}): Promise<StageResult> {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    o.log?.(line);
  };
  return withLock(
    stageLock(),
    async () => {
      const ctx = await context({ run: o.run, log });
      if (o.kitInfo) ctx.kit = o.kitInfo;
      const started = new Date().toISOString();
      const out: StageResult = { stage: name, started, finished: started, kit: null, asked: { ...ask }, results: [], log: lines };
      try {
        const picked = pick(ctx.settings.employees, ask.employees);
        if ('error' in picked) throw new Error(picked.error);
        if (name === 'merge' || name === 'round') {
          // A round is merge --yes --team, then a release for every version not yet released (stages/round.ts).
          const round = name === 'round';
          const yes = round || !!ask.yes;
          const merged = await merge(ctx, picked.employees, { yes, team: round || !!ask.team });
          out.results = merged.map(({ merged: _m, ...r }) => r);
          const done = merged.filter((r) => r.merged.length).map((r) => r.id);
          if (yes && done.length) {
            // A release when Settings say so, at the kit the Steward hands out; and whatever each merged PR asks for.
            let releaseKit: string | null = null;
            if (ctx.settings.releaseAfterMerge) {
              const chosen = chooseKit(ctx.kit, ask.kit);
              if ('error' in chosen) log(`release after merge: ${chosen.error}`);
              else {
                log(`release after merge (Settings): ${done.join(', ')}`);
                out.kit = chosen.version;
                releaseKit = chosen.version;
              }
            }
            out.results.push(...(await afterMerge(ctx, picked.employees, merged, { releaseKit })));
          }
          if (round) {
            const releasedNow = new Set(out.results.filter((r) => r.message.startsWith('release: ')).map((r) => r.id));
            const released = await releaseUnreleased(ctx, picked.employees.filter((e) => !releasedNow.has(e.id)));
            out.results.push(...released.map((r) => ({ ...r, message: `release: ${r.message}` })));
            // Then each employee's jobs whose installed script is the merged one, approved, so an update never leaves them waiting.
            for (const e of picked.employees) {
              let r: EmployeeResult | null;
              try {
                r = await approveMerged(ctx, e);
              } catch (err) {
                log(`[${e.id}] jobs: ${(err as Error).message}`);
                r = null;
              }
              if (r) out.results.push({ ...r, message: `jobs: ${r.message}` });
            }
          }
        } else {
          const chosen = chooseKit(ctx.kit, ask.kit);
          if ('error' in chosen) throw new Error(chosen.error);
          out.kit = chosen.version;
          if (chosen.note) log(`kit ${chosen.version}: ${chosen.note}`);
          if (name === 'bump') {
            if (!ctx.kit.released.includes(chosen.version) && !ask.kitFrom) {
              throw new Error(`kit ${chosen.version} has no release kit-v${chosen.version}, so the employees couldn't fetch it: publish it first (npm run kit-release -- --publish in the Steward's checkout), or try it with --kit-from <kit folder>`);
            }
            out.results = await bump(ctx, picked.employees, { kit: chosen.version, base: ask.base, kitFrom: ask.kitFrom });
          } else if (name === 'push') out.results = await push(ctx, picked.employees, { kit: chosen.version, changelog: await changelogFor(ctx, chosen.version) });
          else out.results = await release(ctx, picked.employees, { kit: chosen.version });
        }
      } catch (e) {
        out.error = (e as Error).message;
        log(`${name}: ${out.error}`);
      }
      out.finished = new Date().toISOString();
      // A round with nothing done or failed leaves no trace: the last stage stays what last happened.
      if (name === 'round' && !roundDidSomething(out.results, out.error)) return out;
      writeJson(lastStageFile(), out);
      appendFileSync(dataFile('stages.log'), `${JSON.stringify({ ...out, log: undefined })}\n`);
      try {
        await refreshStaff(ctx, { fetch: true });
      } catch (e) {
        log(`couldn't refresh the staff's table: ${(e as Error).message}`);
      }
      return out;
    },
    // A bump can take a while; a holder whose process is gone is still seen at once.
    { waitMs: 2000, staleMs: 3 * 3600_000 },
  );
}
