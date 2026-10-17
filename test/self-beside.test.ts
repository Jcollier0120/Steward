import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Steward 0.36.121: builds release main, and the Steward merges no one's PRs (whoever wrote one merges it once vouched).
// Whole build rounds here (the owner's Build now), the Steward's own repository beside an agent's, on a data folder of
// their own, git and gh standing in, and npm for the Steward's checks and its release: the Steward's own new version on
// main is tested once at main's head (stages/mainbuild.ts) and released with the agent's main in the same build; a new
// kit on main is tried on the agents (stages/trial.ts), released, and rolled out in the same build, the rollout merging
// its own kit PR (mergeOwn), and the agent released with it. The team's open PRs are left open throughout.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-self-beside-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage } = await import('../src/steward.ts');
const { APP } = await import('../src/app.ts');
const { loadPipeline } = await import('../src/pipeline.ts');
const { kitTrialsFile, mainKeyOf } = await import('../src/stages/trial.ts');
const { fakeEmployee, ok, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');

// The Steward's package.json names the scripts a person runs (npm stands in for each): its whole suite runs before a kit's release.
const stewardPackage = `{\n  "name": "fake",\n  "version": "0.8.13",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "kit": "node tools/kit.ts --from kit",\n    "typecheck": "tsc --noEmit",\n    "test": "node --test",\n    "release": "node tools/release.ts"\n  }\n}\n`;
const steward = fakeEmployee(path.join(home, 'steward'), { version: '0.8.13', kit: null, files: { 'kit/VERSION': '1.0.1\n', 'package.json': stewardPackage } });
const other = fakeEmployee(path.join(home, 'other'), { version: '0.4.0', kit: '1.0.1' });
const STEWARD = 'Jcollier0120/Steward';
const OTHER = 'Jcollier0120/Other';
const repos: Record<string, { origin: string; checkout: string }> = { [STEWARD]: steward, [OTHER]: other };
const versionFiles = ['package.json', 'package-lock.json', 'src/app.ts'];
// The Steward's clone names GitHub's URL, which its bare origin stands for (git's insteadOf): it releases only from there.
sh(steward.checkout, 'config', `url.${steward.origin.replace(/\\/g, '/')}.insteadOf`, `https://github.com/${STEWARD}.git`);
sh(steward.checkout, 'remote', 'set-url', 'origin', `https://github.com/${STEWARD}.git`);

// Each release command notes the version it releases, which gh's release list then shows.
const attempts = path.join(home, 'released-other.txt');
const releaseCmd = `node -e "const fs=require('fs');fs.appendFileSync(process.argv[1],JSON.parse(fs.readFileSync('package.json','utf8')).version+'\\n')" ${attempts}`;
writeFileSync(
  path.join(home, 'settings.json'),
  JSON.stringify({
    employees: [{ id: 'other', name: 'Other', repo: OTHER, checkout: other.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles, release: releaseCmd, install: '', approve: '' }],
    team: ['Jcollier0120'],
    workRoot: path.join(home, 'work'),
    afterRelease: [],
    stewardRepo: STEWARD,
    // The rollout's bumps read the kit's release from this clone: the fake one, never this PC's.
    stewardCheckout: steward.checkout,
    releaseSelf: true,
    alarms: { manorUrl: '', surveyorUrl: '', toast: false },
  }),
);

/** The kits released, newest first, and the Steward's own versions. */
const kits = ['1.0.1'];
const stewardReleases = ['0.8.13'];
const released = () => ['0.4.0', ...(existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean) : [])];
/** The open PRs on each repository, as gh lists them. */
const prs: Record<string, any[]> = { [STEWARD]: [], [OTHER]: [] };
/** Those the Steward opens are numbered from here. */
let prNumber = 100;
/** What happened, in order: the Steward's tests beginning and ending, its releases, and each merge. */
const events: string[] = [];

const repoOf = (args: string[]) => args[args.indexOf('--repo') + 1];
const pr = (repo: string, n: number, head: string, title: string) => ({
  number: n,
  title,
  url: `https://github.com/${repo}/pull/${n}`,
  body: '',
  headRefName: head,
  headRefOid: sh(repos[repo].origin, 'rev-parse', head),
  baseRefName: 'main',
  isCrossRepository: false,
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  author: { login: 'Jcollier0120' },
  labels: [],
  files: [],
  statusCheckRollup: [],
});

