import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitOf, fetchBranch, removeWorktree, showFile } from '../git.ts';
import { readLsRemote } from '../scm.ts';
import { stayAwake } from '../kit/awake.ts';
import { combinedEntry } from '../kit/notes.ts';
import { isUrgent, letOut, NEVER_SOLD } from '../kit/exchequer.ts';
import { compareVersions } from '../kitfiles.ts';
import { runLine, splitCommand, tail } from '../run.ts';
import { releasedHere, releasesRepoEnv, TAG_RELEASE, type Employee } from '../settings.ts';
import { tasteFirst } from '../tasting.ts';
import { agreedVersion } from '../versions.ts';
import { keepFailure } from '../failure.ts';
import { noteSigningDown, signingDown, signingProblem, signsWith } from '../signing.ts';
import { checksLogOf, needsNpmCi } from './bump.ts';
import { recordTested } from '../tested.ts';
import { guardPackages, installPackages } from './modules.ts';
import { readPin } from './staff.ts';
import { noteReleased } from '../strangers.ts';
import { checkoutOf, exchequerNote, forgetGlance, freshBranch, hostIs, mapLimit, networkNote, NOT_ON_KIT, notHiredHere, passingFailure, releasedOf, releaseDirOf, result, freshWorktree, type Ctx, type EmployeeResult } from './common.ts';
import { hostFor } from '../hosts/index.ts';
import { runWhenReleased } from './gitevents.ts';
import { withRepo } from './slots.ts';
import { linkSharedModules } from './modules.ts';
import { kitOnlyRelease, noteKitOnlyRelease, type KitOnly } from './kitonly.ts';
import { rolloutDone, rolloutGoingOn } from './rollout.ts';
import { clearPending, dueAgain, exchequerCommand, finishFailed, loadExchequerPending, missedExchequer, notePending } from './exchequer.ts';

/**
 * Stage 4, `steward release`: for each employee whose branch on origin carries the kit and a version with
 * no GitHub release yet, a worktree at that very commit, and its release command run there. Releases come
 * from the branch, never from a PR's, so a release and its branch never drift apart. A Node agent whose release
 * builds something gets its packages first (`npm ci`): Reeve's release builds its dashboard with them, and from kit
 * 2.16.0 every hire's builds its code with esbuild (releaseNeedsPackages).
 */

/** A command in an npm script that needs no packages: the kit's own tools, run with Node. */
const KIT_ONLY = /^node\s+(tools[\\/]kit\.ts|src[\\/]kit[\\/]release\.ts)(\s|$)/;

/**
 * Whether an employee's release needs its packages installed (npm ci) in the fresh worktree: a Node project whose
 * release runs anything but the kit's own tools. A hire's `npm run release -- --publish` runs `node tools/kit.ts &&
 * node src/kit/release.ts` (pre and release scripts), which packs src with Node alone: no. Reeve's builds its
 * dashboard with vite: yes. Anything the Steward can't read is taken to need them, as every release did before.
 * From kit 2.16.0 the kit's release builds what it carries with esbuild (minify.ts), the agent's devDependency: an
 * agent with esbuild in its package.json needs its packages, whatever its scripts.
 */
export function releaseNeedsPackages(dir: string, release: string): boolean {
  if (!needsNpmCi(dir)) return false;
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, ''));
    if (pkg?.devDependencies?.esbuild || pkg?.dependencies?.esbuild) return true;
  } catch {
    return true;
  }
  const words = splitCommand(release);
  const commands = (line: string) => line.split('&&').map((c) => c.trim()).filter(Boolean);
  let lines: string[];
  if (words[0] === 'node') lines = [words.join(' ')];
  else if (words[0] === 'npm' && (words[1] === 'run' || words[1] === 'run-script') && words[2]) {
    let scripts: Record<string, unknown>;
    try {
      scripts = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')).scripts ?? {};
    } catch {
      return true;
    }
    const name = words[2];
    if (typeof scripts[name] !== 'string') return true;
    lines = [scripts[`pre${name}`], scripts[name], scripts[`post${name}`]].filter((x): x is string => typeof x === 'string');
  } else return true;
  return !lines.flatMap(commands).every((c) => KIT_ONLY.test(c));
}

export interface ReleaseCandidate {
  usesKit: boolean;
  /** The kit its branch pins, and its version there. */
  kit: string | null;
  version: string | null;
  /** The versions it has released. */
  released: string[];
}

