import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Steward on someone else's PC: no owner settings, Reeve's repositories, no Wright, Bailiff or Surveyor. It offers
// the person's own repositories, looks after the ones they pick, merges and releases only where they said yes, to
// their own repositories, and nothing of Castellan's runs.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-customer-'));
process.env.STEWARD_HOME = home;
// None of the owner's own agents here.
for (const k of ['WRIGHT_HOME', 'BAILIFF_HOME', 'SURVEYOR_HOME', 'REEVE_HOME', 'ALETASTER_HOME', 'MANOR_HOME']) process.env[k] = path.join(home, `no-${k.toLowerCase()}`);
delete process.env.MANOR_RELEASES_REPO;
after(() => rmSync(home, { recursive: true, force: true }));

const settingsModule = await import('../src/settings.ts');
const { DEFAULT_SETTINGS, SETTINGS_SPEC, inEffect, loadSettings, releasesRepoEnv, settingsFile } = settingsModule;
const { candidates, findRepos, githubOf, loadFound, lookAfter, anyRepo } = await import('../src/found.ts');
const { runStage } = await import('../src/steward.ts');
const { watchAlarms } = await import('../src/alarms.ts');
const { tend } = await import('../src/tend.ts');
const { authorOf } = await import('../src/stages/kickback.ts');
const { NOT_MERGING } = await import('../src/stages/merge.ts');
const { releasesRepo } = await import('../src/kit/release.ts');
const { ONBOARDING } = await import('../src/onboarding.ts');
const { fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
const { bundleForNode, importPath } = await import('../kit/test/react-render.ts');

// The person's clone of their own app, with a test script and no release script.
const app = fakeEmployee(path.join(home, 'clones', 'app'), { version: '1.2.0', kit: null, files: { 'package.json': '{\n  "name": "app",\n  "version": "1.2.0",\n  "scripts": { "test": "node -e process.exit(0)" }\n}\n', 'CHANGELOG.md': '# Changelog\n\n## 1.2.0\n\n**The first.**\n' } });
// What Reeve lists: their app (on GitHub, theirs), someone else's they only read, a local one, and one he leaves alone.
const reeve = {
  repos: [
    { name: 'app', path: app.checkout, slug: 'me/app', web: 'https://github.com/me/app', branch: 'main', defaultBranch: 'main', packages: [{ dir: '', lockfile: 'package-lock.json', ecosystem: 'npm' }] },
    { name: 'lib', path: path.join(home, 'clones', 'lib'), slug: 'them/lib', web: 'https://github.com/them/lib', branch: 'main' },
    { name: 'local', path: path.join(home, 'clones', 'local'), slug: null, web: null, branch: 'main' },
    { name: 'quiet', path: path.join(home, 'clones', 'quiet'), slug: 'me/quiet', web: 'https://github.com/me/quiet', branch: 'main', ignored: true },
  ],
};
const getJson = async (url: string) => (url.endsWith('/api/repos') ? reeve : { error: 'not here' });

test('a new install: nothing of Castellan, and nothing merged or released by itself until the person says yes', () => {
  assert.equal(existsSync(settingsFile()), false);
  const s = loadSettings();
  assert.deepEqual([s.releasesCastellan, s.byItself, s.rollout, s.releaseSelf, s.mergeSelf, s.stewardRepo, s.releasesRepo], [false, false, false, false, false, '', '']);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile(), 'utf8')), { releasesCastellan: false }, 'decided once: it never takes this PC for an older install');
  assert.deepEqual(releasesRepoEnv(s), { MANOR_RELEASES_REPO: '' }, 'a release goes to its own repository only');
  // No Wright here: nothing handed to it, its drafts never looked at, and a "wright" label is anyone's.
  assert.deepEqual([s.wrightHere, s.fileWork, s.wrightReview.on], [false, false, false]);
  assert.equal(authorOf({ labels: ['wright'], head: 'wright/12-fix' } as any), 'person');
});

