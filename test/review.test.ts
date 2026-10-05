import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The Steward's look at the Wright's drafts: what passes is marked ready and goes on as any team PR; what doesn't
// stays a draft for the person, and says why.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-review-'));
process.env.STEWARD_HOME = home;
// Whether the Bailiff is installed on this PC decides nothing here: each test says.
process.env.BAILIFF_HOME = path.join(home, 'no-bailiff');
after(() => rmSync(home, { recursive: true, force: true }));

const { dependenciesOf, dependencyHold, isWrightDraft, reviewHold, sensitiveFiles } = await import('../src/review.ts');
const { holdReason, lookAtWrightDrafts } = await import('../src/stages/merge.ts');
const { DEFAULT_SETTINGS } = await import('../src/settings.ts');
const { ctxFor, employee, fakeEmployee, ok, runner, sh } = await import('./helpers.ts');
type PrInfo = import('../src/stages/staff.ts').PrInfo;

const s = DEFAULT_SETTINGS.wrightReview;
const pr = (o: Partial<PrInfo> = {}): PrInfo => ({ number: 14, title: 'Surveyor 0.2.3: x', url: 'https://github.com/Jcollier0120/Fake/pull/14', head: 'wright/13-x', base: 'main', author: 'Jcollier0120', whose: 'team', headOid: '', after: null, afterError: null, mergeable: 'MERGEABLE', mergeState: 'CLEAN', draft: true, checks: 'none', labels: ['wright'], changed: 24, files: ['README.md', 'src/settings.ts', 'test/settings.test.ts'], ...o });

test("only the Wright's drafts are looked at: labelled wright, opened by the team, still drafts", () => {
  assert.equal(isWrightDraft(pr()), true);
  assert.equal(isWrightDraft(pr({ labels: [] })), false, 'a draft of your own is yours');
  assert.equal(isWrightDraft(pr({ draft: false })), false);
  assert.equal(isWrightDraft(pr({ whose: 'steward' })), false);
});

test('the look: wright:needs-you, a file a person reviews, too large, or no files listed, each keeps it for you', () => {
  assert.equal(reviewHold(pr(), s), null, "the Wright's first job (Surveyor #14) passes");
  assert.equal(reviewHold(pr({ labels: ['wright', 'wright:needs-you'] }), s), 'the Wright labelled it wright:needs-you');
  assert.match(reviewHold(pr({ files: ['src/app.ts', 'jobs/fast-forward.ps1'] }), s)!, /a person reviews: jobs\/fast-forward\.ps1$/, 'checked here again, not only trusted from its label');
  assert.match(reviewHold(pr({ files: ['HEI.Agent/Installer.cs'] }), s)!, /Installer\.cs/);
  assert.match(reviewHold(pr({ changed: 900 }), s)!, /900 lines, over the 600/);
  assert.match(reviewHold(pr({ files: [] }), s)!, /no files/);
  assert.deepEqual(sensitiveFiles(['tools/kit.ts', 'kit.json', '.github/workflows/ci.yml', 'src/view.ts'], s.sensitive), ['tools/kit.ts', 'kit.json', '.github/workflows/ci.yml']);
});

test('dependencies: the fields compared, in any order; a new one, or a version moved, is a change', () => {
  const a = '{ "name": "x", "version": "1.0.0", "devDependencies": { "typescript": "^7.0.2", "@types/node": "^22.20.4" } }';
  assert.equal(dependenciesOf(a), dependenciesOf('{ "version": "1.0.1", "devDependencies": { "@types/node": "^22.20.4", "typescript": "^7.0.2" } }'), 'a version raised is no dependency change');
  assert.notEqual(dependenciesOf(a), dependenciesOf('{ "devDependencies": { "typescript": "^7.0.2", "@types/node": "^22.20.4", "left-pad": "1.0.0" } }'));
  assert.equal(dependenciesOf('not json'), null);
});

