import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Turns with the licence's other PCs (lease.ts): a repository another PC holds is left to it; no licence, or an
// Exchequer that doesn't coordinate (404), is exactly as before; out of reach, only a turn already held is used. And
// version claims through the Exchequer, with the Steward's own store as the fallback.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-lease-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { takeTurns, handOver, turnsView, loadLeases, leasesFile, licenceToken, coordHere, ttlFor, SCOPE } = await import('../src/lease.ts');
const { claimVersion, claimsFile, loadClaims, pruneClaims, releaseClaim, syncClaims } = await import('../src/claims.ts');
const { runStage } = await import('../src/steward.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');

type Lease = { device: string; name: string; until: number; since: number };

/** The Exchequer, stood in for: leases and claims of one licence, this PC being `me`. */
function exchequer(o: { mode?: 'on' | '404' | '401' | 'down' | 'no-leases' } = {}) {
  let clock = Date.parse('2026-10-08T12:00:00Z');
  const leases = new Map<string, Lease>();
  const claims: any[] = [];
  const calls: { method: string; route: string; body: any }[] = [];
  const x = {
    mode: o.mode ?? 'on',
    leases,
    claims,
    calls,
    get now() {
      return clock;
    },
    advance(ms: number) {
      clock += ms;
    },
    holdElsewhere(repo: string, name = 'DESKTOP-ABC', minutes = 30) {
      leases.set(repo.toLowerCase(), { device: 'other', name, until: clock + minutes * 60_000, since: clock });
    },
    coord: null as any,
  };
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const take = (resource: string, ttl: number, force = false) => {
    const l = leases.get(resource);
    if (!force && l && l.device !== 'me' && l.until > clock) return { resource, held: false, until: new Date(l.until).toISOString(), holder: { deviceId: l.device, name: l.name } };
    const since = l && l.device === 'me' && l.until > clock ? l.since : clock;
    leases.set(resource, { device: 'me', name: 'LAPTOP', until: clock + ttl * 1000, since });
    return { resource, held: true, until: new Date(clock + ttl * 1000).toISOString(), since: new Date(since).toISOString(), from: l && l.device !== 'me' && l.until > clock ? { deviceId: l.device, name: l.name } : null };
  };
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const route = new URL(url).pathname.replace('/api/v1', '');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: String(init.method), route, body });
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer token-for-tests');
    if (x.mode === 'down') throw new TypeError('fetch failed');
    if (x.mode === 'no-leases') return answer(200, { ok: true });
    if (x.mode === '404') return answer(404, { error: 'not-available', message: '…' });
    if (x.mode === '401') return answer(401, { error: 'unauthorized', message: '…' });
    if (init.method === 'POST' && route === '/lease') {
      if (Array.isArray(body.resources)) return answer(200, { leases: body.resources.map((r: string) => { const { from: _f, ...a } = take(r, body.ttlSeconds) as any; return a; }) });
      const { resource: _r, from: _f, ...one } = take(body.resource, body.ttlSeconds) as any;
      return answer(200, one);
    }
    if (init.method === 'POST' && route === '/lease/handover') {
      const { resource: _r, ...one } = take(body.resource, body.ttlSeconds, true) as any;
      return answer(200, one);
    }
    if (init.method === 'GET' && route === '/claims') return answer(200, { claims });
    if (init.method === 'POST' && route === '/claims') {
      const had = claims.find((c) => c.repo.toLowerCase() === body.repo.toLowerCase() && body.branch && c.branch === body.branch);
      if (had) return answer(200, { claim: had, again: true });
      const all = [body.branchVersion, ...body.released, ...body.openVersions, ...body.taken, ...claims.filter((c) => c.repo.toLowerCase() === body.repo.toLowerCase()).map((c) => c.version)].filter(Boolean);
      if (!all.length) return answer(409, { error: 'no-version', message: '…' });
      const top = all.map((v: string) => v.split('.').map(Number)).sort((a: number[], b: number[]) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
      const claim = { repo: body.repo, version: body.minor ? `${top[0]}.${top[1] + 1}.0` : `${top[0]}.${top[1]}.${top[2] + 1}`, branch: body.branch, by: body.by, for: body.for, at: new Date(clock).toISOString() };
      claims.push(claim);
      return answer(200, { claim, again: false });
    }
    if (init.method === 'DELETE' && route === '/claims') {
      const i = claims.findIndex((c) => c.repo.toLowerCase() === body.repo.toLowerCase() && c.version === body.version);
      if (i >= 0) claims.splice(i, 1);
      return answer(200, { released: i >= 0 });
    }
    return answer(404, { error: 'not-found' });
  }) as unknown as typeof fetch;
  x.coord = { base: 'https://exchequer.test', token: 'token-for-tests', fetch: fakeFetch, now: () => clock };
  return x;
}

