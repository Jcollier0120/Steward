import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Steward 0.36.234: an urgent kit reaches the agents in minutes, not at the next build. On 2026-10-25 kit 2.136.1, an
// urgent fix merged at 03:44Z, waited for the 14:00Z build: the urgent fix's build of the Steward's own took no kit, and
// each agent's kit bump said nothing urgent. Whole rounds here, the Steward's repository beside an agent's, on a data
// folder of their own, git and gh standing in (as self-beside.test.ts): the urgent build of the Steward's own releases its
// urgent kit and rolls it out to every agent, each agent's entry an urgent fix; the round between builds after it builds
// the agent at once, for that entry; a later plain kit waits for the next build, as before.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-urgent-kit-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { runStage } = await import('../src/steward.ts');
const { APP } = await import('../src/app.ts');
const { DEFAULT_PIPELINE, lastBuildTime, loadPipeline, savePipeline } = await import('../src/pipeline.ts');
const { isUrgent } = await import('../src/kit/exchequer.ts');
const { fakeEmployee, ok, sh } = await import('./helpers.ts');
const { run: realRun } = await import('../src/run.ts');

const stewardPackage = (v: string) => `{\n  "name": "fake",\n  "version": "${v}",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "kit": "node tools/kit.ts --from kit",\n    "typecheck": "tsc --noEmit",\n    "test": "node --test",\n    "release": "node tools/release.ts"\n  }\n}\n`;
/** The kit's changelog on the Steward's main: each version's entry, newest first. */
const kitLog = (...entries: [string, string][]) => `# The Steward's kit\n\n${entries.map(([v, bold]) => `## ${v}\n\n**${bold}**\n\n### What changed\n\n- ${bold}\n\n### Before you update\n\n- Nothing: it updates itself as usual.\n`).join('\n')}`;
const KIT_101: [string, string] = ['1.0.1', 'The parts every agent shares.'];
const KIT_102: [string, string] = ['1.0.2', 'Urgent fix: the PowerShell worker starts in a signed release.'];
const KIT_103: [string, string] = ['1.0.3', 'A staff member whose work keeps failing stops after three tries.'];
const steward = fakeEmployee(path.join(home, 'steward'), { version: '0.8.13', kit: null, files: { 'kit/VERSION': '1.0.1\n', 'kit/CHANGELOG.md': kitLog(KIT_101), 'package.json': stewardPackage('0.8.13') } });
const other = fakeEmployee(path.join(home, 'other'), { version: '0.4.0', kit: '1.0.1' });
const STEWARD = 'Jcollier0120/Steward';
const OTHER = 'Jcollier0120/Other';
const repos: Record<string, { origin: string; checkout: string }> = { [STEWARD]: steward, [OTHER]: other };
const versionFiles = ['package.json', 'package-lock.json', 'src/app.ts'];
sh(steward.checkout, 'config', `url.${steward.origin.replace(/\\/g, '/')}.insteadOf`, `https://github.com/${STEWARD}.git`);
sh(steward.checkout, 'remote', 'set-url', 'origin', `https://github.com/${STEWARD}.git`);
/** Other's v0.4.0, released from its first commit. */
const otherReleased = sh(other.origin, 'rev-parse', 'main');

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
    stewardCheckout: steward.checkout,
    releaseSelf: true,
    alarms: { manorUrl: '', surveyorUrl: '', toast: false },
  }),
);

const kits = ['1.0.1'];
const stewardReleases = ['0.8.13'];
const released = () => ['0.4.0', ...(existsSync(attempts) ? readFileSync(attempts, 'utf8').split('\n').filter(Boolean) : [])];
const prs: Record<string, any[]> = { [STEWARD]: [], [OTHER]: [] };
let prNumber = 100;
const events: string[] = [];
/** Whether GitHub's GraphQL answers (the round's glance): off, each round asks of every repository on its own. */
let glance = false;

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

/** A change merged onto the Steward's main by whoever wrote it: these files written. */
function landOnMain(files: Record<string, string>): string {
  const c = steward.checkout;
  sh(c, 'fetch', '--quiet', 'origin');
  sh(c, 'switch', '--quiet', '--detach', 'origin/main');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(c, file)), { recursive: true });
    writeFileSync(path.join(c, file), text);
  }
  sh(c, 'add', '--', ...Object.keys(files));
  sh(c, 'commit', '--quiet', '-m', 'a change');
  sh(c, 'push', '--quiet', 'origin', 'HEAD:main');
  return sh(c, 'rev-parse', 'HEAD');
}