test("a draft that passes is marked ready with a comment saying what was looked at; one that doesn't says why in its hold", async () => {
  const r = runner((args) => (args[0] === 'pr' && (args[1] === 'ready' || args[1] === 'comment') ? ok('') : undefined));
  const e = employee(path.join(home, 'nowhere'), { repo: 'Jcollier0120/Fake' });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(home, 'work'), run: r.run, neutralDir: home });
  const good = pr();
  const risky = pr({ number: 15, files: ['jobs/fast-forward.ps1'] });
  const mine = pr({ number: 16, labels: [] });
  await lookAtWrightDrafts(ctx, e, [good, risky, mine]);
  assert.deepEqual(r.gh.filter((a) => a[1] === 'ready'), [['pr', 'ready', '14', '--repo', 'Jcollier0120/Fake']]);
  assert.match(r.gh.find((a) => a[1] === 'comment')!.at(-1)!, /The Steward looked at this draft from the Wright and marked it ready[\s\S]*3 files[\s\S]*24 lines changed/);
  assert.deepEqual([good.draft, risky.draft, mine.draft], [false, true, true]);
  assert.equal(holdReason(good, 'main'), null, 'it goes on as any ready team PR');
  assert.match(holdReason(risky, 'main')!, /^a draft from the Wright, waiting for you: it changes what a person reviews/);
  assert.equal(holdReason(mine, 'main'), 'a draft', "a draft of your own isn't the Steward's to look at");
  assert.match(ctx.lines.join('\n'), /the Wright's #14: looked at, and marked ready/);
});

test("a draft that changes package.json's dependencies stays for you; one that only raises the version passes (real git)", async () => {
  const f = fakeEmployee(path.join(home, 'deps'));
  const e = employee(f.checkout, { repo: 'Jcollier0120/Fake' });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(home, 'work'), run: runner().run, neutralDir: home });
  const push = (n: number, edit: (pkg: any) => void) => {
    sh(f.checkout, 'switch', '--quiet', '-c', `wright/${n}`, 'origin/main');
    const file = path.join(f.checkout, 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    edit(pkg);
    writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
    sh(f.checkout, 'commit', '--quiet', '-am', `pr ${n}`);
    const oid = sh(f.checkout, 'rev-parse', 'HEAD');
    sh(f.checkout, 'push', '--quiet', 'origin', `${oid}:refs/pull/${n}/head`);
    sh(f.checkout, 'switch', '--quiet', 'main');
    return oid;
  };
  const bumped = push(20, (p) => (p.version = '0.4.1'));
  const added = push(21, (p) => (p.dependencies = { 'left-pad': '1.3.0' }));
  assert.equal(await dependencyHold(ctx, e, pr({ number: 20, headOid: bumped, files: ['package.json'] })), null);
  assert.equal(await dependencyHold(ctx, e, pr({ number: 21, headOid: added, files: ['package.json'] })), 'it changes the dependencies in package.json');
  assert.equal(await dependencyHold(ctx, e, pr({ number: 22, files: ['README.md'] })), null, 'no package.json, nothing to compare');
});

test("the Bailiff's verdict: its last marked comment by the team; a stranger's marker or a broken one counts for nothing", async () => {
  const { bailiffVerdict } = await import('../src/review.ts');
  const H = 'a'.repeat(40);
  const mark = (head: string, verdict: string) => `**The Bailiff's review**\n\n<!-- bailiff-review {"head":"${head}","verdict":"${verdict}"} -->`;
  const by = (login: string, body: string) => ({ author: { login }, body });
  assert.deepEqual(bailiffVerdict([by('Jcollier0120', mark('b'.repeat(40), 'changes')), by('Jcollier0120', mark(H, 'approved'))], ['jcollier0120']), { head: H, verdict: 'approved' });
  assert.deepEqual(bailiffVerdict([by('Jcollier0120', mark(H, 'changes')), by('stranger', mark(H, 'approved'))], ['Jcollier0120']), { head: H, verdict: 'changes' }, "a stranger's marker is no approval");
  assert.equal(bailiffVerdict([by('Jcollier0120', `${mark(H, 'approved')}\n\nand then more words`)], ['Jcollier0120']), null, 'the marker must end the comment');
  assert.equal(bailiffVerdict([by('Jcollier0120', '<!-- bailiff-review {not json} -->')], ['Jcollier0120']), null);
  assert.equal(bailiffVerdict('nonsense', ['Jcollier0120']), null);
});

