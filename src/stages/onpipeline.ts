import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CHANGES_DIR, CHANGES_README, changesReadme, onPipelineNote } from '../entries.ts';
import { commitOf, fetchBranch, git, removeWorktree, showFile } from '../git.ts';
import type { Employee, Settings } from '../settings.ts';
import { checkoutOf, freshWorktree, PIPELINE_BRANCH, pipelineBranch, result, takesPipeline, workRootOf, type Ctx, type EmployeeResult } from './common.ts';
import { hostFor, must } from '../hosts/index.ts';
import { coveredBy, mergeOwn, prNumberOf } from './mainbuild.ts';
import { setVouch } from './vouch.ts';

/**
 * The switch to the build pipeline (Steward 0.36.248) for an employee on the newest kit already, which no kit bump reaches
 * until the next kit comes: the rollout (rollout.ts) gives it changes/README.md alone, Manor's words with its name, on a
 * branch of its own (steward/pipeline-<main's head>), in a PR opened and merged by the Steward itself, as a stamp is
 * (stamp.ts). One behind the kit gets the file with its kit bump instead (bump.ts pipelineWay). Nothing is tested and
 * nothing released for it: no code changes, and what covered main's head covers the commit too. From then on its PRs
 * write changes/<branch>.md, claim-version says it "rides the build pipeline", and the build stamps the version.
 *
 * One worked with plain git stays as it is: the stamp goes through a PR, which plain git hasn't.
 */

export const pipelineDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-pipeline`);

type OpenPr = { number: number; headRefName: string; headRefOid: string; url: string };

/** An employee's branch given changes/README.md, as the module's comment says: one result, never thrown for a git refusal. */
export async function onPipeline(ctx: Ctx, e: Employee): Promise<EmployeeResult> {
  const { run } = ctx;
  if (!takesPipeline(ctx, e)) return result(e, 'skipped', `it is worked with plain git, where the Steward opens no PRs, so it keeps setting its version in each change`);
  const repo = checkoutOf(e);
  if (!existsSync(repo)) return result(e, 'refused', `no checkout at ${repo}`);
  await fetchBranch(run, repo, e.branch);
  const head = await commitOf(run, repo, `origin/${e.branch}`);
  if (!head) return result(e, 'skipped', `no ${e.branch} on origin`);
  if ((await showFile(run, repo, head, CHANGES_README)) !== null) return result(e, 'skipped', `on the build pipeline already (${CHANGES_README} on ${e.branch})`);
  const host = hostFor(ctx, e);
  // One an earlier build left open (GitHub wouldn't merge it then): merged now, never a second one beside it.
  const open = (JSON.parse(must(await host.listPrs(e.repo, { state: 'open', limit: 100, fields: 'number,headRefName,headRefOid,url' })) || '[]') as OpenPr[]).filter((p) => p.headRefName?.startsWith(PIPELINE_BRANCH));
  if (open.length) {
    const p = open[0];
    const why = await mergeOwn(ctx, e, { number: p.number, head: p.headRefOid });
    return why
      ? result(e, 'failed', `its PR #${p.number} onto the build pipeline is open still (${why}): the next build tries again`, { url: p.url })
      : result(e, 'done', `merged its PR #${p.number} onto the build pipeline, left open by an earlier build`, { url: p.url });
  }
  const sha = head.slice(0, 7);
  const branch = pipelineBranch(head);
  const dir = pipelineDirOf(ctx.settings, e);
  await removeWorktree(run, repo, dir);
  await freshWorktree(run, ctx.settings, repo, dir, head, '--detach');
  try {
    mkdirSync(path.join(dir, CHANGES_DIR), { recursive: true });
    writeFileSync(path.join(dir, CHANGES_README), changesReadme(e.name));
    await git(run, dir, 'add', '--', CHANGES_README);
    const title = `${e.name} rides the build pipeline: ${CHANGES_README}`;
    await git(run, dir, 'commit', '--quiet', '-m', title);
    // Another PC's turn here now (lease.ts): it does this.
    if (ctx.lease && !(await ctx.lease.ok(e))) return result(e, 'skipped', `another PC publishes ${e.name} now, so it wasn't put on the build pipeline here`);
    const pushed = await run('git', ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir, timeoutMs: 5 * 60_000 });
    if (pushed.code !== 0) {
      const lines = (pushed.err || pushed.out).trim().split('\n');
      return result(e, 'failed', `${branch} couldn't be pushed (never forced): ${(lines.find((l) => /rejected|error|fatal/i.test(l)) ?? lines[0]).trim()}`);
    }
    const commit = (await git(run, dir, 'rev-parse', 'HEAD')).trim();
    // Only changes/README.md since main's head: what covered it covers this too.
    const by = await coveredBy(ctx, e, head);
    if (by) {
      const refused = await setVouch(ctx, e, e.repo, commit, `Only ${CHANGES_README} was added since ${sha}: ${by}`.slice(0, 140));
      if (refused) ctx.log(`[${e.id}] ${refused}`);
    }
    const body = [onPipelineNote(e.name), '', `Only that file is added, to ${e.branch} at ${sha}: nothing is released for it. Opened and merged by the Steward at a build.`].join('\n');
    const url = must(await host.createPr(e.repo, { base: e.branch, head: branch, title, body })).trim().split('\n').pop() ?? '';
    const n = prNumberOf(url);
    const why = n ? await mergeOwn(ctx, e, { number: n, head: commit }) : `no PR number in ${url}`;
    const note = why ? `opened ${url} to put it on the build pipeline, but it is open still (${why}): the next build merges it` : `put it on the build pipeline (${CHANGES_README}, ${url}), and merged it`;
    ctx.log(`[${e.id}] ${note}`);
    return result(e, why ? 'failed' : 'done', note, { url });
  } finally {
    try {
      await removeWorktree(run, repo, dir);
    } catch (err) {
      ctx.log(`[${e.id}] couldn't remove ${dir}: ${(err as Error).message}`);
    }
  }
}