/** The Steward's version raised on main, with its own changelog entry marked as given. */
const stewardVersion = (v: string, bold: string) => ({
  'package.json': stewardPackage(v),
  'CHANGELOG.md': `# The Steward's changelog\n\n## ${v}\n\n**${bold}**\n\n### What changed\n\n- ${bold}\n\n### Before you update\n\n- Nothing: it updates itself as usual.\n`,
});

const run = async (cmd: string, args: string[], opts?: any) => {
  if (cmd === 'npm') {
    mkdirSync(path.join(opts!.cwd!, 'node_modules'), { recursive: true });
    if (args[0] === 'test') events.push('Steward tests');
    if (args[0] === 'run' && args[1] === 'release') {
      const v = JSON.parse(readFileSync(path.join(opts!.cwd!, 'package.json'), 'utf8')).version as string;
      stewardReleases.unshift(v);
      events.push(`Steward v${v} released`);
    }
    return ok('');
  }
  // The kit's release: tagged kit-v<version> on the Steward's origin, as the kit's release script tags it, so the rollout
  // reads the kit's whole changelog from it (trialpass.ts's releasedChangelog).
  if (cmd === 'node' && args[0] === 'tools/kit-release.ts') {
    const v = readFileSync(path.join(opts!.cwd!, 'kit', 'VERSION'), 'utf8').trim();
    sh(opts!.cwd!, 'tag', `kit-v${v}`);
    sh(opts!.cwd!, 'push', '--quiet', 'origin', `refs/tags/kit-v${v}`);
    kits.unshift(v);
    events.push(`kit ${v} released`);
    return ok('');
  }
  if (cmd === 'node' && args[0] === 'tools/kit.ts') return ok('');
  if (cmd !== 'gh') return realRun(cmd, args, opts);
  // The glance, when it answers: Other's main and its release (the Steward's main left out, so it has nothing to release).
  if (args[0] === 'api' && args[1] === 'graphql' && glance) {
    return ok({
      data: {
        steward: { releases: { nodes: [...kits.map((k) => `kit-v${k}`), ...stewardReleases.map((v) => `v${v}`)].map((tagName) => ({ tagName, isDraft: false })) } },
        e0: {
          ref: { target: { oid: sh(other.origin, 'rev-parse', 'main') } },
          pullRequests: { nodes: [] },
          releases: { nodes: released().reverse().map((v) => ({ tagName: `v${v}`, isDraft: false, publishedAt: null, tagCommit: { oid: v === '0.4.0' ? otherReleased : null } })) },
        },
      },
    });
  }
  if (args[0] === 'release' && args[1] === 'list') {
    if (repoOf(args) === STEWARD) return ok([...kits.map((k) => `kit-v${k}`), ...stewardReleases.map((v) => `v${v}`)].map((tagName) => ({ tagName, isDraft: false, publishedAt: '2026-10-25T00:00:00Z' })));
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
    sh(repos[repo].origin, 'update-ref', 'refs/heads/main', p.headRefOid);
    prs[repo] = prs[repo].filter((x) => x !== p);
    events.push(`${repo.split('/')[1]} #${p.number} merged`);
    return ok('');
  }
  return { code: 1, out: '', err: `no stand-in for gh ${args.join(' ')}` };
};