/** A change merged onto `repo`'s main by whoever wrote it: its version raised `from` → `to`, and `files` written too. */
function landOnMain(repo: string, o: { from?: string; to?: string; files?: Record<string, string> }): void {
  const c = repos[repo].checkout;
  sh(c, 'fetch', '--quiet', 'origin');
  sh(c, 'switch', '--quiet', '--detach', 'origin/main');
  const changed = Object.keys(o.files ?? {});
  if (o.from && o.to) {
    for (const file of versionFiles) writeFileSync(path.join(c, file), readFileSync(path.join(c, file), 'utf8').replaceAll(o.from, o.to));
    changed.push(...versionFiles);
  }
  for (const [file, text] of Object.entries(o.files ?? {})) writeFileSync(path.join(c, file), text);
  sh(c, 'add', '--', ...changed);
  sh(c, 'commit', '--quiet', '-m', o.to ? `${o.to}: a change` : 'a change');
  sh(c, 'push', '--quiet', 'origin', 'HEAD:main');
}

/** A ready PR #n on `repo`, on a branch of its own, that whoever wrote it hasn't merged yet. */
function openPr(repo: string, n: number, branch: string): void {
  const c = repos[repo].checkout;
  sh(c, 'fetch', '--quiet', 'origin');
  sh(c, 'switch', '--quiet', '-c', branch, 'origin/main');
  writeFileSync(path.join(c, 'NOTES.md'), `${branch}\n`);
  sh(c, 'add', 'NOTES.md');
  sh(c, 'commit', '--quiet', '-m', 'a change in progress');
  sh(c, 'push', '--quiet', 'origin', branch, `HEAD:refs/pull/${n}/head`);
  sh(c, 'switch', '--quiet', '--detach', 'origin/main');
  prs[repo].push(pr(repo, n, branch, `${repo.split('/')[1]}: a change in progress`));
}

