import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// Work for the Wright: a failed bump or release, and Reeve's alerts that are code work, filed as manor:work issues in
// the employee's repository where the Wright works; their alarms wait while it works on them. And the commits whose
// tests passed here, for the Surveyor (GET /api/tested).
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-work-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { closeResolved, fileWork, holdForWork, marker, reeveItems, withoutPublish, workFiledFile, workItems } = await import('../src/work.ts');
const { alarmsFile, watchAlarms } = await import('../src/alarms.ts');
const { DEFAULT_SETTINGS, normalizeSettings } = await import('../src/settings.ts');
const { STAFF: DEFAULT_EMPLOYEES } = await import('./fixtures/staff.ts');
const { checksLogOf } = await import('../src/stages/bump.ts');
const { bumpDirOf, releaseDirOf } = await import('../src/stages/common.ts');
const { KEEP_TESTED, recordTested, testedFile, testedView } = await import('../src/tested.ts');
const { employee, fakeEmployee, ok, runner } = await import('./helpers.ts');

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-05T08:00:00Z');
const at = (h: number) => new Date(T0 + h * HOUR);
const settings = structuredClone(DEFAULT_SETTINGS);
settings.workRoot = path.join(home, 'work');
const employees = DEFAULT_EMPLOYEES;
const porter = employees.find((e) => e.id === 'porter')!;
const reeve = employees.find((e) => e.id === 'reeve')!;
const roundResult = (more = {}) => ({ stage: 'round' as const, started: at(0).toISOString(), finished: at(0).toISOString(), kit: null, asked: {}, results: [], log: [], ...more });

/** The Wright's GET /api/work, as Wright 0.1.5 and later answer it. */
const WORK = (more = {}) => ({ at: 'x', takesWork: true, label: 'manor:work', repos: ['Jcollier0120/Porter', 'Jcollier0120/Reeve', 'Jcollier0120/GamerNexus'], team: ['Jcollier0120'], needsYou: [], recent: [], error: null, ...more });

