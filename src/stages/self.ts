import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { APP } from '../app.ts';
import { expandEnv } from '../kit/settings-kit.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { commitOf, fetchBranch, gh, git, gitMaybe, removeWorktree, showFile } from '../git.ts';
import { STEWARD_BRANCH, stewardMainFrom, type StewardMain } from '../glance.ts';
import { compareVersions } from '../kitfiles.ts';
import { runLine, tail } from '../run.ts';
import { networkFailure, workRootOf, type Ctx, type EmployeeResult } from './common.ts';

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
  const list = JSON.parse(await gh(ctx.run, ctx.neutralDir, 'release', 'list', '--repo', ctx.settings.stewardRepo, '--limit', '100', '--json', 'tagName')) as { tagName: string }[];
  return { main, tags: list.map((r) => r.tagName) };
}

async function releaseStep(ctx: Ctx, repo: string, step: SelfStep): Promise<EmployeeResult> {
  const { run } = ctx;
  const at = step.commit.slice(0, 7);
  const dir = selfDirOf(ctx);
  await removeWorktree(run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  if (!(await commitOf(run, repo, step.commit))) await fetchBranch(run, repo, STEWARD_BRANCH);
  // Only a commit on origin's main, which the scripts need too ("HEAD isn't on origin yet").
  if ((await gitMaybe(run, repo, 'merge-base', '--is-ancestor', step.commit, `origin/${STEWARD_BRANCH}`)) === null) {
    await fetchBranch(run, repo, STEWARD_BRANCH);
    if ((await gitMaybe(run, repo, 'merge-base', '--is-ancestor', step.commit, `origin/${STEWARD_BRANCH}`)) === null) return selfResult('failed', `${at} isn't on origin/${STEWARD_BRANCH} in ${repo}`, { version: step.version, commit: at });
  }
  await git(run, repo, 'worktree', 'add', '--quiet', '--detach', dir, step.commit);
  ctx.log(`[${APP.id}] releasing ${step.tag} from origin/${STEWARD_BRANCH} (${at}) in ${dir}`);
  try {
    const commands = SELF_COMMANDS[step.what];
    for (const [i, line] of commands.entries()) {
      // The last one publishes: never from a tree with anything uncommitted in it.
      if (i === commands.length - 1) {
        const dirty = (await git(run, dir, 'status', '--porcelain', '--untracked-files=all')).trim();
        if (dirty) return selfResult('failed', `the worktree at ${at} isn't clean (${dirty.split('\n').slice(0, 3).join(', ')}), so ${step.tag} wasn't released`, { version: step.version, commit: at });
      }
      const r = await runLine(run, line, { cwd: dir, timeoutMs: 30 * 60_000 });
      for (const l of tail(`${r.out}\n${r.err}`, 15).split('\n')) ctx.log(`[${APP.id}]   ${l}`);
      if (r.code !== 0) return selfResult('failed', `${line} failed (exit ${r.code}), so ${step.tag} wasn't released`, { version: step.version, commit: at });
    }
    return selfResult('done', `released ${step.tag} from origin/${STEWARD_BRANCH} (${at})`, { version: step.version, commit: at, url: `https://github.com/${ctx.settings.stewardRepo}/releases/tag/${step.tag}` });
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${APP.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

/**
 * The round's look at the Steward's own versions: planSelf on what GitHub said, then each release, kit first. A
 * Steward version whose kit release failed this round waits. What failed is kept by tag; a tag released since is let go.
 */
export async function releaseSelf(ctx: Ctx, o: { checkout: string; main: StewardMain | null; tags: string[] | null }): Promise<EmployeeResult[]> {
  const failed = loadSelfFailures();
  const before = JSON.stringify(failed);
  for (const tag of Object.keys(failed)) if (o.tags?.includes(tag)) delete failed[tag];
  const plan = planSelf({ on: ctx.settings.releaseSelf, main: o.main, tags: o.tags, failed });
  for (const n of plan.notes) ctx.log(`[${APP.id}] ${n}`);
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
        if (step.what === 'steward' && results.some((r) => r.outcome === 'failed')) {
          results.push(selfResult('skipped', `${step.tag} waits for the kit's release, which failed`));
          continue;
        }
        let r: EmployeeResult;
        try {
          r = await releaseStep(ctx, repo, step);
        } catch (err) {
          r = selfResult('failed', `${step.tag}: ${(err as Error).message}`, { version: step.version, commit: step.commit.slice(0, 7) });
        }
        // One the network cut short (the kit's net.ts) is tried again next round, not left to a person.
        if (r.outcome === 'failed' && !(await networkFailure(ctx, r.message))) failed[step.tag] = { commit: step.commit, message: r.message.replace(/^self: /, ''), at: new Date().toISOString() };
        else if (r.outcome === 'done') delete failed[step.tag];
        results.push(r);
      }
    }
  }
  if (JSON.stringify(failed) !== before) writeJson(selfFailedFile(), failed);
  return results;
}