test("Reeve's repositories: those on GitHub the person can push to are offered, and one picked is looked after as they said", async () => {
  assert.equal(githubOf(reeve.repos[2]), null, 'a local origin is no GitHub repository');
  const r = runner((args) => (args[0] === 'api' && args[1] === 'graphql' ? ok({ data: { r0: { viewerPermission: 'ADMIN' }, r1: { viewerPermission: 'READ' } } }) : undefined));
  const found = await findRepos({ run: r.run, cwd: home, getJson });
  assert.deepEqual(found.repos.map((x) => [x.repo, x.push]), [['me/app', true], ['them/lib', false]], 'the ignored one and the local one are left out');
  assert.match(r.gh[0].join(' '), /r0: repository\(owner: "me", name: "app"\) \{ viewerPermission \}/);
  assert.deepEqual(candidates(found, []).map((x) => x.repo), ['me/app']);
  // Picked, with merging ticked and releasing not: no kit, nothing installed, its tests and version read from its clone.
  const picked = lookAfter('me/app', { merges: true, release: false });
  assert.ok('employee' in picked);
  const e = loadSettings().employees[0];
  assert.deepEqual(
    { ...e, checkout: path.basename(e.checkout) },
    { id: 'app', name: 'app', repo: 'me/app', checkout: 'Fake', branch: 'main', merges: true, usesKit: false, fill: '', test: ['npm test'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: '', install: '', approve: '', installed: '' },
  );
  assert.deepEqual(candidates(loadFound(), loadSettings().employees), [], 'looked after: no longer offered');
  assert.match((lookAfter('me/app', { merges: false, release: false }) as { error: string }).error, /looked after already/);
  assert.match((lookAfter('them/lib', { merges: false, release: false }) as { error: string }).error, /isn't one Reeve found here that you can push to/);
  // A version claim works for any repository Reeve found, in Settings or not.
  assert.equal(anyRepo('me/app')?.repo, 'me/app');
});

test("with Manor here and its Repositories brought in, they are the Steward's list (spec/REPOSITORIES.md), and Look after adds to them", () => {
  const manor = path.join(home, 'manor');
  mkdirSync(path.join(manor, 'app'), { recursive: true });
  const tracked = [
    { name: 'Gadget', checkout: path.join(home, 'clones', 'gadget'), repo: 'me/gadget', versionFiles: ['package.json'], merges: true, release: 'tag', test: 'npm test' },
    { name: 'Notes', checkout: path.join(home, 'clones', 'notes') },
  ];
  writeFileSync(path.join(manor, 'settings.json'), JSON.stringify({ name: 'Mine', projects: tracked, projectsFromSteward: '2026-10-08T21:00:00.000Z' }));
  const { employeesOfProjects, manorTakesOver } = settingsModule;
  const own = loadSettings().employees;
  assert.equal(manorTakesOver(own, manor), true, 'brought in: Manor has them now');
  assert.equal(manorTakesOver(own, path.join(home, 'old-manor')), false, 'no Manor here');
  mkdirSync(path.join(home, 'older', 'app'), { recursive: true });
  writeFileSync(path.join(home, 'older', 'settings.json'), JSON.stringify({ projects: [] }));
  assert.equal(manorTakesOver(own, path.join(home, 'older')), false, "an older Manor that hasn't brought them in would leave them out");
  assert.equal(manorTakesOver([], path.join(home, 'older')), true, 'unless the Steward had none');
  // Each tracked repository on GitHub, as the Steward looks after it; one with no GitHub repository left out.
  const projects = [
    { name: 'Gadget', checkout: tracked[0].checkout, repo: 'me/gadget', branch: 'main', test: 'npm test', versionFiles: ['package.json'], cleanBranches: true, merges: true, release: 'tag' },
    { name: 'Notes', checkout: tracked[1].checkout, repo: null, branch: 'main', test: null, versionFiles: [], cleanBranches: true },
  ];
  assert.deepEqual(employeesOfProjects(projects), [
    { id: 'gadget', name: 'Gadget', repo: 'me/gadget', checkout: tracked[0].checkout, branch: 'main', merges: true, usesKit: false, fill: '', test: ['npm test'], versionFiles: ['package.json'], release: 'tag', install: '', approve: '', installed: '', note: "from Manor's Repositories" },
  ]);
  const s = inEffect(loadSettings(), false, projects);
  assert.deepEqual(s.employees.map((e) => e.repo), ['me/gadget'], "Manor's list, not the Steward's own");
  assert.deepEqual(inEffect({ ...loadSettings(), releasesCastellan: true }, false, projects).employees.map((e) => e.repo), ['me/app'], 'where Castellan is released, its own');
  // Look after writes into Manor's Repositories, by the kit's rules, the rest of its file kept.
  const added = lookAfter('me/app', { merges: true, release: true, manorHome: manor });
  assert.ok('employee' in added, JSON.stringify(added));
  const m = JSON.parse(readFileSync(path.join(manor, 'settings.json'), 'utf8'));
  assert.equal(m.name, 'Mine');
  assert.deepEqual(m.projects.at(-1), { name: 'app', checkout: app.checkout, repo: 'me/app', test: 'npm test', versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], merges: true, release: 'tag' });
  assert.match((lookAfter('me/app', { merges: false, release: false, manorHome: manor }) as { error: string }).error, /looked after already/);
  assert.equal(JSON.parse(readFileSync(settingsFile(), 'utf8')).employees.length, 1, "the Steward's own list untouched");
});

test("a round on the person's PC: their PRs merged only where they said yes, a new version released to their own repository, and no kit asked for", async () => {
  // Releasing: switched on in Settings as "tag" (it has no release script), as Look after's tick would have.
  const raw = JSON.parse(readFileSync(settingsFile(), 'utf8'));
  raw.employees[0].release = 'tag';
  raw.employees.push({ ...raw.employees[0], id: 'app-two', name: 'two', repo: 'me/two', merges: false, release: '' });
  writeFileSync(settingsFile(), JSON.stringify(raw));
  const pr = (repo: string, n: number) => ({ number: n, title: 'A fix', url: `https://github.com/${repo}/pull/${n}`, headRefName: 'fix', headRefOid: sh(app.checkout, 'rev-parse', 'HEAD'), baseRefName: 'main', isCrossRepository: false, author: { login: 'me' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }], body: '' });
  const r = runner((args) => {
    if (args[0] === 'api' && args[1] === 'graphql') return { code: 1, out: '', err: 'no glance here' };
    if (args[0] === 'pr' && args[1] === 'list') return ok(args.includes('me/app') ? [] : [pr('me/two', 3)]);
    if (args[0] === 'pr' && args[1] === 'merge') return ok('');
    if (args[0] === 'release' && args[1] === 'list') return ok([]);
    if (args[0] === 'release' && args[1] === 'create') return ok('');
  });
  const out = await runStage('round', { full: true }, { run: r.run, owner: () => 'me' });
  assert.equal(out.error, undefined, out.log.join('\n'));
  assert.deepEqual(r.gh.filter((a) => a[1] === 'merge'), [], "nothing merged where the person didn't say yes");
  const two = out.results.find((x) => x.id === 'app-two' && !x.message.startsWith('release: '))!;
  assert.match(two.message, new RegExp(`1 open PR \\(#3\\) ${NOT_MERGING.replace(/[()]/g, '\\$&')}`));
  const create = r.gh.find((a) => a[0] === 'release' && a[1] === 'create')!;
  assert.deepEqual(create.slice(0, 5), ['release', 'create', 'v1.2.0', '--repo', 'me/app'], 'released to their own repository');
  assert.ok(create.includes('--notes-file'), 'its notes the CHANGELOG.md entry');
  assert.match(out.results.find((x) => x.id === 'app' && x.message.startsWith('release: '))!.message, /released v1\.2\.0 from origin\/main/);
  assert.match(out.results.find((x) => x.id === 'app-two' && x.message.startsWith('release: '))!.message, /not released by the Steward: Settings name no way to/);
  assert.ok(!r.gh.some((a) => a.join(' ').includes('kit-v') || a.includes('Jcollier0120/Steward') || a.includes('Jcollier0120/Manor-releases')), 'nothing of Castellan asked or published');
  // Bump and Push are Castellan's: refused here.
  assert.match((await runStage('bump', {}, { run: r.run, owner: () => 'me' })).error ?? '', /only its makers' PC does/);
});

test('no Surveyor installed: no alarm that its page is down, however long', async () => {
  const s = loadSettings();
  const now = new Date(Date.now() + 48 * 3600_000);
  const state = await watchAlarms({ settings: s, round: { stage: 'round', started: '', finished: '', kit: null, asked: {}, results: [], log: [] }, held: [], failedReleases: {}, employees: s.employees, log: () => {} }, { getJson: async () => ({ error: 'down' }), toast: async () => {}, now, manorUrl: null });
  assert.ok(!Object.keys(state.watching).some((id) => id.startsWith('surveyor:')), JSON.stringify(state.watching));
  // Where it is installed, its page down is watched as before.
  const watched = await watchAlarms({ settings: s, round: { stage: 'round', started: '', finished: '', kit: null, asked: {}, results: [], log: [] }, held: [], failedReleases: {}, employees: s.employees, log: () => {} }, { getJson: async () => ({ error: 'down' }), toast: async () => {}, now, manorUrl: null, surveyorInstalled: () => true });
  assert.ok('surveyor:down' in watched.watching);
});

test("once Manor keeps the staff's pages and the manor-wide alarms, the Steward leaves them to it", async () => {
  const keeps = { keeps: ['tend', 'alarms'], roles: [{ holder: { id: 'porter', name: 'Porter', state: 'stopped', page: { up: false }, can: { open: true } } }] };
  const opened: string[] = [];
  assert.deepEqual(await tend({ manorUrl: 'http://m', getJson: async () => keeps, open: async (id) => (opened.push(id), { ok: true, said: '' }), log: () => {} }), []);
  assert.deepEqual(opened, [], 'nothing opened: Manor does it');
  const s = loadSettings();
  const state = await watchAlarms({ settings: s, round: { stage: 'round', started: '', finished: '', kit: null, asked: {}, results: [], log: [] }, held: [], failedReleases: {}, employees: s.employees, log: () => {} }, { getJson: async (u: string) => (u.endsWith('/api/state') ? keeps : { error: 'down' }), toast: async () => {}, now: new Date(), manorUrl: 'http://m', surveyorInstalled: () => true });
  assert.deepEqual(Object.keys(state.watching), [], 'no manor-wide condition watched here');
});

test("the held-back wording: on the person's PC the page and Settings speak of their repositories and their yes, never Castellan's internals", async () => {
  const fields = SETTINGS_SPEC.schema;
  const shown = (key: string) => (fields.find((f) => f.key === key) as any)?.shownWhen;
  for (const key of ['stewardRepo', 'stewardCheckout', 'rollout', 'releaseSelf', 'mergeSelf', 'releasesRepo']) assert.deepEqual(shown(key), { key: 'releasesCastellan', is: ['true'] }, key);
  for (const key of ['fileWork', 'wrightReview', 'wrightHere']) assert.deepEqual(shown(key), { key: 'wrightHere', is: ['true'] }, key);
  const employees = fields.find((f) => f.key === 'employees') as any;
  for (const key of ['usesKit', 'fill', 'install', 'approve', 'installed']) assert.deepEqual(employees.fields.find((f: any) => f.key === key).shownWhen, { key: 'releasesCastellan', is: ['true'] }, key);
  assert.equal(employees.blank.merges, false, 'a repository added by hand merges nothing until the person says yes');
  assert.match(employees.fields.find((f: any) => f.key === 'merges').help, /^Off until you say yes/);
  assert.doesNotMatch(JSON.stringify(ONBOARDING), /kit|Wright|Bailiff|Castellan|employee/i, 'the onboarding is about their repositories');
  // The page, as /api/page's body on this PC.
  const m = await bundleForNode<{ render: (body: unknown) => string }>(
    `import { renderToStaticMarkup } from 'react-dom/server';
     import { StewardBody } from '${importPath('src/web/steward.tsx')}';
     export const render = (v) => renderToStaticMarkup(<StewardBody v={v} />);`,
  );
  const s = loadSettings();
  const row = { id: 'app', name: 'app', repo: 'me/app', usesKit: false, merges: false, releases: false, branch: 'main', checkout: { path: app.checkout, exists: true, branch: 'main', changes: 0 }, main: null, release: null, releaseNeeded: false, prs: [], prepared: null, notes: ['not using the kit yet'] };
  const offered = { repo: 'me/new', name: 'new', path: path.join(home, 'clones', 'new'), branch: 'main', lockfiles: [], push: true };
  const html = m.render({
    castellan: false,
    found: { at: new Date().toISOString(), error: null, from: 'reeve', offered: [offered], found: 2 },
    staff: { at: new Date().toISOString(), kit: null, kitNote: null, released: [], local: null, rows: [row] },
    last: null,
    running: null,
    refreshing: false,
    team: ['me'],
    teamNote: null,
    round: { on: s.byItself, minutes: 10, onDuty: true, lastRunAt: null, rollout: false, releaseSelf: false, tend: false, repos: true, castellan: false },
  });
  const words = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(words, /\bkit\b|Wright|Bailiff|Castellan|employee/i, 'nothing of Castellan on their page');
  assert.doesNotMatch(html, /\/api\/stage\/(bump|push)/, "no kit rollout's buttons");
  assert.doesNotMatch(html, /Roll out the kit/, 'no kit rollout to show');
  assert.match(html, /Found on this PC/);
  assert.match(html, /only if you tick that/);
  assert.match(html, /PRs left to you/);
  assert.match(html, /merges and releases only when asked, until you say yes/);
  assert.match(html, /data-post="\/api\/repos\/look-after"/);
  assert.match(html, /data-post="\/api\/stage\/merge-team"[^>]*>Merge your ready PRs</);
});

test("allow-update takes a version x.y.z (its check had lost its backslashes)", () => {
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const said = execFileSync(process.execPath, [cli, 'allow-update', '0.8.14'], { encoding: 'utf8', env: { ...process.env, STEWARD_HOME: home } });
  assert.match(said, /0\.8\.14 isn't flagged: nothing to allow/);
  assert.throws(() => execFileSync(process.execPath, [cli, 'allow-update', 'ddd.d'], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, STEWARD_HOME: home } }), /allow-update takes one version/);
});

