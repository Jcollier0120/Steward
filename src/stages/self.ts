import { existsSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { whileAwake } from '../kit/awake.ts';
import { expandEnv } from '../kit/settings-kit.ts';
import { releasesRepoEnv, type Employee } from '../settings.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { commitOf, fetchBranch, git, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { STEWARD_BRANCH, stewardMainFrom, type StewardMain } from '../glance.ts';
import { compareVersions } from '../kitfiles.ts';
import { runLine, tail } from '../run.ts';
import { exchequerNote, networkFailure, networkNote, passingFailure, freshWorktree, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
import { guardPackages, installPackages } from './modules.ts';
import { releaseNeedsPackages } from './release.ts';
import { linkSharedModules } from './modules.ts';
import { recordTested } from '../tested.ts';
import { hostFor, must } from '../hosts/index.ts';
import { settleWholeSuite, wholeSuiteBefore } from './wholesuite.ts';
import { kitTrialAtMain } from './trial.ts';
import { stewardEmployee } from './selfmerge.ts';
import { mainGate } from './mainbuild.ts';
import { clearPending, missedExchequer, notePending } from './exchequer.ts';
import { signingDown } from '../signing.ts';

/**
 * The Steward's own releases, in a round. The Steward's repository isn't an employee's, so this is kept apart from
 * the employees' releases: when the Steward's main on GitHub carries a kit version (kit/VERSION) with no kit-v<version>
 * release, or a Steward version (package.json) with no v<version> release, the round releases it as a person would,
 * with the repository's own scripts (README, "Kit releases"): `npm run kit-release -- --publish` (its kit filled first,
 * as `npm run kit` would), then `npm run release -- --publish`. What it reads comes from the round's glance at GitHub.
 *
 * Always from a fresh worktree of the Steward's checkout (Settings) at that very commit of origin/main, in the work
 * folder, never the person's working tree; a worktree with anything uncommitted in it is refused, and both scripts
 * refuse a dirty tree and a version already released themselves. A release carries only what is committed on main,
 * never this PC's Settings or data, so an internal agent (the Wright) is never in anything published from here.
 *
 * A version that isn't above the newest release of its kind is never released (a person sees to that), and a Steward
 * version waits for the kit version on main to be released first. A release that fails is kept in self-failed.json
 * by its tag, with the commit: an alarm at once, and the rounds don't try it again until a new commit lands on main.
 * A kit, which every agent takes, is released only once it has been tried on every agent at that commit (trial.ts: one
 * that fails holds the kit, and the Steward's version behind it, with an alarm of its own) and the Steward's whole suite
 * has passed there (wholesuite.ts), since its PRs ran only the tests each change reached; one that fails is held the same
 * way. On the Steward's page the suite runs beside the rounds: the round that starts it goes on at once, and the kit
 * waits for it. A Steward version is released once main's head is tested, or a vouch covers it (mainbuild.ts).
 */

export const selfFailedFile = () => dataFile('self-failed.json');

export interface SelfHold {
  commit: string;
  message: string;
  at: string;
}

export const loadSelfFailures = (): Record<string, SelfHold> => readJson<Record<string, SelfHold>>(selfFailedFile(), {});

export interface SelfStep {
  what: 'kit' | 'steward';
  tag: string;
  version: string;
  commit: string;
}

/** What a person runs for each, in the Steward's checkout (the README's "Kit releases"); the kit-release script needs its kit filled. */
export const SELF_COMMANDS: Record<SelfStep['what'], string[]> = {
  kit: ['node tools/kit.ts --from kit', 'node tools/kit-release.ts --publish'],
  steward: ['npm run release -- --publish'],
};

const newestOf = (tags: string[], prefix: string) =>
  tags
    .map((t) => (t.startsWith(prefix) && /^\d+\.\d+\.\d+$/.test(t.slice(prefix.length)) ? t.slice(prefix.length) : null))
    .filter((v): v is string => !!v)
    .sort((a, b) => compareVersions(b, a))[0] ?? null;

/** Which of the Steward's own versions on main to release now, and a line for each that waits. Pure. */
export function planSelf(o: { on: boolean; main: StewardMain | null; tags: string[] | null; failed: Record<string, SelfHold> }): { steps: SelfStep[]; notes: string[] } {
  if (!o.on) return { steps: [], notes: [] };
  if (!o.main?.head || !o.tags) return { steps: [], notes: [`couldn't read the Steward's ${STEWARD_BRANCH} or its releases on GitHub`] };
  const head = o.main.head;
  const tags = o.tags;
  const steps: SelfStep[] = [];
  const notes: string[] = [];
  const consider = (what: SelfStep['what'], version: string | null, prefix: string): 'none' | 'released' | 'below' | 'held' | 'step' => {
    const name = what === 'kit' ? 'kit/VERSION' : "package.json's version";
    if (!version) return notes.push(`no ${name} on ${STEWARD_BRANCH}`), 'none';
    const tag = `${prefix}${version}`;
    if (tags.includes(tag)) return 'released';
    const newest = newestOf(tags, prefix);
    if (newest && compareVersions(version, newest) <= 0) return notes.push(`${name} on ${STEWARD_BRANCH} is ${version}, not above ${prefix}${newest}, the newest release: left to you`), 'below';
    const h = o.failed[tag];
    if (h && h.commit === head) return notes.push(`${tag} failed to release at ${head.slice(0, 7)} (${h.message}), so the rounds leave it until a new commit lands on ${STEWARD_BRANCH}`), 'held';
    steps.push({ what, tag, version, commit: head });
    return 'step';
  };
  const kit = consider('kit', o.main.kit, 'kit-v');
  if (kit === 'released' || kit === 'step') consider('steward', o.main.version, 'v');
  else if (o.main.version && !tags.includes(`v${o.main.version}`)) notes.push(`v${o.main.version} waits for kit-v${o.main.kit ?? '?'} to be released first`);
  return { steps, notes };
}

const selfResult = (outcome: EmployeeResult['outcome'], message: string, more: Partial<EmployeeResult> = {}): EmployeeResult => ({ id: APP.id, name: APP.name, outcome, message: `self: ${message}`, ...more });

/** The checkout the Steward's own releases are made from, as Settings name it. */
export const selfCheckoutOf = (checkout: string) => path.resolve(expandEnv(checkout));
/** The worktree they are made in. */
export const selfDirOf = (ctx: Ctx) => path.join(workRootOf(ctx.settings), `_${APP.id}-release`);

/** owner/name from a GitHub remote URL (https or ssh), or null. */
const repoFromUrl = (url: string) => {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
};

/** The Steward's main and its release tags, asked on their own: when the round had no glance at GitHub. */
export async function selfFactsAlone(ctx: Ctx, checkout: string): Promise<{ main: StewardMain | null; tags: string[] | null }> {
  const repo = selfCheckoutOf(checkout);
  if (!existsSync(repo)) return { main: null, tags: null };
  await fetchBranch(ctx.run, repo, STEWARD_BRANCH);
  const remote = `origin/${STEWARD_BRANCH}`;
  const main = stewardMainFrom({ main: { target: { oid: await commitOf(ctx.run, repo, remote) } }, kitVersion: { text: await showFile(ctx.run, repo, remote, 'kit/VERSION') }, packageJson: { text: await showFile(ctx.run, repo, remote, 'package.json') } });
  const list = JSON.parse(must(await hostFor(ctx).listReleases(ctx.settings.stewardRepo, 'tagName'))) as { tagName: string }[];
  return { main, tags: list.map((r) => r.tagName) };
}

async function releaseStep(ctx: Ctx, repo: string, step: SelfStep): Promise<EmployeeResult> {
  const { run } = ctx;
  const at = step.commit.slice(0, 7);
  const dir = selfDirOf(ctx);
  await removeWorktree(run, repo, dir);
  if (!(await commitOf(run, repo, step.commit))) await fetchBranch(run, repo, STEWARD_BRANCH);
  // Only a commit on origin's main, which the scripts need too ("HEAD isn't on origin yet").
  if ((await gitMaybe(run, repo, 'merge-base', '--is-ancestor', step.commit, `origin/${STEWARD_BRANCH}`)) === null) {
    await fetchBranch(run, repo, STEWARD_BRANCH);
    if ((await gitMaybe(run, repo, 'merge-base', '--is-ancestor', step.commit, `origin/${STEWARD_BRANCH}`)) === null) return selfResult('failed', `${at} isn't on origin/${STEWARD_BRANCH} in ${repo}`, { version: step.version, commit: at });
  }
  await freshWorktree(run, ctx.settings, repo, dir, step.commit, '--detach');
  ctx.log(`[${APP.id}] releasing ${step.tag} from origin/${STEWARD_BRANCH} (${at}) in ${dir}`);
  try {
    // The Steward's release builds with esbuild (kit 2.17.0), its devDependency: its packages first, as an employee's,
    // linked from the set installed for its lockfile where they can be (modules.ts), else installed.
    // A kit's too: its release tests build the fixture's releases with it before it is published (tools/kit-release.ts).
    if (releaseNeedsPackages(dir, SELF_COMMANDS.steward[0])) {
      // No package's install script runs unless Settings allow it; one that isn't holds the release (installscripts.ts).
      const g = await guardPackages(ctx, { id: APP.id, name: APP.name, repo: ctx.settings.stewardRepo }, dir, `the release of ${step.tag}`);
      if (g.held) return selfResult('failed', `${g.held}, so ${step.tag} wasn't released`, { version: step.version, commit: at });
      const say = (line: string) => ctx.log(`[${APP.id}] ${line}`);
      const ci = (await linkSharedModules(ctx, dir, say, g.plan)) ? null : await installPackages(ctx, dir, g.plan, say);
      if (ci) return selfResult('failed', `${ci.line.startsWith('npm ci') ? 'npm ci' : ci.line} failed (exit ${ci.code}), so ${step.tag} wasn't released${networkNote(`${ci.out}\n${ci.err}`)}`, { version: step.version, commit: at });
    }
    const commands = SELF_COMMANDS[step.what];
    let exchequer = '';
    for (const [i, line] of commands.entries()) {
      // The last one publishes: never from a tree with anything uncommitted in it.
      if (i === commands.length - 1) {
        const dirty = (await git(run, dir, 'status', '--porcelain', '--untracked-files=all')).trim();
        if (dirty) return selfResult('failed', `the worktree at ${at} isn't clean (${dirty.split('\n').slice(0, 3).join(', ')}), so ${step.tag} wasn't released`, { version: step.version, commit: at });
      }
      // Its release goes to the releases repository too, as Settings say (MANOR_RELEASES_REPO, the kit's release.ts).
      const r = await runLine(run, line, { cwd: dir, timeoutMs: 30 * 60_000, env: releasesRepoEnv(ctx.settings), paced: true });
      for (const l of tail(`${r.out}\n${r.err}`, 15).split('\n')) ctx.log(`[${APP.id}]   ${l}`);
      if (r.code !== 0) {
        // On GitHub, and not at the Exchequer (exchequer.ts): released, and finished there later, as an employee's is.
        // Before, it stood as failed until the next round saw the tag on GitHub and let it go, and no Manor was offered it.
        const missed = step.what === 'steward' ? missedExchequer(`${r.out}\n${r.err}`) : null;
        if (missed && (await hostFor(ctx).viewRelease(ctx.settings.stewardRepo, step.tag, 'tagName')).code === 0) return onGitHubOnly(ctx, step, missed);
        // Its scripts couldn't be signed (kit 2.121.0: SimplySign Desktop not connected): nothing failed, and a round that
        // can sign releases it.
        const down = signingDown(`${r.out}\n${r.err}`);
        if (down) return selfResult('skipped', `${step.tag} waits until this PC can sign: ${down}`, { version: step.version, commit: at, again: true });
        return selfResult('failed', `${line} failed (exit ${r.code}), so ${step.tag} wasn't released${networkNote(`${r.out}\n${r.err}`)}`, { version: step.version, commit: at });
      }
      exchequer ||= exchequerNote(`${r.out}\n${r.err}`);
    }
    // Released from this commit of main: the Surveyor's GET /api/tested (tested.ts).
    recordTested(APP.id, { commit: step.commit, stage: 'release', branch: STEWARD_BRANCH, version: step.version });
    // One before it that reached GitHub alone is behind this one now, which went on to the Exchequer.
    if (step.what === 'steward' && !exchequer) clearPending(APP.id);
    return selfResult('done', `released ${step.tag} from origin/${STEWARD_BRANCH} (${at})${exchequer}`, { version: step.version, commit: at, url: `https://github.com/${ctx.settings.stewardRepo}/releases/tag/${step.tag}` });
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${APP.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

/**
 * The Steward's version released on GitHub, which didn't reach the Exchequer (exchequer.ts): kept by its id, for the
 * rounds to finish there (finishPending, with selfToFinish). Done when the network or the Exchequer's own failing kept it
 * out; else failed, but released, so the rounds hold nothing against it and its alarm is what reaches the person.
 */
function onGitHubOnly(ctx: Ctx, step: SelfStep, missed: { why: string; passing: boolean }): EmployeeResult {
  const at = step.commit.slice(0, 7);
  recordTested(APP.id, { commit: step.commit, stage: 'release', branch: STEWARD_BRANCH, version: step.version });
  const now = new Date().toISOString();
  notePending(APP.id, { version: step.version, commit: step.commit, why: missed.why, passing: missed.passing, since: now, last: now, tries: 0 });
  const released = `released ${step.tag} from origin/${STEWARD_BRANCH} (${at})`;
  const url = `https://github.com/${ctx.settings.stewardRepo}/releases/tag/${step.tag}`;
  if (missed.passing) return selfResult('done', `${released}; on GitHub only for now: the Exchequer couldn't be reached (${missed.why}), so the rounds publish it there`, { version: step.version, commit: at, url });
  return selfResult('failed', `${released}; on GitHub only: the Exchequer refused it (${missed.why}), so no Manor is offered it: fix that, then press Publish it now on its alarm`, { version: step.version, url, released: true });
}

/** The Steward as finishExchequer (release.ts) runs its own release with --exchequer: with the release command it publishes with. */
export const selfToFinish = (e: Employee): Employee => ({ ...e, release: SELF_COMMANDS.steward[0] });

/**
 * The round's look at the Steward's own versions: planSelf on what GitHub said, then each release, kit first. A
 * Steward version whose kit release failed this round waits. What failed is kept by tag; a tag released since is let go.
 */
export async function releaseSelf(ctx: Ctx, o: { checkout: string; main: StewardMain | null; tags: string[] | null }): Promise<EmployeeResult[]> {
  const failed = loadSelfFailures();
  const before = JSON.stringify(failed);
  for (const tag of Object.keys(failed)) if (o.tags?.includes(tag)) delete failed[tag];
  // One held for the network or GitHub's own failing (before common.ts's passingFailure knew a 5xx) is let go.
  for (const [tag, f] of Object.entries(failed)) if (passingFailure(f.message)) delete failed[tag];
  const plan = planSelf({ on: ctx.settings.releaseSelf, main: o.main, tags: o.tags, failed });
  const kitStep = plan.steps.find((s) => s.what === 'kit');
  for (const n of plan.notes) ctx.log(`[${APP.id}] ${n}`);
  // A whole suite beside the rounds for code main has moved on from, or for a kit no longer waiting, is stopped (wholesuite.ts).
  if (o.main?.head && o.tags) await settleWholeSuite(ctx, plan.steps.find((s) => s.what === 'kit') ?? null);
  const results: EmployeeResult[] = [];
  if (plan.steps.length) {
    const repo = selfCheckoutOf(o.checkout);
    let why: string | null = null;
    if (!existsSync(path.join(repo, '.git'))) why = `no checkout of the Steward at ${repo} (Settings: The Steward's checkout)`;
    else {
      // origin's URL as configured (get-url would give what an insteadOf rewrites it to).
      const origin = repoFromUrl((await gitMaybe(ctx.run, repo, 'config', '--get', 'remote.origin.url')) ?? '');
      if (origin?.toLowerCase() !== ctx.settings.stewardRepo.toLowerCase()) why = `${repo}'s origin is ${origin ?? 'not a GitHub repository'}, not ${ctx.settings.stewardRepo}`;
    }
    if (why) results.push(selfResult('refused', `${plan.steps.map((s) => s.tag).join(' and ')} not released: ${why}`));
    else {
      for (const step of plan.steps) {
        if (step.what === 'steward' && kitStep && !results.some((r) => r.outcome === 'done' && r.version === kitStep.version)) {
          results.push(selfResult('skipped', `${step.tag} waits for ${kitStep.tag}'s release`));
          continue;
        }
        // Another PC took its turn here meanwhile (lease.ts): it releases this.
        if (ctx.lease && !(await ctx.lease.ok({ id: APP.id, repo: ctx.settings.stewardRepo }))) {
          // Its whole suite too, beside the rounds here: that PC's Steward runs it there.
          await settleWholeSuite(ctx, null, "the Steward's own turn is another PC's now");
          results.push(selfResult('skipped', `${step.tag} is left to another PC, whose turn it is now`));
          break;
        }
        const steward = stewardEmployee(ctx.settings, repo);
        const at = step.commit.slice(0, 7);
        if (step.what === 'kit') {
          // Tried on every agent first (trial.ts): one still going holds the round's kit, and one failing holds the kit
          // alone (its alarm is the trial's own); the employees' releases go on either way.
          const tried = await kitTrialAtMain(ctx, steward, { commit: step.commit, kit: step.version }).catch((err: Error) => ({ state: 'going' as const, why: `its trial couldn't go on: ${err.message}` }));
          if (tried.state === 'going') {
            results.push(selfResult('skipped', `${step.tag} waits: ${tried.why}`, { version: step.version, commit: at, kitWaits: step.version }));
            break;
          }
          if (tried.state === 'failed') {
            results.push(selfResult('skipped', `${step.tag} isn't released: ${tried.why}`, { version: step.version, commit: at }));
            continue;
          }
        }
        let r: EmployeeResult;
        try {
          // A kit, which every agent takes, once the Steward's whole suite has passed at its commit (wholesuite.ts).
          const held = step.what === 'kit' ? await wholeSuiteBefore(ctx, repo, step) : null;
          // Windows ended its run, or it runs beside the rounds: a later round asks again; the Steward's version waits for it.
          if (held?.retry) {
            results.push(selfResult('skipped', held.beside ? `${step.tag} waits: ${held.why}` : `${step.tag} waits for the next round: ${held.why}`, { version: step.version, commit: step.commit.slice(0, 7), kitWaits: step.version }));
            break;
          }
          // The PC kept awake while it releases (the kit's awake.ts).
          // A Steward version once main's head is tested here, or a vouch covers it (mainbuild.ts).
          const untested = step.what === 'steward' ? await mainGate(ctx, steward, step.commit, newestOf(o.tags ?? [], 'v')) : null;
          r = held
            ? selfResult('failed', `${held.why}, so ${step.tag} wasn't released`, { version: step.version, commit: at })
            : untested
              ? selfResult('failed', `${step.tag} wasn't released: ${untested}`, { version: step.version, commit: at })
              : await whileAwake(`the Steward's ${step.tag}`, () => releaseStep(ctx, repo, step), ctx.log);
        } catch (err) {
          r = selfResult('failed', `${step.tag}: ${(err as Error).message}`, { version: step.version, commit: step.commit.slice(0, 7) });
        }
        // One the network cut short (the kit's net.ts) is tried again next round, not left to a person.
        // One released on GitHub that the Exchequer refused isn't held: its own alarm says what to do (exchequer.ts).
        if (r.outcome === 'failed' && !r.released && !(await networkFailure(ctx, r.message))) failed[step.tag] = { commit: step.commit, message: r.message.replace(/^self: /, ''), at: new Date().toISOString() };
        else if (r.outcome === 'done' || r.released) delete failed[step.tag];
        results.push(r);
      }
    }
  }
  if (JSON.stringify(failed) !== before) writeJson(selfFailedFile(), failed);
  return results;
}

/**
 * Main's new kit tried ahead of the next build (trial.ts), a slice a round between builds, so the build finds it tried:
 * while Settings say the Steward releases itself, main's kit has no release, and isn't held by a release that failed at
 * this commit. A line to log, or null when there is nothing to try. Never throws.
 */
export async function trialAhead(ctx: Ctx, o: { checkout: string; main: StewardMain | null; tags: string[] | null }): Promise<string | null> {
  const plan = planSelf({ on: ctx.settings.releaseSelf, main: o.main, tags: o.tags, failed: loadSelfFailures() });
  const step = plan.steps.find((s) => s.what === 'kit');
  if (!step) return null;
  const repo = selfCheckoutOf(o.checkout);
  if (!existsSync(path.join(repo, '.git'))) return null;
  try {
    const tried = await kitTrialAtMain(ctx, stewardEmployee(ctx.settings, repo), { commit: step.commit, kit: step.version });
    return tried.state === 'passed' ? `kit ${step.version} on ${STEWARD_BRANCH} passed its trial on the agents: the next build releases it` : `${step.tag}: ${tried.why}`;
  } catch (err) {
    return `${step.tag}: its trial ahead of the next build couldn't go on: ${(err as Error).message}`;
  }
}