/**
 * Whether to release an employee now, or why not. `kit` is the kit its branch must pin (the rollout's), or null
 * for a release a merged PR asked for, which carries whatever its branch has.
 */
export function releaseDecision(c: ReleaseCandidate, kit: string | null): { release: true } | { release: false; why: string } {
  if (kit !== null) {
    if (!c.usesKit) return { release: false, why: NOT_ON_KIT };
    if (!c.kit) return { release: false, why: 'its branch has no kit.json' };
    if (c.kit !== kit) return { release: false, why: `its branch pins kit ${c.kit}, not ${kit}: merge the bump first` };
  }
  if (!c.version) return { release: false, why: 'no version found on its branch' };
  if (c.released.includes(c.version)) return { release: false, why: `v${c.version} is already released` };
  // Merged out of order (Steward 0.36.124: PRs merge as their authors merge them): a version below one released isn't
  // released. claim-version hands out one above main's and every release's, for the work that brings it up.
  const newest = [...c.released].sort(compareVersions).at(-1);
  if (newest && compareVersions(c.version, newest) < 0) return { release: false, why: `v${c.version} on its branch is below v${newest}, released already: a version above it (claim-version) releases what is merged` };
  return { release: true };
}

/**
 * `unless`, given the commit to release and its version, may say why not (a round leaves a commit whose release
 * failed before to a person). Then the Assayer checks that commit (tasting.ts): a release it holds waits, with its
 * reason, and the next round asks again.
 *
 * The PC is kept awake while a release is made (the kit's awake.ts, Steward 0.36.45), from when it is decided on until
 * it is done; not while it is only looked at.
 *
 * A person's Release (not a round's, nor a hire) first finishes a release of the employee's that reached GitHub but not
 * the Exchequer (exchequer.ts), whatever kept it out: the Release an alarm asks for once the person has fixed that.
 */
export async function releaseOne(ctx: Ctx, e: Employee, o: ReleaseOptions): Promise<EmployeeResult> {
  let letGo = () => {};
  try {
    const finished = o.kitOnly || o.hire ? null : await finishExchequer(ctx, e, { person: true });
    const r = await releaseIn(ctx, e, o, (what) => (letGo = stayAwake(what, ctx.log)));
    if (!finished) return r;
    // Its branch's version is the one just finished: nothing more to say.
    if (r.outcome === 'skipped' && r.released && r.version === finished.version) return finished;
    const outcome = [finished.outcome, r.outcome].includes('failed') ? 'failed' : [finished.outcome, r.outcome].includes('done') ? 'done' : r.outcome;
    return { ...r, outcome, message: `${finished.message}; then ${r.message}` };
  } finally {
    letGo();
  }
}

/**
 * `kitOnly`: a round's release, which holds a version that is a new kit alone unless it changes what the agent runs (once
 * a day), or the kit says it is urgent or a fix for it (kitonly.ts). A person's Release isn't held.
 */
/**
 * `gate`: a build's test of the very commit it releases (mainbuild.ts's mainGate), asked once the release is decided on,
 * before the signing and the tasting: why not, which fails the release, or null.
 */
type ReleaseOptions = { kit: string | null; unless?: (commit: string, version: string) => string | null; hire?: boolean; kitOnly?: boolean; gate?: (commit: string, since: string | null) => Promise<string | null> };

