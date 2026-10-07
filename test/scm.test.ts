import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Source control (scm.ts): what this PC has, found and offered; how each repository is worked with; and whole rounds
// over plain git, with no GitHub CLI at all. Nothing reaches GitHub, the live ~/.steward or the real checkouts.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-scm-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const S = await import('../src/scm.ts');
const { SETTINGS_SCHEMA, SETTINGS_SPEC, DEFAULT_SETTINGS } = await import('../src/settings.ts');
const { runStage } = await import('../src/steward.ts');
const { candidates } = await import('../src/found.ts');
const { fakeEmployee, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');
type ScmLook = import('../src/scm.ts').ScmLook;

const look = (o: { git?: boolean; gh?: boolean; signedIn?: boolean; hg?: boolean } = {}): ScmLook => ({
  at: new Date().toISOString(),
  tools: [
    { cmd: 'git', name: 'Git', version: o.git === false ? null : 'git version 2.55.0', supported: true },
    { cmd: 'gh', name: 'GitHub CLI', version: o.gh ? 'gh version 2.101.0' : null, supported: true, ...(o.gh ? { signedIn: !!o.signedIn } : {}) },
    { cmd: 'hg', name: 'Mercurial', version: o.hg ? 'Mercurial Distributed SCM (version 6.8)' : null, supported: false },
  ],
});

test('what is installed is found: each tool asked its version, the GitHub CLI whether it is signed in, and no token kept', async () => {
  const asked: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    asked.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'git') return { code: 0, out: 'git version 2.55.0.windows.5\n', err: '' };
    if (cmd === 'gh' && args[0] === '--version') return { code: 0, out: 'gh version 2.101.0 (2026-09-15)\nhttps://github.com/cli/cli/releases/tag/v2.101.0\n', err: '' };
    if (cmd === 'gh' && args[0] === 'auth') return { code: 0, out: 'gho_SECRET_TOKEN\n', err: '' };
    return { code: 1, out: '', err: `'${cmd}' is not recognized` };
  };
  const found = await S.findScm(run, new Date('2026-10-07T22:00:00Z'));
  assert.deepEqual(
    found.tools.filter((t) => t.version).map((t) => [t.cmd, t.version, t.signedIn]),
    [['git', 'git version 2.55.0.windows.5', undefined], ['gh', 'gh version 2.101.0 (2026-09-15)', true]],
  );
  assert.ok(asked.includes('gh auth token --hostname github.com'));
  assert.ok(!JSON.stringify(found).includes('SECRET'), 'the token is never kept');
  assert.equal(S.githubReady(found), true);
  assert.equal(S.foundWords(found), 'Found on this PC: Git; GitHub CLI, signed in.');
  // Kept, and looked at again only once it is an hour old.
  rmSync(S.scmFile(), { force: true });
  await S.scmNow(run, { now: new Date('2026-10-07T22:00:00Z') });
  const n = asked.length;
  await S.scmNow(run, { now: new Date('2026-10-07T22:30:00Z') });
  assert.equal(asked.length, n, 'within the hour: kept');
  await S.scmNow(run, { now: new Date('2026-10-07T23:01:00Z') });
  assert.ok(asked.length > n, 'an hour on: looked at again');
});

test('each repository is worked with GitHub only where it is on GitHub and the GitHub CLI is signed in; else plain git', () => {
  const s = (sourceControl: 'auto' | 'git' | 'github', releasesCastellan = false) => ({ sourceControl, releasesCastellan });
  const onGithub = { repo: 'octocat/app' };
  const onGitlab = { repo: 'gitlab.com/group/app' };
  assert.equal(S.hostOf(onGithub, s('auto'), look({ gh: true, signedIn: true })), 'github');
  assert.equal(S.hostOf(onGithub, s('auto'), look({ gh: true, signedIn: false })), 'git', 'signed out: plain git');
  assert.equal(S.hostOf(onGithub, s('auto'), look()), 'git', 'no GitHub CLI: plain git');
  assert.equal(S.hostOf(onGitlab, s('auto'), look({ gh: true, signedIn: true })), 'git');
  assert.equal(S.hostOf(onGithub, s('auto'), null), 'github', 'never looked: as before');
  assert.equal(S.hostOf(onGithub, s('git'), look({ gh: true, signedIn: true })), 'git', 'chosen: Git for every one');
  assert.equal(S.hostOf(onGitlab, s('github'), look()), 'github', 'chosen: GitHub for every one');
  assert.equal(S.hostOf(onGitlab, s('git', true), look()), 'github', "Castellan's own release machinery is GitHub's");
});

