import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchBranch, git, removeWorktree } from '../git.ts';
import { expandEnv } from '../kit/settings-kit.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { splitCommand, tail, type Ran } from '../run.ts';
import type { Employee, Settings } from '../settings.ts';
import { runChecks, type AffectedScope } from './bump.ts';
import { claimedBranches, headsOnOrigin, proposal } from './branchesin.ts';
import { checkoutOf, forgetGlance, hostIs, workRootOf, type Ctx } from './common.ts';
import { recordTested } from '../tested.ts';

/**
 * Plain git's events (scm.ts): a repository worked with plain git has no pull requests, so what the Steward does where
 * a host would have one is the person's to say, as commands in Settings.
 *
 * - When a branch is ready (`whenReady`): a claimed branch (claims.ts), pushed, not yet in the employee's branch, is tested
 *   here at its head (its Test it commands, in a worktree of its own: there is no host to carry a vouch), then the
 *   command is run in the clone, lowest version first. Exit 0 is handed in: it isn't run again at that head. What lands
 *   the branch is the command's (a fast-forward push, a review opened on a server of your own, a mail); once the head
 *   is in the employee's branch the claim is done with, and the branch's version is released as any other.
 * - After a release (`whenReleased`): run in the clone once the release's tag is pushed (release.ts).
 *
 * Each command line is split into words first and its {placeholders} filled in word by word, so a value with spaces or
 * quotes stays one word and nothing reaches a shell (a command that wants one starts it: cmd /c, powershell -Command).
 * %USERPROFILE% and the like are expanded. A placeholder it doesn't know is left as it is.
 */

/** A command's words with {name} filled in from values, each word on its own; null when there's no command. */
export function fillCommand(line: string, values: Record<string, string>): string[] | null {
  const words = splitCommand(expandEnv(line)).map((w) => w.replace(/\{([a-zA-Z]+)\}/g, (all, k: string) => (Object.hasOwn(values, k) ? values[k] : all)));
  return words.length ? words : null;
}

/** Runs a filled-in command in a folder. */
export async function runFilled(ctx: Ctx, line: string, values: Record<string, string>, cwd: string, timeoutMs = 30 * 60_000): Promise<Ran> {
  const words = fillCommand(line, values);
  if (!words) return { code: 2, out: '', err: 'no command' };
  const [cmd, ...args] = words;
  return ctx.run(cmd, args, { cwd, timeoutMs });
}

/** The last line a command said, for a round's line. */
const said = (r: Ran) => (r.err || r.out).trim().split('\n').pop()?.trim() || 'no output';

/** A handed-in branch, kept by employee and branch (handed-in.json). */
export interface HandedIn {
  /** The head it was looked at. */
  head: string;
  /** Tested here at that head: passed, or what failed. */
  tested?: { ok: boolean; note: string };
  /** The command ran and said yes. */
  ok?: boolean;
  /** The times the command failed at that head. */
  tries?: number;
  /** What it said last. */
  note?: string;
  at: string;
}

export const handedInFile = () => dataFile('handed-in.json');
const keyOf = (e: Employee, branch: string) => `${e.id}:${branch}`;
const handedIn = (e: Employee, branch: string): HandedIn | null => readJson<Record<string, HandedIn>>(handedInFile(), {})[keyOf(e, branch)] ?? null;
function keep(e: Employee, branch: string, h: HandedIn): void {
  const all = readJson<Record<string, HandedIn>>(handedInFile(), {});
  all[keyOf(e, branch)] = h;
  writeJson(handedInFile(), Object.fromEntries(Object.entries(all).slice(-500)));
}

/** A command that failed this many times at one head isn't run there again: the branch must move. */
export const HAND_IN_TRIES = 3;