/** gh as GitHub answers it: signed in as the team, no open work, and each issue created given the next number. */
function gh(o: { login?: string; open?: { number: number; url: string; body: string }[]; noLabel?: boolean } = {}) {
  let next = 40;
  let labelled = !o.noLabel;
  const bodies: string[] = [];
  const r = runner((args) => {
    if (args[0] === 'api' && args[1] === 'user') return ok(`${o.login ?? 'Jcollier0120'}\n`);
    if (args[0] === 'issue' && args[1] === 'list') return ok(o.open ?? []);
    if (args[0] === 'label' && args[1] === 'create') {
      if (labelled) return { code: 1, out: '', err: `label with name "${args[2]}" already exists; use \`--force\` to update its color and description` };
      labelled = true;
      return ok('');
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      if (!labelled) return { code: 1, out: '', err: `could not add label: '${args[args.indexOf('--label') + 1]}' not found` };
      bodies.push(readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'));
      const repo = args[args.indexOf('--repo') + 1];
      return ok(`https://github.com/${repo}/issues/${next++}\n`);
    }
    return undefined;
  });
  return { ...r, bodies, creates: () => r.gh.filter((a) => a[0] === 'issue' && a[1] === 'create') };
}

beforeEach(() => {
  rmSync(workFiledFile(), { force: true });
  rmSync(alarmsFile(), { force: true });
});

test("a failed bump and a failed release are work, with the output kept beside their worktrees, secrets taken out; a push, or the Steward's own, isn't", () => {
  mkdirSync(settings.workRoot, { recursive: true });
  writeFileSync(checksLogOf(bumpDirOf(settings, porter)), `npm test (exit 1)\n\n${'ok line\n'.repeat(100)}not ok 3 - feeds parse\n  token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n`);
  writeFileSync(checksLogOf(releaseDirOf(settings, reeve)), 'npm run release -- --publish (exit 1)\n\nesbuild: Could not resolve "./dash.ts"\n');
  const items = workItems({
    failedReleases: { reeve: 'abc1234', steward: 'def5678' },
    failedRollouts: { porter: { kit: '2.12.1', head: '0123456789abcdef', stage: 'bump', message: 'npm test failed (exit 1): "feeds parse", twice' }, reeve: { kit: '2.12.1', head: 'fedcba', stage: 'push', message: 'GitHub said 403' } },
    round: roundResult({ results: [{ id: 'reeve', name: 'Reeve', outcome: 'failed', message: 'release: npm run release -- --publish failed (exit 1)' }] }),
    employees,
    settings,
  });
  assert.deepEqual(items.map((i) => [i.id, i.condition, i.repo]), [
    ['bump:porter:2.12.1', 'rollout:porter:2.12.1', 'Jcollier0120/Porter'],
    ['release:reeve:abc1234', 'release:reeve:abc1234', 'Jcollier0120/Reeve'],
  ]);
  const [bump, release] = items;
  assert.equal(bump.title, "Porter's bump to kit 2.12.1 fails its checks");
  assert.match(bump.body, /`steward\/kit-2\.12\.1` was never pushed/);
  assert.match(bump.body, /\*\*Where the fix goes:\*\* main/);
  assert.match(bump.body, /\*\*Done means:\*\* with your fix on main, the Steward's next bump to kit 2\.12\.1 passes its checks/);
  assert.match(bump.body, /not ok 3 - feeds parse/);
  assert.match(bump.body, /token=\[redacted\]/);
  assert.ok(!bump.body.includes('ghp_'), 'no token leaves this PC');
  assert.ok(bump.body.split('\n').filter((l) => l === 'ok line').length <= 60, 'only the end of the output');
  assert.ok(bump.body.endsWith(marker('bump:porter:2.12.1')));
  assert.match(release.body, /esbuild: Could not resolve/);
  assert.match(release.body, /> npm run release -- --publish failed \(exit 1\)/);
  assert.match(release.body, /`npm run release` \(without publishing/);
  // Rollout off: its bumps aren't the rounds' to file.
  assert.deepEqual(workItems({ failedReleases: {}, failedRollouts: { porter: { kit: '2.12.1', head: 'a', stage: 'bump', message: 'x' } }, employees, settings: { ...settings, rollout: false } }), []);
  assert.equal(withoutPublish('powershell -NoProfile -File HEI.Agent\\release.ps1 -Publish'), 'powershell -NoProfile -File HEI.Agent\\release.ps1');
});

const ALERTS = {
  alerts: [
    { id: 'dependency-health:aaaaaaaaaaaa', job: 'dependency-health', title: "Reeve's dependency-health job: porter: new high/critical security alert: https://github.com/advisories/GHSA-1", detail: ['porter: 1 open alert. Report: C:\\x.md', 'porter: new high/critical security alert: https://github.com/advisories/GHSA-1'], since: '2026-10-05T07:00:00Z', url: 'http://reeve.localhost:18383/#job-dependency-health' },
    { id: 'dependency-health:bbbbbbbbbbbb', job: 'dependency-health', title: "Reeve's dependency-health job: gamernexus: new high/critical security alert: https://github.com/advisories/GHSA-2", detail: [], url: 'u' },
    { id: 'dependency-health:cccccccccccc', job: 'dependency-health', title: "Reeve's dependency-health job: exited 1", detail: ['Log: C:\\Users\\x\\.reeve\\logs\\porter.log'], url: 'u' },
    { id: 'npu-health:dddddddddddd', job: 'npu-health', title: "Reeve's npu-health job: NPU driver changed", detail: [], url: 'u' },
    { id: 'maestro-runs:eeeeeeeeeeee', job: 'maestro-runs', title: "Reeve's maestro-runs job: Maestro FAILED: Reeve dashboard at: Tap on Jobs", detail: [], url: 'u' },
  ],
};

test("Reeve's alerts: an advisory or a failed Maestro flow naming an employee is work in its repository; a crash, the NPU, or another project's isn't", () => {
  const items = reeveItems(ALERTS, employees);
  assert.deepEqual(items.map((i) => [i.id, i.condition, i.repo]), [
    ['reeve:dependency-health:aaaaaaaaaaaa:Jcollier0120/Porter', 'reeve:dependency-health:aaaaaaaaaaaa', 'Jcollier0120/Porter'],
    ['reeve:maestro-runs:eeeeeeeeeeee:Jcollier0120/Reeve', 'reeve:maestro-runs:eeeeeeeeeeee', 'Jcollier0120/Reeve'],
  ]);
  assert.equal(items[0].title, 'Porter: porter: new high/critical security alert: https://github.com/advisories/GHSA-1');
  assert.match(items[0].body, /a new high or critical security advisory/);
  assert.match(items[0].body, /\*\*Done means:\*\* the advisory no longer applies on main/);
});

test('filed once where the Wright works, by its team, with the label and a marker; never a repository that is only the Wright\'s, nor past the day\'s few', async () => {
  const items = [
    ...reeveItems(ALERTS, employees),
    // A repository the Wright works in that isn't an employee's: one of this PC's own projects, never the Steward's to file in.
    { id: 'reeve:x:Jcollier0120/GamerNexus', condition: 'reeve:x', repo: 'Jcollier0120/GamerNexus', title: 't', body: 'b' },
    { id: 'release:herald:1234567', condition: 'release:herald:1234567', repo: 'Jcollier0120/Herald', title: 't', body: 'b' },
  ];
  const g = gh();
  const lines: string[] = [];
  const states = await fileWork({ items, work: WORK(), employees, run: g.run, cwd: home, now: at(0), log: (l) => lines.push(l) });
  assert.deepEqual([...states.entries()].map(([id, s]) => [id, s.state, 'why' in s ? s.why : s.url]), [
    ['reeve:dependency-health:aaaaaaaaaaaa:Jcollier0120/Porter', 'filed', 'https://github.com/Jcollier0120/Porter/issues/40'],
    ['reeve:maestro-runs:eeeeeeeeeeee:Jcollier0120/Reeve', 'filed', 'https://github.com/Jcollier0120/Reeve/issues/41'],
    ['reeve:x:Jcollier0120/GamerNexus', 'not-filed', "Jcollier0120/GamerNexus isn't one of the Steward's employees"],
    ['release:herald:1234567', 'not-filed', "the Wright doesn't work in Jcollier0120/Herald"],
  ]);
  const create = g.creates()[0];
  assert.deepEqual([create[create.indexOf('--repo') + 1], create[create.indexOf('--label') + 1]], ['Jcollier0120/Porter', 'manor:work']);
  assert.ok(g.bodies[0].includes(marker('reeve:dependency-health:aaaaaaaaaaaa:Jcollier0120/Porter')));
  assert.ok(lines.some((l) => l.startsWith('work: filed https://github.com/Jcollier0120/Porter/issues/40')));
  assert.ok(!g.gh.some((a) => a.includes('Jcollier0120/GamerNexus')), 'gh never asked about it');

  // The next round: already filed, nothing asked of GitHub.
  const again = gh();
  const s2 = await fileWork({ items: items.slice(0, 2), work: WORK(), employees, run: again.run, cwd: home, now: at(1), log: () => {} });
  assert.deepEqual([[...s2.values()].map((s) => s.state), again.gh], [['filed', 'filed'], []]);

  // At most a few a day: today's two and one more; tomorrow the next.
  const more = ['a', 'b', 'c'].map((k) => ({ id: `release:porter:${k}`, condition: `release:porter:${k}`, repo: 'Jcollier0120/Porter', title: k, body: k }));
  const s3 = await fileWork({ items: more, work: WORK(), employees, run: gh().run, cwd: home, now: at(2), log: () => {} });
  assert.deepEqual([...s3.values()].map((s) => s.state), ['filed', 'not-filed', 'not-filed']);
  const s4 = await fileWork({ items: more, work: WORK(), employees, run: gh().run, cwd: home, now: at(24), log: () => {} });
  assert.deepEqual([...s4.values()].map((s) => s.state), ['filed', 'filed', 'filed']);
});

test("a newer kit's failed bump takes over the employee's open bump issue, and closes the older ones, rather than filing another", async () => {
  const issue = (n: number, id: string) => ({ number: n, url: `https://github.com/Jcollier0120/Porter/issues/${n}`, body: `x\n${marker(id)}` });
  // Porter's three, one a kit; and the Developer Herald's, which is no Herald's.
  const open = [issue(45, 'bump:porter:2.21.0'), issue(46, 'bump:porter:2.23.0'), issue(48, 'bump:porter:2.24.0'), issue(17, 'bump:developer-herald:2.24.0'), issue(50, 'release:porter:abc1234')];
  const r = runner((args) => {
    if (args[0] === 'api' && args[1] === 'user') return ok('Jcollier0120\n');
    if (args[0] === 'issue' && args[1] === 'list') return ok(open);
    if (args[0] === 'issue' && (args[1] === 'edit' || args[1] === 'close')) return ok('');
    return undefined;
  });
  const item = { id: 'bump:porter:2.26.0', condition: 'rollout:porter:2.26.0', repo: 'Jcollier0120/Porter', title: "Porter's bump to kit 2.26.0 fails its checks", body: `b\n${marker('bump:porter:2.26.0')}` };
  const lines: string[] = [];
  // Even with the day's few all filed: taking one over files nothing new.
  const s = await fileWork({ items: [item], work: WORK(), employees, run: r.run, cwd: home, now: at(0), log: (l) => lines.push(l), perDay: 0 });
  assert.deepEqual(s.get(item.id), { state: 'filed', url: 'https://github.com/Jcollier0120/Porter/issues/48', at: at(0).toISOString() });
  const edit = r.gh.find((a) => a[1] === 'edit')!;
  assert.deepEqual(edit.slice(0, 6), ['issue', 'edit', '48', '--repo', 'Jcollier0120/Porter', '--title']);
  assert.equal(edit[6], item.title);
  assert.deepEqual(r.gh.filter((a) => a[1] === 'close').map((a) => a[2]), ['46', '45']);
  assert.match(r.gh.find((a) => a[1] === 'close')!.at(-1)!, /Superseded by #48, now the bump to kit 2\.26\.0/);
  assert.ok(!r.gh.some((a) => a[1] === 'create'));
  assert.match(lines.join('\n'), /issues\/48 is now the bump to kit 2\.26\.0; #46, #45 closed as superseded/);
  // Kept under its new id; the next round asks GitHub nothing.
  const kept = JSON.parse(readFileSync(workFiledFile(), 'utf8'));
  assert.equal(kept['bump:porter:2.26.0'].number, 48);
  const again = gh();
  await fileWork({ items: [item], work: WORK(), employees, run: again.run, cwd: home, now: at(1), log: () => {} });
  assert.deepEqual(again.gh, []);

  // The Herald's bump never takes the Developer Herald's issue; with none of its own open, it is filed anew.
  const herald = { ...item, id: 'bump:herald:2.26.0', condition: 'rollout:herald:2.26.0' };
  const h = runner((args) => (args[1] === 'user' ? ok('Jcollier0120\n') : args[1] === 'list' ? ok(open) : args[1] === 'create' ? ok('https://github.com/Jcollier0120/Porter/issues/60\n') : undefined));
  await fileWork({ items: [herald], work: WORK(), employees, run: h.run, cwd: home, now: at(2), log: () => {} });
  assert.ok(!h.gh.some((a) => a[1] === 'edit' || a[1] === 'close'));
  assert.equal(h.gh.filter((a) => a[1] === 'create').length, 1);
});

test("a kit's failed bumps count as one of the day's few: a kit that breaks six agents' checks has all six filed that day", async () => {
  const bumps = ['porter', 'reeve', 'gamernexus', 'herald', 'miller', 'pinder'].map((e) => ({ id: `bump:${e}:2.21.0`, condition: `rollout:${e}:2.21.0`, repo: 'Jcollier0120/Porter', title: e, body: e }));
  const others = ['a', 'b', 'c'].map((k) => ({ id: `release:porter:${k}`, condition: `release:porter:${k}`, repo: 'Jcollier0120/Porter', title: k, body: k }));
  const g = gh();
  const s = await fileWork({ items: [...bumps, ...others], work: WORK(), employees, run: g.run, cwd: home, now: at(0), log: () => {} });
  // The kit's six are one; two releases make three; the third release waits for tomorrow.
  assert.deepEqual([...s.values()].map((x) => x.state), [...bumps.map(() => 'filed'), 'filed', 'filed', 'not-filed']);
  assert.equal(g.creates().length, 8);
  // Another kit's bumps are another one, and today's few are filed.
  const next = await fileWork({ items: [{ ...bumps[0], id: 'bump:porter:2.22.0' }], work: WORK(), employees, run: gh().run, cwd: home, now: at(1), log: () => {} });
  assert.equal([...next.values()][0].state, 'not-filed');
});

test("a repository without the Wright's label yet has it made, as the others have it, and the issue filed", async () => {
  const item = { id: 'release:porter:abc1234', condition: 'release:porter:abc1234', repo: 'Jcollier0120/Porter', title: 't', body: 'b' };
  const g = gh({ noLabel: true });
  const lines: string[] = [];
  const s = await fileWork({ items: [item], work: WORK(), employees, run: g.run, cwd: home, now: at(0), log: (l) => lines.push(l) });
  assert.deepEqual(s.get(item.id), { state: 'filed', url: 'https://github.com/Jcollier0120/Porter/issues/40', at: at(0).toISOString() });
  assert.deepEqual(g.gh.filter((a) => a[0] === 'label'), [['label', 'create', 'manor:work', '--repo', 'Jcollier0120/Porter', '--color', '1d76db', '--description', 'Queued for the Wright']]);
  assert.equal(g.creates().length, 2, 'tried again once');
  assert.ok(lines.includes("work: created the manor:work label in Jcollier0120/Porter, which hadn't it"));

  // Made meanwhile by someone else: "already exists" is as good, and the issue is filed.
  rmSync(workFiledFile(), { force: true });
  const raced = runner((args) => {
    if (args[1] === 'user') return ok('Jcollier0120\n');
    if (args[1] === 'list') return ok([]);
    if (args[0] === 'label') return { code: 1, out: '', err: 'label with name "manor:work" already exists; use `--force` to update its color and description' };
    return raced.gh.filter((a) => a[1] === 'create').length < 2 ? { code: 1, out: '', err: "could not add label: 'manor:work' not found" } : ok('https://github.com/Jcollier0120/Porter/issues/41\n');
  });
  const s2 = await fileWork({ items: [item], work: WORK(), employees, run: raced.run, cwd: home, now: at(0), log: () => {} });
  assert.equal(s2.get(item.id)!.state, 'filed');

  // gh can't make it either: not filed, and said why, with no third try.
  rmSync(workFiledFile(), { force: true });
  const refused = runner((args) => (args[1] === 'user' ? ok('Jcollier0120\n') : args[1] === 'list' ? ok([]) : args[0] === 'label' ? { code: 1, out: '', err: 'HTTP 403: Resource not accessible' } : { code: 1, out: '', err: "could not add label: 'manor:work' not found" }));
  const quiet: string[] = [];
  const s3 = await fileWork({ items: [item], work: WORK(), employees, run: refused.run, cwd: home, now: at(0), log: (l) => quiet.push(l) });
  assert.deepEqual(s3.get(item.id), { state: 'not-filed', why: "gh couldn't file it in Jcollier0120/Porter" });
  assert.equal(refused.gh.filter((a) => a[1] === 'create' && a[0] === 'issue').length, 1);
  assert.ok(quiet.some((l) => l.startsWith("work: couldn't create the manor:work label in Jcollier0120/Porter: HTTP 403")));

  // Another failure isn't a missing label: no label made.
  rmSync(workFiledFile(), { force: true });
  const other = runner((args) => (args[1] === 'user' ? ok('Jcollier0120\n') : args[1] === 'list' ? ok([]) : { code: 1, out: '', err: 'HTTP 502' }));
  await fileWork({ items: [item], work: WORK(), employees, run: other.run, cwd: home, now: at(0), log: () => {} });
  assert.ok(!other.gh.some((a) => a[0] === 'label'));
});

test('no queue, no team, or an issue already open with its marker: not filed again', async () => {
  const item = { id: 'release:porter:abc1234', condition: 'release:porter:abc1234', repo: 'Jcollier0120/Porter', title: 't', body: 'b' };
  const why = async (work: unknown, g = gh()) => {
    const s = (await fileWork({ items: [item], work, employees, run: g.run, cwd: home, now: at(0), log: () => {} })).get(item.id)!;
    return 'why' in s ? s.why : s.state;
  };
  assert.match(await why(null), /the Wright's page isn't set/);
  assert.match(await why({ error: 'ECONNREFUSED' }), /doesn't answer \(ECONNREFUSED\)/);
  assert.match(await why(WORK({ takesWork: false })), /takes no work now/);
  assert.match(await why({ at: 'x', needsYou: [] }), /a Wright before 0\.1\.5/);
  assert.match(await why(WORK(), gh({ login: 'someone-else' })), /only from its team \(Jcollier0120\), and gh is signed in as someone-else/);
  const g = gh({ open: [{ number: 7, url: 'https://github.com/Jcollier0120/Porter/issues/7', body: `x\n${marker(item.id)}` }] });
  assert.equal(await why(WORK(), g), 'filed');
  assert.deepEqual(g.creates(), [], 'found open: not filed twice');
  assert.equal(JSON.parse(readFileSync(workFiledFile(), 'utf8'))[item.id].url, 'https://github.com/Jcollier0120/Porter/issues/7');
});

test("the alarm waits a day from when it was filed; at once when the Wright is stuck, its PR waits for you, or it couldn't be filed", async () => {
  const cond = { id: 'release:porter:abc1234', who: 'porter', title: "Porter's release failed at abc1234", detail: ['a fact'], afterMs: 0 };
  const items = [{ id: 'release:porter:abc1234', condition: cond.id, repo: 'Jcollier0120/Porter', title: 't', body: 'b' }];
  const url = 'https://github.com/Jcollier0120/Porter/issues/40';
  const held = holdForWork([cond], items, new Map([[items[0].id, { state: 'filed', url, at: at(0).toISOString() }]]), 24)[0];
  assert.deepEqual([held.afterMs, held.since, held.url], [24 * HOUR, at(0).toISOString(), url]);
  assert.match(held.detail[0], /^Handed to the Wright: https:\/\/github\.com\/Jcollier0120\/Porter\/issues\/40\. An alarm only if/);
  const stuck = holdForWork([cond], items, new Map([[items[0].id, { state: 'stuck', url, at: at(0).toISOString() }]]), 24)[0];
  assert.deepEqual([stuck.afterMs, stuck.url], [0, url]);
  assert.match(stuck.detail[0], /The Wright got stuck on/);
  const not = holdForWork([cond], items, new Map([[items[0].id, { state: 'not-filed', why: "the Wright doesn't work in X" }]]), 24)[0];
  assert.deepEqual([not.afterMs, not.detail.at(-1)], [0, "Not handed to the Wright: the Wright doesn't work in X."]);
  assert.deepEqual(holdForWork([{ ...cond, id: 'other' }], items, new Map(), 24)[0].afterMs, 0, 'a condition with no work is as it was');
});

test('watching: a failed release is filed and its alarm waits a day; stuck, it is raised at once; filing off, at once as before', async () => {
  const s = structuredClone(settings);
  Object.assign(s.alarms, { manorUrl: '', surveyorUrl: '', wrightUrl: 'http://127.0.0.1:29797', reeveUrl: '' });
  let work: unknown = WORK();
  const g = gh();
  const watch = (h: number, more: Partial<typeof s> = {}) =>
    watchAlarms({ settings: { ...s, ...more }, round: roundResult(), held: [], failedReleases: { porter: 'abc1234' }, employees, log: () => {}, run: g.run, neutralDir: home }, { getJson: async (u: string) => (u === 'http://127.0.0.1:29797/api/work' ? work : { error: 'none' }), toast: async () => {}, now: at(h) });
  let st = await watch(0);
  assert.deepEqual(st.open.map((a) => a.id), [], 'filed: no alarm yet');
  assert.equal(g.creates().length, 1);
  st = await watch(23);
  assert.deepEqual(st.open.map((a) => a.id), []);
  st = await watch(24);
  assert.deepEqual(st.open.map((a) => a.id), ['release:porter:abc1234'], 'nothing landed in a day: an alarm');
  assert.match(st.open[0].detail[0], /^Handed to the Wright: https:\/\/github\.com\/Jcollier0120\/Porter\/issues\/40/);

  rmSync(alarmsFile(), { force: true });
  work = WORK({ needsYou: [{ id: 'stuck:Jcollier0120/Porter#40', kind: 'stuck', repo: 'Jcollier0120/Porter', number: 40, title: 't', url: 'https://github.com/Jcollier0120/Porter/issues/40' }] });
  st = await watch(1);
  assert.deepEqual(st.open.map((a) => a.id).sort(), ['release:porter:abc1234', 'wright:stuck:Jcollier0120/Porter#40'], 'stuck: at once');

  rmSync(alarmsFile(), { force: true });
  work = WORK({ needsYou: [{ id: 'review:Jcollier0120/Porter#41', kind: 'review', repo: 'Jcollier0120/Porter', number: 41, title: 't', url: 'https://github.com/Jcollier0120/Porter/pull/41' }], recent: [{ repo: 'Jcollier0120/Porter', issue: 40, pr: 'https://github.com/Jcollier0120/Porter/pull/41' }] });
  st = await watch(1);
  const a = st.open.find((x) => x.id === 'release:porter:abc1234')!;
  assert.deepEqual([a.url, a.detail[0]], ['https://github.com/Jcollier0120/Porter/pull/41', "The Wright's fix for https://github.com/Jcollier0120/Porter/issues/40, https://github.com/Jcollier0120/Porter/pull/41, waits for your review."]);

  rmSync(alarmsFile(), { force: true });
  rmSync(workFiledFile(), { force: true });
  work = WORK();
  const before = g.gh.length;
  st = await watch(1, { fileWork: false });
  assert.deepEqual([st.open.map((x) => x.id), g.gh.length], [['release:porter:abc1234'], before], 'off: an alarm at once, and nothing asked of gh');
  assert.equal(normalizeSettings({}).settings.fileWork, true);
  assert.equal(normalizeSettings({ fileWork: false }).settings.fileWork, false);
});

test('tested: the newest first, a commit and stage once, the last few of each employee, with its repository', () => {
  rmSync(testedFile(), { force: true });
  for (let i = 0; i < KEEP_TESTED + 5; i++) recordTested('porter', { commit: `c${i}`, stage: 'merge', pr: i }, at(i));
  recordTested('porter', { commit: 'c24', stage: 'merge', pr: 24 }, at(30));
  recordTested('steward', { commit: 'd1', stage: 'release', branch: 'main', version: '0.9.0' }, at(1));
  const v = testedView({ employees, stewardRepo: 'Jcollier0120/Steward' }, at(31));
  assert.deepEqual(Object.keys(v), ['at', 'keep', 'employees']);
  assert.equal(v.employees.porter.repo, 'Jcollier0120/Porter');
  assert.equal(v.employees.porter.tested.length, KEEP_TESTED);
  assert.deepEqual(v.employees.porter.tested.slice(0, 2).map((t) => [t.commit, t.at]), [['c24', at(30).toISOString()], ['c23', at(23).toISOString()]]);
  assert.deepEqual(v.employees.steward, { repo: 'Jcollier0120/Steward', tested: [{ commit: 'd1', stage: 'release', branch: 'main', version: '0.9.0', at: at(1).toISOString() }] });
  assert.ok(existsSync(testedFile()));
});

test("a bump issue whose failure is gone is closed: the employee's branch pins that kit or a newer one now; one still failing, or still behind, stays", async () => {
  // Two employees on fake git: one bumped past the kit since, one still behind it.
  const past = employee(fakeEmployee(path.join(home, 'resolved-past'), { kit: '2.26.0' }).checkout, { id: 'past', name: 'Past', repo: 'Jcollier0120/Past' });
  const behind = employee(fakeEmployee(path.join(home, 'resolved-behind'), { kit: '2.19.0' }).checkout, { id: 'behind', name: 'Behind', repo: 'Jcollier0120/Behind' });
  const entry = (repo: string, n: number) => ({ url: `https://github.com/${repo}/issues/${n}`, number: n, repo, at: at(0).toISOString(), condition: 'x' });
  writeFileSync(workFiledFile(), JSON.stringify({
    'bump:past:2.23.0': entry('Jcollier0120/Past', 42),
    'bump:past:2.26.0': entry('Jcollier0120/Past', 46),
    'bump:behind:2.23.0': entry('Jcollier0120/Behind', 7),
    'release:past:abc1234': entry('Jcollier0120/Past', 9),
  }));
  const r = runner((args) => (args[0] === 'issue' && args[1] === 'close' ? (args[2] === '46' ? { code: 1, out: '', err: 'issue #46 is already closed' } : ok('')) : undefined));
  const lines: string[] = [];
  await closeResolved({ items: [], employees: [past, behind], run: r.run, cwd: home, log: (l) => lines.push(l) });
  // Past's two: closed, or found closed already; Behind's waits; a release's is never this one's to close.
  assert.deepEqual(r.gh.map((a) => [a[2], a[4]]), [['42', 'Jcollier0120/Past'], ['46', 'Jcollier0120/Past']]);
  assert.match(r.gh[0].at(-1)!, /Nothing left to do: main now carries kit 2\.26\.0, so Past's bump to kit 2\.23\.0 has passed/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(workFiledFile(), 'utf8'))).sort(), ['bump:behind:2.23.0', 'release:past:abc1234']);
  assert.deepEqual(lines, ['work: closed https://github.com/Jcollier0120/Past/issues/42: Past carries kit 2.26.0 now']);

  // One this round's failures still name is left alone, whatever its branch says.
  writeFileSync(workFiledFile(), JSON.stringify({ 'bump:past:2.23.0': entry('Jcollier0120/Past', 42) }));
  const quiet = runner(() => ok(''));
  await closeResolved({ items: [{ id: 'bump:past:2.23.0', condition: 'x', repo: 'Jcollier0120/Past', title: 't', body: 'b' }], employees: [past], run: quiet.run, cwd: home, log: () => {} });
  assert.deepEqual(quiet.gh, []);
});