test("Settings' Source control: offered as this PC has it, a saved choice kept, and what was found said", () => {
  const base = SETTINGS_SCHEMA.find((f) => f.key === 'sourceControl')!;
  assert.equal(DEFAULT_SETTINGS.sourceControl, 'auto');
  const gitOnly = S.sourceControlField(base, look({ hg: true }), 'auto');
  assert.ok(gitOnly.kind === 'choice');
  assert.deepEqual(gitOnly.options.map((o) => o.value), ['auto', 'git'], 'only Git here: no GitHub to offer');
  assert.equal(gitOnly.options[0].label, 'Automatic: Git for every repository, on any host');
  assert.match(gitOnly.help ?? '', /Found on this PC: Git\. Not worked with yet: Mercurial\.$/);
  const both = S.sourceControlField(base, look({ gh: true, signedIn: true }), 'auto');
  assert.ok(both.kind === 'choice');
  assert.deepEqual(both.options.map((o) => o.value), ['auto', 'github', 'git']);
  assert.equal(both.options[0].label, 'Automatic: GitHub for repositories on GitHub (the GitHub CLI is signed in), Git for any other');
  const kept = S.sourceControlField(base, look(), 'github');
  assert.ok(kept.kind === 'choice');
  assert.deepEqual(kept.options.map((o) => o.value), ['auto', 'github', 'git'], 'GitHub chosen before: still offered');
  // The page's Settings are served narrowed, from the last look kept.
  writeFileSync(S.scmFile(), JSON.stringify(look()));
  const served = SETTINGS_SPEC.schema.find((f) => f.key === 'sourceControl')!;
  assert.ok(served.kind === 'choice');
  assert.deepEqual(served.options.map((o) => o.value), ['auto', 'git']);
  assert.match(S.autoWords(look({ gh: true, signedIn: false })), /GitHub CLI is installed, but not signed in/);
});

test("a repository's name from its origin, whatever the host", () => {
  const cases: [string, string | null][] = [
    ['https://github.com/octocat/hello-world.git', 'octocat/hello-world'],
    ['git@github.com:octocat/hello-world.git', 'octocat/hello-world'],
    ['https://gitlab.com/group/sub/app.git', 'gitlab.com/group/sub/app'],
    ['git@gitlab.example.com:team/app.git', 'gitlab.example.com/team/app'],
    ['https://jane@dev.azure.com/org/project/_git/app', 'dev.azure.com/org/project/_git/app'],
    ['ssh://git@bitbucket.org:7999/team/app.git', 'bitbucket.org/team/app'],
    ['\\\\nas\\git\\app.git', 'local/app'],
    ['D:/repos/app.git', 'local/app'],
  ];
  for (const [url, name] of cases) assert.equal(S.repoFromUrl(url), name, url);
  assert.equal(S.isGithubRepo('octocat/app'), true);
  assert.equal(S.isGithubRepo('gitlab.com/group/app'), false);
  assert.equal(S.isGithubRepo('local/app'), true, 'a local one reads as owner/name: worked with GitHub only when it is on it (its origin decides employ)');
});

test("git ls-remote read: the branch's head, and v<x.y.z> tags newest first, an annotated one at the commit it tags", () => {
  const g = S.readLsRemote(
    [
      'aaa\trefs/heads/main',
      'bbb\trefs/heads/other',
      'ccc\trefs/tags/v0.4.0',
      'ddd\trefs/tags/v0.10.0',
      'eee\trefs/tags/v0.10.0^{}',
      'fff\trefs/tags/nightly',
    ].join('\n'),
    'main',
  );
  assert.equal(g.head, 'aaa');
  assert.deepEqual(g.prs, []);
  assert.deepEqual(g.releases.map((r) => [r.tagName, r.commit]), [['v0.10.0', 'eee'], ['v0.4.0', 'ccc']]);
});

