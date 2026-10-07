import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// One release PC per repository, elected through refs/manor/release-pc in the repository's own remote (lease.ts), and
// version claims shared through refs/manor/claims (claims.ts): against real bare repositories, with real git.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-turns-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const L = await import('../src/lease.ts');
const R = await import('../src/remote-ref.ts');
const C = await import('../src/claims.ts');
const { runStage } = await import('../src/steward.ts');
const { run: realRun } = await import('../src/run.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type Settings = import('../src/settings.ts').Settings;
type RemoteRepo = import('../src/remote-ref.ts').RemoteRepo;
type Employee = import('../src/settings.ts').Employee;
type TurnRecord = import('../src/lease.ts').TurnRecord;

const A = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'LAPTOP' };
const B = { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'DESKTOP-ABC' };
const T0 = Date.parse('2026-10-08T12:00:00Z');
const MIN = 60_000;
const scratch = path.join(home, 'scratch.git');
const settings = { roundMinutes: 10, workRoot: path.join(home, 'work') } as Settings;
const TTL = 30 * MIN;

let n = 0;
/** A bare repository standing in for a remote, and the RemoteRepo for it; `refuse`: a host that refuses refs/manor/*. */
function remote(o: { refuse?: boolean } = {}): RemoteRepo {
  const dir = path.join(home, `remote-${++n}.git`);
  sh(home, 'init', '--quiet', '--bare', dir);
  if (o.refuse) writeFileSync(path.join(dir, 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read o n r; do case "$r" in refs/manor/*) echo "custom refs are not allowed here" >&2; exit 1;; esac; done\nexit 0\n', { mode: 0o755 });
  return { key: `o/r${n}`, url: dir, scratch };
}
const gone = (): RemoteRepo => ({ key: 'o/gone', url: path.join(home, 'no-such-remote.git'), scratch });

/** Another PC writes the turn record, over whatever is there. */
async function write(r: RemoteRepo, rec: Partial<TurnRecord> & { pc: string }) {
  const read = await R.readRef(realRun, r, L.RELEASE_PC_REF, L.RELEASE_PC_FILE);
  const full = { name: rec.pc === B.id ? B.name : A.name, until: new Date(T0 + TTL).toISOString(), since: new Date(T0).toISOString(), pinned: false, ...rec };
  const w = await R.writeRef(realRun, r, L.RELEASE_PC_REF, L.RELEASE_PC_FILE, JSON.stringify(full), read.kind === 'found' ? read.sha : null, 'test');
  assert.equal(w.kind, 'ok');
  return full;
}
async function recordOf(r: RemoteRepo) {
  const read = await R.readRef(realRun, r, L.RELEASE_PC_REF, L.RELEASE_PC_FILE);
  return read.kind === 'found' ? L.readRecord(read.text) : null;
}
async function shaOf(r: RemoteRepo, ref: string) {
  const ls = await R.lsRemote(realRun, r, [ref]);
  return ls.ok ? (ls.refs[ref] ?? null) : null;
}

/** An employee whose remote is `r` (no checkout here unless given). */
const emp = (id: string, r: RemoteRepo, more: Partial<Employee> = {}) => employee(more.checkout ?? path.join(home, 'nowhere', id), { id, name: id[0].toUpperCase() + id.slice(1), repo: r.key, ...more });
const deps = (remotes: Record<string, RemoteRepo>, now = T0, device = A) => ({ device, now: () => now, remote: async (e: Employee) => remotes[e.id] ?? null });

test('decide: free or run out is taken; its own renewed at half its time; a pin waits a day; a checkout beats none', () => {
  const me = { pc: A.id, checkout: true };
  const rec = (o: Partial<TurnRecord>): TurnRecord => ({ pc: B.id, name: B.name, until: new Date(T0 + 10 * MIN).toISOString(), since: new Date(T0).toISOString(), pinned: false, ...o });
  assert.equal(L.decide(null, me, T0, TTL), 'take');
  assert.equal(L.decide(rec({}), me, T0, TTL), 'elsewhere');
  assert.equal(L.decide(rec({ until: new Date(T0 - MIN).toISOString() }), me, T0, TTL), 'elsewhere', "within the clocks' margin");
  assert.equal(L.decide(rec({ until: new Date(T0 - 3 * MIN).toISOString() }), me, T0, TTL), 'take');
  assert.equal(L.decide(rec({ pc: A.id, until: new Date(T0 + 20 * MIN).toISOString() }), me, T0, TTL), 'keep');
  assert.equal(L.decide(rec({ pc: A.id, until: new Date(T0 + 10 * MIN).toISOString() }), me, T0, TTL), 'renew');
  assert.equal(L.decide(rec({ pinned: true, until: new Date(T0 - 23 * 60 * MIN).toISOString() }), me, T0, TTL), 'elsewhere');
  assert.equal(L.decide(rec({ pinned: true, until: new Date(T0 - 25 * 60 * MIN).toISOString() }), me, T0, TTL), 'take');
  assert.equal(L.decide(rec({ checkout: false }), me, T0, TTL), 'take');
  assert.equal(L.decide(rec({ checkout: false }), { pc: A.id, checkout: false }, T0, TTL), 'elsewhere');
});

test("with no turns (the tests' default), every repository is this PC's, and nothing is written", async () => {
  const r = remote();
  const t = await L.takeTurns([emp('clerk', r)], { run: realRun, settings, deps: null });
  assert.deepEqual([t.acting.map((e) => e.id), t.elsewhere, t.guard], [['clerk'], [], null]);
  assert.equal(await shaOf(r, L.RELEASE_PC_REF), null);
});

test('no ref anywhere: the first look takes the turn, and every repository acts as before', async () => {
  rmSync(L.turnsFile(), { force: true });
  const r1 = remote();
  const r2 = remote();
  const t = await L.takeTurns([emp('clerk', r1), emp('porter', r2)], { run: realRun, settings, deps: deps({ clerk: r1, porter: r2 }) });
  assert.deepEqual(t.acting.map((e) => e.id), ['clerk', 'porter']);
  assert.deepEqual(t.elsewhere, []);
  assert.deepEqual({ ...(await recordOf(r1)) }, { pc: A.id, name: 'LAPTOP', until: new Date(T0 + TTL).toISOString(), since: new Date(T0).toISOString(), pinned: false, checkout: false });
  assert.equal(await t.guard!.ok(emp('clerk', r1)), true);
  assert.deepEqual(L.turnsView([emp('clerk', r1)], T0)?.rows.map((x) => [x.name, x.holder, x.pinned]), [['Clerk', 'this PC', false]]);
});

test("another PC's turn is left to it, said with its name; run out, it is taken", async () => {
  const r = remote();
  await write(r, { pc: B.id });
  const clerk = emp('clerk', r);
  let t = await L.takeTurns([clerk], { run: realRun, settings, deps: deps({ clerk: r }) });
  assert.deepEqual(t.acting, []);
  assert.deepEqual(t.elsewhere.map((x) => x.message), ['merging and releasing for Clerk: done by DESKTOP-ABC']);
  assert.equal(await t.guard!.ok(clerk), false);
  assert.deepEqual(L.turnsView([clerk], T0)?.rows.map((x) => [x.status, x.holder]), [['elsewhere', 'DESKTOP-ABC']]);
  t = await L.takeTurns([clerk], { run: realRun, settings, deps: deps({ clerk: r }, T0 + TTL + 3 * MIN) });
  assert.deepEqual(t.acting.map((e) => e.id), ['clerk']);
  assert.equal((await recordOf(r))?.pc, A.id);
});

test('a pin: never taken while renewed; gone quiet, said on the page; after a day, taken (and no longer pinned)', async () => {
  const r = remote();
  await write(r, { pc: B.id, pinned: true });
  const clerk = emp('clerk', r);
  let t = await L.takeTurns([clerk], { run: realRun, settings, deps: deps({ clerk: r }, T0 + 2 * 60 * MIN) });
  assert.deepEqual(t.acting, []);
  const row = L.turnsView([clerk], T0 + 2 * 60 * MIN)!.rows[0];
  assert.deepEqual([row.pinned, row.quiet], [true, true]);
  t = await L.takeTurns([clerk], { run: realRun, settings, deps: deps({ clerk: r }, T0 + 25 * 60 * MIN) });
  assert.deepEqual(t.acting.map((e) => e.id), ['clerk']);
  const now = await recordOf(r);
  assert.deepEqual([now?.pc, now?.pinned], [A.id, false]);
});

test('a PC with a checkout takes the turn from one without', async () => {
  const f = fakeEmployee(path.join(home, 'with-checkout'));
  const r: RemoteRepo = { key: 'o/withco', url: f.origin, scratch };
  await write(r, { pc: B.id, checkout: false });
  const e = emp('clerk', r, { checkout: f.checkout });
  const t = await L.takeTurns([e], { run: realRun, settings, deps: deps({ clerk: r }) });
  assert.deepEqual(t.acting.map((x) => x.id), ['clerk']);
  assert.equal((await recordOf(r))?.checkout, true);
});

test('before each publishing act: still its own goes on; renewed near its end; taken by another PC meanwhile, it stops', async () => {
  rmSync(L.turnsFile(), { force: true });
  const r = remote();
  const clerk = emp('clerk', r);
  let now = T0;
  const t = await L.takeTurns([clerk], { run: realRun, settings, deps: { device: A, now: () => now, remote: async () => r } });
  const first = await shaOf(r, L.RELEASE_PC_REF);
  assert.equal(await t.guard!.ok(clerk), true);
  assert.equal(await shaOf(r, L.RELEASE_PC_REF), first, 'nothing written while far from its end');
  now = T0 + TTL - MIN;
  assert.equal(await t.guard!.ok(clerk), true, 'renewed');
  assert.notEqual(await shaOf(r, L.RELEASE_PC_REF), first);
  assert.equal((await recordOf(r))?.until, new Date(now + TTL).toISOString());
  // Do it here, on the other PC.
  await write(r, { pc: B.id, until: new Date(now + TTL).toISOString() });
  assert.equal(await t.guard!.ok(clerk), false);
  assert.ok(t.guard!.skip.has('clerk'));
});

test("a remote out of reach: it acts as before (it can't publish there anyway), and the page says releasing waits", async () => {
  const e = emp('clerk', gone());
  const t = await L.takeTurns([e], { run: realRun, settings, deps: deps({ clerk: gone() }) });
  assert.deepEqual(t.acting.map((x) => x.id), ['clerk']);
  assert.equal(await t.guard!.ok(e), true);
  const row = L.turnsView([e])!.rows[0];
  assert.deepEqual([row.status, row.note], ['unreachable', 'releasing Clerk waits until this PC can reach its remote']);
});

test('a host that refuses the ref: this PC works alone there, and says so on the page', async () => {
  const r = remote({ refuse: true });
  const e = emp('clerk', r);
  const t = await L.takeTurns([e], { run: realRun, settings, deps: deps({ clerk: r }) });
  assert.deepEqual(t.acting.map((x) => x.id), ['clerk']);
  assert.equal(await t.guard!.ok(e), true);
  const row = L.turnsView([e])!.rows[0];
  assert.equal(row.status, 'alone');
  assert.match(row.note ?? '', /^Clerk's remote doesn't take the Steward's turn ref \(.+\), so this PC works alone there$/);
});

test('compare-and-swap: of two PCs writing over the same commit, one wins and the other is told it lost', async () => {
  const r = remote();
  const w1 = await R.writeRef(realRun, r, 'refs/manor/x', 'x.json', '1', null, 'one');
  const w2 = await R.writeRef(realRun, r, 'refs/manor/x', 'x.json', '2', null, 'two');
  assert.deepEqual([w1.kind, w2.kind], ['ok', 'stale']);
  assert.equal(((await R.readRef(realRun, r, 'refs/manor/x', 'x.json')) as { text: string }).text, '1');
});

test('Do it here, Keep it on this PC and Unpin write the turn to this PC', async () => {
  const r = remote();
  await write(r, { pc: B.id });
  const e = emp('clerk', r);
  const d = deps({ clerk: r });
  assert.deepEqual(await L.handOver(e, { run: realRun, settings, deps: d }), { ok: true, message: 'This PC merges and releases Clerk now from DESKTOP-ABC.' });
  let rec = await recordOf(r);
  assert.deepEqual([rec?.pc, rec?.pinned], [A.id, false]);
  assert.equal((await L.handOver(e, { run: realRun, settings, deps: d, pin: true })).ok, true);
  assert.equal((await recordOf(r))?.pinned, true);
  assert.equal(L.turnsView([e])!.rows[0].pinned, true);
  assert.equal((await L.handOver(e, { run: realRun, settings, deps: d, pin: false })).ok, true);
  rec = await recordOf(r);
  assert.equal(rec?.pinned, false);
  assert.equal((await L.handOver(emp('gone', gone()), { run: realRun, settings, deps: deps({ gone: gone() }) })).ok, false);
});

// ---- Whole rounds on a fake employee ----

function roundSetup(name: string) {
  const f = fakeEmployee(path.join(home, name), { version: '0.4.0' });
  writeFileSync(
    path.join(home, 'settings.json'),
    JSON.stringify({
      employees: [{ id: 'fake', name: 'Fake', repo: 'Jcollier0120/Fake', checkout: f.checkout, branch: 'main', usesKit: true, parts: ['node'], fill: '', test: ['node -e process.exit(0)'], versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'], release: '', install: '', approve: '' }],
      team: ['Jcollier0120'],
      workRoot: path.join(home, 'work'),
    }),
  );
  sh(f.checkout, 'switch', '--quiet', '-c', 'fix/thing');
  writeFileSync(path.join(f.checkout, 'README.md'), 'a fix\n');
  sh(f.checkout, 'add', '-A');
  sh(f.checkout, 'commit', '--quiet', '-m', 'a fix');
  const sha = sh(f.checkout, 'rev-parse', 'HEAD');
  sh(f.checkout, 'push', '--quiet', 'origin', `${sha}:refs/pull/7/head`);
  sh(f.checkout, 'switch', '--quiet', 'main');
  const r = runner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return ok(args.includes('Jcollier0120/Fake') ? [{ number: 7, title: 'a fix', url: 'https://github.com/Jcollier0120/Fake/pull/7', headRefName: 'fix/thing', headRefOid: sha, baseRefName: 'main', isCrossRepository: false, author: { login: 'Jcollier0120' }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [], body: '' }] : []);
    if (args[0] === 'pr' && args[1] === 'merge') return ok('');
    if (args[0] === 'release' && args[1] === 'list') return ok([{ tagName: 'v0.4.0', isDraft: false }]);
  });
  const remoteRepo: RemoteRepo = { key: 'jcollier0120/fake', url: f.origin, scratch };
  return { f, r, sha, remoteRepo, merges: () => r.gh.filter((a) => a[1] === 'merge') };
}
const MERGE7 = ['pr', 'merge', '7', '--repo', 'Jcollier0120/Fake', '--merge'];

test("a round with no ref anywhere merges exactly as before, and takes the turn; another PC's turn, it publishes nothing", async () => {
  rmSync(L.turnsFile(), { force: true });
  const s = roundSetup('round-fresh');
  const d = { device: A, now: () => T0, remote: async () => s.remoteRepo };
  const first = await runStage('round', { full: true }, { run: s.r.run, turns: d });
  assert.equal(first.error, undefined);
  assert.deepEqual(s.merges(), [MERGE7], 'merged as before');
  assert.equal((await recordOf(s.remoteRepo))?.pc, A.id, "and the turn is this PC's now");
  // The desktop presses Do it here: this PC's next round publishes nothing there.
  await write(s.remoteRepo, { pc: B.id, until: new Date(T0 + TTL).toISOString() });
  const second = await runStage('round', { full: true }, { run: s.r.run, turns: d });
  assert.deepEqual(s.merges(), [MERGE7], 'nothing more merged');
  assert.ok(second.results.some((y) => y.id === 'fake' && y.message === 'merging and releasing for Fake: done by DESKTOP-ABC'), JSON.stringify(second.results));
});

test('offline (the remote out of reach), a round still builds and tests: nothing local waits for a turn', async () => {
  rmSync(L.turnsFile(), { force: true });
  const s = roundSetup('round-offline');
  const out = await runStage('round', { full: true }, { run: s.r.run, turns: { device: A, now: () => T0, remote: async () => gone() } });
  assert.equal(out.error, undefined);
  // The team PR GitHub runs no checks on was built and tested here, at its head, as always.
  assert.ok(out.log.some((l) => l.includes(`#7 has no checks on GitHub: testing it here at ${s.sha.slice(0, 7)}`)), out.log.join('\n'));
  assert.ok(out.results.some((y) => y.id === 'fake' && /checks passed here/.test(y.message)), JSON.stringify(out.results));
  assert.ok(out.log.some((l) => l.includes('releasing Fake waits until this PC can reach its remote')));
});

// ---- Version claims through refs/manor/claims ----

function claimSetup(name: string) {
  const d = path.join(home, name);
  const { checkout, origin } = fakeEmployee(d, { version: '0.4.10' });
  const r = runner((a) => {
    if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.10', isDraft: false, publishedAt: '2026-10-05T00:00:00Z' }]);
    if (a[0] === 'pr' && a[1] === 'list') return ok([{ title: 'Fake 0.4.11: open', headRefName: 'claude/open' }]);
  });
  const e = employee(checkout);
  const remoteRepo: RemoteRepo = { key: 'jcollier0120/fake', url: origin, scratch };
  return { e, remoteRepo, ctx: ctxFor({ employees: [e], workRoot: path.join(d, 'work'), run: r.run, neutralDir: d }) };
}
async function sharedClaims(r: RemoteRepo) {
  const read = await R.readRef(realRun, r, C.CLAIMS_REF, C.CLAIMS_FILE);
  return read.kind === 'found' ? C.parseClaims(read.text) : [];
}

test("claims through the claims ref: shared by every PC, the same branch again, above another PC's", async () => {
  rmSync(C.claimsFile(), { force: true });
  const s = claimSetup('claims-shared');
  // One claimed here alone earlier (the remote out of reach then): it goes up with the next claim.
  writeFileSync(C.claimsFile(), JSON.stringify([{ repo: 'Jcollier0120/Fake', version: '0.4.12', branch: 'claude/old', by: 'claude', for: 'old', at: new Date().toISOString() }]));
  const a = await C.claimVersion(s.ctx, s.e, { branch: 'claude/a', by: 'claude', for: 'a fix', remote: s.remoteRepo });
  assert.deepEqual([a.claim.version, a.again, a.claim.source], ['0.4.13', false, 'shared']);
  assert.deepEqual((await sharedClaims(s.remoteRepo)).map((c) => [c.version, c.branch]), [['0.4.12', 'claude/old'], ['0.4.13', 'claude/a']]);
  // Another PC claims 0.4.14 meanwhile.
  const read = (await R.readRef(realRun, s.remoteRepo, C.CLAIMS_REF, C.CLAIMS_FILE)) as { sha: string; text: string };
  await R.writeRef(realRun, s.remoteRepo, C.CLAIMS_REF, C.CLAIMS_FILE, JSON.stringify([...JSON.parse(read.text), { repo: 'Jcollier0120/Fake', version: '0.4.14', branch: 'claude/desk', by: 'claude', for: 'on the desktop', at: new Date().toISOString() }]), read.sha, 'desk');
  assert.equal((await C.claimVersion(s.ctx, s.e, { branch: 'claude/b', by: 'claude', for: 'b', remote: s.remoteRepo })).claim.version, '0.4.15');
  assert.equal((await C.claimVersion(s.ctx, s.e, { branch: 'claude/a', by: 'claude', for: 'a', remote: s.remoteRepo })).again, true);
  assert.deepEqual(C.loadClaims().map((c) => [c.version, c.source]).sort(), [['0.4.12', 'shared'], ['0.4.13', 'shared'], ['0.4.14', 'shared'], ['0.4.15', 'shared']]);
  // Given back there too.
  assert.equal(await C.releaseClaim('Jcollier0120/Fake', '0.4.15', { remote: s.remoteRepo, run: realRun }), true);
  assert.ok(!(await sharedClaims(s.remoteRepo)).some((c) => c.version === '0.4.15'));
});

test('claimers at the same moment through the ref each get a version of their own', async () => {
  rmSync(C.claimsFile(), { force: true });
  const s = claimSetup('claims-together');
  const got = await Promise.all(Array.from({ length: 4 }, (_, i) => C.claimVersion(s.ctx, s.e, { branch: `claude/w${i}`, by: 'claude', for: `worker ${i}`, remote: s.remoteRepo })));
  assert.deepEqual(got.map((g) => g.claim.version).sort(), ['0.4.12', '0.4.13', '0.4.14', '0.4.15']);
  assert.equal((await sharedClaims(s.remoteRepo)).length, 4);
});

test('the claims ref out of reach: claimed here as before; shared on the next reach; a clash is marked for the page', async () => {
  rmSync(C.claimsFile(), { force: true });
  const s = claimSetup('claims-offline');
  const a = await C.claimVersion(s.ctx, s.e, { branch: 'claude/offline', by: 'claude', for: 'offline work', remote: gone() });
  assert.deepEqual([a.claim.version, a.claim.source], ['0.4.12', undefined]);
  const b = await C.claimVersion(s.ctx, s.e, { branch: 'claude/second', by: 'claude', for: 'more', remote: gone() });
  assert.equal(b.claim.version, '0.4.13');
  // Meanwhile another PC, which could reach the remote, claimed 0.4.13 for its own work.
  await R.writeRef(realRun, s.remoteRepo, C.CLAIMS_REF, C.CLAIMS_FILE, JSON.stringify([{ repo: 'Jcollier0120/Fake', version: '0.4.13', branch: 'claude/desk', by: 'claude', for: "the desktop's fix", at: new Date().toISOString() }]), null, 'desk');
  const rows = [{ repo: 'Jcollier0120/Fake', name: 'Fake', main: { version: '0.4.10' }, release: { version: '0.4.10' }, prs: [] }];
  await C.shareClaims(realRun, rows, [{ repo: 'Jcollier0120/Fake', remote: s.remoteRepo, sha: await shaOf(s.remoteRepo, C.CLAIMS_REF) }]);
  assert.deepEqual((await sharedClaims(s.remoteRepo)).map((c) => [c.version, c.branch]), [['0.4.13', 'claude/desk'], ['0.4.12', 'claude/offline']], "this PC's free one went up");
  assert.deepEqual(C.claimClashes(), ["Jcollier0120/Fake 0.4.13 was claimed on another PC too (for the desktop's fix) while this PC couldn't reach the remote: claude/second gets a new version when it merges"]);
  // The merge stage sees the desktop's claim, so a PR from claude/second that sets 0.4.13 is held and caught up.
  assert.ok(C.claimsOn('Jcollier0120/Fake').some((c) => c.version === '0.4.13' && c.branch === 'claude/desk'));
});

test('a throwaway ref against a real remote, when STEWARD_REAL_REMOTE names one', { skip: !process.env.STEWARD_REAL_REMOTE }, async () => {
  const r: RemoteRepo = { key: 'real', url: process.env.STEWARD_REAL_REMOTE!, scratch };
  const ref = `refs/manor/test-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const w = await R.writeRef(realRun, r, ref, 'test.json', '{"hello":1}\n', null, 'a throwaway test ref');
    assert.equal(w.kind, 'ok', JSON.stringify(w));
    assert.equal((await R.writeRef(realRun, r, ref, 'test.json', '{}', null, 'again')).kind, 'stale');
    assert.equal(((await R.readRef(realRun, r, ref, 'test.json')) as { text: string }).text, '{"hello":1}\n');
  } finally {
    assert.equal(await R.deleteRef(realRun, r, ref), true);
  }
  assert.equal((await R.readRef(realRun, r, ref, 'test.json')).kind, 'absent');
});