const settings = { roundMinutes: 10 };
const dir = path.join(home, 'repos');
mkdirSync(dir, { recursive: true });
const clerk = employee(path.join(dir, 'clerk'), { id: 'clerk', name: 'Clerk', repo: 'Jcollier0120/Clerk' });
const porter = employee(path.join(dir, 'porter'), { id: 'porter', name: 'Porter', repo: 'Jcollier0120/Porter' });
const away = employee(path.join(dir, 'not-cloned-here'), { id: 'away', name: 'Away', repo: 'Jcollier0120/Away' });
mkdirSync(clerk.checkout, { recursive: true });
mkdirSync(porter.checkout, { recursive: true });

test('with no licence, every repository is this PC\'s, as before', async () => {
  const t = await takeTurns([clerk, porter, away], { coord: null, settings });
  assert.deepEqual(t.acting.map((e) => e.id), ['clerk', 'porter', 'away']);
  assert.equal(t.guard, null);
  assert.equal(t.mode, 'off');
  // No licence.json, and never the real Exchequer under node --test.
  assert.equal(licenceToken(path.join(home, 'no-manor')), null);
  assert.equal(coordHere(), null);
});

test('a licence.json gives the token Manor keeps', () => {
  const manor = path.join(home, 'manor');
  mkdirSync(manor, { recursive: true });
  writeFileSync(path.join(manor, 'licence.json'), '﻿{ "token": "abc", "licence": "x.y.z" }');
  assert.equal(licenceToken(manor), 'abc');
  writeFileSync(path.join(manor, 'licence.json'), 'not json');
  assert.equal(licenceToken(manor), null);
});

test('takes each repository with a checkout here in one call, and leaves the one another PC holds to it', async () => {
  const x = exchequer();
  x.holdElsewhere('jcollier0120/porter');
  const t = await takeTurns([clerk, porter, away], { coord: x.coord, settings });
  assert.deepEqual(x.calls, [{ method: 'POST', route: '/lease', body: { scope: SCOPE, resources: ['jcollier0120/clerk', 'jcollier0120/porter'], ttlSeconds: 1800 } }]);
  assert.deepEqual(t.acting.map((e) => e.id), ['clerk']);
  assert.deepEqual(t.elsewhere.map((r) => [r.id, r.outcome, r.message]), [
    ['porter', 'skipped', 'merging and releasing for Porter: done by DESKTOP-ABC'],
    ['away', 'skipped', 'no checkout of Away on this PC, so a PC with one merges and releases it'],
  ]);
  assert.equal(t.mode, 'on');
  assert.deepEqual([...t.guard!.skip].sort(), ['away', 'porter']);
  // The page's view: Porter, done by the desktop.
  assert.deepEqual(turnsView([clerk, porter, away], x.now)?.elsewhere.map((e) => [e.name, e.holder]), [['Porter', 'DESKTOP-ABC']]);
  assert.equal(turnsView([clerk, porter, away], x.now)?.here, 1);
});

test('a lease lasts three rounds, never less than 15 minutes', () => {
  assert.equal(ttlFor({ roundMinutes: 10 }), 1800);
  assert.equal(ttlFor({ roundMinutes: 1 }), 900);
});

