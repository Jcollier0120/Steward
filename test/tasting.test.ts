import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Aletaster's release gate: a release is published only once the Aletaster's tasting of that very commit lets it
// through; otherwise it waits, with the reason, and the next round asks again. It never deadlocks: no Aletaster, an
// Aletaster off duty for Developer options, one that predates the tasting or doesn't answer, and the Aletaster's own
// release all go without a tasting, and say so. A hold that lasts is an alarm.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-tasting-'));
process.env.STEWARD_HOME = home;
process.env.WRIGHT_HOME = path.join(home, 'no-wright');
after(() => rmSync(home, { recursive: true, force: true }));

const { aletasterVacant, clearTastingHold, isAletaster, loadTastingHolds, tasteFirst } = await import('../src/tasting.ts');
const { releaseOne } = await import('../src/stages/release.ts');
const { releaseUnreleased } = await import('../src/stages/round.ts');
const { afterRound } = await import('../src/stages/changes.ts');
const { roundConditions } = await import('../src/alarms.ts');
const { DEFAULT_SETTINGS, normalizeSettings } = await import('../src/settings.ts');
const { STAFF: DEFAULT_EMPLOYEES } = await import('./fixtures/staff.ts');
const { ctxFor, employee, fakeEmployee, ok, runner } = await import('./helpers.ts');
type HttpRequest = import('../src/upkeep.ts').HttpRequest;
type TastingDeps = import('../src/tasting.ts').TastingDeps;

const HOUR = 3_600_000;
const COMMIT = '4c1d2e9f0a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d';
const TOKEN = 'tok_0123456789abcdefABCDEF';
const PAGE = `<html><head><meta name="page-token" content="${TOKEN}"></head></html>`;
const porter = DEFAULT_EMPLOYEES.find((e) => e.id === 'porter')!;
const aletaster = DEFAULT_EMPLOYEES.find((e) => e.id === 'aletaster')!;
const settings = structuredClone(DEFAULT_SETTINGS);

const tasting = (more: Record<string, unknown> = {}) => ({ id: '9e41c07ab2d3', repo: 'Jcollier0120/Porter', commit: COMMIT, version: '0.4.13', project: 'Porter', from: 'manor', state: 'done', verdict: 'pass', reason: 'Version agreement: 0.4.13 at 4c1d2e9', checks: [], errors: [], release: true, strict: false, ...more });

/** A stand-in Aletaster: its page, then the POST's answer, then each GET's in turn; every request kept. */
function aletasterHttp(o: { page?: { status: number; body: string } | { error: string }; post: { status: number; body: unknown } | { error: string }; gets?: ({ status: number; body: unknown } | { error: string })[] }) {
  const asked: { method: string; path: string; headers?: Record<string, string>; body?: any }[] = [];
  const gets = [...(o.gets ?? [])];
  const answer = (a: { status: number; body: unknown } | { error: string }) => ('error' in a ? a : { status: a.status, body: typeof a.body === 'string' ? a.body : JSON.stringify(a.body) });
  const http: HttpRequest = async (url, r) => {
    asked.push({ method: r.method, path: url.pathname + url.search, headers: r.headers, body: r.body ? JSON.parse(r.body) : undefined });
    assert.equal(url.host, '127.0.0.1:19191');
    if (r.method === 'GET' && url.pathname === '/') return o.page ?? { status: 200, body: PAGE };
    if (r.method === 'POST' && url.pathname === '/api/taste') return answer(o.post);
    if (r.method === 'GET' && url.pathname === '/api/taste') return answer(gets.shift() ?? { status: 500, body: { error: 'asked once too often' } });
    return { status: 404, body: '{"error":"not found"}' };
  };
  return { http, asked };
}

const deps = (http: HttpRequest, more: Partial<TastingDeps> = {}): TastingDeps => ({ installed: () => true, vacant: () => false, http, sleep: async () => {}, now: () => new Date('2026-10-04T08:00:00Z'), ...more });
const ask = (e = porter, d?: TastingDeps, s = settings) => tasteFirst(e, { commit: COMMIT, version: '0.4.13' }, s, d);

