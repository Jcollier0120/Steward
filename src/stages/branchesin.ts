import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimsOn, type Claim } from '../claims.ts';
import { changeFiles, changeVersion, CHANGES_DIR, entryBody } from '../entries.ts';
import { fetchBranch, gh, gitMaybe, showFile } from '../git.ts';
import { CHANGELOG, entryOf, headlineOf } from '../kit/notes.ts';
import { compareVersions } from '../kitfiles.ts';
import type { Employee } from '../settings.ts';
import { checkoutOf, forgetGlance, glanceOf, hostIs, type Ctx } from './common.ts';
import { parsePrs, prListArgs, type PrInfo } from './staff.ts';
import { vouchOn } from './vouch.ts';

/**
 * Branches in: work doesn't open its own pull request. A Claude Code session (or a person) claims a version for its
 * branch (claims.ts), pushes the branch, and vouches for its head (`steward vouch`, stages/vouch.ts, which needs no PR
 * for a claimed branch). At its round the Steward opens the pull request for it, ready, and the same round stamps
 * (stages/stamp.ts) and merges it as any other.
 *
 * The branches come from the claims, which name them and are shared by every PC that looks after the repository, so
 * nothing scans a repository's branches. A claimed branch gets its PR once all hold: it is on origin, its head isn't in
 * the employee's branch already, no PR is open from it, none was closed at that same head (closed is closed), and the
 * latest vouch on its head is a team account's. Its title is "<Name> <version>: <the entry's bold line>", its version the
 * changes file it adds or else its claim's, and its description the entry, then where it came from. Only where GitHub
 * has pull requests (scm.ts): a repository worked with plain git has none to open. The Steward's own branches
 * (steward/…) and the Wright's (wright/…, which opens its own drafts for the Bailiff) are never taken.
 */

/** The claims on an employee's repository that name a branch it would open a PR from: the highest version per branch. */
export function claimedBranches(e: Employee, claims: Claim[] = claimsOn(e.repo)): Claim[] {
  const by = new Map<string, Claim>();
  for (const c of claims) {
    if (!c.branch || c.branch === e.branch || c.branch.startsWith('steward/') || c.branch.startsWith('wright/')) continue;
    const had = by.get(c.branch);
    if (!had || compareVersions(c.version, had.version) > 0) by.set(c.branch, c);
  }
  return [...by.values()].sort((a, b) => compareVersions(a.version, b.version) || a.branch!.localeCompare(b.branch!));
}

/** A branch's heads on origin, by branch name, for the ones origin has. One ls-remote for them all. */
async function headsOnOrigin(ctx: Ctx, repo: string, branches: string[]): Promise<Map<string, string>> {
  const out = await gitMaybe(ctx.run, repo, 'ls-remote', '--heads', 'origin', ...branches.map((b) => `refs/heads/${b}`));
  const heads = new Map<string, string>();
  for (const line of (out ?? '').split('\n')) {
    const [oid, ref] = line.trim().split(/\s+/);
    if (oid && ref?.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), oid);
  }
  return heads;
}

/**
 * The PR's title and description for a vouched branch: its version (the highest changes file it adds, else its claim's),
 * the entry for it (that file, else CHANGELOG.md's entry at its head), and the entry's bold line, else what its claim
 * says the work is.
 */
export async function proposal(ctx: Ctx, e: Employee, c: Claim, head: string, o: { by: string }): Promise<{ title: string; body: string; version: string }> {
  const repo = checkoutOf(e);
  const start = (await gitMaybe(ctx.run, repo, 'merge-base', `origin/${e.branch}`, head))?.trim();
  const listed = async (ref: string) => changeFiles(((await gitMaybe(ctx.run, repo, 'ls-tree', '--name-only', ref, `${CHANGES_DIR}/`)) ?? '').split('\n').map((l) => l.trim()));
  const had = new Set(start ? await listed(start) : []);
  const added = (await listed(head)).filter((f) => !had.has(f));
  let version = c.version;
  let entry: string | null = null;
  if (added.length) {
    version = changeVersion(added.at(-1)!)!;
    entry = entryBody((await showFile(ctx.run, repo, head, added.at(-1)!)) ?? '', version);
  } else entry = entryOf((await showFile(ctx.run, repo, head, CHANGELOG)) ?? '', version);
  const line = (entry && headlineOf(entry)) || c.for || c.branch!;
  const from = `Opened by the Steward from \`${c.branch}\`, whose head ${head.slice(0, 7)} ${o.by} vouched for (its checks passed in their clone). Claimed by ${c.by}${c.for ? ` for ${c.for}` : ''}.`;
  return { version, title: `${e.name} ${version}: ${line.replace(/[.\s]+$/, '')}`, body: [entry ?? `No changelog entry for v${version} was found on the branch.`, '', '---', '', from].join('\n') };
}