// GitHub's GraphQL isn't answered: each round asks of every repository on its own (no glance); nor are commit statuses,
// so no vouch covers main's head, and the build tests it here.
const run = async (cmd: string, args: string[], opts?: any) => {
  if (cmd === 'npm') {
    // The Steward's checks stand in: its packages "installed", its kit filled, its checks passing.
    mkdirSync(path.join(opts!.cwd!, 'node_modules'), { recursive: true });
    if (args[0] === 'test') {
      events.push('Steward tests begin');
      events.push('Steward tests end');
    }
    // Its own release (stages/self.ts), which gh's release list then shows.
    if (args[0] === 'run' && args[1] === 'release') {
      const v = JSON.parse(readFileSync(path.join(opts!.cwd!, 'package.json'), 'utf8')).version as string;
      stewardReleases.unshift(v);
      events.push(`Steward v${v} released`);
    }
    return ok('');
  }
  // Its kit's release (stages/self.ts), which gh's release list then shows.
  if (cmd === 'node' && args[0] === 'tools/kit-release.ts') {
    kits.unshift(readFileSync(path.join(opts!.cwd!, 'kit', 'VERSION'), 'utf8').trim());
    events.push(`kit ${kits[0]} released`);
    return ok('');
  }
  if (cmd === 'node' && args[0] === 'tools/kit.ts') return ok('');
  if (cmd !== 'gh') return realRun(cmd, args, opts);
  if (args[0] === 'release' && args[1] === 'list') {
    if (repoOf(args) === STEWARD) return ok([...kits.map((k) => `kit-v${k}`), ...stewardReleases.map((v) => `v${v}`)].map((tagName) => ({ tagName, isDraft: false, publishedAt: '2026-10-16T00:00:00Z' })));
    return ok(released().map((v) => ({ tagName: `v${v}`, isDraft: false })));
  }
  if (args[0] === 'pr' && args[1] === 'list') {
    const open = prs[repoOf(args)] ?? [];
    return ok(args.includes('--head') ? open.filter((p) => p.headRefName === args[args.indexOf('--head') + 1]) : open);
  }
  if (args[0] === 'pr' && args[1] === 'create') {
    const repo = repoOf(args);
    const n = ++prNumber;
    prs[repo].push(pr(repo, n, args[args.indexOf('--head') + 1], args[args.indexOf('--title') + 1]));
    return ok(`https://github.com/${repo}/pull/${n}\n`);
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    const repo = repoOf(args);
    const p = prs[repo].find((x) => String(x.number) === args[2]);
    if (!p) return { code: 1, out: '', err: `no open PR #${args[2]}` };
    const head = args.includes('--match-head-commit') ? args[args.indexOf('--match-head-commit') + 1] : null;
    if (head && head !== p.headRefOid) return { code: 1, out: '', err: 'Head branch was modified. Review and try the merge again.' };
    sh(repos[repo].origin, 'update-ref', 'refs/heads/main', p.headRefOid);
    prs[repo] = prs[repo].filter((x) => x !== p);
    events.push(`${repo.split('/')[1]} #${p.number} merged`);
    return ok('');
  }
  return { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
};
const buildNow = () => runStage('round', { buildNow: {} }, { run, ownKit: '9.9.9', self: { checkout: steward.checkout }, pipeline: true });
const done = (out: { results: { outcome: string; message: string }[] }) => out.results.filter((r) => r.outcome !== 'skipped').map((r) => r.message.replace(/\b[0-9a-f]{7}\b/g, '…'));
const openNumbers = () => [...prs[STEWARD], ...prs[OTHER]].map((p) => p.number);

test("in a build, the Steward's own new version and an agent's, merged by whoever wrote them, are each tested once at main's head and released; no one's PR is merged", async () => {
  landOnMain(STEWARD, { from: '0.8.13', to: '0.8.14' });
  landOnMain(OTHER, { from: '0.4.0', to: '0.4.1' });
  openPr(STEWARD, 47, 'claude/a-fix');
  openPr(OTHER, 7, 'fix/thing');

  const out = await buildNow();
  const log = out.log.join('\n');
  assert.equal(out.error, undefined, log);
  // The Steward's main tested here (no vouch covers it), then released; the agent's main tested and released with it.
  assert.deepEqual(events, ['Steward tests begin', 'Steward tests end', 'Steward v0.8.14 released']);
  assert.deepEqual(done(out), ['self: released v0.8.14 from origin/main (…)', 'release: released v0.4.1 from origin/main (…), with kit 1.0.1']);
  assert.match(log, /\[steward\] checks passed here at [0-9a-f]{7}/);
  assert.match(log, /\[other\] checks passed here at [0-9a-f]{7}/);
  assert.equal(out.build?.closed, true, log);
  const build = loadPipeline().builds.at(-1);
  assert.deepEqual(build?.merged, [], 'no PR merged');
  assert.deepEqual(new Set(build?.released), new Set([`${APP.id} v0.8.14`, 'other v0.4.1']));
  assert.deepEqual(released(), ['0.4.0', '0.4.1']);
  assert.deepEqual(openNumbers(), [47, 7], 'the ready PRs left open, for whoever wrote them to merge');
});

test("in a build, main's new kit is tried on the agents, released, and rolled out in the same build: the rollout merges its own kit PR, and the agent is released with the kit", async () => {
  events.length = 0;
  // Main carries kit 1.0.2, not released yet; the Steward's own version on it is released already.
  landOnMain(STEWARD, { files: { 'kit/VERSION': '1.0.2\n' } });
  const at = sh(steward.origin, 'rev-parse', 'main');

  const out = await buildNow();
  const log = out.log.join('\n');
  assert.equal(out.error, undefined, log);
  // Tried on Other at main and the Steward's whole suite run there first; released; then Other bumped to it, and its kit
  // PR merged by the Steward itself, at once.
  assert.deepEqual(events, ['Steward tests begin', 'Steward tests end', 'kit 1.0.2 released', 'Other #101 merged']);
  const trial = JSON.parse(readFileSync(kitTrialsFile(), 'utf8'))[mainKeyOf(at)];
  assert.deepEqual([trial?.kit, trial?.failed, trial?.pending], ['1.0.2', [], undefined], JSON.stringify(trial));
  assert.match(log, /kit 1\.0\.2 released: it is rolled out now/);
  const did = done(out);
  assert.equal(did.length, 3, did.join('\n'));
  assert.match(did[0], /^self: released kit-v1\.0\.2 from origin\/main \(…\)$/);
  assert.match(did[1], /^rollout: kit 1\.0\.2: 0\.4\.2 on steward\/kit-1\.0\.2 \(…\): kit 1\.0\.1 → 1\.0\.2.*; opened "Other 0\.4\.2: the Steward's kit 1\.0\.2"; merged it$/);
  assert.equal(did[2], 'release: released v0.4.2 from origin/main (…), with kit 1.0.2');
  assert.equal(out.build?.closed, true, log);
  const build = loadPipeline().builds.at(-1);
  assert.deepEqual(build?.merged, ['other #101'], 'its own kit PR, merged by the Steward');
  // A kit's release isn't a version of a repository's (steward.ts's releasedSomething): the build's record has the agent's.
  assert.deepEqual(build?.released, ['other v0.4.2']);
  assert.deepEqual(released(), ['0.4.0', '0.4.1', '0.4.2']);
  assert.deepEqual(openNumbers(), [47, 7], "the team's ready PRs still left open");
});