async function releaseIn(ctx: Ctx, e: Employee, o: ReleaseOptions, awake: (what: string) => void): Promise<EmployeeResult> {
  const { run } = ctx;
  if (!e.usesKit && o.kit !== null) return result(e, 'skipped', NOT_ON_KIT);
  // Released only once the person said how (Settings' Release it), and only a repository with a version.
  if (!e.release) return result(e, 'skipped', NO_RELEASE);
  if (!e.versionFiles.length) return result(e, 'skipped', 'no version files in Settings, so no version to release');
  // Hired: its first install on this PC (Manor's Hire for one of this PC's own agents, staff.local.json). Only one built
  // here (its release installs it), only while it isn't installed, and at the version on its branch, released or not.
  if (o.hire) {
    if (!releasedHere(e)) return result(e, 'refused', `${e.name} is installed from its published release, not built here: hire it in Manor`);
    if (!e.installed) return result(e, 'refused', `Settings name no install folder for ${e.name}, so the Steward can't tell whether it is installed`);
    if (!notHiredHere(e)) return result(e, 'skipped', `${e.name} is installed here already (${e.installed})`);
  }
  // Released here, its release installs it: not for one that was removed from this PC, unless it is hired again.
  const away = releasedHere(e) && !o.hire ? notHiredHere(e) : null;
  if (away) return result(e, 'skipped', away);
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return result(e, 'refused', `no checkout at ${repo}`);
  const remote = `origin/${e.branch}`;
  // A release for a kit reads its branch from GitHub, whatever the stage's glance said: the kit's rollout may have merged
  // the bump since, and the clone not fetched it yet (Steward 0.36.137).
  const commit = await freshBranch(ctx, e, repo, { fetch: o.kit !== null });
  if (!commit) return result(e, 'refused', `no ${remote}`);
  // Asked together, so git reads them in one command (showFile).
  const [texts, pinText] = await Promise.all([Promise.all(e.versionFiles.map(async (f) => [f, await showFile(run, repo, remote, f)] as [string, string | null])), showFile(run, repo, remote, 'kit.json')]);
  const v = agreedVersion(texts);
  const released = (await releasedOf(ctx, e)).map((r) => r.version);
  const pinned = readPin(pinText)?.kit ?? null;
  // A hire installs the version on its branch, whatever has been released before: there is no install of it here.
  const decision = o.hire ? releaseDecision({ usesKit: e.usesKit, kit: pinned, version: 'version' in v ? v.version : null, released: [] }, null) : releaseDecision({ usesKit: e.usesKit, kit: pinned, version: 'version' in v ? v.version : null, released }, o.kit);
  if (!decision.release) {
    const out = 'version' in v && released.includes(v.version);
    return result(e, 'skipped', 'error' in v ? v.error : decision.why, out ? { released: true, version: v.version } : {});
  }
  const version = (v as { version: string }).version;
  const not = o.unless?.(commit, version);
  if (not) return result(e, 'skipped', not, { version, commit: commit.slice(0, 7) });
  // The release before: the versions merged since and never released on their own come in its notes.
  const since = released.filter((r) => compareVersions(r, version) < 0).sort(compareVersions).at(-1) ?? null;
  // A new kit alone (kitonly.ts): it waits, merged, for the agent's next release of its own, unless it changes what the
  // agent runs (once a day) or its kit says it is urgent or a fix for it. Before the signing and the tasting, which it
  // would only have to do again.
  const alone: KitOnly | null = o.kitOnly && !o.hire ? await kitOnlyRelease(ctx, e, { repo, commit, version, since }) : null;
  if (alone?.kitOnly && !alone.release) {
    ctx.log(`[${e.id}] v${version} ${alone.why}`);
    return result(e, 'skipped', `v${version} ${alone.why}`, { version, commit: commit.slice(0, 7) });
  }
  const kitWords = alone?.kitOnly ? `; ${alone.why}` : '';
  const daily = () => void (alone?.kitOnly && alone.release && alone.daily && noteKitOnlyRelease(e.id, version));
  // A build tests the commit it releases, once, unless a vouch covers it (mainbuild.ts).
  const untested = o.gate && !o.hire ? await o.gate(commit, since) : null;
  if (untested) return result(e, 'failed', `v${version} wasn't released: ${untested}`, { version, commit: commit.slice(0, 7) });
  // A release that signs waits while this PC can't (SimplySign Desktop not connected): nothing is built, nothing fails,
  // and the next round looks again (signing.ts). Before the tasting, which it would only have to do again.
  const signs = e.release === TAG_RELEASE ? null : signsWith({ kitJson: pinText, signTs: await showFile(run, repo, remote, 'tools/sign.ts'), release: e.release });
  if (signs) {
    const down = await signingProblem(run, signs);
    if (down) {
      ctx.log(`[${e.id}] v${version} waits until this PC can sign: ${down}`);
      return result(e, 'skipped', `v${version} waits until this PC can sign: ${down}`, { version, commit: commit.slice(0, 7), again: true, signing: down });
    }
  }
  const gate = await tasteFirst(e, { commit, version }, ctx.settings, ctx.tasting);
  if (!gate.go) {
    ctx.log(`[${e.id}] ${gate.why}`);
    return result(e, 'skipped', gate.why, { version, commit: commit.slice(0, 7), url: gate.url, again: true });
  }
  if (gate.note) ctx.log(`[${e.id}] ${gate.note}`);
  const noted = gate.note ? `; ${gate.note}` : '';
  // Another PC took its turn here meanwhile (lease.ts): it releases this. A hire is this PC's own install.
  if (!o.hire && ctx.lease && !(await ctx.lease.ok(e))) return result(e, 'skipped', `v${version} is left to another PC, whose turn it is now`, { version, commit: commit.slice(0, 7) });
  awake(`${e.name} v${version}'s release`);

  // A GitHub release the Steward makes itself: no worktree, no command of the repository's.
  if (e.release === TAG_RELEASE) {
    const tagged = await tagRelease(ctx, e, { repo, commit, version, remote, noted: `${noted}${kitWords}`, since });
    if (tagged.outcome === 'done') daily();
    return tagged;
  }

  const dir = releaseDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  rmSync(checksLogOf(dir), { force: true });
  await freshWorktree(run, ctx.settings, repo, dir, commit, '--detach');
  ctx.log(`[${e.id}] releasing v${version} from ${remote} (${commit.slice(0, 7)}) in ${dir}`);
  try {
    const held = await packagesFor(ctx, e, dir, e.release, `the release of v${version}`);
    if (held) return result(e, 'failed', `${held.why}, so its release wasn't built${held.network}`, { version, commit: commit.slice(0, 7) });
    // The kit's release publishes to the releases repository only on the PC that releases Castellan (MANOR_RELEASES_REPO).
    const r = await runLine(run, e.release, { cwd: dir, timeoutMs: 30 * 60_000, env: releasesRepoEnv(ctx.settings), paced: true });
    for (const line of tail(`${r.out}\n${r.err}`, 15).split('\n')) ctx.log(`[${e.id}]   ${line}`);
    if (r.code !== 0) {
      keepFailure(dir, e.release, r.code, `${r.out}\n${r.err}`);
      // It couldn't reach the code-signing key after all (SimplySign's session ended while it built, or its sign-in waited
      // there): it waits, as above, and what it met is the look for the releases after it (noteSigningDown).
      const down = signingDown(`${r.out}\n${r.err}`);
      if (down && signs) noteSigningDown(signs, down);
      if (down) return result(e, 'skipped', `v${version} waits until this PC can sign: ${down}`, { version, commit: commit.slice(0, 7), again: true, signing: down });
      // On GitHub, and not at the Exchequer (exchequer.ts): released, by this Steward, which finishes it there later. Only
      // once GitHub shows it: the kit says so whether or not GitHub took it.
      const missed = releasedHere(e) ? null : missedExchequer(`${r.out}\n${r.err}`);
      if (missed) forgetGlance(ctx, e);
      if (missed && (await releasedOf(ctx, e).catch(() => null))?.some((x) => x.version === version)) {
        recordTested(e.id, { commit, stage: 'release', branch: e.branch, version });
        noteReleased(e, version);
        daily();
        const at = new Date().toISOString();
        notePending(e.id, { version, commit, why: missed.why, passing: missed.passing, since: at, last: at, tries: 0 });
        const released = `released v${version} from ${remote} (${commit.slice(0, 7)})${pinned ? `, with kit ${pinned}` : ''}${noted}${kitWords}`;
        const url = hostFor(ctx, e).releaseUrl(e.repo, `v${version}`);
        if (missed.passing) return result(e, 'done', `${released}; on GitHub only for now: the Exchequer couldn't be reached (${missed.why}), so the rounds publish it there`, { version, commit: commit.slice(0, 7), url });
        // No commit: a round holds nothing against it (round.ts), and the alarm is what reaches the person (alarms.ts).
        return result(e, 'failed', `${released}; on GitHub only: the Exchequer refused it (${missed.why}), so no one is offered it: fix that, then press Publish it now on its alarm (or Release ${e.name}), which publishes it there from GitHub's files`, { version, url, released: true });
      }
      return result(e, 'failed', `${e.release} failed (exit ${r.code})${networkNote(`${r.out}\n${r.err}`)}`, { version, commit: commit.slice(0, 7) });
    }
    // Its releases have changed: the glance no longer says how they are.
    forgetGlance(ctx, e);
    const byGit = hostIs(ctx, e) === 'git';
    // Worked with plain git (scm.ts): the release is the v<version> tag on origin, which the Steward pushes once the
    // command has run (or finds the command pushed). One built and installed here alone has nothing to publish.
    if (byGit && !releasedHere(e)) {
      const tagged = await pushReleaseTag(ctx, e, { repo, commit, version, since });
      if (tagged) return result(e, 'failed', `${e.release} finished, but the tag v${version} couldn't be pushed to its origin: ${tagged}${networkNote(tagged)}`, { version, commit: commit.slice(0, 7) });
    }
    // A repository's own release command must make the GitHub release, or the next round would run it again: one that
    // didn't is a failed release, which the rounds then leave to the person at that commit. On the PC that releases
    // Castellan too: from 2026-10-13 to 10-14 kit 2.69.1's release.ts did nothing under a work folder reached through a
    // junction and still exited 0, and every round reported its agents released. (One released only on this PC has no
    // GitHub release.)
    else if (!byGit && !releasedHere(e)) {
      const now = await releasedOf(ctx, e).catch(() => null);
      if (now && !now.some((x) => x.version === version)) {
        keepFailure(dir, e.release, r.code, `${r.out}\n${r.err}`);
        return result(e, 'failed', `${e.release} finished, but ${hostFor(ctx, e).name} has no release v${version} in ${e.repo}: a release command must make it (or set Release it to tag, and the Steward makes it)`, { version, commit: commit.slice(0, 7) });
      }
    }
    // Released from this commit of its branch: the Surveyor's GET /api/tested (tested.ts).
    recordTested(e.id, { commit, stage: 'release', branch: e.branch, version });
    // This Steward's release, not someone else's (strangers.ts).
    noteReleased(e, version);
    // Released on GitHub; when it didn't reach the Exchequer too, the kit's line says why, as a note (never an alarm).
    const exchequer = exchequerNote(`${r.out}\n${r.err}`);
    // One before it that reached GitHub alone (exchequer.ts) is behind this one now, which went on to the Exchequer.
    if (!exchequer) clearPending(e.id);
    const urgent = exchequer ? '' : await urgentNote(ctx, e, { repo, commit, version, since });
    const after = byGit ? await afterReleaseNote(ctx, e, { repo, commit, version, since }) : '';
    daily();
    return result(e, 'done', `released v${version} from ${remote} (${commit.slice(0, 7)})${pinned ? `, with kit ${pinned}` : ''}${byGit && !releasedHere(e) ? `, tagged v${version} on its origin` : ''}${noted}${kitWords}${exchequer}${urgent}${after}`, { version, commit: commit.slice(0, 7), ...(byGit ? {} : { url: hostFor(ctx, e).releaseUrl(e.repo, `v${version}`) }) });
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

/**
 * An urgent release let out to customers now, ahead of the Exchequer's release day (Tuesdays and Fridays): one whose
 * CHANGELOG.md entry, or one it brings, has a line starting "**Urgent fix:" (kit/node/exchequer.ts isUrgent). A kit from
 * 2.59.0 asked for it as it published; an older one didn't, so the Steward asks either way (out already is fine). Only
 * for Castellan's own agents, published to the Exchequer from this PC (never Heiward, nor one built here alone). '' when
 * it isn't urgent; else a note for the release's line. The release stands either way.
 */
export async function urgentNote(ctx: Ctx, e: Employee, o: { repo: string; commit: string; version: string; since: string | null }): Promise<string> {
  if (!ctx.settings.releasesCastellan || releasedHere(e) || NEVER_SOLD.includes(e.id)) return '';
  const entry = combinedEntry((await showFile(ctx.run, o.repo, o.commit, 'CHANGELOG.md').catch(() => null)) ?? '', o.version, o.since);
  if (!isUrgent(entry)) return '';
  const out = await letOut(e.id, o.version, ctx.exchequer);
  ctx.log(`[${e.id}] an urgent fix: ${out.line}`);
  return `; an urgent fix: ${out.line}`;
}

/**
 * A release worktree's packages, before its command runs: linked from the set installed once for its lockfile
 * (modules.ts), as a bump's are; installed only where that can't be done (0.35.68). The release only reads them, and
 * never packs node_modules (the kit's release.ts). Null once they're there, or when the command needs none; else why
 * not, and the network's line when it was the network.
 */
async function packagesFor(ctx: Ctx, e: Employee, dir: string, line: string, what: string): Promise<{ why: string; network: string } | null> {
  if (!releaseNeedsPackages(dir, line)) return null;
  // No package's install script runs unless Settings allow it; one that isn't holds the release (installscripts.ts).
  const g = await guardPackages(ctx, e, dir, what);
  if (g.held) {
    ctx.log(`[${e.id}] packages held: ${g.held}`);
    return { why: g.held, network: '' };
  }
  const say = (l: string) => ctx.log(`[${e.id}] ${l}`);
  const ci = (await linkSharedModules(ctx, dir, say, g.plan)) ? null : await installPackages(ctx, dir, g.plan, say);
  if (!ci) return null;
  for (const l of tail(`${ci.out}\n${ci.err}`, 15).split('\n')) ctx.log(`[${e.id}]   ${l}`);
  keepFailure(dir, ci.line, ci.code, `${ci.out}\n${ci.err}`);
  return { why: `${ci.line.startsWith('npm ci') ? 'npm ci' : ci.line} failed (exit ${ci.code})`, network: networkNote(`${ci.out}\n${ci.err}`) };
}

/**
 * A release of the employee's that reached GitHub but not the Exchequer (exchequer.ts), finished there: its release
 * command with --exchequer (the kit's release.ts exchequerOnly), in a worktree of the commit released, which publishes
 * GitHub's own files of it to the Exchequer, as `npm run release -- --exchequer` by hand would. A round's try (`person`
 * false) only once it's due (dueAgain); a person's Release tries at once, whatever kept it out. Null when nothing is
 * tried.
 */
export async function finishExchequer(ctx: Ctx, e: Employee, o: { person: boolean; now?: Date }): Promise<EmployeeResult | null> {
  const p = loadExchequerPending()[e.id];
  const now = o.now ?? new Date();
  if (!p || (!o.person && !dueAgain(p, now))) return null;
  const line = e.release ? exchequerCommand(e.release) : null;
  const repo = checkoutOf(e);
  if (!line || !existsSync(repo)) return null;
  const more = { version: p.version, commit: p.commit.slice(0, 7) };
  // Tried: a person's ask (askAgain) is answered.
  const { asked: _asked, ...was } = p;
  const tried = (why: string, passing: boolean) => notePending(e.id, { ...was, why, passing, last: now.toISOString(), tries: p.tries + 1 });
  const dir = releaseDirOf(ctx.settings, e);
  const letGo = stayAwake(`${e.name} v${p.version}'s publish to the Exchequer`, ctx.log);
  try {
    await removeWorktree(ctx.run, repo, dir);
    if (!(await commitOf(ctx.run, repo, p.commit))) await fetchBranch(ctx.run, repo, e.branch);
    await freshWorktree(ctx.run, ctx.settings, repo, dir, p.commit, '--detach');
    ctx.log(`[${e.id}] publishing v${p.version} to the Exchequer from its release on GitHub (${p.commit.slice(0, 7)}), which didn't reach it: ${p.why}`);
    const held = await packagesFor(ctx, e, dir, line, `the publish of v${p.version} to the Exchequer`);
    const r = held ? null : await runLine(ctx.run, line, { cwd: dir, timeoutMs: 15 * 60_000, env: releasesRepoEnv(ctx.settings), paced: true });
    if (r) for (const l of tail(`${r.out}\n${r.err}`, 15).split('\n')) ctx.log(`[${e.id}]   ${l}`);
    if (r?.code === 0) {
      clearPending(e.id);
      return result(e, 'done', `published v${p.version} to the Exchequer from its release on GitHub, which hadn't reached it (${p.why})`, { ...more, released: true });
    }
    const failed = held ? { why: held.why, passing: !!held.network } : finishFailed(`${r!.out}\n${r!.err}`);
    tried(failed.why, failed.passing);
    if (failed.passing) return result(e, 'skipped', `v${p.version} is on GitHub only still: the Exchequer couldn't be reached again (${failed.why}), so the rounds try again`, { ...more, again: true });
    // No commit, as above: the alarm is what reaches the person.
    return result(e, 'failed', `v${p.version} is on GitHub only still: the Exchequer refused it (${failed.why}), so no one is offered it: fix that, then press Publish it now on its alarm`, { version: p.version });
  } catch (err) {
    // The Steward's own trouble (its worktree): tried again as it was.
    const why = (err as Error).message;
    ctx.log(`[${e.id}] couldn't publish v${p.version} to the Exchequer: ${why}`);
    tried(p.why, p.passing || passingFailure(why));
    return result(e, 'skipped', `v${p.version} is on GitHub only still: ${why}`, { ...more, again: true });
  } finally {
    try {
      await removeWorktree(ctx.run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
    letGo();
  }
}

/**
 * The round's tries at the Exchequer: each release that reached GitHub alone and is due again (exchequer.ts), one at a
 * time. In every round, not only a build's release: no one is offered it until it's there.
 */
export async function finishPending(ctx: Ctx, employees: Employee[], now = new Date()): Promise<EmployeeResult[]> {
  const pending = loadExchequerPending();
  const due = employees.filter((e) => pending[e.id] && dueAgain(pending[e.id], now));
  const out = await mapLimit(due, 1, async (e) => {
    try {
      return await withRepo(ctx.log, e.id, () => finishExchequer(ctx, e, { person: false, now }));
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      return null;
    }
  });
  return out.filter((r): r is EmployeeResult => r !== null);
}

/** Why a repository isn't released: Settings name no way to. */
export const NO_RELEASE = 'not released by the Steward: Settings name no way to (Release it)';

/**
 * A GitHub release the Steward makes itself (Release it: tag): v<version> in the repository, at the branch's commit, titled
 * "<name> <version>", its notes the version's entry in CHANGELOG.md at that commit with those of the versions since the
 * release before (kit/node/notes.ts combinedEntry), else GitHub's own
 * from the commits since the release before.
 */
/**
 * A plain-git release's After a release command (gitevents.ts), its notes the version's CHANGELOG.md entry with those
 * of the versions since the release before: '' when it ran or there is none, else a note for the release's line. The
 * release stands either way.
 */
async function afterReleaseNote(ctx: Ctx, e: Employee, o: { repo: string; commit: string; version: string; since?: string | null }): Promise<string> {
  if (!e.whenReleased) return '';
  const notes = combinedEntry((await showFile(ctx.run, o.repo, o.commit, 'CHANGELOG.md').catch(() => null)) ?? '', o.version, o.since ?? null);
  const failed = await runWhenReleased(ctx, e, { commit: o.commit, version: o.version, notes });
  return failed ? `; After a release failed (${failed})` : '; After a release ran';
}

async function tagRelease(ctx: Ctx, e: Employee, o: { repo: string; commit: string; version: string; remote: string; noted: string; since: string | null }): Promise<EmployeeResult> {
  const tag = `v${o.version}`;
  // Worked with plain git (scm.ts): the release is the tag itself, pushed to origin.
  if (hostIs(ctx, e) === 'git') {
    ctx.log(`[${e.id}] releasing ${tag} from ${o.remote} (${o.commit.slice(0, 7)}): a tag pushed to its origin`);
    const failed = await pushReleaseTag(ctx, e, o);
    if (failed) return result(e, 'failed', `the tag ${tag} couldn't be pushed to its origin: ${failed}${networkNote(failed)}`, { version: o.version, commit: o.commit.slice(0, 7) });
    forgetGlance(ctx, e);
    recordTested(e.id, { commit: o.commit, stage: 'release', branch: e.branch, version: o.version });
    noteReleased(e, o.version);
    const after = await afterReleaseNote(ctx, e, o);
    return result(e, 'done', `released v${o.version} from ${o.remote} (${o.commit.slice(0, 7)}), tagged ${tag} on its origin${o.noted}${after}`, { version: o.version, commit: o.commit.slice(0, 7) });
  }
  const entry = combinedEntry((await showFile(ctx.run, o.repo, o.commit, 'CHANGELOG.md')) ?? '', o.version, o.since ?? null);
  const notesDir = mkdtempSync(path.join(os.tmpdir(), 'steward-notes-'));
  try {
    let notesFile: string | null = null;
    if (entry) {
      notesFile = path.join(notesDir, 'notes.md');
      writeFileSync(notesFile, entry);
    }
    ctx.log(`[${e.id}] releasing ${tag} from ${o.remote} (${o.commit.slice(0, 7)}): a ${hostFor(ctx, e).name} release, its notes ${entry ? 'the CHANGELOG.md entry' : "the host's"}`);
    const r = await hostFor(ctx, e).createRelease(e.repo, { tag, target: o.commit, title: `${e.name} ${o.version}`, notesFile });
    if (r.code !== 0) return result(e, 'failed', `gh release create ${tag} failed (exit ${r.code}): ${(r.err || r.out).trim().split('\n').pop()}${networkNote(`${r.out}\n${r.err}`)}`, { version: o.version, commit: o.commit.slice(0, 7) });
  } finally {
    rmSync(notesDir, { recursive: true, force: true });
  }
  forgetGlance(ctx, e);
  recordTested(e.id, { commit: o.commit, stage: 'release', branch: e.branch, version: o.version });
  noteReleased(e, o.version);
  return result(e, 'done', `released v${o.version} from ${o.remote} (${o.commit.slice(0, 7)})${o.noted}`, { version: o.version, commit: o.commit.slice(0, 7), url: hostFor(ctx, e).releaseUrl(e.repo, tag) });
}

/**
 * A release worked with plain git (scm.ts): the annotated tag v<version> at the commit, its message "<name> <version>"
 * and the version's CHANGELOG.md entry, pushed to origin, never forced. One already on origin at that commit (the
 * release command pushed it) is left as it is. Null when it is there; else why not.
 */
export async function pushReleaseTag(ctx: Ctx, e: Employee, o: { repo: string; commit: string; version: string; since?: string | null }): Promise<string | null> {
  const tag = `v${o.version}`;
  const said = (r: { out: string; err: string }) => (r.err || r.out).trim().split('\n').pop() || 'no output';
  const there = await ctx.run('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: o.repo, timeoutMs: 2 * 60_000 });
  if (there.code !== 0) return `git ls-remote failed: ${said(there)}`;
  const at = readLsRemote(there.out, '').releases.find((r) => r.tagName === tag)?.commit;
  if (at) return at === o.commit ? null : `origin has ${tag} already, at ${at.slice(0, 7)}, not ${o.commit.slice(0, 7)}`;
  const local = await commitOf(ctx.run, o.repo, `refs/tags/${tag}`);
  if (local && local !== o.commit) return `this clone has a tag ${tag} at ${local.slice(0, 7)}, not ${o.commit.slice(0, 7)}: delete it, or raise the version`;
  if (!local) {
    const entry = combinedEntry((await showFile(ctx.run, o.repo, o.commit, 'CHANGELOG.md')) ?? '', o.version, o.since ?? null);
    const notesDir = mkdtempSync(path.join(os.tmpdir(), 'steward-notes-'));
    try {
      const file = path.join(notesDir, 'notes.md');
      writeFileSync(file, `${e.name} ${o.version}\n\n${entry ?? ''}`.trimEnd() + '\n');
      let r = await ctx.run('git', ['tag', '-a', tag, o.commit, '-F', file], { cwd: o.repo, timeoutMs: 60_000 });
      // No name or email set for git on this PC: a plain tag needs none.
      if (r.code !== 0 && /user\.(name|email)|identity|tell me who you are/i.test(`${r.out}\n${r.err}`)) r = await ctx.run('git', ['tag', tag, o.commit], { cwd: o.repo, timeoutMs: 60_000 });
      if (r.code !== 0) return `git tag failed: ${said(r)}`;
    } finally {
      rmSync(notesDir, { recursive: true, force: true });
    }
  }
  const pushed = await ctx.run('git', ['push', '--quiet', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], { cwd: o.repo, timeoutMs: 5 * 60_000 });
  return pushed.code === 0 ? null : `git push failed: ${said(pushed)}`;
}

/**
 * Each employee released, a few at a time. A release for a kit whose rollout runs beside the rounds (rollout.ts) waits for
 * it to end first (Steward 0.36.137): until the rollout has merged an employee's bump, its branch pins the kit before,
 * and the release would skip it ("merge the bump first"). The rollout bumps every employee, then pushes and merges each
 * in turn, holding none of them in between: a Release pressed two minutes into kit 2.82.4's rollout (2026-10-17)
 * released the 22 employees it had merged and skipped the 13 it hadn't, which a round then held as a new kit alone.
 */
export async function release(ctx: Ctx, employees: Employee[], o: { kit: string | null; hire?: boolean }): Promise<EmployeeResult[]> {
  const going = o.kit !== null && !o.hire ? rolloutGoingOn() : null;
  if (going && employees.some((e) => going.names.includes(e.name))) {
    ctx.log(`waits for kit ${going.kit}'s rollout beside the rounds to end (${going.names.length} employee${going.names.length === 1 ? '' : 's'}), so each release reads the bump it merged`);
    await rolloutDone();
  }
  return mapLimit(employees, ctx.settings.parallel, async (e) => {
    try {
      return await withRepo(ctx.log, e.id, () => releaseOne(ctx, e, o));
    } catch (err) {
      ctx.log(`[${e.id}] ${(err as Error).message}`);
      return result(e, 'failed', (err as Error).message);
    }
  });
}
