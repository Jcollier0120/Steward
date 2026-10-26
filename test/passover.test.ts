import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A PR stuck next in its repository's version line for an hour is passed over, re-versioned once main passes it, kept
// caught up with main, and taken back once it moves (passover.ts, Steward#173), all through the claims ref.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-passover-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const P = await import('../src/passover.ts');
const C = await import('../src/claims.ts');
const R = await import('../src/remote-ref.ts');
const { lockBeside, mergeChangelogs, renumberChangelog, resolveVersionConflicts, settledFiles } = await import('../src/stages/catchup.ts');
const { run: realRun } = await import('../src/run.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type Claim = import('../src/claims.ts').Claim;
type PrInfo = import('../src/stages/staff.ts').PrInfo;
type RemoteRepo = import('../src/remote-ref.ts').RemoteRepo;

const REPO = 'Jcollier0120/Fake';
const T0 = Date.parse('2026-10-26T10:00:00Z');
const MIN = 60_000;

const pr = (number: number, head: string, headOid: string, title: string, more: Partial<PrInfo> = {}): PrInfo => ({ number, title, url: `https://github.com/${REPO}/pull/${number}`, head, base: 'main', author: 'Jcollier0120', whose: 'team', headOid, after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: false, checks: 'passing', labels: [], changed: 2, files: [], fork: false, ...more });
const claim = (version: string, branch: string, more: Partial<Claim> = {}): Claim => ({ repo: REPO, version, branch, by: 'claude', for: branch, at: new Date(T0 - 60 * MIN).toISOString(), ...more });
const at = (t: number) => new Date(t).toISOString();

// Two PRs written side by side each add an entry at the top of the changelog, under their own versions.
const log = (...entries: [string, string][]) => ['# Changelog', '', 'Newest first.', '', ...entries.flatMap(([v, t]) => [`## ${v}`, '', t, ''])].join('\n');

test('stuck: the lowest claim with an open PR is next in line; the same head and hold for an hour is stuck; anything else starts the hour again', () => {
  const a = pr(1, 'claude/a', 'aaa', 'Fake 0.4.11: a fix', { checks: 'failing' });
  const b = pr(2, 'claude/b', 'bbb', 'Fake 0.4.12: b');
  const plan = (claims: Claim[], now: number, prs = [a, b]) => P.planLine({ branch: 'main', main: '0.4.10', released: ['0.4.10'], prs, claims, now });
  // A first look marks it next in line, held by its failing checks; the one above it waits.
  assert.deepEqual(plan([claim('0.4.12', 'claude/b'), claim('0.4.11', 'claude/a')], T0), [{ kind: 'watch', claim: claim('0.4.11', 'claude/a'), line: { pr: 1, since: at(T0), head: 'aaa', kind: 'failing', why: 'its checks fail' } }]);
  const watched = claim('0.4.11', 'claude/a', { line: { pr: 1, since: at(T0), head: 'aaa', kind: 'failing', why: 'its checks fail' } });
  assert.deepEqual(plan([watched, claim('0.4.12', 'claude/b')], T0 + 59 * MIN), [], 'under an hour: it waits');
  // Its author pushed, or its checks run again: progress, so the hour starts again.
  assert.equal((plan([watched], T0 + 59 * MIN, [{ ...a, headOid: 'aa2' }])[0] as { line: { since: string } }).line.since, at(T0 + 59 * MIN));
  assert.equal((plan([watched], T0 + 59 * MIN, [{ ...a, checks: 'pending' }])[0] as { line: { why: string } }).line.why, "its checks haven't finished");
  // An hour: stuck. The next one up is next in line now.
  const steps = plan([watched, claim('0.4.12', 'claude/b')], T0 + 60 * MIN);
  assert.deepEqual(steps.map((s) => [s.kind, s.claim.version]), [['pass', '0.4.11'], ['watch', '0.4.12']]);
  assert.deepEqual((steps[0] as { passed: object }).passed, { pr: 1, url: a.url, since: at(T0), at: at(T0 + 60 * MIN), head: 'aaa', kind: 'failing', why: 'its checks fail', from: '0.4.11' });
  // One marked before that isn't next any more loses its mark.
  const bWatched = claim('0.4.12', 'claude/b', { line: { pr: 2, since: at(T0), head: 'bbb', kind: 'author', why: 'x' } });
  assert.deepEqual(plan([watched, bWatched], T0 + 10 * MIN).map((s) => [s.kind, s.claim.version]), [['unwatch', '0.4.12']]);
  // Not in the line: a claim with no open PR, a fork's, the Steward's own, one into another branch.
  for (const p of [{ ...a, fork: true }, { ...a, whose: 'steward' as const }, { ...a, base: 'next' }]) assert.deepEqual(plan([claim('0.4.11', 'claude/a')], T0, [p]), []);
  assert.deepEqual(plan([claim('0.4.11', 'claude/gone')], T0), []);
});

test('what holds a PR: the owner first, a draft, a conflict, its checks, GitHub not knowing, or only its author', () => {
  const p = pr(1, 'claude/a', 'aaa', 'Fake 0.4.11: a');
  assert.deepEqual(P.holdOf(p), { kind: 'author', why: 'it waits for its author to vouch for it and merge it' });
  assert.equal(P.holdOf({ ...p, labels: ['owner-first'], draft: true }).kind, 'owner');
  assert.equal(P.holdOf({ ...p, labels: ['owner-first', 'owner-done'], draft: true }).kind, 'draft');
  assert.match(P.ownerFirst({ labels: [], files: ['db/migrations/0004.sql'] })!, /changes db\/migrations\/0004\.sql, which may need the owner first/);
  assert.equal(P.holdOf({ ...p, mergeable: 'CONFLICTING' }).why, 'it conflicts with main');
  assert.equal(P.holdOf({ ...p, checks: 'failing' }).kind, 'failing');
  assert.equal(P.holdOf({ ...p, checks: 'pending' }).kind, 'pending');
  assert.equal(P.holdOf({ ...p, mergeable: 'UNKNOWN' }).kind, 'unknown');
});

/**
 * A repository at 0.4.10 with two PRs on it: #1 (claude/a, 0.4.11, a fix) and #2 (claude/b, 0.4.12), each with its own
 * changelog entry, and its claims ref on its origin. `merge` merges a branch into main, as its author would.
 */
function line(name: string) {
  const dir = path.join(home, name);
  const { checkout, origin } = fakeEmployee(dir, { version: '0.4.10', files: { 'CHANGELOG.md': log(['0.4.10', 'The first.']) } });
  const write = (f: string, t: string) => writeFileSync(path.join(checkout, f), t);
  const read = (f: string) => readFileSync(path.join(checkout, f), 'utf8');
  const branch = (b: string, v: string, entry: string, file: string) => {
    sh(checkout, 'switch', '--quiet', '-c', b, 'main');
    for (const f of ['package.json', 'package-lock.json', 'src/app.ts']) write(f, read(f).split('0.4.10').join(v));
    write('CHANGELOG.md', log([v, entry], ['0.4.10', 'The first.']));
    write(file, `export const x = '${b}';\n`);
    sh(checkout, 'add', '-A');
    sh(checkout, 'commit', '--quiet', '-m', `Fake ${v}: ${entry}`);
    sh(checkout, 'push', '--quiet', 'origin', b);
    const head = sh(checkout, 'rev-parse', 'HEAD');
    sh(checkout, 'switch', '--quiet', 'main');
    return head;
  };
  const a = branch('claude/a', '0.4.11', 'A fix.', 'src/a.ts');
  const b = branch('claude/b', '0.4.12', 'B.', 'src/b.ts');
  const main = () => sh(checkout, 'rev-parse', 'main');
  const merge = (from: string) => {
    sh(checkout, 'merge', '--quiet', '--no-ff', '--no-edit', from);
    sh(checkout, 'push', '--quiet', 'origin', 'main');
    return main();
  };
  // A commit to main that leaves its version alone.
  const docs = (t: string) => {
    write('README.md', t);
    sh(checkout, 'add', '-A');
    sh(checkout, 'commit', '--quiet', '-m', 'Docs');
    sh(checkout, 'push', '--quiet', 'origin', 'main');
    return main();
  };
  // Its author pushes to its branch.
  const push = (b: string) => {
    sh(checkout, 'fetch', '--quiet', 'origin');
    sh(checkout, 'switch', '--quiet', '--detach', `origin/${b}`);
    write(`src/more-${b.replace('/', '-')}.ts`, 'export const more = 1;\n');
    sh(checkout, 'add', '-A');
    sh(checkout, 'commit', '--quiet', '-m', 'More');
    sh(checkout, 'push', '--quiet', 'origin', `HEAD:refs/heads/${b}`);
    const head = sh(checkout, 'rev-parse', 'HEAD');
    sh(checkout, 'switch', '--quiet', 'main');
    return head;
  };
  const remote: RemoteRepo = { key: 'jcollier0120/fake', url: origin, scratch: path.join(dir, 'scratch.git') };
  let open = [{ title: 'Fake 0.4.11: A fix.', headRefName: 'claude/a' }];
  const { run, gh } = runner((x) => {
    if (x[0] === 'release' && x[1] === 'list') return ok([{ tagName: 'v0.4.10', isDraft: false, publishedAt: '2026-10-05T00:00:00Z' }]);
    if (x[0] === 'pr' && x[1] === 'list') return ok(open);
    if (x[0] === 'pr' && (x[1] === 'comment' || x[1] === 'edit')) return ok('');
  });
  const e = employee(checkout);
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run, neutralDir: dir });
  const row = (version: string, prs: PrInfo[]) => ({ id: 'fake', name: 'Fake', repo: REPO, branch: 'main', main: { commit: main(), version }, release: { version: '0.4.10' }, prs });
  // The claims as every PC has them: in the claims ref, and copied here.
  const claims = async (list: Claim[]) => {
    const w = await R.writeRef(realRun, remote, C.CLAIMS_REF, C.CLAIMS_FILE, JSON.stringify(list), null, 'test');
    assert.equal(w.kind, 'ok');
    writeFileSync(C.claimsFile(), JSON.stringify(list.map((c) => ({ ...c, source: 'shared' }))));
  };
  const shared = async () => {
    const r = await R.readRef(realRun, remote, C.CLAIMS_REF, C.CLAIMS_FILE);
    return r.kind === 'found' ? C.parseClaims(r.text) : [];
  };
  const pass = (rows: ReturnType<typeof row>[], now: number) => P.passOver(ctx, rows, { employees: [e], now, remote: async () => remote });
  const comments = () => gh.filter((x) => x[1] === 'comment').map((x) => [x[2], x.at(-1)!] as const);
  const show = (ref: string, f: string) => {
    sh(checkout, 'fetch', '--quiet', 'origin');
    return sh(checkout, 'show', `origin/${ref}:${f}`);
  };
  return { checkout, a, b, main, merge, docs, push, remote, ctx, gh, row, claims, shared, pass, comments, show, setOpen: (o: typeof open) => (open = o) };
}