test('a pass lets the release through, asked with the page token, no Origin, and what the Steward knows of the employee', async () => {
  const a = aletasterHttp({ post: { status: 200, body: tasting({ cached: true }) } });
  const g = await ask(porter, deps(a.http));
  assert.deepEqual(g, { go: true, note: 'tasted by the Aletaster: pass' });
  const post = a.asked.find((x) => x.method === 'POST')!;
  assert.equal(post.headers!['x-token'], TOKEN);
  assert.ok(!('origin' in post.headers!) && !('Origin' in post.headers!));
  assert.deepEqual([post.body.repo, post.body.commit, post.body.version, post.body.name, post.body.versionFiles], ['Jcollier0120/Porter', COMMIT, '0.4.13', 'Porter', porter.versionFiles]);
  assert.equal(post.body.checkout, path.resolve('C:\\Projects\\Porter'));
  assert.deepEqual(loadTastingHolds(), {}, 'nothing held');
});

test('a warning the Aletaster lets through goes, its reason said; one it holds (strict) waits', async () => {
  const warn = aletasterHttp({ post: { status: 200, body: tasting({ verdict: 'warn', reason: 'Unreleased work: #12 has no changelog line' }) } });
  assert.deepEqual(await ask(porter, deps(warn.http)), { go: true, note: 'tasted by the Aletaster: warn (Unreleased work: #12 has no changelog line)' });
  const strict = aletasterHttp({ post: { status: 200, body: tasting({ verdict: 'warn', reason: 'Unreleased work: #12 has no changelog line', release: false, strict: true }) } });
  const g = await ask(porter, deps(strict.http));
  assert.equal(g.go, false);
  clearTastingHold('porter');
});

test('a failure holds the release, with the reason and a link to the tasting, kept for the alarms', async () => {
  const reason = 'Version agreement: src/app.ts says 0.4.12, but package.json says 0.4.13';
  const a = aletasterHttp({ post: { status: 200, body: tasting({ id: '51b0e6d3c9a4', verdict: 'fail', reason, release: false, cached: true }) } });
  const g = await ask(porter, deps(a.http));
  assert.deepEqual(g, { go: false, why: `v0.4.13 at 4c1d2e9 waits for the Aletaster's tasting: fail: ${reason}`, url: 'http://aletaster.localhost:19191/api/taste?id=51b0e6d3c9a4' });
  const held = loadTastingHolds().porter;
  assert.deepEqual([held.commit, held.version, held.since, held.url], [COMMIT, '0.4.13', '2026-10-04T08:00:00.000Z', g.go ? '' : g.url]);
  // Asked again later, the same commit keeps the time it was first held.
  await ask(porter, deps(a.http, { now: () => new Date('2026-10-04T09:00:00Z') }));
  assert.equal(loadTastingHolds().porter.since, '2026-10-04T08:00:00.000Z');
  // Then it passes: the hold is gone.
  await ask(porter, deps(aletasterHttp({ post: { status: 200, body: tasting() } }).http));
  assert.equal(loadTastingHolds().porter, undefined);
});

test('a tasting under way is asked about every couple of seconds until it is done', async () => {
  const a = aletasterHttp({ post: { status: 202, body: tasting({ state: 'running', verdict: 'not checked', reason: 'Still tasting', release: false }) }, gets: [{ status: 200, body: tasting({ state: 'running', verdict: 'not checked', release: false }) }, { status: 200, body: tasting() }] });
  const slept: number[] = [];
  const g = await ask(porter, deps(a.http, { sleep: async (ms) => void slept.push(ms) }));
  assert.deepEqual(g, { go: true, note: 'tasted by the Aletaster: pass' });
  assert.deepEqual(slept, [2000, 2000]);
  assert.deepEqual(a.asked.filter((x) => x.method === 'GET' && x.path.startsWith('/api/taste')).map((x) => x.path), ['/api/taste?id=9e41c07ab2d3', '/api/taste?id=9e41c07ab2d3']);
});

