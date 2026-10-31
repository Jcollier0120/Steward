import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

// The Steward's hosts and pipeline with the real tools on this PC (Steward 0.36.267): opt-in (STEWARD_LIVE_HOSTS=1), for
// they ask hosts over the network and build the samples for real. Everything runs from a home of its own (STEWARD_HOME,
// with Manor's, the Wright's, the Bailiff's, the Assayer's and Reeve's beside it empty), and nothing signed in is used:
// gh is taken off PATH and given an empty config folder, and the rounds' runner refuses it and any push but to the
// sandbox or a folder, so GitHub is never asked; glab and az each get an empty config folder (anonymous on gitlab.com,
// signed out on Azure DevOps), and git's credential helpers are off for Bitbucket's API. The Gitea of your own when
// STEWARD_GITEA_SANDBOX names its address (http://127.0.0.1:<port>), STEWARD_GITEA_TEA_CONFIG the folder holding tea's
// login for it (as XDG_CONFIG_HOME) and STEWARD_GITEA_GIT_CREDENTIALS a git credential store file for it: its
// repositories are made afresh, and deleted after. Its commands (look after, claim-version, vouch, build --dry-run) run
// as the CLI runs them, in a process of its own; its rounds in this one, as the page's Build now starts them.
const LIVE = process.env.STEWARD_LIVE_HOSTS === '1';
const skip = !LIVE && 'set STEWARD_LIVE_HOSTS=1 to try the real hosts and tools';
const sandbox = process.env.STEWARD_GITEA_SANDBOX?.replace(/\/+$/, '');
const teaConfig = process.env.STEWARD_GITEA_TEA_CONFIG;
const credentials = process.env.STEWARD_GITEA_GIT_CREDENTIALS;
const noSandbox = skip || ((!sandbox || !teaConfig || !credentials) && 'set STEWARD_GITEA_SANDBOX, STEWARD_GITEA_TEA_CONFIG and STEWARD_GITEA_GIT_CREDENTIALS to try a Gitea of your own');

const home = mkdtempSync(path.join(os.tmpdir(), 'steward-hosts-live-'));
const empty = (name: string) => {
  const d = path.join(home, name);
  mkdirSync(d, { recursive: true });
  return d;
};
/** Settings of git for everything this file starts, after any already there (test-git.ts's), as git reads them. */
function gitConfig(pairs: [string, string][]) {
  let n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  for (const [k, v] of pairs) Object.assign(process.env, { [`GIT_CONFIG_KEY_${n}`]: k, [`GIT_CONFIG_VALUE_${n++}`]: v });
  process.env.GIT_CONFIG_COUNT = String(n);
}
Object.assign(process.env, {
  STEWARD_HOME: path.join(home, 'steward'),
  MANOR_HOME: empty('manor'),
  WRIGHT_HOME: path.join(home, 'no-wright'),
  BAILIFF_HOME: path.join(home, 'no-bailiff'),
  ASSAYER_HOME: path.join(home, 'no-assayer'),
  REEVE_HOME: path.join(home, 'no-reeve'),
  GH_CONFIG_DIR: empty('gh'),
  GLAB_CONFIG_DIR: empty('glab'),
  AZURE_CONFIG_DIR: empty('azure'),
  XDG_CONFIG_HOME: teaConfig ?? empty('tea'),
  PATH: (process.env.PATH ?? '').split(path.delimiter).filter((p) => !/GitHub CLI/i.test(p)).join(path.delimiter),
});
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN', 'AZURE_DEVOPS_EXT_PAT']) delete process.env[k];
gitConfig([
  ['credential.interactive', 'never'],
  ['credential.https://api.bitbucket.org.helper', ''],
  ...(sandbox && credentials ? ([[`credential.${sandbox}.helper`, ''], [`credential.${sandbox}.helper`, `store --file=${credentials.replace(/\\/g, '/')}`]] as [string, string][]) : []),
]);
const made: string[] = [];
after(() => {
  for (const repo of made) teaMaybe('-X', 'DELETE', `/repos/${repo}`);
  rmSync(home, { recursive: true, force: true });
});

