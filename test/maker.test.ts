import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The maker's laptop and everyone else's PC (maker.ts): the same Steward, sold as a developer's hire. On a customer's PC
// it looks after their repositories alone, nothing of Castellan's, and only while Developer options are on; on the
// maker's laptop everything is as before.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-maker-'));
process.env.STEWARD_HOME = path.join(home, 'steward');
mkdirSync(process.env.STEWARD_HOME, { recursive: true });
// A Manor of the test's own: its shipped staff.json (the agents' ids), and its Developer options switch.
const manor = path.join(home, 'manor');
process.env.MANOR_HOME = manor;
mkdirSync(path.join(manor, 'app'), { recursive: true });
writeFileSync(path.join(manor, 'app', 'staff.json'), JSON.stringify({ agents: [{ id: 'porter' }, { id: 'reeve' }, { id: 'steward' }, { id: 'toller' }] }));
const developerOptions = (on: boolean) => writeFileSync(path.join(manor, 'settings.json'), JSON.stringify({ developerOptions: on }));
developerOptions(true);
delete process.env.STEWARD_CUSTOMER;
after(() => rmSync(home, { recursive: true, force: true }));

const maker = await import('../src/maker.ts');
const { DEVELOPER_ONLY, isMakersUuid, makersIds, makersOwn, makersPc, makersPcForTests, makersRepo, stewardActs, uuidIn } = maker;
const { DEFAULT_SETTINGS, SETTINGS_SPEC, inEffect, normalizeSettings, releasesRepoEnv } = await import('../src/settings.ts');
const { candidates, lookAfter } = await import('../src/found.ts');
const { claimVersion } = await import('../src/claims.ts');
const { employeeFor } = await import('../src/employ.ts');
const { runStage } = await import('../src/steward.ts');
const { gateGets, gatePosts, offView } = await import('../src/agent.ts');
const { fakeEmployee } = await import('./helpers.ts');
const { bundleForNode, importPath } = await import('../kit/test/react-render.ts');
const { STAFF } = await import('./fixtures/staff.ts');

const customer = () => makersPcForTests(() => false);
const makers = () => makersPcForTests(() => true);

// The owner's settings.json as it is: every agent's repository under the maker's account, and Castellan's releases.
const OWNER = { employees: STAFF.map(({ merges: _m, ...e }) => ({ ...e, merges: true })), stewardRepo: 'Jcollier0120/Steward', releasesCastellan: true, releasesRepo: 'Jcollier0120/Manor-releases', byItself: true };
const MINE = { id: 'app', name: 'app', repo: 'me/app', checkout: path.join(home, 'app'), branch: 'main', merges: true, usesKit: false, fill: '', test: ['npm test'], versionFiles: ['package.json'], release: 'tag', install: '', approve: '', installed: '' };

test("the maker's laptop is its firmware UUID, salted and hashed; nothing else makes a PC the maker's", () => {
  assert.equal(uuidIn('HKEY_LOCAL_MACHINE\\SYSTEM\\HardwareConfig\n    LastConfig    REG_SZ    {4c4c4544-0042-3510-8051-b4c04f4b4e33}\n'), '4C4C4544-0042-3510-8051-B4C04F4B4E33');
  assert.equal(uuidIn('ERROR: The system was unable to find the specified registry key or value.'), null);
  const uuid = '11111111-2222-3333-4444-555555555555';
  const expected = createHash('sha256').update(`castellan-makers-pc:${uuid}`).digest('hex');
  assert.equal(isMakersUuid(uuid, expected), true);
  assert.equal(isMakersUuid('11111111-2222-3333-4444-555555555556', expected), false);
  assert.equal(isMakersUuid(null, expected), false);
  assert.equal(isMakersUuid(uuid), false, "any other PC's UUID isn't the maker's");
  // STEWARD_CUSTOMER=1 only ever takes it away.
  makers();
  process.env.STEWARD_CUSTOMER = '1';
  try {
    assert.equal(makersPc(), false);
  } finally {
    delete process.env.STEWARD_CUSTOMER;
  }
  assert.equal(makersPc(), true);
});