test('a tasting still under way after the wait holds the release until the next round', async () => {
  const running = tasting({ state: 'running', verdict: 'not checked', reason: 'Still tasting', release: false });
  const a = aletasterHttp({ post: { status: 202, body: running }, gets: Array(10).fill({ status: 200, body: running }) });
  const g = await ask(porter, deps(a.http, { waitMs: 6000, pollMs: 2000 }));
  assert.equal(g.go, false);
  assert.match(g.go ? '' : g.why, /the tasting is still under way after 6 s; the next round asks again$/);
  clearTastingHold('porter');
});

test("(a) no gate where the Aletaster isn't installed, or is off duty for Developer options", async () => {
  const never: HttpRequest = async () => assert.fail('the Aletaster is not asked');
  assert.deepEqual(await ask(porter, deps(never, { installed: () => false })), { go: true, note: "released without a tasting: the Aletaster isn't here" });
  const vacant = await ask(porter, deps(never, { vacant: () => true }));
  assert.equal(vacant.go, true);
  assert.match(vacant.go ? vacant.note! : '', /^released without a tasting: the Aletaster isn't here \(its role is vacant while Manor's Developer options are off\)$/);
});

test("no gate when the Aletaster's own Developer options are off (no Manor to decide): it tastes nothing, as when vacant; on, it is asked as ever", async () => {
  /** An Aletaster whose /api/ping says its switch; it refuses a tasting while off, as Aletaster 0.8.7 does. */
  const own = (on: boolean) => {
    const a = aletasterHttp({ post: on ? { status: 200, body: tasting() } : { status: 403, body: { ok: false, verdict: 'not checked', release: false, reason: 'its Developer options are off, so it tastes nothing' } } });
    const http: HttpRequest = async (url, r) => (url.pathname === '/api/ping' ? { status: 200, body: JSON.stringify({ app: 'aletaster', developer: on }) } : a.http(url, r));
    return { http, asked: a.asked };
  };
  const off = own(false);
  assert.deepEqual(await ask(porter, deps(off.http)), { go: true, note: "released without a tasting: the Aletaster's Developer options are off, so it tastes nothing" });
  assert.deepEqual(off.asked.filter((x) => x.method === 'POST'), [], 'no tasting asked for');
  assert.deepEqual(loadTastingHolds(), {}, 'nothing held');
  const on = own(true);
  assert.deepEqual(await ask(porter, deps(on.http)), { go: true, note: 'tasted by the Aletaster: pass' });
  assert.equal(on.asked.filter((x) => x.method === 'POST').length, 1);
});

test("Developer options off leave the Aletaster's role vacant, as Manor's staff.json says it is a developer role", () => {
  const manor = path.join(home, 'manor');
  mkdirSync(path.join(manor, 'app'), { recursive: true });
  const settingsJson = (v: unknown) => writeFileSync(path.join(manor, 'settings.json'), JSON.stringify({ developerOptions: v }));
  settingsJson(true);
  assert.equal(aletasterVacant(manor), false, 'on');
  settingsJson(null);
  assert.equal(aletasterVacant(manor), false, "Manor hasn't said");
  settingsJson(false);
  assert.equal(aletasterVacant(manor), true, 'off, and no staff.json to say otherwise');
  writeFileSync(path.join(manor, 'app', 'staff.json'), JSON.stringify({ agents: [{ id: 'aletaster', developer: false }] }));
  assert.equal(aletasterVacant(manor), false, 'a general role, if Manor ever moves it');
  writeFileSync(path.join(manor, 'app', 'staff.json'), JSON.stringify({ agents: [{ id: 'aletaster', developer: true }] }));
  assert.equal(aletasterVacant(manor), true);
  assert.equal(aletasterVacant(path.join(home, 'no-manor')), false, 'no Manor: its own duty decides, and a tasting answers off duty');
});