const { runStage } = await import('../src/steward.ts');
const { run: realRun } = await import('../src/run.ts');
const { lookAfter } = await import('../src/found.ts');
const { repoFromUrl, scmNow, giteaHosts } = await import('../src/scm.ts');
const { loadSettings } = await import('../src/settings.ts');
const { GitLab, whereIs } = await import('../src/hosts/gitlab.ts');
const { AzureDevOps, whereAzure } = await import('../src/hosts/azure.ts');
const { Bitbucket } = await import('../src/hosts/bitbucket.ts');
const { sampleNames, spinUp } = await import('../tools/lib/samples.ts');

const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Live Test', '-c', 'user.email=live@example.test', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** The Steward's CLI, as a person runs it: a process of its own (not one of node --test's, which claims nothing on a remote). */
function steward(cwd: string, ...args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, encoding: 'utf8', timeout: 10 * 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const base = { developerOptions: true, workRoot: path.join(home, 'work'), releasesCastellan: false, byItself: true, tasteBeforeRelease: false, afterRelease: [], alarms: { manorUrl: '', surveyorUrl: '', toast: false } };
const settingsFile = path.join(home, 'steward', 'settings.json');
/** Settings afresh, with no repository looked after: each test looks after its own. */
const freshSettings = (o: Record<string, unknown> = {}) => {
  mkdirSync(path.dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ ...base, employees: [], ...o }, null, 2));
};
const lookAfterClone = (dir: string) => {
  const r = lookAfter('', { merges: false, release: true, folder: dir });
  assert.ok('employee' in r, JSON.stringify(r));
  return r.employee;
};
const files = (dir: string, all: Record<string, string>) => {
  for (const [f, text] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), text);
  }
};
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * A runner for this file's rounds: git, tea and each repository's own commands for real; gh refused, and a push to
 * anywhere but the sandbox or a folder on this PC refused, each kept for the test to see.
 */
function guarded() {
  const asked: string[] = [];
  const refused: string[] = [];
  const run = async (cmd: string, args: string[], opts?: any) => {
    asked.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'gh') return (refused.push(`gh ${args.join(' ')}`), { code: 1, out: '', err: 'gh is refused by the live test' });
    const at = args.indexOf('push');
    if (cmd === 'git' && at >= 0) {
      const remote = args.slice(at + 1).find((a) => !a.startsWith('-')) ?? 'origin';
      const url = /^[a-z+]+:|^[A-Za-z]:[\\/]|^[\\/]/i.test(remote) ? remote : (await realRun('git', ['remote', 'get-url', '--push', remote], { cwd: opts?.cwd })).out.trim();
      const ok = (sandbox && url.startsWith(`${sandbox}/`)) || /^file:|^[A-Za-z]:[\\/]|^[\\/]/i.test(url);
      if (!ok) return (refused.push(`push to ${url}`), { code: 1, out: '', err: `a push to ${url} is refused by the live test` });
    }
    return realRun(cmd, args, opts);
  };
  return { run, asked, refused };
}
/** The page's Build now, with this PC's tools as the Steward last looked at them (under node --test it looks at none itself). */
const buildNow = async (run: any) => runStage('round', { full: true, buildNow: { toCustomers: false } }, { run, scm: await scmNow(realRun) });
const resultOf = (r: { results: { id: string; message: string }[] }, id: string) => r.results.filter((x) => x.id === id).map((x) => x.message).join('\n');