test('an Exchequer that does not coordinate (404), or no longer knows this PC (401), is no turns at all', async () => {
  for (const mode of ['404', '401'] as const) {
    const x = exchequer({ mode });
    const t = await takeTurns([clerk, porter, away], { coord: x.coord, settings });
    assert.deepEqual(t.acting.map((e) => e.id), ['clerk', 'porter', 'away'], mode);
    assert.equal(t.guard, null);
    assert.equal(turnsView([clerk, porter]), null, 'nothing on the page');
  }
});

test('out of reach: a turn already held is used until it nearly runs out; none is taken', async () => {
  rmSync(leasesFile(), { force: true });
  const x = exchequer();
  await takeTurns([clerk], { coord: x.coord, settings });
  x.mode = 'down';
  x.advance(10 * 60_000);
  let t = await takeTurns([clerk, porter], { coord: x.coord, settings });
  assert.deepEqual(t.acting.map((e) => e.id), ['clerk'], 'Clerk was held: kept');
  assert.match(t.elsewhere[0].message, /^merging and releasing for Porter waits: the Exchequer didn't answer/);
  assert.equal(loadLeases().mode, 'unreachable');
  assert.equal(turnsView([clerk, porter], x.now)?.mode, 'unreachable');
  // Within two minutes of its end, it is no longer trusted.
  x.advance(19 * 60_000);
  t = await takeTurns([clerk, porter], { coord: x.coord, settings });
  assert.deepEqual(t.acting, []);
  // Still out of reach a round later: still waiting, never back to acting alone while another PC may hold the turns.
  x.advance(10 * 60_000);
  t = await takeTurns([clerk, porter], { coord: x.coord, settings });
  assert.deepEqual([t.acting, t.mode], [[], 'unreachable']);
  // Back: turns as before.
  x.mode = 'on';
  t = await takeTurns([clerk, porter], { coord: x.coord, settings });
  assert.deepEqual(t.acting.map((e) => e.id), ['clerk', 'porter']);
});

test('out of reach on a PC that never took turns, or an answer with no leases: no turns, every repository acts as before', async () => {
  for (const mode of ['down', 'no-leases'] as const) {
    rmSync(leasesFile(), { force: true });
    const x = exchequer({ mode });
    const t = await takeTurns([clerk, porter, away], { coord: x.coord, settings });
    assert.deepEqual([t.acting.map((e) => e.id), t.elsewhere, t.guard, t.mode], [['clerk', 'porter', 'away'], [], null, 'off'], mode);
    assert.equal(turnsView([clerk, porter]), null, 'nothing on the page');
    // And again the next round: still alone.
    assert.equal((await takeTurns([clerk], { coord: x.coord, settings })).mode, 'off');
  }
  // After a 404 too: turns had never been on.
  rmSync(leasesFile(), { force: true });
  const x = exchequer({ mode: '404' });
  await takeTurns([clerk], { coord: x.coord, settings });
  x.mode = 'down';
  assert.equal((await takeTurns([clerk], { coord: x.coord, settings })).mode, 'off');
});

test('before each merge or release the turn is checked: renewed near its end, or found taken', async () => {
  rmSync(leasesFile(), { force: true });
  const x = exchequer();
  const t = await takeTurns([clerk], { coord: x.coord, settings });
  const calls = () => x.calls.length;
  const before = calls();
  assert.equal(await t.guard!.ok(clerk), true);
  assert.equal(calls(), before, 'far from its end: nothing asked');
  x.advance(27 * 60_000);
  assert.equal(await t.guard!.ok(clerk), true);
  assert.equal(calls(), before + 1, 'near its end: renewed');
  // Another PC pressed Do it here meanwhile.
  x.leases.set('jcollier0120/clerk', { device: 'other', name: 'DESKTOP-ABC', until: x.now + 30 * 60_000, since: x.now });
  x.advance(28 * 60_000);
  assert.equal(await t.guard!.ok(clerk), false);
  assert.ok(t.guard!.skip.has('clerk'));
  assert.equal(await t.guard!.ok(porter), false, 'never one it was not given');
});

test('"Do it here" takes the turn now, from whichever PC had it', async () => {
  const x = exchequer();
  x.holdElsewhere('jcollier0120/porter');
  await takeTurns([porter], { coord: x.coord, settings });
  const r = await handOver('Jcollier0120/Porter', { coord: x.coord, settings });
  assert.deepEqual(r, { ok: true, message: 'This PC merges and releases Jcollier0120/Porter now from DESKTOP-ABC.' });
  assert.equal(loadLeases().leases['jcollier0120/porter'].held, true);
  assert.deepEqual(turnsView([porter], x.now)?.elsewhere, []);
  assert.equal((await handOver('Jcollier0120/Porter', { coord: null, settings })).ok, false);
});

// ---- A round on a fake employee: left alone while another PC holds it; merged once there are no turns ----

test('a round leaves a repository another PC holds alone, and merges as before when the Exchequer does not coordinate', async () => {
  const f = fakeEmployee(path.join(home, 'fake'), { version: '0.4.0' });
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
  const merges = () => r.gh.filter((a) => a[1] === 'merge');
  const MERGE7 = ['pr', 'merge', '7', '--repo', 'Jcollier0120/Fake', '--merge'];
  // The Exchequer out of reach on a PC that has never taken turns: the round merges as it always did.
  rmSync(leasesFile(), { force: true });
  const down = exchequer({ mode: 'down' });
  const blind = await runStage('round', { full: true }, { run: r.run, coord: down.coord });
  assert.equal(blind.error, undefined);
  assert.deepEqual(merges(), [MERGE7], 'merged as before');
  assert.ok(blind.results.some((y) => y.id === 'fake' && y.outcome === 'done'), JSON.stringify(blind.results));
  // (#7 stays open in this stand-in, so the rounds below can merge it again.)
  const x = exchequer();
  x.holdElsewhere('jcollier0120/fake');
  const held = await runStage('round', { full: true }, { run: r.run, coord: x.coord });
  assert.equal(held.error, undefined);
  assert.deepEqual(merges(), [MERGE7], 'nothing more merged where another PC has its turn');
  assert.ok(held.results.some((y) => y.id === 'fake' && y.message === 'merging and releasing for Fake: done by DESKTOP-ABC'), JSON.stringify(held.results));
  // Turns were on: out of reach now, and this PC never held Fake's turn, so it waits rather than merge beside the desktop.
  x.mode = 'down';
  const waiting = await runStage('round', { full: true }, { run: r.run, coord: x.coord });
  assert.deepEqual(merges(), [MERGE7], 'nothing merged while it cannot tell whose turn it is');
  assert.ok(waiting.results.some((y) => y.id === 'fake' && y.outcome === 'skipped' && /^merging and releasing for Fake: done by DESKTOP-ABC/.test(y.message)), JSON.stringify(waiting.results));
  // The Exchequer doesn't coordinate (404): the round is as it always was.
  x.mode = '404';
  const alone = await runStage('round', { full: true }, { run: r.run, coord: x.coord });
  assert.deepEqual(merges(), [MERGE7, MERGE7]);
  assert.ok(alone.results.some((y) => y.id === 'fake' && y.outcome === 'done'));
});

// ---- Version claims through the Exchequer ----

function claimSetup(name: string) {
  const d = path.join(home, name);
  const { checkout } = fakeEmployee(d, { version: '0.4.10' });
  const r = runner((a) => {
    if (a[0] === 'release' && a[1] === 'list') return ok([{ tagName: 'v0.4.10', isDraft: false, publishedAt: '2026-10-05T00:00:00Z' }]);
    if (a[0] === 'pr' && a[1] === 'list') return ok([{ title: 'Fake 0.4.11: open', headRefName: 'claude/open' }]);
  });
  const e = employee(checkout);
  return { e, ctx: ctxFor({ employees: [e], workRoot: path.join(d, 'work'), run: r.run, neutralDir: d }) };
}

test('with a licence, a version is claimed through the Exchequer, from what this PC knows, and kept here too', async () => {
  rmSync(claimsFile(), { force: true });
  const s = claimSetup('claim-shared');
  const x = exchequer();
  // One claimed here alone before claims were shared: the Exchequer is told it is taken.
  writeFileSync(claimsFile(), JSON.stringify([{ repo: 'Jcollier0120/Fake', version: '0.4.12', branch: 'claude/old', by: 'claude', for: 'old', at: new Date().toISOString() }]));
  const a = await claimVersion(s.ctx, s.e, { branch: 'claude/a', by: 'claude', for: 'a fix', coord: x.coord });
  assert.deepEqual([a.claim.version, a.again, a.claim.source], ['0.4.13', false, 'exchequer']);
  const sent = x.calls.find((c) => c.route === '/claims')!.body;
  assert.deepEqual(sent, { repo: 'Jcollier0120/Fake', branch: 'claude/a', by: 'claude', for: 'a fix', minor: false, branchVersion: '0.4.10', released: ['0.4.10'], openBranches: ['claude/open'], openVersions: ['0.4.11'], taken: ['0.4.12'] });
  // Another PC claimed meanwhile: the next is above it.
  x.claims.push({ repo: 'Jcollier0120/Fake', version: '0.4.14', branch: 'claude/desk', by: 'claude', for: 'on the desktop', at: new Date().toISOString() });
  assert.equal((await claimVersion(s.ctx, s.e, { branch: 'claude/b', by: 'claude', for: 'b', coord: x.coord })).claim.version, '0.4.15');
  // The same branch again, here alone or shared: the same version.
  assert.deepEqual((await claimVersion(s.ctx, s.e, { branch: 'claude/a', by: 'claude', for: 'a', coord: x.coord })).claim.version, '0.4.13');
  assert.deepEqual((await claimVersion(s.ctx, s.e, { branch: 'claude/old', by: 'claude', for: 'old', coord: x.coord })), { claim: loadClaims()[0], again: true });
  assert.deepEqual(loadClaims().map((c) => [c.version, c.source ?? 'here']).sort(), [['0.4.12', 'here'], ['0.4.13', 'exchequer'], ['0.4.15', 'exchequer']]);
  // Each round copies every PC's claims here, so the merge stage sees the desktop's too.
  await syncClaims(x.coord);
  assert.deepEqual(loadClaims().map((c) => c.version).sort(), ['0.4.12', '0.4.13', '0.4.14', '0.4.15']);
  // Given back on both.
  assert.equal(await releaseClaim('Jcollier0120/Fake', '0.4.15', { coord: x.coord }), true);
  assert.ok(!x.claims.some((c) => c.version === '0.4.15'));
  // Landed: dropped here, and given back on the Exchequer.
  await pruneClaims([{ repo: 'Jcollier0120/Fake', name: 'Fake', main: { version: '0.4.13' }, release: null, prs: [{ head: 'claude/desk', title: 'Fake 0.4.14: x' }] }], Date.now(), { coord: x.coord });
  assert.deepEqual(loadClaims().map((c) => c.version).sort(), ['0.4.14']);
  assert.deepEqual(x.claims.map((c) => c.version), ['0.4.14']);
});

test('with no Exchequer to ask, or one that does not hand claims out, the claim is this PC\'s own, as before', async () => {
  for (const mode of ['404', 'down'] as const) {
    rmSync(claimsFile(), { force: true });
    const s = claimSetup(`claim-${mode}`);
    const x = exchequer({ mode });
    const a = await claimVersion(s.ctx, s.e, { branch: 'claude/a', by: 'claude', for: 'a fix', coord: x.coord });
    assert.deepEqual([a.claim.version, a.claim.source], ['0.4.12', undefined], mode);
    assert.equal(JSON.parse(readFileSync(claimsFile(), 'utf8')).length, 1);
  }
});

test('leases.json goes when there are no turns any more', async () => {
  const x = exchequer();
  await takeTurns([clerk], { coord: x.coord, settings });
  assert.equal(loadLeases().mode, 'on');
  await takeTurns([clerk], { coord: null, settings });
  assert.deepEqual(JSON.parse(readFileSync(leasesFile(), 'utf8')), { at: null, mode: 'off', note: null, leases: {} });
});