test('(b) no gate when the Aletaster predates /api/taste, or its page gives no answer at all', async () => {
  const old = aletasterHttp({ post: { status: 404, body: { error: 'not found' } } });
  assert.deepEqual(await ask(porter, deps(old.http)), { go: true, note: 'released without a tasting: the Aletaster here predates /api/taste' });
  const down = aletasterHttp({ page: { error: 'connect ECONNREFUSED 127.0.0.1:19191' }, post: { error: 'unused' } });
  assert.deepEqual(await ask(porter, deps(down.http)), { go: true, note: "released without a tasting: the Aletaster's page doesn't answer (connect ECONNREFUSED 127.0.0.1:19191)" });
  const gone = aletasterHttp({ post: { error: 'socket hang up' } });
  assert.equal((await ask(porter, deps(gone.http))).go, true);
  // A repository it doesn't know is a 404 with a verdict: that holds, as the Aletaster says.
  const unknown = aletasterHttp({ post: { status: 404, body: { error: 'x', verdict: 'not checked', release: false, reason: "Jcollier0120/Porter isn't a project the Aletaster tastes" } } });
  const g = await ask(porter, deps(unknown.http));
  assert.deepEqual([g.go, g.go ? '' : g.why], [false, "v0.4.13 at 4c1d2e9 waits for the Aletaster's tasting: Jcollier0120/Porter isn't a project the Aletaster tastes"]);
  // A request it can't read holds too, with its error.
  const bad = await ask(porter, deps(aletasterHttp({ post: { status: 403, body: { error: 'no token' } } }).http));
  assert.match(bad.go ? '' : bad.why, /: no token$/);
  clearTastingHold('porter');
});

test("(c) the Aletaster's own release is never held by its tasting", async () => {
  assert.ok(isAletaster(aletaster));
  const fail = aletasterHttp({ post: { status: 200, body: tasting({ verdict: 'fail', release: false }) } });
  assert.deepEqual(await ask(aletaster, deps(fail.http)), { go: true, note: "released without a tasting: the Aletaster's own release is never held by its tasting" });
  assert.equal(fail.asked.length, 0, 'not asked at all');
});

test('the setting off: no gate and nothing said; on by default', async () => {
  assert.equal(DEFAULT_SETTINGS.tasteBeforeRelease, true);
  assert.equal(normalizeSettings({ tasteBeforeRelease: false }).settings.tasteBeforeRelease, false);
  assert.equal(normalizeSettings({}).settings.alarms.tastingHours, 6);
  const fail = aletasterHttp({ post: { status: 200, body: tasting({ verdict: 'fail', release: false }) } });
  assert.deepEqual(await ask(porter, deps(fail.http), { ...settings, tasteBeforeRelease: false }), { go: true, note: null });
  assert.equal(fail.asked.length, 0);
  // Under node --test, with no stand-in, the live Aletaster is never asked.
  assert.deepEqual(await ask(porter, undefined), { go: true, note: null });
});

test('(d) a hold that lasts its while is an alarm, with the reason and the link; not while the setting is off', () => {
  const round = { stage: 'round' as const, started: '', finished: '', kit: null, asked: {}, results: [], log: [] };
  const hold = { commit: COMMIT, version: '0.4.13', since: '2026-10-04T08:00:00.000Z', why: "v0.4.13 at 4c1d2e9 waits for the Aletaster's tasting: fail: versions disagree", url: 'http://aletaster.localhost:19191/api/taste?id=51b0e6d3c9a4' };
  const c = roundConditions({ round, held: [], failedReleases: {}, tastingHolds: { porter: hold, gone: hold }, employees: DEFAULT_EMPLOYEES, settings });
  assert.equal(c.length, 1, 'one for an employee the Steward still has');
  assert.deepEqual([c[0].id, c[0].who, c[0].since, c[0].afterMs, c[0].url, c[0].detail[0]], ['tasting:porter:4c1d2e9:0.4.13', 'porter', hold.since, 6 * HOUR, hold.url, hold.why]);
  assert.equal(c[0].title, "Porter v0.4.13 has waited 6 hours or more for the Aletaster's tasting");
  assert.equal(roundConditions({ round, held: [], failedReleases: {}, tastingHolds: { porter: hold }, employees: DEFAULT_EMPLOYEES, settings: { ...settings, tasteBeforeRelease: false } }).length, 0);
});