test('Look after offers a clone on any host: one GitHub can\'t say of is offered when it is worked with plain git', () => {
  const found = {
    at: null,
    from: 'reeve' as const,
    error: null,
    repos: [
      { repo: 'octocat/app', name: 'app', path: 'C:\\a', branch: 'main', lockfiles: [], push: true },
      { repo: 'octocat/theirs', name: 'theirs', path: 'C:\\b', branch: 'main', lockfiles: [], push: false },
      { repo: 'octocat/unknown', name: 'unknown', path: 'C:\\c', branch: 'main', lockfiles: [], push: null },
      { repo: 'gitlab.com/group/game', name: 'game', path: 'C:\\d', branch: 'main', lockfiles: [], push: null, byGit: true },
    ],
  };
  assert.deepEqual(candidates(found, []).map((r) => r.repo), ['octocat/app', 'gitlab.com/group/game']);
});

// Whole rounds on a fake repository whose origin is a plain git folder, on a PC with Git and no GitHub CLI.
test('a round over plain git: its version released and tagged on origin, no PRs, and gh never run', async () => {
  const f = fakeEmployee(path.join(home, 'game'), { version: '0.4.0', kit: null, files: { 'CHANGELOG.md': '# Changelog\n\n## 0.4.1\n\n**A fix.**\n\n### What changed\n\n- It works.\n\n## 0.4.0\n\nFirst.\n' } });
  const attempts = path.join(home, 'released.txt');
  const releaseCmd = `node -e "require('fs').appendFileSync(process.argv[1],JSON.parse(require('fs').readFileSync('package.json','utf8')).version+'\\n')" ${attempts}`;
  writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({
      employees: [
        { id: 'game', name: 'Game', repo: 'nas/game', checkout: f.checkout, branch: 'main', merges: true, usesKit: false, parts: [], fill: '', test: [], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: releaseCmd, install: '', approve: '' },
      ],
      workRoot: path.join(home, 'work'),
      releasesCastellan: false,
      byItself: true,
      tasteBeforeRelease: false,
      afterRelease: [],
      alarms: { manorUrl: '', surveyorUrl: '', toast: false },
    }),
  );
  const ghCalls: string[][] = [];
  const run = async (cmd: string, args: string[], opts?: any) => {
    if (cmd === 'gh') {
      ghCalls.push(args);
      return { code: 127, out: '', err: "gh isn't installed" };
    }
    return realRun(cmd, args, opts);
  };
  const scm = look();
  const round = () => runStage('round', { full: true }, { run, scm });

  // v0.4.0 is on main and not tagged yet: released, and tagged.
  const first = await round();
  assert.equal(first.error, undefined, first.log.join('\n'));
  const r = first.results.find((x) => x.message.startsWith('release: '))!;
  assert.equal(r.outcome, 'done', `${r.message}\n${first.log.join('\n')}`);
  assert.match(r.message, /^release: released v0\.4\.0 from origin\/main \(.{7}\), tagged v0\.4\.0 on its origin$/);
  assert.equal(r.url, undefined, 'no GitHub page for it');
  assert.equal(sh(f.origin, 'rev-parse', 'v0.4.0^{commit}'), sh(f.origin, 'rev-parse', 'main'));
  assert.match(first.results.find((x) => x.id === 'game' && !x.message.startsWith('release: '))!.message, /worked with plain git/);

  // Nothing new: not released again.
  const second = await round();
  assert.match(second.results.find((x) => x.message.startsWith('release: '))!.message, /v0\.4\.0 is already released/);
  assert.deepEqual(readFileSync(attempts, 'utf8').split('\n').filter(Boolean), ['0.4.0']);

  // A new version pushed to main: released, its tag annotated with the CHANGELOG.md entry.
  sh(f.checkout, 'pull', '--quiet', '--ff-only', 'origin', 'main');
  for (const file of ['package.json', 'package-lock.json', 'src/app.ts']) writeFileSync(path.join(f.checkout, file), readFileSync(path.join(f.checkout, file), 'utf8').replaceAll('0.4.0', '0.4.1'));
  sh(f.checkout, 'commit', '--quiet', '-am', 'Fake 0.4.1');
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  const third = await round();
  assert.match(third.results.find((x) => x.message.startsWith('release: '))!.message, /released v0\.4\.1 .*tagged v0\.4\.1 on its origin$/);
  const message = sh(f.origin, 'tag', '-l', '--format=%(contents)', 'v0.4.1');
  assert.match(message, /^Fake 0\.4\.1|^Game 0\.4\.1/);
  assert.match(message, /- It works\./);
  assert.deepEqual(ghCalls, [], 'the GitHub CLI was never run');
  assert.ok(!existsSync(path.join(home, 'alarms.json')) || !JSON.parse(readFileSync(path.join(home, 'alarms.json'), 'utf8')).open.length, 'no alarm');
});