const failingA = (head: string, more: Partial<PrInfo> = {}) => pr(1, 'claude/a', head, 'Fake 0.4.11: A fix.', { checks: 'failing', ...more });
const stuckLine = (head: string, more: Partial<Claim['line'] & object> = {}) => ({ pr: 1, since: at(T0), head, kind: 'failing' as const, why: 'its checks fail', ...more });
const passedMark = (head: string, more: Partial<NonNullable<Claim['passed']>> = {}) => ({ pr: 1, url: `https://github.com/${REPO}/pull/1`, since: at(T0), at: at(T0 + 60 * MIN), head, kind: 'failing' as const, why: 'its checks fail', from: '0.4.11', ...more });

test('passed over: marked in the claims ref, for every PC; the PR told; the page and the alarm say what holds it and the version it gets', async () => {
  const s = line('passed');
  await s.claims([claim('0.4.11', 'claude/a', { line: stuckLine(s.a) }), claim('0.4.12', 'claude/b')]);
  const rows = [s.row('0.4.10', [failingA(s.a), pr(2, 'claude/b', s.b, 'Fake 0.4.12: B.')])];
  const out = await s.pass(rows, T0 + 61 * MIN);
  assert.deepEqual(out.map((r) => r.outcome), ['done']);
  assert.match(out[0].message, /^Fake #1 \(v0\.4\.11\): stuck since .+, passed over \(its checks fail\); will be re-versioned to 0\.4\.13$/);
  // In the ref: #1 passed over, #2 next in line now. Another PC reads the same.
  const there = await s.shared();
  assert.deepEqual(there.find((c) => c.version === '0.4.11')?.passed, passedMark(s.a, { at: at(T0 + 61 * MIN) }));
  assert.equal(there.find((c) => c.version === '0.4.11')?.line, undefined);
  assert.deepEqual(there.find((c) => c.version === '0.4.12')?.line, { pr: 2, since: at(T0 + 61 * MIN), head: s.b, kind: 'author', why: 'it waits for its author to vouch for it and merge it' });
  assert.deepEqual(C.loadClaims().find((c) => c.version === '0.4.11')?.passed, there.find((c) => c.version === '0.4.11')?.passed, 'and here');
  const [said] = s.comments();
  assert.equal(said[0], '1');
  assert.match(said[1], /^Passed over by the Steward: this PR has been next in line at v0\.4\.11 since .+ with no progress \(its checks fail\), so the PRs above it in the version line merge first\. Once main passes v0\.4\.11, the Steward claims it the next free version, catches it up with main and keeps it caught up: pull before you push to it\. It is taken back into the line once nothing holds it but its author, or its author pushes to it\.$/);
  // The page's line and the alarm.
  const lines = P.passedLines(rows);
  assert.deepEqual(lines.map((l) => [l.pr, l.version, l.next, l.alone]), [[1, '0.4.11', '0.4.13', null]]);
  assert.match(P.passedWords(lines[0], T0 + 62 * MIN), /^Fake #1 \(v0\.4\.11\): stuck since .+, passed over \(its checks fail\); will be re-versioned to 0\.4\.13$/);
  const [alarm] = P.passedConditions(lines, T0 + 62 * MIN);
  assert.deepEqual([alarm.id, alarm.who, alarm.title, alarm.since, alarm.afterMs, alarm.url], ['passedover:jcollier0120/fake#1', 'fake', 'Fake #1 is stuck, passed over: its checks fail', at(T0), 0, `https://github.com/${REPO}/pull/1`]);
  assert.match(alarm.detail.at(-1)!, /^Fix it and push to its branch/);
  // A round later, with nothing changed: nothing more is said or done.
  const again = await s.pass([s.row('0.4.10', [failingA(s.a), pr(2, 'claude/b', s.b, 'Fake 0.4.12: B.')])], T0 + 70 * MIN);
  assert.ok(!again.length, JSON.stringify(again));
  assert.equal(s.comments().length, 1);
});

test('re-versioned: once main passes it, its claim moves to the next free version in the ref, and its branch is caught up at that version', async () => {
  const s = line('reversioned');
  await s.claims([claim('0.4.11', 'claude/a', { passed: passedMark(s.a) }), claim('0.4.12', 'claude/b')]);
  // #2 merged above it.
  s.merge('claude/b');
  const out = await s.pass([s.row('0.4.12', [failingA(s.a)])], T0 + 90 * MIN);
  assert.deepEqual(out.map((r) => [r.outcome, r.version]), [['done', '0.4.13']], JSON.stringify(out));
  assert.match(out[0].message, /^#1, passed over: merged main into it, its version lines and changelog resolved; v0\.4\.13, from v0\.4\.11$/);
  // Its branch: main's work and its own, 0.4.13 in every version file, its entry above #2's under its new version.
  assert.equal(JSON.parse(s.show('claude/a', 'package.json')).version, '0.4.13');
  const lock = JSON.parse(s.show('claude/a', 'package-lock.json'));
  assert.deepEqual([lock.version, lock.packages[''].version], ['0.4.13', '0.4.13']);
  assert.match(s.show('claude/a', 'src/app.ts'), /version: '0\.4\.13'/);
  assert.equal(s.show('claude/a', 'CHANGELOG.md'), log(['0.4.13', 'A fix.'], ['0.4.12', 'B.'], ['0.4.10', 'The first.']).trimEnd());
  assert.match(s.show('claude/a', 'src/b.ts'), /claude\/b/);
  assert.equal(sh(s.checkout, 'merge-base', '--is-ancestor', s.a, 'origin/claude/a'), '', 'its commits kept: a merge on top');
  // The claims ref: 0.4.13 for its branch, still passed over, from 0.4.11; 0.4.11 and #2's landed 0.4.12 gone.
  const there = await s.shared();
  const pushed = sh(s.checkout, 'rev-parse', 'origin/claude/a');
  assert.deepEqual(there.map((c) => [c.version, c.branch]), [['0.4.13', 'claude/a']]);
  assert.deepEqual(there[0].passed, { ...passedMark(s.a), pushed, main: s.main(), note: 'merged main into it, its version lines and changelog resolved; v0.4.13, from v0.4.11' });
  assert.deepEqual(C.claimsOn(REPO).map((c) => [c.version, !!c.passed]), [['0.4.13', true]], 'and here');
  // Its title follows, and it is told once.
  assert.deepEqual(s.gh.find((x) => x[1] === 'edit')?.slice(-2), ['--title', 'Fake 0.4.13: A fix.']);
  assert.match(s.comments()[0][1], /^Caught up by the Steward: merged main into it, its version lines and changelog resolved; v0\.4\.13, from v0\.4\.11\. It is still passed over/);
  // The page says it was.
  const [l] = P.passedLines([s.row('0.4.12', [failingA(pushed, { title: 'Fake 0.4.13: A fix.' })])]);
  assert.match(P.passedWords(l, T0 + 91 * MIN), /^Fake #1 \(v0\.4\.13, from 0\.4\.11\): stuck since .+, passed over \(its checks fail\); re-versioned, kept caught up with main$/);
});

test('caught up: while it stays passed over, each round that finds main moved merges main into it again; told only the first time', async () => {
  const s = line('caught-up');
  await s.claims([claim('0.4.11', 'claude/a', { passed: passedMark(s.a) })]);
  const first = s.docs('One.\n');
  const out = await s.pass([s.row('0.4.10', [failingA(s.a)])], T0 + 90 * MIN);
  assert.deepEqual(out.map((r) => [r.outcome, r.message]), [['done', '#1, passed over: merged main into it']]);
  const pushed = sh(s.checkout, 'rev-parse', 'origin/claude/a');
  assert.equal(JSON.parse(s.show('claude/a', 'package.json')).version, '0.4.11', 'its own version, still above main');
  assert.equal(s.show('claude/a', 'README.md'), 'One.');
  assert.deepEqual((await s.shared())[0].passed, { ...passedMark(s.a), pushed, main: first, note: 'merged main into it' });
  // Main as it was: nothing to do.
  assert.deepEqual(await s.pass([s.row('0.4.10', [failingA(pushed)])], T0 + 95 * MIN), []);
  // Main moved again: caught up again, its head the Steward's own (not its author's), and nothing more said.
  s.docs('Two.\n');
  const again = await s.pass([s.row('0.4.10', [failingA(pushed, { checks: 'pending' })])], T0 + 100 * MIN);
  assert.deepEqual(again.map((r) => r.message), ['#1, passed over: merged main into it']);
  assert.equal(s.show('claude/a', 'README.md'), 'Two.');
  assert.equal(s.comments().length, 1);
  assert.match(s.comments()[0][1], /^Caught up by the Steward: merged main into it\. It is still passed over \(stuck since .+: its checks fail\)/);
  assert.equal((await s.shared())[0].passed?.pushed, sh(s.checkout, 'rev-parse', 'origin/claude/a'));
});

test('taken back: its author pushed, so its marks go and it is told to vouch and merge; its branch is left as its author pushed it', async () => {
  const s = line('taken-back');
  await s.claims([claim('0.4.11', 'claude/a', { passed: passedMark(s.a) })]);
  const theirs = s.push('claude/a');
  s.docs('Moved.\n');
  const out = await s.pass([s.row('0.4.10', [failingA(theirs)])], T0 + 90 * MIN);
  assert.deepEqual(out.map((r) => [r.outcome, r.message]), [['done', '#1 taken back into the line at v0.4.11: its author pushed to it']]);
  assert.equal(sh(s.checkout, 'rev-parse', 'origin/claude/a'), theirs, 'not pushed to');
  const there = await s.shared();
  assert.deepEqual([there[0].version, there[0].passed, there[0].line], ['0.4.11', undefined, undefined]);
  assert.equal(s.comments()[0][1], 'Taken back into the line by the Steward at v0.4.11: its author pushed to it. Vouch for it (steward vouch 1) and merge it once the versions below it have merged: the Steward merges nothing.');
  // Back in the line: next in line again, its hour from now.
  const next = await s.pass([s.row('0.4.10', [failingA(theirs)])], T0 + 95 * MIN);
  assert.deepEqual(next, []);
  assert.deepEqual((await s.shared())[0].line, stuckLine(theirs, { since: at(T0 + 95 * MIN) }));
});

test('taken back where main passed it: re-versioned once more to the next free version, then told to vouch and merge', async () => {
  const s = line('taken-back-reversioned');
  await s.claims([claim('0.4.11', 'claude/a', { passed: passedMark(s.a) }), claim('0.4.12', 'claude/b')]);
  s.merge('claude/b');
  // Its checks pass now: nothing holds it but its author.
  const out = await s.pass([s.row('0.4.12', [failingA(s.a, { checks: 'passing' })])], T0 + 90 * MIN);
  assert.deepEqual(out.map((r) => [r.outcome, r.version]), [['done', '0.4.13']]);
  assert.match(out[0].message, /^#1 taken back into the line at v0\.4\.13: nothing holds it now but its author \(its checks fail, before\); merged main into it/);
  assert.equal(JSON.parse(s.show('claude/a', 'package.json')).version, '0.4.13');
  const there = await s.shared();
  assert.deepEqual(there.map((c) => [c.version, c.branch, c.passed]), [['0.4.13', 'claude/a', undefined]]);
  assert.match(s.comments()[0][1], /^Taken back into the line by the Steward at v0\.4\.13: nothing holds it now but its author \(its checks fail, before\)\. Merged main into it, .+\. Vouch for it \(steward vouch 1\) and merge it once the versions below it have merged: the Steward merges nothing\.$/);
});

test('owner-first: marked and shown, never told, pushed to or re-versioned until the owner labels it owner-done', async () => {
  const s = line('owner-first');
  const owner = (more: Partial<PrInfo> = {}) => failingA(s.a, { labels: ['owner-first'], ...more });
  const why = 'it waits for the owner first (labelled owner-first)';
  await s.claims([claim('0.4.11', 'claude/a', { line: stuckLine(s.a, { kind: 'owner', why }) }), claim('0.4.12', 'claude/b')]);
  const out = await s.pass([s.row('0.4.10', [owner(), pr(2, 'claude/b', s.b, 'Fake 0.4.12: B.')])], T0 + 61 * MIN);
  assert.match(out[0].message, /passed over \(it waits for the owner first \(labelled owner-first\)\); will be re-versioned to 0\.4\.13: it waits for the owner first, so the Steward leaves it to them$/);
  assert.equal((await s.shared()).find((c) => c.version === '0.4.11')?.passed?.kind, 'owner');
  // Main passes it: still left alone, its claim where it was.
  s.merge('claude/b');
  assert.deepEqual(await s.pass([s.row('0.4.12', [owner()])], T0 + 90 * MIN), []);
  assert.equal(sh(s.checkout, 'rev-parse', 'origin/claude/a'), s.a);
  assert.equal((await s.shared()).find((c) => c.branch === 'claude/a')?.version, '0.4.11');
  assert.equal(s.gh.filter((x) => x[1] === 'comment' || x[1] === 'edit').length, 0);
  // The owner is done: taken back, re-versioned, and told; the Steward still merges nothing.
  const back = await s.pass([s.row('0.4.12', [owner({ labels: ['owner-first', 'owner-done'] })])], T0 + 100 * MIN);
  assert.deepEqual(back.map((r) => [r.outcome, r.version]), [['done', '0.4.13']]);
  assert.match(back[0].message, /^#1 taken back into the line at v0\.4\.13: the owner is done/);
  assert.equal(JSON.parse(s.show('claude/a', 'package.json')).version, '0.4.13');
  assert.match(s.comments()[0][1], /^Taken back into the line by the Steward at v0\.4\.13: the owner is done\./);
  assert.equal(s.gh.filter((x) => x[1] === 'merge').length, 0);
});

test('passed by main before it was passed over (CastellanSite#114): its claim holds while its PR is open, it is passed over at once and re-versioned the next round', async () => {
  const s = line('overtaken');
  await s.claims([claim('0.4.11', 'claude/a'), claim('0.4.12', 'claude/b')]);
  s.merge('claude/b');
  const rows = [s.row('0.4.12', [pr(1, 'claude/a', s.a, 'Fake 0.4.11: A fix.')])];
  // The round's claims step keeps it: its PR is open.
  await C.pruneClaims(rows, T0 + 90 * MIN);
  assert.deepEqual(C.claimsOn(REPO).map((c) => c.version), ['0.4.11']);
  const out = await s.pass(rows, T0 + 90 * MIN);
  assert.match(out[0].message, /^Fake #1 \(v0\.4\.11\): stuck since .+, passed over \(main reached v0\.4\.11 before it merged; it waits for its author to vouch for it and merge it\); will be re-versioned to 0\.4\.13$/);
  assert.match(s.comments()[0][1], /^Passed over by the Steward: main reached v0\.4\.11 before this PR merged \(it waits for its author to vouch for it and merge it\), so it needs a new version\. On its next round the Steward claims it the next free version/);
  const again = await s.pass(rows, T0 + 95 * MIN);
  assert.deepEqual(again.map((r) => r.version), ['0.4.13']);
  assert.equal(JSON.parse(s.show('claude/a', 'package.json')).version, '0.4.13');
  assert.deepEqual((await s.shared()).map((c) => [c.version, c.passed?.from]), [['0.4.13', '0.4.11']]);
});

test("a branch's claim main passed holds while its PR is open, and the branch's next claim takes its place", async () => {
  const facts = { branchVersion: '0.4.12', released: ['0.4.10'], openBranches: ['claude/a'], openVersions: [], now: T0 };
  assert.equal(C.stillHeld(claim('0.4.11', 'claude/a'), facts), true);
  assert.equal(C.stillHeld(claim('0.4.11', 'claude/merged'), facts), false);
  assert.equal(C.stillHeld({ ...claim('2.1.0', 'claude/a'), repo: `${REPO}#kit` }, { ...facts, released: ['2.1.0'] }), false, "a kit's isn't");
  // Its author claims again for it (as the owner did by hand for CastellanSite#114): a new version, the old one gone.
  const s = line('reclaimed');
  await s.claims([claim('0.4.11', 'claude/a', { passed: passedMark(s.a) })]);
  s.merge('claude/b');
  s.setOpen([{ title: 'Fake 0.4.11: A fix.', headRefName: 'claude/a' }]);
  const c = await C.claimVersion(s.ctx, employee(s.checkout), { branch: 'claude/a', by: 'claude', for: 'a fix', remote: s.remote });
  assert.deepEqual([c.claim.version, c.again, c.claim.passed], ['0.4.13', false, undefined]);
  assert.deepEqual((await s.shared()).map((x) => x.version), ['0.4.13']);
});

// The catch-up's resolving, from the version queue's before Steward 0.36.124.
const conflict = (ours: string[], base: string[], theirs: string[]) => ['{', '<<<<<<< HEAD', ...ours, '||||||| abc1234', ...base, '=======', ...theirs, '>>>>>>> origin/main', '}'].join('\n');

test('a conflict where one side changed only versions gives way to the other; any other conflict is left', () => {
  const lock = conflict(['      "version": "0.4.11",'], ['      "version": "0.4.10",'], ['      "version": "0.4.10",', '      "license": "UNLICENSED",']);
  assert.equal(resolveVersionConflicts(lock), '{\n      "version": "0.4.10",\n      "license": "UNLICENSED",\n}');
  assert.equal(resolveVersionConflicts(conflict(['  "version": "0.4.11",'], ['  "version": "0.4.10",'], ['  "version": "0.4.12",'])), '{\n  "version": "0.4.12",\n}');
  assert.equal(resolveVersionConflicts(conflict(['  "version": "0.4.11",', '  "type": "module",'], ['  "version": "0.4.10",'], ['  "version": "0.4.10",', '  "license": "UNLICENSED",'])), null);
  assert.equal(resolveVersionConflicts(['<<<<<<< HEAD', 'a 1.0.1', '=======', 'a 1.0.2', '>>>>>>> main'].join('\n')), null);
  assert.equal(resolveVersionConflicts('no conflicts\r\nhere'), 'no conflicts\r\nhere');
});

test("the changelog: the PR's new entry goes above the branch's, under the version it ends up with; anything else is left", () => {
  const base = log(['0.4.0', 'The first.']);
  const ours = log(['0.4.1', 'A feature.\n- and its detail'], ['0.4.0', 'The first.']);
  const theirs = log(['0.4.1', 'All rights reserved.'], ['0.4.0', 'The first.']);
  assert.equal(mergeChangelogs(base, ours, theirs, '0.4.2'), log(['0.4.2', 'A feature.\n- and its detail'], ['0.4.1', 'All rights reserved.'], ['0.4.0', 'The first.']));
  assert.ok(mergeChangelogs(base.replace(/\n/g, '\r\n'), ours, theirs.replace(/\n/g, '\r\n'), '0.4.2')!.includes('\r\n## 0.4.2\r\n'));
  assert.equal(mergeChangelogs(base, log(['0.4.1', 'a'], ['0.4.0', 'Ours.']), log(['0.4.1', 'b'], ['0.4.0', 'Theirs.']), '0.4.2'), null);
  assert.equal(mergeChangelogs(base, log(['0.4.2', 'b'], ['0.4.1', 'a'], ['0.4.0', 'The first.']), theirs, '0.4.3'), null);
  // Renamed alone (no conflict): only when the top entry is the one that names the PR's old version.
  assert.equal(renumberChangelog(ours, '0.4.1', '0.4.2'), ours.replace('## 0.4.1', '## 0.4.2'));
  assert.equal(renumberChangelog(theirs, '0.4.3', '0.4.4'), null);
});

test('a lock is settled with package.json only while it says the same version', () => {
  const dir = mkdtempSync(path.join(home, 'settled-'));
  writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "fake",\n  "version": "0.4.1"\n}\n');
  const lockAt = (v: string) => writeFileSync(path.join(dir, 'package-lock.json'), `{\n  "name": "fake",\n  "version": "${v}",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "fake",\n      "version": "${v}"\n    }\n  }\n}\n`);
  lockAt('0.4.1');
  assert.deepEqual(settledFiles(dir, ['package.json']), ['package.json', 'package-lock.json']);
  lockAt('0.3.9');
  assert.deepEqual(settledFiles(dir, ['package.json']), ['package.json']);
  assert.deepEqual(lockBeside(['Package.json']), ['package-lock.json']);
});