test("the kit's release publishes to the releases repository only where the Steward's settings say this PC releases Castellan", () => {
  const steward = path.join(home, 'owner-steward');
  mkdirSync(steward, { recursive: true });
  const env = (more: Record<string, string>) => ({ STEWARD_HOME: steward, ...more }) as NodeJS.ProcessEnv;
  assert.equal(releasesRepo(env({})), null, 'no Steward settings: its own repository only');
  writeFileSync(path.join(steward, 'settings.json'), JSON.stringify({ releasesCastellan: false, releasesRepo: 'me/releases' }));
  assert.equal(releasesRepo(env({})), null, "not Castellan's PC: its own repository only");
  writeFileSync(path.join(steward, 'settings.json'), JSON.stringify({ releasesCastellan: true, releasesRepo: 'me/releases' }));
  assert.equal(releasesRepo(env({})), 'me/releases', 'a release by hand on the PC that releases Castellan');
  assert.equal(releasesRepo(env({ MANOR_RELEASES_REPO: '' })), null, 'the Steward says none');
  assert.equal(releasesRepo(env({ MANOR_RELEASES_REPO: 'me/other' })), 'me/other', 'the Steward names it');
  assert.equal(inEffect({ ...DEFAULT_SETTINGS, releasesRepo: 'me/releases' }).releasesRepo, '', 'off: never used');
});