test("in a release: a hold publishes nothing and asks again next round; a pass releases and says it was tasted", async () => {
  const dir = path.join(home, 'release');
  const { checkout } = fakeEmployee(dir, { version: '0.4.1', kit: '1.0.0' });
  const marker = path.join(dir, 'released');
  const e = employee(checkout, { release: `node -e "require('fs').writeFileSync(process.argv[1], '')" "${marker}"` });
  const { run } = runner((a) => (a[0] === 'release' && a[1] === 'list' ? ok([{ tagName: 'v0.4.0', isDraft: false }]) : undefined));
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });

  ctx.tasting = deps(aletasterHttp({ post: { status: 200, body: tasting({ repo: e.repo, verdict: 'fail', reason: 'versions disagree', release: false }) } }).http);
  const held = await releaseUnreleased(ctx, [e]);
  assert.deepEqual([held[0].outcome, held[0].again], ['skipped', true]);
  assert.match(held[0].message, /^v0\.4\.1 at [0-9a-f]{7} waits for the Aletaster's tasting: fail: versions disagree$/);
  assert.ok(!existsSync(marker), 'its release command never ran');
  assert.ok(loadTastingHolds().fake, 'kept for the alarms');
  // The round looks at it again, whatever GitHub says.
  const plan = { full: false, why: null, look: [e], quiet: [], sigs: { fake: 'sig' } };
  assert.equal(afterRound({ full: null, ok: true, repos: {} }, { plan, results: held, held: [] }).repos.fake, undefined);

  ctx.tasting = deps(aletasterHttp({ post: { status: 200, body: tasting({ repo: e.repo }) } }).http);
  const done = await releaseOne(ctx, e, { kit: null });
  assert.equal(done.outcome, 'done', `${done.message}\n${ctx.lines.join('\n')}`);
  assert.match(done.message, /^released v0\.4\.1 from origin\/main \([0-9a-f]{7}\), with kit 1\.0\.0; tasted by the Aletaster: pass$/);
  assert.ok(existsSync(marker));
  assert.equal(loadTastingHolds().fake, undefined);
});

test("a release marked failed is cleared once its version is out, by a person or a run that beat the round to it", async () => {
  const { roundFailuresFile } = await import('../src/stages/round.ts');
  const { readFileSync } = await import('node:fs');
  const dir = path.join(home, 'released-elsewhere');
  const { checkout } = fakeEmployee(dir, { version: '0.4.1', kit: '1.0.0' });
  const e = employee(checkout, { release: 'node -e "process.exit(1)"' });
  // GitHub lists v0.4.1: it was published, though this PC's round failed at it ("a release with the same tag name already exists").
  const { run } = runner((a) => (a[0] === 'release' && a[1] === 'list' ? ok([{ tagName: 'v0.4.1', isDraft: false }]) : undefined));
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  writeFileSync(roundFailuresFile(), JSON.stringify({ fake: 'f2e18a8', other: 'abc1234' }));
  const [r] = await releaseUnreleased(ctx, [e]);
  assert.deepEqual([r.outcome, r.released, r.message], ['skipped', true, 'v0.4.1 is already released']);
  assert.deepEqual(JSON.parse(readFileSync(roundFailuresFile(), 'utf8')), { other: 'abc1234' }, "its failure no longer stands; another employee's does");
});
