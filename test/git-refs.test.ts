import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { branchOnDisk, commitOf, refOnDisk } from '../src/git.ts';
import { apiAsk, takeGlance } from '../src/glance.ts';
import { GithubLimited } from '../src/budget.ts';
import { run } from '../src/run.ts';

// Fewer processes (Steward 0.35.11): a branch's commit read from the clone's files, and the glance asked over HTTPS.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-refs-'));
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

test("a branch's commit from the clone's files: loose, packed, from a worktree, and git's answer when the files don't say", async () => {
  const repo = path.join(home, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  g(repo, 'config', 'user.email', 't@example.test');
  g(repo, 'config', 'user.name', 'T');
  writeFileSync(path.join(repo, 'a.txt'), 'a');
  g(repo, 'add', '.');
  g(repo, 'commit', '-qm', 'one');
  const one = g(repo, 'rev-parse', 'HEAD');
  g(repo, 'update-ref', 'refs/remotes/origin/main', one);
  writeFileSync(path.join(repo, 'a.txt'), 'b');
  g(repo, 'commit', '-qam', 'two');
  const two = g(repo, 'rev-parse', 'HEAD');

  assert.equal(refOnDisk(repo, 'refs/heads/main'), two, 'loose');
  assert.equal(refOnDisk(repo, 'origin/main'), one, 'origin/<branch> is refs/remotes/origin/<branch>');
  g(repo, 'pack-refs', '--all');
  assert.equal(refOnDisk(repo, 'refs/heads/main'), two, 'packed');
  assert.equal(refOnDisk(repo, 'origin/main'), one);

  const wt = path.join(home, 'wt');
  g(repo, 'worktree', 'add', '-q', '-b', 'side', wt, one);
  assert.equal(refOnDisk(wt, 'refs/heads/side'), one, "a worktree's branch, from the main clone's refs");
  assert.equal(refOnDisk(wt, 'refs/heads/main'), two);

  // What the files don't say plainly is git's: no such ref, a commit, a revision expression, a name git reads first.
  assert.equal(refOnDisk(repo, 'refs/heads/none'), null);
  assert.equal(refOnDisk(repo, one), null);
  assert.equal(refOnDisk(repo, 'origin/main^'), null);
  assert.equal(refOnDisk(repo, 'HEAD'), null);
  g(repo, 'tag', 'origin/main', two);
  assert.equal(refOnDisk(repo, 'origin/main'), null, 'a tag named origin/main comes before the remote branch for git');

  // commitOf answers as git does either way.
  for (const ref of ['refs/heads/main', 'origin/main', 'refs/heads/none', one, 'refs/heads/side']) {
    const ask = (r: string) => (execFileSync('git', ['rev-parse', '--verify', '--quiet', `${r}^{commit}`], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null);
    let want: string | null;
    try {
      want = ask(ref);
    } catch {
      want = null;
    }
    assert.equal(await commitOf(run, repo, ref), want, ref);
  }
});

test("the glance over HTTPS: GitHub's answer as gh gave it, partial answers kept, and a rate limit is GithubLimited", async () => {
  const asked: { url: string; body: any; auth: string }[] = [];
  const answer = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: String((init?.headers as Record<string, string>).authorization) });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  const porter = { id: 'porter', repo: 'Jcollier0120/Porter', branch: 'main', checkout: home } as any;
  const data = { rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-10-11T20:00:00Z' }, e0: { ref: { target: { oid: 'a'.repeat(40) } }, pullRequests: { totalCount: 0, nodes: [] }, releases: { nodes: [] } } };
  const ask = apiAsk({ token: async () => 't0k', fetch: answer(200, { data, errors: [{ path: ['steward'], message: 'gone' }] }) });
  const glance = await takeGlance(async () => assert.fail('no gh'), '.', { employees: [porter], stewardRepo: '' }, undefined, undefined, ask);
  assert.equal(glance.repos.porter.head, 'a'.repeat(40));
  assert.equal(glance.cost, 1);
  assert.match(asked[0].url, /\/graphql$/);
  assert.match(asked[0].body.query, /Porter/);
  assert.equal(asked[0].auth, 'Bearer t0k');

  const limited = apiAsk({ token: async () => 't', fetch: answer(403, { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' }) });
  await assert.rejects(takeGlance(async () => assert.fail('no gh'), '.', { employees: [porter], stewardRepo: '' }, undefined, undefined, limited), (e: unknown) => e instanceof GithubLimited && e.secondary);
});

test("the branch a clone has checked out, from its HEAD file: a clone's, a worktree's own, detached, and none", () => {
  const repo = path.join(home, 'heads');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  g(repo, 'config', 'user.email', 't@example.test');
  g(repo, 'config', 'user.name', 'T');
  writeFileSync(path.join(repo, 'a.txt'), 'a');
  g(repo, 'add', '.');
  g(repo, 'commit', '-qm', 'one');
  assert.equal(branchOnDisk(repo), 'main');
  const wt = path.join(home, 'heads-wt');
  g(repo, 'worktree', 'add', '-q', '-b', 'feat/side', wt);
  assert.equal(branchOnDisk(wt), 'feat/side', "a worktree's own HEAD, not the main clone's");
  g(repo, 'switch', '-q', '--detach');
  assert.equal(branchOnDisk(repo), '', 'detached');
  assert.equal(branchOnDisk(path.join(home, 'no-clone')), null);
});