test("Castellan's own: any repository under the maker's account, or an id of Manor's agents or the manor's repositories", () => {
  for (const r of ['Jcollier0120/Manor', 'jcollier0120/CastellanSite', 'Jcollier0120/Exchequer', 'Jcollier0120/Manor-releases', 'Jcollier0120/Porter', 'github.com/Jcollier0120/Toller', 'https://github.com/Jcollier0120/Steward.git']) assert.ok(makersRepo(r), r);
  for (const r of ['me/manor', 'someone/Jcollier0120', 'gitlab.com/Jcollier0120/x']) assert.ok(!makersRepo(r), r);
  const ids = makersIds();
  for (const id of ['porter', 'reeve', 'toller', 'manor', 'exchequer', 'castellansite', 'manor-releases', 'kit']) assert.ok(ids.has(id), id);
  assert.ok(!ids.has('app'));
  // In words, on a customer's PC; nothing on the maker's.
  assert.match(makersOwn({ name: 'Manor', repo: 'Jcollier0120/Manor' }, { makers: false })!, /^Manor is one of Castellan's own repositories, which only its makers look after: the Steward here looks after yours\.$/);
  assert.match(makersOwn({ id: 'porter', repo: 'me/porter' }, { makers: false })!, /^porter is the name of one of Castellan's own agents or repositories.*give yours another id in Settings\.$/);
  assert.equal(makersOwn({ id: 'porter', repo: 'me/porter' }, { makers: false, byId: false }), null, 'a name made up for a claim is not an id');
  assert.equal(makersOwn({ id: 'app', repo: 'me/app' }, { makers: false }), null);
  assert.equal(makersOwn({ id: 'manor', repo: 'Jcollier0120/Manor' }, { makers: true }), null);
});

test("a customer's PC: Castellan's releases off whatever the file says, and none of its repositories looked after", () => {
  customer();
  const { settings: s, problems } = normalizeSettings({ ...OWNER, employees: [...OWNER.employees, MINE] });
  assert.deepEqual([s.releasesCastellan, s.makersPc], [false, false], "the file's yes counts for nothing here");
  assert.equal(problems.length, OWNER.employees.length, 'each of Castellan\'s repositories is said');
  assert.match(problems[0], /is one of Castellan's own repositories/);
  const used = inEffect({ ...s, releasesCastellan: true });
  assert.deepEqual(used.employees.map((e) => e.id), ['app'], 'only theirs');
  assert.deepEqual([used.releasesCastellan, used.rollout, used.releaseSelf, used.mergeSelf, used.stewardRepo, used.releasesRepo], [false, false, false, false, '', '']);
  assert.deepEqual(releasesRepoEnv({ releasesCastellan: true, releasesRepo: 'Jcollier0120/Manor-releases' }), { MANOR_RELEASES_REPO: '' }, "never Castellan's releases repository");
  // A repository of theirs that takes an agent's id is left out until they give it another.
  assert.deepEqual(inEffect({ ...s, employees: [{ ...MINE, id: 'porter' }] }).employees, []);
  // Settings: the switch isn't offered, and a save naming one of Castellan's is refused beside it.
  const field = (k: string) => SETTINGS_SPEC.schema.find((f) => f.key === k) as any;
  assert.deepEqual(field('releasesCastellan').shownWhen, { key: 'makersPc', is: ['true'] });
  assert.equal(field('makersPc').readOnly, true);
  assert.equal(SETTINGS_SPEC.developerOnly, true, "a developer's form: none with Developer options off");
  const checked = SETTINGS_SPEC.check!({ ...s, employees: [MINE, { ...MINE, id: 'manor', repo: 'Jcollier0120/Manor', name: 'Manor' }, { ...MINE, id: 'reeve', repo: 'me/reeve' }] }, ['employees'], {}) as { errors: Record<string, string> };
  assert.deepEqual(Object.keys(checked.errors), ['employees.1.repo', 'employees.2.id']);
  assert.match(checked.errors['employees.1.repo'], /Manor is one of Castellan's own repositories/);
});

test("a customer's PC: Castellan's repositories aren't offered or taken on, and theirs never take an agent's id", () => {
  customer();
  const clone = (n: string) => path.join(home, 'clones', n);
  const found = { at: new Date().toISOString(), from: 'reeve' as const, error: null, repos: [
    { repo: 'Jcollier0120/Porter', name: 'porter', path: clone('Porter'), branch: 'main', lockfiles: [], push: true },
    { repo: 'me/porter', name: 'porter', path: clone('porter'), branch: 'main', lockfiles: [], push: true },
  ] };
  assert.deepEqual(candidates(found, []).map((r) => r.repo), ['me/porter']);
  assert.deepEqual(candidates(found, [], true).map((r) => r.repo), ['Jcollier0120/Porter', 'me/porter'], "the maker's laptop offers both");
  const file = path.join(home, 'look-after.json');
  writeFileSync(file, '{}');
  assert.match((lookAfter('Jcollier0120/Porter', { merges: true, release: true, found, file }) as { error: string }).error, /^Jcollier0120\/Porter is one of Castellan's own repositories/);
  const took = lookAfter('me/porter', { merges: false, release: false, found, file });
  assert.ok('employee' in took);
  assert.equal(took.employee.id, 'porter-2', "its own id, not the Porter's");
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).employees.map((e: { repo: string }) => e.repo), ['me/porter']);
});

test("a customer's PC: no version of Castellan's repositories or kit is claimed, and none of its agents is employed", async () => {
  customer();
  await assert.rejects(claimVersion({} as any, { ...MINE, name: 'Manor', repo: 'Jcollier0120/Manor' }, { by: 'claude', for: 'x' }), /Manor is one of Castellan's own repositories/);
  await assert.rejects(claimVersion({} as any, { ...MINE, repo: 'me/steward' }, { by: 'claude', for: 'x', part: 'kit' }), /Claiming a version of Castellan's kit is for the people who make Castellan/);
  const agent = fakeEmployee(path.join(home, 'agent'), { files: { 'manor-agent.json': JSON.stringify({ agent: { id: 'toller', name: 'Toller' } }) } });
  const theirs = employeeFor(agent.checkout, [], { origin: () => 'Jcollier0120/Toller', internal: new Set(), staff: new Set() });
  assert.match((theirs as { error: string }).error, /^Toller is one of Castellan's own repositories/);
  const sameId = employeeFor(agent.checkout, [], { origin: () => 'me/toller', internal: new Set(), staff: new Set() });
  assert.match((sameId as { error: string }).error, /^toller is the name of one of Castellan's own agents/);
  makers();
  assert.ok('employee' in employeeFor(agent.checkout, [], { origin: () => 'Jcollier0120/Toller', internal: new Set(), staff: new Set() }), "the maker's laptop takes it on");
});

test("Developer options off on a customer's PC: nothing runs, its reads and buttons say why, and its page is one plain line", async () => {
  customer();
  developerOptions(false);
  try {
    assert.equal(stewardActs(), false);
    const r = await runStage('round', { full: true });
    assert.deepEqual([r.error, r.results], [DEVELOPER_ONLY, []]);
    assert.doesNotMatch(DEVELOPER_ONLY, /repositor|GitHub|pull request|settings\.json/i, 'in plain words');
    const called: string[] = [];
    const gets = gateGets({ '/api/page': () => ({ json: 'page' }), '/api/staff': () => (called.push('staff'), { json: 'rows' }), '/api/alarms': () => ({ json: 'alarms' }), '/api/version-queues': () => ({ json: 'q' }) });
    const req = {} as any;
    const json = async (h: (r: any) => unknown) => ((await h(req)) as { json: unknown }).json;
    assert.equal(await json(gets['/api/page']), 'page', 'the page draws the plain line itself');
    assert.deepEqual(await json(gets['/api/staff']), { off: DEVELOPER_ONLY });
    assert.deepEqual(await json(gets['/api/alarms']), { on: false, at: null, open: [], cleared: [], page: '/#alarms' }, "Manor's read keeps its shape");
    assert.deepEqual(await json(gets['/api/version-queues']), { at: '', repos: [] });
    const posts = gatePosts({ '/api/run': () => (called.push('run'), { json: { started: true } }) });
    assert.deepEqual(await json(posts['/api/run']), { started: false, error: DEVELOPER_ONLY, message: DEVELOPER_ONLY });
    assert.deepEqual(called, [], 'nothing behind them is even asked');
    const m = await bundleForNode<{ render: (body: unknown) => string }>(
      `import { renderToStaticMarkup } from 'react-dom/server';
       import { RunNow, StewardBody } from '${importPath('src/web/steward.tsx')}';
       export const render = (v) => renderToStaticMarkup(<><RunNow v={v} /><StewardBody v={v} /></>);`,
    );
    const html = m.render(offView());
    assert.ok(html.includes(DEVELOPER_ONLY.replace(/'/g, '&#x27;')), html);
    assert.doesNotMatch(html, /Run now|data-post/, 'no button');
    // On again: it acts.
    developerOptions(true);
    assert.equal(stewardActs(), true);
  } finally {
    developerOptions(true);
  }
});

test("the maker's laptop: as before, whatever Developer options say, and with all of Castellan's", () => {
  makers();
  developerOptions(false);
  try {
    assert.equal(stewardActs(), true, 'the release machinery is never held by a switch');
  } finally {
    developerOptions(true);
  }
  const { settings: s, problems } = normalizeSettings(OWNER);
  assert.deepEqual([s.releasesCastellan, s.makersPc, problems], [true, true, []]);
  const used = inEffect(s);
  assert.deepEqual(used.employees.map((e) => e.id), OWNER.employees.map((e) => e.id), 'every one of its employees');
  assert.deepEqual([used.releasesCastellan, used.stewardRepo, used.releasesRepo], [true, 'Jcollier0120/Steward', 'Jcollier0120/Manor-releases']);
  assert.deepEqual(releasesRepoEnv(used), { MANOR_RELEASES_REPO: 'Jcollier0120/Manor-releases' });
  assert.deepEqual((SETTINGS_SPEC.check!(used, ['employees'], {}) as { errors: object }).errors, {});
  assert.equal(DEFAULT_SETTINGS.employees.length, 0, 'nobody built in, here or anywhere');
});

test("the maker-only commands, and the developer's, answer in a sentence on a customer's PC", () => {
  const cli = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (...args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, STEWARD_CUSTOMER: '1' } }) };
    } catch (e: any) {
      return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
    }
  };
  for (const [args, what] of [[['ports'], "The ports of Castellan's agents"], [['claim-port', 'crier'], "Claiming a port for a new agent of Castellan's"], [['release-port', 'crier'], 'Giving back a port'], [['mine', 'porter', '#1'], 'Marking Castellan'], [['claim-version', 'kit'], "Claiming a version of Castellan's kit"]] as const) {
    const r = run(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.out, new RegExp(`${what}.* is for the people who make Castellan, on their own PC`), args.join(' '));
  }
  developerOptions(false);
  try {
    for (const args of [['claims'], ['claim-version', 'app'], ['round']]) {
      const r = run(...args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.out, /The Steward is for people who write software/, args.join(' '));
    }
  } finally {
    developerOptions(true);
  }
});