// 04:00, between the 00:00 build, which has been, and the 06:00 one.
const now = new Date(2026, 9, 25, 4, 0);
const round = () => runStage('round', {}, { run, now: () => now, ownKit: '9.9.9', self: { checkout: steward.checkout }, pipeline: true });
const midnight = lastBuildTime(DEFAULT_PIPELINE, now)!.toISOString();
const scheduled = { due: midnight, by: 'schedule' as const, started: midnight, finished: midnight, rounds: 1, merged: [], released: [], failed: [] };
/** The urgent fix's build of the Steward's own, begun for main at `head` (stages/urgent.ts found it marked urgent). */
const urgentBuild = (head: string) => savePipeline({ open: { due: now.toISOString(), by: 'urgent', started: now.toISOString(), employees: [APP.id], urgent: [`${APP.id} ${head}`], rounds: 0, merged: [], released: [], failed: [] }, builds: [...loadPipeline().builds, ...(loadPipeline().builds.length ? [] : [scheduled])] });
/** Other's CHANGELOG.md on its origin's main: its top entry. */
const otherTopEntry = () => sh(other.origin, 'show', 'main:CHANGELOG.md').replace(/\r\n/g, '\n').split(/^(?=## )/m).find((s) => s.startsWith('## ')) ?? '';

test("the urgent fix's build of the Steward's own, its kit urgent: the kit is tried, released and rolled out to every agent in it, and each agent's entry is an urgent fix", async () => {
  // Kit 1.0.2, an urgent fix, merged with the Steward's own version that hands it out, both marked urgent (Steward#430).
  const head = landOnMain({ 'kit/VERSION': '1.0.2\n', 'kit/CHANGELOG.md': kitLog(KIT_102, KIT_101), ...stewardVersion('0.8.14', 'Urgent fix: it hands out the kit 1.0.2.') });
  urgentBuild(head);

  const out = await round();
  const log = out.log.join('\n');
  assert.equal(out.error, undefined, log);
  assert.equal(out.build?.by, 'urgent', log);
  // Tried on Other and the whole suite run, the kit released, the Steward's urgent version with it; then Other bumped to
  // the kit and its kit PR merged by the Steward itself, in the same build.
  assert.deepEqual(events.filter((x) => !x.startsWith('Steward tests')), ['kit 1.0.2 released', 'Steward v0.8.14 released', 'Other #101 merged'], log);
  assert.match(log, /kit 1\.0\.2 is an urgent fix: kit 1\.0\.2 goes out in this build to every employee still behind it, and each is built at once after it/);
  assert.doesNotMatch(log, /the newest kit waits for the next build/);
  // Other's entry is an urgent fix, as the Steward's urgent rule reads one (the kit's exchequer.ts isUrgent).
  const entry = otherTopEntry();
  assert.match(entry, /^## 0\.4\.1\n\n\*\*Urgent fix: it carries the Steward's kit 1\.0\.2, with an urgent fix to the parts every agent of the manor shares\.\*\*\n/, entry);
  assert.match(entry, /^- The Steward's kit 1\.0\.2: Urgent fix: the PowerShell worker starts in a signed release\.$/m);
  assert.equal(isUrgent(entry), true);
  // The build is the Steward's alone: it closes, Other not released in it, and the next round comes sooner, to build it.
  assert.equal(out.build?.closed, true, log);
  assert.equal(out.soon, true);
  const build = loadPipeline().builds.at(-1);
  assert.deepEqual([build?.by, build?.released], ['urgent', [`${APP.id} v0.8.14`]]);
  assert.deepEqual(released(), ['0.4.0']);
});

test('the round between builds after it builds the agent at once, for its urgent entry: released, not at the next build', async () => {
  events.length = 0;
  glance = true;
  const head = sh(other.origin, 'rev-parse', 'main');
  const out = await round();
  const log = out.log.join('\n');
  assert.equal(out.error, undefined, log);
  assert.match(log, new RegExp(`an urgent fix is on main \\(other at ${head.slice(0, 7)}\\): it builds at once, for its repository alone`));
  assert.match(log, new RegExp(`the urgent fix's build \\(other ${head.slice(0, 7)}\\) begins for other`));
  assert.equal(out.build?.by, 'urgent');
  assert.deepEqual(released(), ['0.4.0', '0.4.1'], 'Other released now, with the urgent kit');
  assert.ok(out.results.some((r) => r.id === 'other' && /^release: released v0\.4\.1 from origin\/main \([0-9a-f]{7}\), with kit 1\.0\.2/.test(r.message)), log);
  const build = loadPipeline().builds.at(-1);
  assert.deepEqual([build?.by, build?.employees, build?.urgent], ['urgent', ['other'], [`other ${head}`]]);
  glance = false;
});

test("a later plain kit stays as before: the Steward's urgent build releases it with its own urgent fix, and leaves its rollout to the next build", async () => {
  events.length = 0;
  prNumber = 200;
  const before = sh(other.origin, 'rev-parse', 'main');
  // Kit 1.0.3, not urgent, under the Steward's own urgent fix of something else.
  const head = landOnMain({ 'kit/VERSION': '1.0.3\n', 'kit/CHANGELOG.md': kitLog(KIT_103, KIT_102, KIT_101), ...stewardVersion('0.8.15', 'Urgent fix: its page opens again.') });
  urgentBuild(head);

  const out = await round();
  const log = out.log.join('\n');
  assert.equal(out.error, undefined, log);
  assert.deepEqual(events.filter((x) => !x.startsWith('Steward tests')), ['kit 1.0.3 released', 'Steward v0.8.15 released'], log);
  assert.match(log, /the newest kit waits for the next build: this one is for an urgent fix/);
  assert.doesNotMatch(log, /is an urgent fix: kit/);
  assert.equal(sh(other.origin, 'rev-parse', 'main'), before, 'Other not bumped: no kit PR');
  assert.deepEqual(prs[OTHER], []);
  assert.equal(out.build?.closed, true, log);
  assert.equal(out.soon, undefined);
});