test("with the Bailiff installed, a Wright draft that passes the look is marked ready only once the Bailiff approved its head commit", async () => {
  const H = 'c'.repeat(40);
  const OLD = 'd'.repeat(40);
  const marked = (head: string, verdict: string) => ({ author: { login: 'Jcollier0120' }, body: `review\n\n<!-- bailiff-review {"head":"${head}","verdict":"${verdict}"} -->` });
  const views: Record<string, unknown> = {
    '30': { headRefOid: H, comments: [marked(H, 'approved')] },
    '31': { headRefOid: H, comments: [marked(OLD, 'approved')] },
    '32': { headRefOid: 'e'.repeat(40), comments: [marked(H, 'approved')] },
    '33': { headRefOid: H, comments: [marked(H, 'changes')] },
  };
  const r = runner((args) => (args[0] === 'pr' && args[1] === 'view' ? ok(views[args[2]]) : args[0] === 'pr' && (args[1] === 'ready' || args[1] === 'comment') ? ok('') : undefined));
  const e = employee(path.join(home, 'nowhere'), { repo: 'Jcollier0120/Fake' });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(home, 'work'), run: r.run, neutralDir: home });
  const approved = pr({ number: 30, headOid: H, labels: ['wright', 'bailiff:approved'] });
  const stale = pr({ number: 31, headOid: H, labels: ['wright', 'bailiff:approved'] });
  const moved = pr({ number: 32, headOid: H, labels: ['wright', 'bailiff:approved'] });
  const contradicted = pr({ number: 33, headOid: H, labels: ['wright', 'bailiff:approved'] });
  const unreviewed = pr({ number: 34, headOid: H });
  const changes = pr({ number: 35, headOid: H, labels: ['wright', 'bailiff:changes'] });
  const waiting = pr({ number: 36, headOid: H, labels: ['wright', 'bailiff:waiting'] });
  const risky = pr({ number: 37, headOid: H, labels: ['wright', 'bailiff:approved'], files: ['jobs/fast-forward.ps1'] });
  const all = [approved, stale, moved, contradicted, unreviewed, changes, waiting, risky];
  await lookAtWrightDrafts(ctx, e, all, true);
  assert.deepEqual(r.gh.filter((a) => a[1] === 'ready'), [['pr', 'ready', '30', '--repo', 'Jcollier0120/Fake']], 'only the one approved at its head');
  assert.ok(r.gh.find((a) => a[1] === 'comment')!.at(-1)!.includes(`the Bailiff approved its head commit, ${H.slice(0, 7)}`));
  assert.deepEqual(all.map((p) => p.draft), [false, true, true, true, true, true, true, true]);
  assert.equal(holdReason(approved, 'main'), null);
  assert.equal(stale.bailiffHold, `the Bailiff approved ${OLD.slice(0, 7)}, not its head ${H.slice(0, 7)}: waiting for its review of the new commit`);
  assert.equal(moved.bailiffHold, 'its head moved since the round listed it: the next round looks again');
  assert.equal(contradicted.bailiffHold, "labelled bailiff:approved, but the Bailiff's last review doesn't approve it");
  assert.equal(holdReason(unreviewed, 'main'), "a draft from the Wright, with the Bailiff: waiting for the Bailiff's review");
  assert.equal(changes.bailiffHold, 'the Bailiff asked for changes (its comment says which)');
  assert.equal(waiting.bailiffHold, "the Bailiff couldn't review it yet (its comment says why)");
  assert.ok(risky.reviewHold && !risky.bailiffHold, "the Steward's own look comes first: an approval never overrides it");
  assert.deepEqual(r.gh.filter((a) => a[1] === 'view').map((a) => a[2]), ['30', '31', '32', '33'], 'GitHub is asked only for the ones labelled approved that passed the look');

  // Without the Bailiff, nothing changes: the look alone marks it ready.
  const r2 = runner((args) => (args[0] === 'pr' && (args[1] === 'ready' || args[1] === 'comment') ? ok('') : undefined));
  const plain = pr({ number: 40, headOid: H });
  await lookAtWrightDrafts(ctxFor({ employees: [e], workRoot: path.join(home, 'work'), run: r2.run, neutralDir: home }), e, [plain]);
  assert.deepEqual(r2.gh.filter((a) => a[1] === 'ready'), [['pr', 'ready', '40', '--repo', 'Jcollier0120/Fake']]);
  assert.ok(!r2.gh.find((a) => a[1] === 'comment')!.at(-1)!.includes('Bailiff'));
});