/**
 * The PRs the Steward opens for an employee's claimed, pushed and vouched branches (see above), before its merges look
 * at its PRs. One line each for the round; the PRs it opened. Never throws: a branch it couldn't open waits for the next
 * round, and says why in the log.
 */
export async function openVouchedBranches(ctx: Ctx, e: Employee): Promise<{ opened: { number: number; url: string; branch: string }[]; lines: string[] }> {
  const none = { opened: [], lines: [] };
  if (hostIs(ctx, e) === 'git' || !e.merges) return none;
  const claimed = claimedBranches(e);
  if (!claimed.length) return none;
  try {
    const g = glanceOf(ctx, e);
    const prs: PrInfo[] = parsePrs(g ? JSON.stringify(g.prs) : await gh(ctx.run, ctx.neutralDir, ...prListArgs(e.repo)), ctx.settings.team);
    const waiting = claimed.filter((c) => !prs.some((p) => p.head === c.branch && !p.fork));
    if (!waiting.length) return none;
    const repo = checkoutOf(e);
    const heads = await headsOnOrigin(ctx, repo, waiting.map((c) => c.branch!));
    const out: { opened: { number: number; url: string; branch: string }[]; lines: string[] } = { opened: [], lines: [] };
    for (const c of waiting) {
      const branch = c.branch!;
      const head = heads.get(branch);
      // Not pushed yet, or gone: nothing to open.
      if (!head) continue;
      const by = await vouchOn(ctx, e.repo, head, ctx.settings.team);
      // Still being worked on: the vouch comes once its checks pass.
      if (!by) continue;
      await fetchBranch(ctx.run, repo, e.branch);
      await fetchBranch(ctx.run, repo, branch);
      // Merged already (its head in the branch): its claim is done with, not a PR to open.
      if ((await ctx.run('git', ['merge-base', '--is-ancestor', head, `origin/${e.branch}`], { cwd: repo, timeoutMs: 60_000 })).code === 0) continue;
      // Someone closed its PR at this very head: closed is closed, until the branch moves.
      const closed = JSON.parse((await gh(ctx.run, ctx.neutralDir, 'pr', 'list', '--repo', e.repo, '--head', branch, '--state', 'closed', '--json', 'number,headRefOid')) || '[]') as { number: number; headRefOid: string }[];
      const shut = closed.find((p) => p.headRefOid === head);
      if (shut) {
        ctx.log(`[${e.id}] ${branch}: not opened again, as #${shut.number} was closed at its head ${head.slice(0, 7)}`);
        continue;
      }
      // Another PC's turn here now (lease.ts): it opens it.
      if (ctx.lease && !(await ctx.lease.ok(e))) break;
      const p = await proposal(ctx, e, c, head, { by });
      const dir = mkdtempSync(path.join(os.tmpdir(), 'steward-pr-'));
      let url: string;
      try {
        const file = path.join(dir, 'body.md');
        writeFileSync(file, p.body);
        url = (await gh(ctx.run, ctx.neutralDir, 'pr', 'create', '--repo', e.repo, '--base', e.branch, '--head', branch, '--title', p.title, '--body-file', file)).trim().split('\n').pop() ?? '';
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
      const line = `opened #${number || '?'} from ${branch} (v${p.version}, vouched for by ${by} at ${head.slice(0, 7)})`;
      ctx.log(`[${e.id}] ${line}`);
      out.opened.push({ number, url, branch });
      out.lines.push(line);
    }
    // Its PRs have changed: from here on they are read afresh, not from the glance.
    if (out.opened.length) forgetGlance(ctx, e);
    return out;
  } catch (err) {
    ctx.log(`[${e.id}] couldn't open the PRs for its vouched branches: ${(err as Error).message}`);
    return none;
  }
}
