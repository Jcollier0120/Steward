import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// GitLab's way with the real glab, on a throwaway GitLab CE of your own (Steward 0.36.268): opt-in, for it needs one.
// STEWARD_LIVE_HOSTS=1, GITLAB_CE_URL its address (http://127.0.0.1:<port> and nothing else, so no real server is ever
// asked) and GITLAB_CE_TOKEN_FILE a file holding only its admin token. With the admin token (read from the file, never
// shown), a user of its own is made with a token, and that user makes a group, a subgroup and the projects in it; glab is
// signed in as that user into a config folder of its own (GLAB_CONFIG_DIR, its token in the file there, never the
// keyring), and git pushes with a credential store file of its own. Then the Steward's own code: scm.ts finds glab
// signed in, Look after reads each project's .steward.json, the dry run, a claim through its claims ref, a vouch and
// the merge command it says, Build now's release on the GitLab through glab and its tag release, and signed out, the
// sentence docs/PIPELINE.md promises. Afterwards the user is hard-deleted, which takes the group it alone owns with it.
// Everything else runs from a home of its own, as test/hosts-live.test.ts's do: gh off PATH, nothing signed in used.
const LIVE = process.env.STEWARD_LIVE_HOSTS === '1';
const ce = process.env.GITLAB_CE_URL?.replace(/\/+$/, '');
const tokenFile = process.env.GITLAB_CE_TOKEN_FILE;
const hasGlab = spawnSync('glab', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = !LIVE
  ? 'set STEWARD_LIVE_HOSTS=1 to try the real hosts and tools'
  : !ce || !tokenFile
    ? 'set GITLAB_CE_URL (http://127.0.0.1:<port>, a throwaway GitLab CE on this PC) and GITLAB_CE_TOKEN_FILE (a file holding only its admin token) to try GitLab\'s way for real'
    : !/^http:\/\/127\.0\.0\.1:\d+$/.test(ce)
      ? `GITLAB_CE_URL must be http://127.0.0.1:<port>, a throwaway GitLab on this PC, never a real server: not ${ce}`
      : !existsSync(tokenFile)
        ? `GITLAB_CE_TOKEN_FILE names no file: ${tokenFile}`
        : !hasGlab && "glab isn't installed here";
const hostPort = ce?.replace(/^http:\/\//, '') ?? '';

const home = mkdtempSync(path.join(os.tmpdir(), 'steward-gitlab-ce-live-'));
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
const credentials = path.join(home, 'git-credentials');
const glabConfig = empty('glab');
Object.assign(process.env, {
  STEWARD_HOME: path.join(home, 'steward'),
  MANOR_HOME: empty('manor'),
  WRIGHT_HOME: path.join(home, 'no-wright'),
  BAILIFF_HOME: path.join(home, 'no-bailiff'),
  ASSAYER_HOME: path.join(home, 'no-assayer'),
  REEVE_HOME: path.join(home, 'no-reeve'),
  GH_CONFIG_DIR: empty('gh'),
  GLAB_CONFIG_DIR: glabConfig,
  GLAB_SEND_TELEMETRY: '0',
  GLAB_CHECK_UPDATE: 'false',
  AZURE_CONFIG_DIR: empty('azure'),
  XDG_CONFIG_HOME: empty('tea'),
  PATH: (process.env.PATH ?? '').split(path.delimiter).filter((p) => !/GitHub CLI/i.test(p)).join(path.delimiter),
});
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN', 'GITLAB_HOST', 'GITLAB_URI', 'GL_HOST']) delete process.env[k];
gitConfig([
  ['credential.interactive', 'never'],
  ...(ce ? ([[`credential.${ce}.helper`, ''], [`credential.${ce}.helper`, `store --file=${credentials.replace(/\\/g, '/')}`]] as [string, string][]) : []),
]);

const { runStage } = await import('../src/steward.ts');
const { run: realRun } = await import('../src/run.ts');
const { lookAfter } = await import('../src/found.ts');
const { gitlabReady, hostOf, scmNow } = await import('../src/scm.ts');
const { loadSettings } = await import('../src/settings.ts');

const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Live Test', '-c', 'user.email=live@example.test', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** The Steward's CLI, as a person runs it: a process of its own. */
function steward(cwd: string, ...args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, encoding: 'utf8', timeout: 10 * 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
/** glab as this file's user has it: its own config folder, nothing typed at it. */
const glab = (args: string[], input?: string) => spawnSync('glab', args, { cwd: home, encoding: 'utf8', input: input ?? '', timeout: 2 * 60_000 });
const base = { developerOptions: true, workRoot: path.join(home, 'work'), releasesCastellan: false, byItself: true, tasteBeforeRelease: false, afterRelease: [], alarms: { manorUrl: '', surveyorUrl: '', toast: false } };
const settingsFile = path.join(home, 'steward', 'settings.json');
const freshSettings = () => {
  mkdirSync(path.dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ ...base, employees: [] }, null, 2));
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
const resultOf = (r: { results: { id: string; message: string }[] }, id: string) => r.results.filter((x) => x.id === id).map((x) => x.message).join('\n');

/**
 * A runner for this file's rounds: git, glab and each project's own commands for real, each kept with the GITLAB_HOST it
 * was given; gh refused, and a push to anywhere but the CE or a folder on this PC refused.
 */
function guarded() {
  const asked: { line: string; gitlabHost?: string }[] = [];
  const refused: string[] = [];
  const run = async (cmd: string, args: string[], opts?: any) => {
    asked.push({ line: `${cmd} ${args.join(' ')}`, gitlabHost: opts?.env?.GITLAB_HOST });
    if (cmd === 'gh') return (refused.push(`gh ${args.join(' ')}`), { code: 1, out: '', err: 'gh is refused by the live test' });
    const at = args.indexOf('push');
    if (cmd === 'git' && at >= 0) {
      const remote = args.slice(at + 1).find((a) => !a.startsWith('-')) ?? 'origin';
      const url = /^[a-z+]+:|^[A-Za-z]:[\\/]|^[\\/]/i.test(remote) ? remote : (await realRun('git', ['remote', 'get-url', '--push', remote], { cwd: opts?.cwd })).out.trim();
      if (!url.startsWith(`${ce}/`) && !/^file:|^[A-Za-z]:[\\/]|^[\\/]/i.test(url)) return (refused.push(`push to ${url}`), { code: 1, out: '', err: `a push to ${url} is refused by the live test` });
    }
    return realRun(cmd, args, opts);
  };
  return { run, asked, refused };
}
/** The page's Build now, with this PC's tools as the Steward last looked at them, its log kept. */
const buildNow = async (run: any, log: string[] = []) => runStage('round', { full: true, buildNow: { toCustomers: false } }, { run, scm: await scmNow(realRun), log: (l) => log.push(l) });

// The CE's REST API: the admin's token for the user, the user's own for the rest. Neither is ever printed.
const made: { userId?: number; username?: string; groupId?: number; groupPath?: string; subId?: number; token?: string; gone?: boolean } = {};
async function api(method: string, endpoint: string, body?: unknown, as: 'admin' | 'user' = 'user'): Promise<any> {
  const token = as === 'admin' ? readFileSync(tokenFile!, 'utf8').trim() : made.token!;
  const r = await fetch(`${ce}/api/v4/${endpoint}`, { method, headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${endpoint}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const status = async (endpoint: string) => (await fetch(`${ce}/api/v4/${endpoint}`, { headers: { 'PRIVATE-TOKEN': readFileSync(tokenFile!, 'utf8').trim() } })).status;

/** The user hard-deleted (its group, which it alone owns, with it), and waited for until GitLab has both gone. */
async function cleanUp(): Promise<string[]> {
  if (!made.userId || made.gone) return [];
  await api('DELETE', `users/${made.userId}?hard_delete=true`, undefined, 'admin');
  const left = () => Promise.all([status(`users/${made.userId}`), made.groupId ? status(`groups/${made.groupId}`) : 404]);
  for (let i = 0; i < 90 && (await left()).some((s) => s !== 404); i++) await new Promise((r) => setTimeout(r, 2000));
  const [user, group] = await left();
  made.gone = user === 404 && group === 404;
  return [...(user === 404 ? [] : [`user ${made.username} (${user})`]), ...(group === 404 ? [] : [`group ${made.groupPath} (${group})`])];
}

before(async () => {
  if (skip) return;
  const tag = randomBytes(4).toString('hex');
  made.username = `steward-live-${tag}`;
  // GitLab refuses a password with parts of the user's name in it: it makes a random one of its own.
  const user = await api('POST', 'users', { username: made.username, name: 'Steward Live Test', email: `${made.username}@example.test`, force_random_password: true, skip_confirmation: true }, 'admin');
  made.userId = user.id;
  const expires = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  made.token = (await api('POST', `users/${user.id}/personal_access_tokens`, { name: 'steward-live', scopes: ['api', 'read_repository', 'write_repository'], expires_at: expires }, 'admin')).token as string;
  // A group the user alone owns (its path not its name's, which the user's own namespace has), and a subgroup in it.
  const group = await api('POST', 'groups', { name: `Steward pipelines ${tag}`, path: `steward-pipelines-${tag}`, visibility: 'private' });
  Object.assign(made, { groupId: group.id, groupPath: group.full_path });
  made.subId = (await api('POST', 'groups', { name: 'apps', path: 'apps', parent_id: group.id, visibility: 'private' })).id;
  // Auto DevOps off in its group: a CE's default puts a pipeline on each commit, which with no runner never finishes,
  // and glab mr merge would wait for it (found live). The Steward's own status stands beside such jobs either way.
  await api('PUT', `groups/${group.id}`, { auto_devops_enabled: false });
  // git's own credential store, for this file's pushes to the CE alone.
  execFileSync('git', ['credential-store', `--file=${credentials}`, 'store'], { input: `protocol=http\nhost=${hostPort}\nusername=${made.username}\npassword=${made.token}\n\n` });
});
after(async () => {
  try {
    const left = await cleanUp();
    if (left.length) console.error(`left on the CE: ${left.join(', ')}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** A project in the subgroup, made by the user, and a clone of it with `all` committed on main and pushed. */
async function ceProject(name: string, all: Record<string, string>): Promise<{ id: number; path: string; dir: string; repo: string }> {
  const p = await api('POST', 'projects', { name, path: name, namespace_id: made.subId, visibility: 'private' });
  const dir = path.join(home, name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  files(dir, all);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'First');
  git(dir, 'remote', 'add', 'origin', `${ce}/${p.path_with_namespace}.git`);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return { id: p.id, path: p.path_with_namespace, dir, repo: `127.0.0.1/${p.path_with_namespace}` };
}
const pipeline = (o: Record<string, unknown>) => json({ host: { kind: 'gitlab', baseUrl: ce }, test: ['node -e process.exit(0)'], ...o });
let released: Awaited<ReturnType<typeof ceProject>>;
let releasedId = '';

test('glab signed in to the CE, in a config folder of its own: scm.ts finds it, and a project naming it is worked GitLab\'s way', { skip, timeout: 5 * 60_000 }, async () => {
  freshSettings();
  const login = glab(['auth', 'login', '--hostname', hostPort, '--api-protocol', 'http', '--git-protocol', 'http', '--stdin', '--insecure-storage'], made.token);
  assert.equal(login.status, 0, `${login.stdout}${login.stderr}`);
  assert.match(readFileSync(path.join(glabConfig, 'config.yml'), 'utf8'), new RegExp(`^ {4}${hostPort.replace(/\./g, '\\.')}:$`, 'm'), "its login in this file's own config folder");
  const look = await scmNow(realRun, { force: true });
  assert.equal(look?.tools.find((t) => t.cmd === 'glab')?.signedIn, true, JSON.stringify(look?.tools));
  assert.ok(gitlabReady(look));

  released = await ceProject('released', {
    'package.json': json({ name: 'released', version: '0.1.0' }),
    'CHANGELOG.md': '# Changelog\n\n## 0.1.0\n\n**The first.**\n',
    '.steward.json': pipeline({ versioning: 'claim', versionFiles: ['package.json'], changelog: 'changelog-md', releaseTo: 'host', mergeMethod: 'merge' }),
  });
  const e = lookAfterClone(released.dir);
  releasedId = e.id;
  assert.equal(e.repo, released.repo, 'named as repoFromUrl names it: its port gone, its subgroup kept');
  const p = loadSettings().employees[0].resolvedPipeline!;
  assert.deepEqual([p.host?.kind, p.host?.baseUrl, p.releaseTo.kind], ['gitlab', ce, 'host']);
  assert.equal(hostOf(loadSettings().employees[0], { sourceControl: 'auto', releasesCastellan: false }, look), 'gitlab');
  const dry = steward(released.dir, 'build', '--dry-run', e.id);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, new RegExp(`^${e.id} \\(127\\.0\\.0\\.1/${released.path}\\), branch main, worked with gitlab$`, 'm'), dry.out);
  assert.doesNotMatch(dry.out, /why plain git/);
});

test('a claim through its claims ref on the CE, a merge request vouched for (its status set through glab), merged by the command the vouch says, and released on the GitLab through glab', { skip, timeout: 15 * 60_000 }, async () => {
  assert.ok(releasedId, 'the first test looked after it');
  const { dir, id, path: full } = released;
  const claimed = steward(dir, 'claim-version', releasedId, '--branch', 'feat/x', '--for', 'a live test', '--by', 'live');
  assert.match(claimed.out, new RegExp(`^${releasedId} 0\\.1\\.1: yours\\. Set it in package\\.json\\.`, 'm'), claimed.out);
  assert.match(git(dir, 'ls-remote', 'origin', 'refs/manor/claims'), /refs\/manor\/claims$/, 'the claim in its claims ref, on the CE');

  git(dir, 'checkout', '-q', '-b', 'feat/x');
  files(dir, { 'package.json': json({ name: 'released', version: '0.1.1' }), 'CHANGELOG.md': '# Changelog\n\n## 0.1.1\n\n**A live test.**\n\n## 0.1.0\n\n**The first.**\n' });
  git(dir, 'commit', '-q', '-am', 'released 0.1.1: a live test');
  git(dir, 'push', '-q', '-u', 'origin', 'feat/x');
  const head = git(dir, 'rev-parse', 'HEAD');
  const mr = (await api('POST', `projects/${id}/merge_requests`, { source_branch: 'feat/x', target_branch: 'main', title: 'released 0.1.1: a live test' })).iid as number;
  const vouched = steward(dir, 'vouch', String(mr));
  assert.equal(vouched.code, 0, vouched.out);
  const statuses = (await api('GET', `projects/${id}/repository/commits/${head}/statuses`)) as { name: string; status: string; author: { username: string } }[];
  assert.deepEqual(statuses.filter((s) => s.name === 'steward/tested').map((s) => [s.status, s.author.username]), [['success', made.username]], JSON.stringify(statuses.map((s) => s.name)));
  // The command it says, run as a person would (glab asks nothing with --yes), merges it on the CE.
  const merge = /\((glab mr merge [^)]+)\)/.exec(vouched.out)?.[1];
  assert.equal(merge, `glab mr merge ${mr} --repo ${ce}/${full}`, vouched.out);
  const merged = glab([...merge!.split(' ').slice(1), '--yes']);
  assert.equal(merged.status, 0, `${merged.stdout}${merged.stderr}`);
  for (let i = 0; i < 30 && (await api('GET', `projects/${id}/merge_requests/${mr}`)).state !== 'merged'; i++) await new Promise((r) => setTimeout(r, 2000));
  assert.equal((await api('GET', `projects/${id}/merge_requests/${mr}`)).state, 'merged');

  // Build now: the vouch seen (the team its glab account), released on the GitLab through glab, at its own address.
  const g = guarded();
  const log: string[] = [];
  const first = await buildNow(g.run, log);
  assert.equal(first.error, undefined);
  const said = resultOf(first, releasedId);
  assert.match(said, /^release: released v0\.1\.1 from origin\/main \(.{7}\)$/m, `${said}\n${log.join('\n')}`);
  assert.ok(log.some((l) => l.includes(`${made.username} vouched for ${head.slice(0, 7)}`)), `its vouch seen:\n${log.join('\n')}`);
  const url = (first.results.find((x) => x.id === releasedId && x.message.startsWith('release: ')) as { url?: string } | undefined)?.url;
  assert.equal(url, `${ce}/${full}/-/releases/v0.1.1`);
  const rel = await api('GET', `projects/${id}/releases/v0.1.1`);
  git(dir, 'fetch', '-q', 'origin');
  assert.deepEqual([rel.tag_name, rel.name, rel.commit.id], ['v0.1.1', 'released 0.1.1', git(dir, 'rev-parse', 'origin/main')]);
  assert.match(rel.description, /\*\*A live test\.\*\*/, 'its notes the CHANGELOG.md entry');
  const create = g.asked.find((a) => a.line.startsWith(`glab api projects/${encodeURIComponent(full)}/releases -X POST`));
  assert.ok(create, g.asked.map((a) => a.line).join('\n'));
  assert.equal(create.gitlabHost, ce, 'glab told the CE by GITLAB_HOST');
  assert.ok(g.asked.filter((a) => a.line.startsWith('glab ')).every((a) => !a.line.includes('--hostname 127.0.0.1')), 'never --hostname with its port lost');
  assert.match(resultOf(await buildNow(g.run), releasedId), /v0\.1\.1 is already released/);
  assert.deepEqual(g.refused, []);
});

test('releaseTo tag on the CE: a tag pushed by git at the commit, by its own format, and no GitLab release', { skip, timeout: 10 * 60_000 }, async () => {
  freshSettings();
  const tagged = await ceProject('tagged', { 'package.json': json({ name: 'tagged', version: '0.2.0' }), '.steward.json': pipeline({ versioning: 'files', versionFiles: ['package.json'], changelog: 'none', tagFormat: 'tagged-{version}', releaseTo: 'tag' }) });
  const e = lookAfterClone(tagged.dir);
  const g = guarded();
  const first = await buildNow(g.run);
  assert.match(resultOf(first, e.id), /^release: released v0\.2\.0 from origin\/main \(.{7}\), tagged tagged-0\.2\.0 on its origin$/m, resultOf(first, e.id));
  const tag = await api('GET', `projects/${tagged.id}/repository/tags/tagged-0.2.0`);
  assert.equal(tag.commit.id, git(tagged.dir, 'rev-parse', 'main'));
  assert.deepEqual(await api('GET', `projects/${tagged.id}/releases`), [], 'a tag alone');
  assert.ok(!g.asked.some((a) => /^glab api .*\/releases -X POST/.test(a.line)));
  assert.match(resultOf(await buildNow(g.run), e.id), /v0\.2\.0 is already released/);
  assert.deepEqual(g.refused, []);
});

test('signed out of the CE: plain git, the dry run says the sentence docs/PIPELINE.md promises, and a release to its host is held saying why', { skip, timeout: 10 * 60_000 }, async () => {
  freshSettings();
  git(released.dir, 'checkout', '-q', 'main');
  git(released.dir, 'pull', '-q', 'origin', 'main');
  const e = lookAfterClone(released.dir);
  const out = glab(['auth', 'logout', '--hostname', hostPort]);
  assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
  const look = await scmNow(realRun, { force: true });
  assert.equal(look?.tools.find((t) => t.cmd === 'glab')?.signedIn, false);
  const dry = steward(released.dir, 'build', '--dry-run', e.id);
  assert.equal(dry.code, 0, dry.out);
  const lines = dry.out.split(/\r?\n/);
  assert.equal(lines[0], `${e.id} (${released.repo}), branch main, worked with plain git`);
  const why = `why plain git: its pipeline names GitLab, but the GitLab CLI isn't signed in (glab auth login --hostname ${hostPort} --api-protocol http --git-protocol http), as the Steward last looked (${look!.at.slice(0, 16).replace('T', ' ')} UTC): plain git until then`;
  assert.equal(lines[1], why);
  // The sentence, as docs/PIPELINE.md gives it for a GitLab of your own (its address and time aside).
  const doc = readFileSync(path.join(import.meta.dirname, '..', 'docs', 'PIPELINE.md'), 'utf8');
  const promised = why.replaceAll(hostPort, 'gitlab.acme.lan:8080').replace(/\(\d{4}-\d\d-\d\d \d\d:\d\d UTC\)/, '(2026-10-31 02:30 UTC)');
  assert.ok(doc.includes(promised), `docs/PIPELINE.md says:\n${promised}`);

  // Its next version, landed: held, for plain git has no releases, and said so.
  files(released.dir, { 'package.json': json({ name: 'released', version: '0.1.2' }), 'CHANGELOG.md': '# Changelog\n\n## 0.1.2\n\n**Signed out.**\n\n## 0.1.1\n\n**A live test.**\n\n## 0.1.0\n\n**The first.**\n' });
  git(released.dir, 'commit', '-q', '-am', 'released 0.1.2: signed out');
  git(released.dir, 'push', '-q', 'origin', 'main');
  const g = guarded();
  const held = resultOf(await buildNow(g.run), e.id);
  assert.match(held, new RegExp(`its pipeline releases it on its host, but ${released.repo.replace(/\./g, '\\.')} is worked with plain git on this PC, which has no releases: sign in to its host's CLI \\(docs/PIPELINE\\.md\\), or set "releaseTo" to tag`), held);
  assert.ok(!g.asked.some((a) => a.line.startsWith('glab api')), 'glab never asked, signed out');
  assert.equal(await status(`projects/${released.id}/releases/v0.1.2`), 404, 'no release made');
  assert.deepEqual(g.refused, []);
});

test('afterwards: the user hard-deleted, and its group and subgroup gone with it', { skip, timeout: 5 * 60_000 }, async () => {
  assert.deepEqual(await cleanUp(), []);
  assert.equal(await status(`groups/${made.subId}`), 404);
});