export const handInDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-handin`);

/** Its Test it commands at a branch's head, in a worktree of its own; tried once more on a failure, as a PR's are. */
async function testHead(ctx: Ctx, e: Employee, branch: string, head: string): Promise<{ ok: boolean; note: string }> {
  const sha = head.slice(0, 7);
  if (!e.test.length) return { ok: true, note: `untested: Settings give ${e.name} no checks` };
  const repo = checkoutOf(e);
  const dir = handInDirOf(ctx.settings, e);
  await removeWorktree(ctx.run, repo, dir);
  if (existsSync(dir) && path.dirname(dir) === workRootOf(ctx.settings)) rmSync(dir, { recursive: true, force: true });
  await git(ctx.run, repo, 'worktree', 'add', '--quiet', '--detach', dir, head);
  ctx.log(`[${e.id}] ${branch}: testing it here at ${sha}, in ${dir}, before it's handed in`);
  try {
    const say = (line: string) => ctx.log(`[${e.id}] ${line}`);
    const scope: AffectedScope | undefined = ctx.settings.affectedTests === false ? undefined : { base: `origin/${e.branch}` };
    const affected = scope ? { affected: scope } : {};
    const failed = await runChecks(ctx, e, dir, { say, ...affected });
    if (!failed) return { ok: true, note: `checks passed here at ${sha}` };
    say(`${branch}: its checks once more (${failed})`);
    const again = await runChecks(ctx, e, dir, { say, ...affected });
    return again ? { ok: false, note: `its checks failed here at ${sha}, twice: ${again}` } : { ok: true, note: `checks passed here at ${sha} on a second try` };
  } finally {
    try {
      await removeWorktree(ctx.run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}

/**
 * The claimed branches of a repository worked with plain git, handed in by its When a branch is ready command (see
 * above). One line each for the round; failed once a command has failed HAND_IN_TRIES times at one head (fewer are
 * tried again next round, with no alarm). The first that can't go in yet holds the ones above it, as a PR does in the
 * version queue. Never throws.
 */
export async function handInBranches(ctx: Ctx, e: Employee): Promise<{ lines: string[]; failed: boolean; handed: number }> {
  const none = { lines: [], failed: false, handed: 0 };
  if (hostIs(ctx, e) !== 'git' || !e.merges || !e.whenReady) return none;
  const claimed = claimedBranches(e);
  if (!claimed.length) return none;
  const out: { lines: string[]; failed: boolean; handed: number } = { lines: [], failed: false, handed: 0 };
  try {
    const repo = checkoutOf(e);
    const heads = await headsOnOrigin(ctx, repo, claimed.map((c) => c.branch!));
    await fetchBranch(ctx.run, repo, e.branch);
    for (const c of claimed) {
      const branch = c.branch!;
      const head = heads.get(branch);
      // Not pushed yet, or gone: nothing to hand in, and nothing held.
      if (!head) continue;
      await fetchBranch(ctx.run, repo, branch);
      // In the branch already: its claim is done with.
      if ((await ctx.run('git', ['merge-base', '--is-ancestor', head, `origin/${e.branch}`], { cwd: repo, timeoutMs: 60_000 })).code === 0) continue;
      const had = handedIn(e, branch);
      const was = had?.head === head ? had : null;
      // Handed in at this head: waiting for it to land, which is the command's.
      if (was?.ok) {
        out.lines.push(`${branch} handed in at ${head.slice(0, 7)}, not in ${e.branch} yet`);
        break;
      }
      if (was && (was.tries ?? 0) >= HAND_IN_TRIES) {
        out.lines.push(`${branch}: When a branch is ready failed ${was.tries} times at ${head.slice(0, 7)} (${was.note}); it is run again once the branch moves`);
        out.failed = true;
        break;
      }
      // Another PC's turn here now (lease.ts): it hands them in.
      if (ctx.lease && !(await ctx.lease.ok(e))) break;
      const tested = was?.tested ?? (await testHead(ctx, e, branch, head));
      const now = new Date().toISOString();
      if (!was?.tested) {
        keep(e, branch, { head, tested, at: now });
        if (tested.ok && e.test.length) recordTested(e.id, { commit: head, stage: 'merge', branch, at: now });
      }
      if (!tested.ok) {
        out.lines.push(`${branch} not handed in: ${tested.note}; tested again once it moves`);
        break;
      }
      const p = await proposal(ctx, e, c, head, { by: 'the Steward' });
      const notesDir = mkdtempSync(path.join(os.tmpdir(), 'steward-handin-'));
      try {
        const notesFile = path.join(notesDir, 'notes.md');
        writeFileSync(notesFile, p.entry ?? '');
        const values = { repo: e.repo, checkout: repo, branch, base: e.branch, commit: head, version: p.version, title: p.title, notesFile };
        ctx.log(`[${e.id}] ${branch}: handing it in (v${p.version}, ${tested.note}): ${fillCommand(e.whenReady, values)!.join(' ')}`);
        const r = await runFilled(ctx, e.whenReady, values, repo);
        for (const line of tail(`${r.out}\n${r.err}`, 15).split('\n')) if (line.trim()) ctx.log(`[${e.id}]   ${line}`);
        if (r.code === 0) {
          keep(e, branch, { head, tested, ok: true, note: said(r), at: new Date().toISOString() });
          out.lines.push(`handed in ${branch} (v${p.version}, ${tested.note})`);
          out.handed++;
          forgetGlance(ctx, e);
          // Landed already (a fast-forward push, say): the next one's turn now.
          await fetchBranch(ctx.run, repo, e.branch);
          if ((await ctx.run('git', ['merge-base', '--is-ancestor', head, `origin/${e.branch}`], { cwd: repo, timeoutMs: 60_000 })).code === 0) continue;
          break;
        }
        const tries = (was?.tries ?? 0) + 1;
        keep(e, branch, { head, tested, tries, note: `exit ${r.code}: ${said(r)}`, at: new Date().toISOString() });
        out.lines.push(`${branch} not handed in: When a branch is ready failed (exit ${r.code}: ${said(r)})${tries < HAND_IN_TRIES ? ', tried again next round' : `, ${tries} times at ${head.slice(0, 7)}: run again once the branch moves`}`);
        if (tries >= HAND_IN_TRIES) out.failed = true;
        break;
      } finally {
        rmSync(notesDir, { recursive: true, force: true });
      }
    }
    return out;
  } catch (err) {
    ctx.log(`[${e.id}] couldn't hand in its claimed branches: ${(err as Error).message}`);
    return out;
  }
}

/**
 * After a release of a repository worked with plain git (release.ts): its After a release command, run in the clone.
 * Null when it ran (or there is none); else what it said, for a note on the release's line. Never throws.
 */
export async function runWhenReleased(ctx: Ctx, e: Employee, o: { commit: string; version: string; notes: string | null }): Promise<string | null> {
  if (hostIs(ctx, e) !== 'git' || !e.whenReleased) return null;
  const notesDir = mkdtempSync(path.join(os.tmpdir(), 'steward-released-'));
  try {
    const notesFile = path.join(notesDir, 'notes.md');
    writeFileSync(notesFile, o.notes ?? '');
    const repo = checkoutOf(e);
    const values = { repo: e.repo, checkout: repo, base: e.branch, tag: `v${o.version}`, version: o.version, commit: o.commit, notesFile };
    ctx.log(`[${e.id}] after its release: ${fillCommand(e.whenReleased, values)?.join(' ') ?? ''}`);
    const r = await runFilled(ctx, e.whenReleased, values, repo);
    for (const line of tail(`${r.out}\n${r.err}`, 15).split('\n')) if (line.trim()) ctx.log(`[${e.id}]   ${line}`);
    return r.code === 0 ? null : `exit ${r.code}: ${said(r)}`;
  } catch (err) {
    return (err as Error).message;
  } finally {
    rmSync(notesDir, { recursive: true, force: true });
  }
}