// The sandbox's own requests, by tea (its login: the one on the sandbox's address).
let login = '';
function tea(...args: string[]): string {
  login ||= (JSON.parse(execFileSync('tea', ['logins', 'list', '--output', 'json'], { encoding: 'utf8' })) as { name: string; url: string }[]).find((l) => l.url.replace(/\/+$/, '') === sandbox)?.name ?? '';
  assert.ok(login, `tea has no login for ${sandbox} in ${teaConfig}`);
  return execFileSync('tea', ['api', '--login', login, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function teaMaybe(...args: string[]): string | null {
  try {
    return tea(...args);
  } catch {
    return null;
  }
}
/** A repository on the sandbox, made afresh, and a clone of it with `all` committed on main and pushed. */
function giteaRepo(name: string, all: Record<string, string>): { full: string; dir: string; repo: string } {
  const owner = JSON.parse(tea('/user')).login as string;
  const full = `${owner}/${name}`;
  teaMaybe('-X', 'DELETE', `/repos/${full}`);
  tea('-X', 'POST', '-d', JSON.stringify({ name, default_branch: 'main' }), '/user/repos');
  made.push(full);
  const dir = path.join(home, name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  files(dir, all);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'First');
  git(dir, 'remote', 'add', 'origin', `${sandbox}/${full}.git`);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return { full, dir, repo: repoFromUrl(`${sandbox}/${full}.git`)! };
}

test('a Gitea of your own, through tea: look after, the dry run, a claim through its claims ref, a vouch, its merge command and a release by its tagFormat', { skip: noSandbox, timeout: 15 * 60_000 }, async () => {
  freshSettings();
  const name = `live-${process.pid}`;
  const { full, dir, repo } = giteaRepo(name, {
    'package.json': json({ name, version: '0.1.0' }),
    'CHANGELOG.md': '# Changelog\n\n## 0.1.0\n\n**The first.**\n',
    '.steward.json': json({ host: { kind: 'gitea', baseUrl: sandbox }, test: ['node -e process.exit(0)'], versioning: 'claim', versionFiles: ['package.json'], tagFormat: `${name}-v{version}`, releaseTo: 'host' }),
  });
  assert.equal(repo, `127.0.0.1/${full}`, 'named as repoFromUrl names it: its port gone');
  // Settings' pipeline for it says a tag format too, and squash merges: .steward.json wins, option by option.
  freshSettings({ pipelines: { [repo]: { tagFormat: 'nope-{version}', mergeMethod: 'squash' } } });
  const e = lookAfterClone(dir);
  assert.equal(e.repo, repo);
  const p = loadSettings().employees[0].resolvedPipeline!;
  assert.deepEqual([p.tagFormat, p.from.tagFormat, p.mergeMethod, p.from.mergeMethod, p.host?.baseUrl], [`${name}-v{version}`, '.steward.json', 'squash', 'Settings', sandbox]);

  // Before the Steward has looked at this PC's tools: plain git, and the dry run says why.
  const before = steward(dir, 'build', '--dry-run', e.id);
  assert.equal(before.code, 0, before.out);
  assert.match(before.out, /worked with plain git\nwhy plain git: its pipeline names Gitea, but the Steward hasn't looked at this PC's source control yet/);
  const look = await scmNow(realRun, { force: true });
  assert.ok(giteaHosts(look).includes('127.0.0.1'), JSON.stringify(look));
  assert.ok(!look!.tools.find((t) => t.cmd === 'gh')?.version, 'gh is off PATH: never asked');
  const dry = steward(dir, 'build', '--dry-run', e.id);
  assert.match(dry.out, new RegExp(`^${e.id} \\(127\\.0\\.0\\.1/${full}\\), branch main, worked with gitea$`, 'm'), dry.out);
  assert.match(dry.out, /tagFormat from \.steward\.json.*mergeMethod from Settings/);
  assert.doesNotMatch(dry.out, /why plain git/);
  assert.match(dry.out, new RegExp(`${name}-v<version>`));

  // A version claimed through its claims ref on the Gitea.
  const claimed = steward(dir, 'claim-version', e.id, '--branch', 'feat/x', '--for', 'a live test', '--by', 'live');
  assert.match(claimed.out, new RegExp(`^${e.id} 0\\.1\\.1: yours\\. Set it in package\\.json\\.`, 'm'), claimed.out);
  assert.match(git(dir, 'ls-remote', 'origin', 'refs/manor/claims'), /refs\/manor\/claims$/);

  // Its PR, vouched for: the status set on the Gitea by tea, and the merge command it says works as said.
  git(dir, 'checkout', '-q', '-b', 'feat/x');
  files(dir, { 'package.json': json({ name, version: '0.1.1' }), 'CHANGELOG.md': '# Changelog\n\n## 0.1.1\n\n**A live test.**\n\n## 0.1.0\n\n**The first.**\n' });
  git(dir, 'commit', '-q', '-am', `${name} 0.1.1: a live test`);
  git(dir, 'push', '-q', '-u', 'origin', 'feat/x');
  const pr = JSON.parse(tea('-X', 'POST', '-d', JSON.stringify({ head: 'feat/x', base: 'main', title: `${name} 0.1.1: a live test` }), `/repos/${full}/pulls`)).number as number;
  const vouched = steward(dir, 'vouch', String(pr));
  assert.equal(vouched.code, 0, vouched.out);
  const head = git(dir, 'rev-parse', 'HEAD');
  const statuses = JSON.parse(tea(`/repos/${full}/commits/${head}/statuses`)) as { context: string; status: string }[];
  assert.deepEqual(statuses.map((s) => [s.context, s.status]), [['steward/tested', 'success']]);
  const merge = /\((tea pr merge [^)]+)\)/.exec(vouched.out)?.[1];
  assert.equal(merge, `tea pr merge ${pr} --repo ${full} --login ${login} --style squash`, vouched.out);
  execFileSync('tea', merge!.split(' ').slice(1), { cwd: home, stdio: 'ignore' });
  assert.equal(JSON.parse(tea(`/repos/${full}/pulls/${pr}`)).merged, true, 'merged by the command the vouch said, run anywhere');

  // Build now: the vouch trusted, released on the Gitea by its own tag format, its notes CHANGELOG.md's entry.
  const g = guarded();
  const first = await buildNow(g.run);
  assert.equal(first.error, undefined);
  const said = resultOf(first, e.id);
  assert.match(said, /^release: released v0\.1\.1 from origin\/main \(.{7}\)$/m, said);
  const released = first.results.find((x) => x.id === e.id && x.message.startsWith('release: ')) as { url?: string } | undefined;
  assert.equal(released?.url, `${sandbox}/${full}/releases/tag/${name}-v0.1.1`, 'its page at the server itself, port and all');
  const rel = JSON.parse(tea(`/repos/${full}/releases/tags/${name}-v0.1.1`)) as { body: string; target_commitish: string };
  assert.match(rel.body, /\*\*A live test\.\*\*/);
  assert.ok(g.asked.some((a) => a.startsWith(`tea api --login ${login} -i -X POST`)), g.asked.join('\n'));
  const again = await buildNow(g.run);
  assert.match(resultOf(again, e.id), /v0\.1\.1 is already released/);
  assert.deepEqual(g.refused, [], 'nothing asked of GitHub, nothing pushed anywhere else');
});

test('a Gitea of your own, versioned by its tags: released to a folder and tagged there by its own format', { skip: noSandbox, timeout: 10 * 60_000 }, async () => {
  freshSettings();
  const name = `tags-${process.pid}`;
  const folder = path.join(home, 'releases', name);
  const { full, dir } = giteaRepo(name, {
    'package.json': json({ name, version: '0.0.0' }),
    '.steward.json': json({ host: { kind: 'gitea', baseUrl: sandbox }, test: ['node -e process.exit(0)'], versioning: 'tags', tagFormat: `${name}-{version}`, changelog: 'none', releaseTo: { folder } }),
  });
  const e = lookAfterClone(dir);
  await scmNow(realRun, { force: true });
  const g = guarded();
  const first = await buildNow(g.run);
  // A folder release is tagged in the clone it was copied from, as its dry run says, its folder named by the tag.
  assert.match(resultOf(first, e.id), new RegExp(`released v0\\.1\\.0 from origin/main \\(.{7}\\) to .*\\\\${name}-0\\.1\\.0, tagged ${name}-0\\.1\\.0 in your clone$`, 'm'), resultOf(first, e.id));
  assert.ok(existsSync(path.join(folder, `${name}-0.1.0`, 'package.json')), 'its files in the folder');
  assert.ok(!existsSync(path.join(folder, `${name}-0.1.0`, '.git')));
  assert.equal(git(dir, 'rev-parse', `${name}-0.1.0^{commit}`), git(dir, 'rev-parse', 'origin/main'));
  assert.doesNotMatch(git(dir, 'ls-remote', '--tags', 'origin'), new RegExp(`${name}-0\\.1\\.0`), 'nothing pushed to the Gitea');
  assert.equal(JSON.parse(tea(`/repos/${full}/releases`)).length, 0, 'a folder release: no Gitea release');
  // A commit on main: the patch after it.
  files(dir, { 'notes.txt': 'more\n' });
  git(dir, 'add', 'notes.txt');
  git(dir, 'commit', '-q', '-m', 'More');
  git(dir, 'push', '-q', 'origin', 'main');
  const second = await buildNow(g.run);
  assert.match(resultOf(second, e.id), /released v0\.1\.1 /, resultOf(second, e.id));
  assert.ok(existsSync(path.join(folder, `${name}-0.1.1`, 'notes.txt')));
  assert.deepEqual(g.refused, []);
});

test('plain git on a bare file:// remote: a claim through its claims ref there, released as a tag pushed there', { skip, timeout: 10 * 60_000 }, async () => {
  freshSettings();
  const bare = path.join(home, 'shared.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const dir = path.join(home, 'notes');
  execFileSync('git', ['clone', '-q', pathToFileURL(bare).href, dir], { stdio: 'ignore' });
  files(dir, { 'package.json': json({ name: 'notes', version: '1.2.0' }), 'CHANGELOG.md': '# Changelog\n\n## 1.2.0\n\n**Notes kept.**\n', '.steward.json': json({ host: 'git', test: ['node -e process.exit(0)'], versioning: 'claim', versionFiles: ['package.json'], releaseTo: 'tag' }) });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Notes 1.2.0');
  git(dir, 'push', '-q', 'origin', 'main');
  const e = lookAfterClone(dir);
  assert.equal(e.repo, 'local/shared', 'named after the repository it shares, not this clone');
  assert.match(steward(dir, 'build', '--dry-run', e.id).out, /worked with plain git\npipeline: host from \.steward\.json/);
  assert.match(steward(dir, 'vouch').out, /is worked with plain git on this PC, which has no pull requests and no commit statuses/);
  const claimed = steward(dir, 'claim-version', e.id, '--branch', 'feat/y', '--for', 'a live test', '--by', 'live');
  assert.match(claimed.out, /^shared 1\.2\.1: yours/m, claimed.out);
  assert.match(git(bare, 'for-each-ref', '--format=%(refname)'), /^refs\/manor\/claims$/m, 'the claim in its claims ref, on the remote');
  files(dir, { 'package.json': json({ name: 'notes', version: '1.2.1' }), 'CHANGELOG.md': '# Changelog\n\n## 1.2.1\n\n**More notes.**\n\n## 1.2.0\n\n**Notes kept.**\n' });
  git(dir, 'commit', '-q', '-am', 'Notes 1.2.1');
  git(dir, 'push', '-q', 'origin', 'main');
  const g = guarded();
  const first = await buildNow(g.run);
  assert.match(resultOf(first, e.id), /^release: released v1\.2\.1 from origin\/main \(.{7}\), tagged v1\.2\.1 on its origin$/m, resultOf(first, e.id));
  assert.equal(git(bare, 'rev-parse', 'v1.2.1^{commit}'), git(bare, 'rev-parse', 'main'));
  assert.match(git(bare, 'tag', '-l', '--format=%(contents)', 'v1.2.1'), /\*\*More notes\.\*\*/);
  assert.match(resultOf(await buildNow(g.run), e.id), /v1\.2\.1 is already released/);
  assert.deepEqual(g.asked.filter((a) => !/^(git|node) /.test(a)), [], 'no host CLI asked');
  assert.deepEqual(g.refused, []);
});

test('a repository with no remote: versioned by its tags, released to a folder, tagged in the clone', { skip, timeout: 10 * 60_000 }, async () => {
  freshSettings();
  const dir = path.join(home, 'diary');
  const folder = path.join(home, 'releases', 'diary');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  files(dir, { 'diary.txt': 'day one\n', '.steward.json': json({ host: 'none', test: ['node -e process.exit(0)'], versioning: 'tags', changelog: 'none', releaseTo: { folder }, vouch: false, sharedRefs: false }) });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Day one');
  const e = lookAfterClone(dir);
  assert.equal(e.repo, 'local/diary');
  assert.match(steward(dir, 'build', '--dry-run', dir).out, /\(no host: local only\)/);
  const g = guarded();
  const first = await buildNow(g.run);
  assert.match(resultOf(first, e.id), /released v0\.1\.0 from origin\/main \(.{7}\) to .*, tagged v0\.1\.0 in your clone$/m, resultOf(first, e.id));
  assert.ok(existsSync(path.join(folder, 'v0.1.0', 'diary.txt')));
  assert.equal(git(dir, 'rev-parse', 'v0.1.0^{commit}'), git(dir, 'rev-parse', 'main'));
  assert.deepEqual(g.refused, []);
});

test("gitlab.com through glab anonymously: a project's and a subgroup's releases, its merge requests, and what needs signing in", { skip, timeout: 5 * 60_000 }, async (t) => {
  if (!(await realRun('glab', ['--version']).catch(() => null))?.out) return t.skip("glab isn't installed here");
  // A real subgroup's URL, both ways git names it.
  const sub = repoFromUrl('https://gitlab.com/gitlab-org/api/client-go.git')!;
  assert.equal(sub, 'gitlab.com/gitlab-org/api/client-go');
  assert.equal(repoFromUrl('git@gitlab.com:gitlab-org/api/client-go.git'), sub);
  assert.deepEqual(whereIs(sub), { hostname: 'gitlab.com', project: 'gitlab-org/api/client-go' });
  const gl = new GitLab(realRun, home, 'gitlab.com');
  for (const repo of ['gitlab.com/gitlab-org/cli', sub]) {
    const r = await gl.listReleases(repo, 'tagName,publishedAt,isDraft', 3);
    assert.equal(r.code, 0, r.err);
    const rels = JSON.parse(r.out) as { tagName: string; isDraft: boolean }[];
    assert.ok(rels.length > 0 && rels.every((x) => /^v\d+\.\d+\.\d+/.test(x.tagName) && x.isDraft === false), r.out.slice(0, 300));
    const one = await gl.viewRelease(repo, rels[0].tagName, 'tagName,isDraft,publishedAt');
    assert.equal(JSON.parse(one.out).tagName, rels[0].tagName);
  }
  const open = await gl.listPrs('gitlab.com/gitlab-org/cli', { state: 'open', limit: 2, fields: 'number,title,headRefName' });
  assert.equal(open.code, 0, open.err);
  assert.ok((JSON.parse(open.out) as { number: number }[]).every((m) => m.number > 0));
  const mr = await gl.viewPr('gitlab.com/gitlab-org/cli', 4256, 'number,state,title,headRefName');
  assert.equal(mr.code, 0, mr.err);
  assert.deepEqual([JSON.parse(mr.out).number, JSON.parse(mr.out).state], [4256, 'MERGED']);
  // A commit's statuses (a PR's checks, the vouch) and who you are need a sign-in, even on a public project.
  const main = (await realRun('git', ['ls-remote', 'https://gitlab.com/gitlab-org/cli.git', 'refs/heads/main'])).out.split(/\s/)[0];
  for (const a of [await gl.statuses('gitlab.com/gitlab-org/cli', main), await gl.whoAmI()]) assert.match(`${a.out}\n${a.err}`, /401 Unauthorized/);
  // The merge command a vouch says takes the host-prefixed name glab is given.
  const view = await realRun('glab', ['mr', 'view', '4256', '--repo', 'gitlab.com/gitlab-org/cli'], { cwd: home });
  assert.equal(view.code, 0, view.err);
  assert.match(view.out, /state:\s+merged/);
});

test('Azure DevOps through az signed out, and Bitbucket with no API token: the sentence each says', { skip, timeout: 5 * 60_000 }, async () => {
  const azRepo = repoFromUrl('https://dev.azure.com/microsoft/vscode-python/_git/vscode-python')!;
  assert.equal(azRepo, 'dev.azure.com/microsoft/vscode-python/_git/vscode-python');
  assert.ok(whereAzure(azRepo));
  const az = new AzureDevOps(realRun, home);
  // An empty AZURE_CONFIG_DIR has no extensions either: az repos and az devops say the extension, which isn't installed.
  for (const a of [await az.listPrs(azRepo, { state: 'open', limit: 2, fields: 'number,title' }), await az.listReleases(azRepo, 'tagName', 2)]) {
    assert.equal(a.code, 1);
    assert.match(a.err, /^the Azure CLI's azure-devops extension isn't installed: az extension add --name azure-devops$|^az's sign-in isn't let into https:\/\/dev\.azure\.com\/microsoft |az isn't installed|not recognized/);
  }
  const who = await az.whoAmI();
  assert.equal(who.code, 1);
  assert.match(who.err, /^az isn't signed in \(az login\): .*az login|az isn't installed|not recognized/);
  const bbRepo = repoFromUrl('https://bitbucket.org/atlassian/python-bitbucket.git')!;
  const bb = new Bitbucket(realRun, home);
  for (const a of [await bb.listPrs(bbRepo, { state: 'open', limit: 2, fields: 'number,title' }), await bb.listReleases(bbRepo, 'tagName', 2), await bb.whoAmI()]) {
    assert.equal(a.code, 1);
    assert.equal(a.err.trim(), "no Bitbucket API token for api.bitbucket.org in this PC's credential store");
  }
});

test("every sample through a real dry run, then built, tested and released for real where its toolchain is here", { skip, timeout: 20 * 60_000 }, async (t) => {
  freshSettings();
  const target = path.join(home, 'samples');
  const spun = spinUp(target);
  assert.deepEqual(spun.map((s) => s.name), sampleNames());
  for (const s of spun) {
    const r = steward(s.dir, 'build', '--dry-run', s.dir);
    assert.equal(r.code, s.name === 'broken-pipeline' ? 1 : 0, `${s.name}:\n${r.out}`);
    assert.match(r.out, s.name === 'broken-pipeline' ? /^held: /m : /Nothing was run \(dry run\)\.$/m, s.name);
  }
  const ids = new Map(spun.map((s) => [s.name, lookAfterClone(s.dir).id]));
  const has = async (cmd: string, ...args: string[]) => (await realRun(cmd, args).catch(() => ({ code: 1 }))).code === 0;
  const here = { dotnet: await has('dotnet', '--list-sdks'), go: await has('go', 'version'), python: (await has('python', '-m', 'pytest', '--version')) || (await has('py', '-m', 'pytest', '--version')), cargo: await has('cargo', '--version') };
  const g = guarded();
  const r = await buildNow(g.run);
  const of = (name: string) => resultOf(r, ids.get(name)!);
  const all = r.results.map((x) => `${x.id}: ${x.message}`).join('\n');
  assert.match(of('node-hello'), /released v\d+\.\d+\.\d+ from origin\/main \(.{7}\), tagged v\d+\.\d+\.\d+ on its origin/, all);
  assert.match(of('folder-release'), /released v\d+\.\d+\.\d+ from origin\/main \(.{7}\) to .*releases\\folder-release\\v\d+\.\d+\.\d+/, all);
  assert.match(of('local-only'), /released v0\.1\.0 .*tagged v0\.1\.0 in your clone/, all);
  assert.match(of('gitlab-hello'), /released v\d+\.\d+\.\d+ .*tagged v\d+\.\d+\.\d+ on its origin/, all);
  assert.match(of('broken-pipeline'), /its pipeline can't be read/, all);
  if (here.dotnet) assert.match(of('dotnet-hello'), /released v\d+\.\d+\.\d+ .* to .*releases\\dotnet-hello\\v\d+\.\d+\.\d+/, all);
  if (here.go) assert.match(of('go-hello'), /released v0\.1\.0 .*tagged v0\.1\.0 on its origin/, all);
  if (here.python) assert.match(of('python-hello'), /released v\d+\.\d+\.\d+ .*tagged python-hello-\d+\.\d+\.\d+ on its origin/, all);
  if (!here.cargo) assert.match(of('rust-hello'), /^release: v0\.1\.0 wasn't released: its checks failed here at .{7}, twice: cargo build --release failed/m, 'no cargo here: its build fails, and nothing is released');
  else assert.match(of('rust-hello'), /tagged rust-hello-v\d+\.\d+\.\d+ on its origin/, all);
  // What each folder release copied, in the samples' own releases folder: local-only's whole worktree, its test.cmd too.
  // (As git checks the release's worktree out: CRLF where its core.autocrlf says so.)
  const lf = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(lf(path.join(target, 'releases', 'local-only', 'v0.1.0', 'hello.cmd')), lf(path.join(target, 'local-only', 'hello.cmd')));
  assert.equal(git(path.join(target, 'local-only'), 'rev-parse', 'v0.1.0^{commit}'), git(path.join(target, 'local-only'), 'rev-parse', 'main'));
  assert.deepEqual(g.refused, []);
  t.diagnostic(`toolchains here: ${JSON.stringify(here)}`);
});

// The Rust sample built for real (Steward 0.36.268): cargo on this PC (rustup; the GNU toolchain links by itself where
// Visual Studio's Build Tools aren't installed), else skipped and said why.
const hasCargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status === 0;
const noCargo = skip || (!hasCargo && "cargo isn't installed here: install Rust (rustup) to build the Rust sample for real");

test('the Rust sample in a copy of its own: its dry run, then cargo builds, tests and runs it, a failing test holds it, and it is tagged by its own format', { skip: noCargo, timeout: 20 * 60_000 }, async (t) => {
  freshSettings();
  const [s] = spinUp(path.join(home, 'rust'), { only: ['rust-hello'] });
  const dir = s.dir;
  const bare = s.origin!;
  // As docs/PIPELINE.md says a person would see it first: each step, nothing run.
  const dry = steward(dir, 'build', '--dry-run', dir);
  assert.equal(dry.code, 0, dry.out);
  for (const line of [/^rust-hello \(local\/rust-hello\), branch main, worked with plain git$/m, /^ 1\. build {5}cargo build --release {2}\(in a fresh worktree of origin\/main\)$/m, /^ 2\. test {6}cargo test {2}\(in a fresh worktree of origin\/main; must pass\)$/m, /^ 3\. version {3}the version in Cargo\.toml, as you set it; nothing claimed$/m, /^ 5\. release {3}cargo run --release {2}\(in a fresh worktree of the commit released, then tags rust-hello-v<version> on its origin\)$/m, /^Nothing was run \(dry run\)\.$/m]) assert.match(dry.out, line);
  assert.ok(!existsSync(path.join(dir, 'target')), 'the dry run built nothing');
  // A tree of its own: the samples' test above built the same tree, and checks that passed on a tree aren't run again.
  files(dir, { 'COPY.md': 'The Rust sample, in a copy of its own.\n' });
  git(dir, 'add', 'COPY.md');
  git(dir, 'commit', '-q', '-m', 'A copy of its own');
  git(dir, 'push', '-q', 'origin', 'main');
  const e = lookAfterClone(dir);
  const logs: string[] = [];
  const g = guarded();
  const build = () => runStage('round', { full: true, buildNow: { toCustomers: false } }, { run: g.run, scm: null, log: (l) => logs.push(l) });

  // Built, tested and released by its own command, then tagged by its own format on its origin.
  const first = await build();
  assert.equal(first.error, undefined);
  assert.match(resultOf(first, e.id), /^release: released v0\.1\.0 from origin\/main \(.{7}\), tagged rust-hello-v0\.1\.0 on its origin$/m, `${resultOf(first, e.id)}\n${logs.join('\n')}`);
  assert.equal(git(bare, 'rev-parse', 'rust-hello-v0.1.0^{commit}'), git(bare, 'rev-parse', 'main'));
  const cargo = g.asked.filter((a) => a.startsWith('cargo '));
  assert.deepEqual([...new Set(cargo)], ['cargo build --release', 'cargo test', 'cargo run --release'], cargo.join('\n'));
  assert.ok(cargo.indexOf('cargo build --release') < cargo.indexOf('cargo test') && cargo.lastIndexOf('cargo run --release') > cargo.lastIndexOf('cargo test'), 'built before its tests, released after');
  assert.ok(logs.some((l) => /Hello, world!/.test(l)) || logs.some((l) => /test result: ok\. 1 passed/.test(l)), logs.join('\n'));
  assert.match(resultOf(await build(), e.id), /0\.1\.0 is already released/);

  // 0.1.1 with a failing test: held, nothing tagged, and why said by cargo's own words.
  const toml = readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
  const main = readFileSync(path.join(dir, 'src', 'main.rs'), 'utf8');
  files(dir, { 'Cargo.toml': toml.replace('version = "0.1.0"', 'version = "0.1.1"'), 'src/main.rs': main.replace('"Hello, Steward!"', '"Goodbye, Steward!"') });
  git(dir, 'commit', '-q', '-am', 'rust-hello 0.1.1: a failing test');
  git(dir, 'push', '-q', 'origin', 'main');
  const held = resultOf(await build(), e.id);
  assert.match(held, /v0\.1\.1 wasn't released: its checks failed here at .{7}, twice: cargo test failed/, held);
  assert.equal(spawnSync('git', ['-C', bare, 'rev-parse', '--verify', '--quiet', 'rust-hello-v0.1.1'], { encoding: 'utf8' }).status, 1, 'not tagged');

  // Fixed: released, and tagged at the fix.
  files(dir, { 'src/main.rs': main });
  git(dir, 'commit', '-q', '-am', 'rust-hello 0.1.1: its test fixed');
  git(dir, 'push', '-q', 'origin', 'main');
  assert.match(resultOf(await build(), e.id), /^release: released v0\.1\.1 from origin\/main \(.{7}\), tagged rust-hello-v0\.1\.1 on its origin$/m);
  assert.equal(git(bare, 'rev-parse', 'rust-hello-v0.1.1^{commit}'), git(bare, 'rev-parse', 'main'));
  assert.deepEqual(g.refused, []);
  t.diagnostic(`${spawnSync('cargo', ['--version'], { encoding: 'utf8' }).stdout.trim()}, ${/^host: (.+)$/m.exec(spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout)?.[1]?.trim() ?? 'its host unknown'}`);
});