test("Release it: tag, over plain git: the Steward's own annotated tag; a tag already on origin counts as released, and is never moved", async () => {
  const f = fakeEmployee(path.join(home, 'site'), { version: '1.2.0', kit: null });
  writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({
      employees: [{ id: 'site', name: 'Site', repo: 'gitlab.com/me/site', checkout: f.checkout, branch: 'main', usesKit: false, parts: [], fill: '', test: [], versionFiles: ['package.json'], release: 'tag', install: '', approve: '' }],
      workRoot: path.join(home, 'work'),
      releasesCastellan: false,
      tasteBeforeRelease: false,
      afterRelease: [],
      alarms: { manorUrl: '', surveyorUrl: '', toast: false },
    }),
  );
  const run = async (cmd: string, args: string[], opts?: any) => (cmd === 'gh' ? { code: 127, out: '', err: "gh isn't installed" } : realRun(cmd, args, opts));
  const out = await runStage('release', {}, { run, scm: look({ gh: true, signedIn: true }) });
  assert.match(out.results[0].message, /^released v1\.2\.0 from origin\/main \(.{7}\), tagged v1\.2\.0 on its origin$/, out.log.join('\n'));
  assert.equal(sh(f.origin, 'cat-file', '-t', 'v1.2.0'), 'tag', 'annotated');

  // Someone tagged 1.2.1 elsewhere on origin: the Steward doesn't move it.
  sh(f.checkout, 'pull', '--quiet', '--ff-only', 'origin', 'main');
  writeFileSync(path.join(f.checkout, 'package.json'), readFileSync(path.join(f.checkout, 'package.json'), 'utf8').replace('1.2.0', '1.2.1'));
  sh(f.checkout, 'commit', '--quiet', '-am', '1.2.1');
  sh(f.checkout, 'tag', 'v1.2.1', 'HEAD~1');
  sh(f.checkout, 'push', '--quiet', 'origin', 'refs/tags/v1.2.1');
  sh(f.checkout, 'tag', '-d', 'v1.2.1');
  sh(f.checkout, 'push', '--quiet', 'origin', 'main');
  const again = await runStage('release', {}, { run, scm: look() });
  assert.match(again.results[0].message, /v1\.2\.1 is already released/, 'its tag is there: released, as git says');

  // Pushing a tag origin has at another commit is refused, never forced; at the same commit, nothing to do.
  const { pushReleaseTag } = await import('../src/stages/release.ts');
  const ctx = { run, host: () => 'git' as const } as any;
  const e = { id: 'site', name: 'Site' } as any;
  const head = sh(f.origin, 'rev-parse', 'main');
  assert.match((await pushReleaseTag(ctx, e, { repo: f.checkout, commit: head, version: '1.2.1' })) ?? '', /^origin has v1\.2\.1 already, at .{7}, not .{7}$/);
  assert.equal(await pushReleaseTag(ctx, e, { repo: f.checkout, commit: sh(f.origin, 'rev-parse', 'v1.2.0^{commit}'), version: '1.2.0' }), null);
});