test("the Steward's own repository is never an employee as well on the PC that releases it, nor offered by Found", () => {
  const own = { ...DEFAULT_SETTINGS, releasesCastellan: true, stewardRepo: 'me/steward', stewardCheckout: path.join(home, 'clones', 'steward') };
  const mine = { id: 'steward', branch: 'main', merges: false, usesKit: false, fill: '', test: [], versionFiles: ['package.json'], release: '', install: '', approve: '', installed: '', name: 'Steward', repo: 'Me/Steward', checkout: path.join(home, 'elsewhere') };
  const byClone = { ...mine, id: 'stew', repo: 'me/fork', checkout: `${own.stewardCheckout}${path.sep}` };
  const other = { ...mine, id: 'app', name: 'app', repo: 'me/app', checkout: app.checkout };
  assert.deepEqual(inEffect({ ...own, employees: [mine, byClone, other] }).employees.map((e) => e.id), ['app'], 'by its repository or its clone');
  // Elsewhere a repository of the same name is anyone's.
  assert.deepEqual(inEffect({ ...DEFAULT_SETTINGS, stewardRepo: 'me/steward', employees: [mine, other] }).employees.map((e) => e.id), ['steward', 'app']);
  const found = { at: null, from: 'reeve' as const, error: null, repos: [{ repo: 'me/steward', name: 'steward', path: own.stewardCheckout, branch: 'main', lockfiles: [], push: true }, { repo: 'me/new', name: 'new', path: path.join(home, 'clones', 'new'), branch: 'main', lockfiles: [], push: true }] };
  assert.deepEqual(candidates(found, [], inEffect(own)).map((r) => r.repo), ['me/new']);
});
