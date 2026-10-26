import { after, claimsOn, claimVersion, highest, loadClaims, markClaim, titleVersions, type Claim, type Hold, type InLine, type PassedOver } from './claims.ts';
import type { Condition } from './alarms.ts';
import { compareVersions } from './kitfiles.ts';
import { loadTurns, remoteFor } from './lease.ts';
import type { RemoteRepo } from './remote-ref.ts';
import type { Employee } from './settings.ts';
import { reversion, type Reversioned } from './stages/catchup.ts';
import { result, type Ctx, type EmployeeResult } from './stages/common.ts';
import { kitClaimKey, kitTitleVersions } from './stages/kitpart.ts';
import type { PrInfo, StaffRow } from './stages/staff.ts';
import { whenWords } from './stages/standin.ts';
import { hostFor } from './hosts/index.ts';

/**
 * A PR that holds up the versions after it, passed over after an hour (Steward 0.36.247, from Steward#173).
 *
 * Versions are claimed before the work starts (claims.ts), and each repository's PRs merge in the order of their
 * versions. A version merged below one already merged has to be claimed again. So the open PR on a repository's lowest
 * claim is next in line, and every PR above it waits on it. A PR that can't move used to hold them all for hours
 * (CastellanSite#43: five). It might have failing or never-finishing checks, a conflict, be a draft, wait for the owner
 * first, or wait for an author who has gone. CastellanSite#114, passed by main's 0.1.105 at 0.1.104, was put right by
 * hand on 2026-10-26. Steward#173 asked for this when the Steward still merged PRs in a version queue; since 0.36.124
 * their authors merge them, so this is built on the claims.
 *
 * - **Next in line**: of a repository's live claims whose branch has an open team PR from the repository itself into its
 *   branch, the lowest above main's version and every release, not passed over. Its claim is marked `line`: the PR,
 *   its head, what holds it (holdOf) and since when. The same head and hold keep that time; anything else starts it
 *   again, and a claim no longer next loses the mark.
 * - **Stuck**: next in line with the same head and hold for STUCK_MS. Its claim is marked `passed`, and the next claim
 *   up is next in line. The page, the alarm and `steward claims` say "stuck since …, passed over; will be re-versioned
 *   to x.y.z". The PR is told, unless it waits for the owner. One whose version main or a release reached before it
 *   merged, its authors merging out of order, is passed over at once: its claim holds while its PR is open
 *   (claims.ts' stillHeld).
 * - **Re-versioned**: once main or a release reaches its version, its claim moves to the next free version (claimVersion's
 *   move: one write to the claims ref, so no other PC hands that version out). Its branch is caught up with main and
 *   given that version: its version files, its changelog entry (CHANGELOG.md's top, or changes/<version>.md) and its
 *   title (stages/catchup.ts). This is pushed, and the PR is told.
 * - **Caught up**: while it stays passed over, each round that finds main moved catches it up again, and gives it a new
 *   version again once main passes it.
 * - **Taken back**: when its author pushed (a head neither the one it was stuck at nor the Steward's own), or what held it
 *   ended: nothing holds it now but its author, the owner labelled it owner-done, or it is no longer a draft. Its mark
 *   goes. Where main passed it, it is re-versioned once more to the next free version. One still above main keeps its
 *   version and its place. The PR is told to vouch and merge once the versions below it have merged: the Steward merges
 *   nothing.
 *
 * A PR waiting for the owner first (labelled owner-first without owner-done, or changing a migration) is marked and
 * shown, and nothing more: no comment, no push, until the owner is done. Nor is a draft, or a PR that raises the kit
 * too (its kit version has its own claims), pushed to; their authors are told what to do.
 *
 * Only the PC whose turn it is on the repository (lease.ts) looks at its line, so two PCs never push to the same PR.
 * The marks live in the repository's claims ref, so every PC shows them.
 */

/** How long the PR next in line may make no progress before it is passed over. */
export const STUCK_MS = 60 * 60_000;

export const OWNER_FIRST_LABEL = 'owner-first';
export const OWNER_DONE_LABEL = 'owner-done';

/** A repository as the staff's table has it (stages/staff.ts), as much as the line needs. */
export type LineRow = Pick<StaffRow, 'id' | 'name' | 'repo' | 'branch'> & { main: { commit: string; version: string | null } | null; release: { version: string } | null; prs: PrInfo[] };

/** Why a PR waits for the owner first, or null: labelled owner-first without owner-done, or it changes a migration. Pure. */
export function ownerFirst(pr: Pick<PrInfo, 'labels' | 'files'>): string | null {
  if (pr.labels.includes(OWNER_DONE_LABEL)) return null;
  if (pr.labels.includes(OWNER_FIRST_LABEL)) return `it waits for the owner first (labelled ${OWNER_FIRST_LABEL})`;
  const files = pr.files.filter((f) => /\.sql$/i.test(f) || /(^|\/)migrations\//i.test(f.replace(/\\/g, '/')));
  return files.length ? `it changes ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}, which may need the owner first` : null;
}

/** What holds a PR next in line, as GitHub has it; 'author' when nothing does but its author vouching and merging. Pure. */
export function holdOf(pr: Pick<PrInfo, 'labels' | 'files' | 'draft' | 'mergeable' | 'mergeState' | 'checks' | 'base'>): Hold {
  const owner = ownerFirst(pr);
  if (owner) return { kind: 'owner', why: owner };
  if (pr.draft) return { kind: 'draft', why: 'it is a draft' };
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') return { kind: 'conflict', why: `it conflicts with ${pr.base}` };
  if (pr.checks === 'failing') return { kind: 'failing', why: 'its checks fail' };
  if (pr.checks === 'pending') return { kind: 'pending', why: "its checks haven't finished" };
  if (pr.mergeable === 'UNKNOWN') return { kind: 'unknown', why: "GitHub hasn't said whether it merges" };
  return { kind: 'author', why: 'it waits for its author to vouch for it and merge it' };
}

/** What takes a PR passed over for `kind` back into the line, in words. */
const backWhen = (kind: Hold['kind']) =>
  kind === 'owner' ? `the owner labels it ${OWNER_DONE_LABEL}` : kind === 'draft' ? 'it is marked ready for review' : kind === 'author' ? 'its author pushes to it' : 'nothing holds it but its author, or its author pushes to it';

/**
 * Why the Steward leaves a passed-over PR to the owner or its author rather than push to it, or null: it waits for the
 * owner first, it is a draft, or it raises the kit too (a kit version in its title, or a kit claim for its branch).
 */
export function leftAlone(e: Pick<Employee, 'repo'>, pr: PrInfo, claims: Claim[] = loadClaims()): string | null {
  if (ownerFirst(pr)) return 'it waits for the owner first, so the Steward leaves it to them';
  if (pr.draft) return 'it is a draft, so its author re-versions it';
  if (kitTitleVersions([pr.title]).length || claimsOn(kitClaimKey(e.repo), claims).some((c) => c.branch === pr.head)) return 'it raises the kit too, so its author re-versions it (claim-version for the kit and for the repository)';
  return null;
}

/** What to do about the claims of one repository's line this round (planLine). */
export type Step =
  | { kind: 'watch'; claim: Claim; line: InLine }
  | { kind: 'unwatch'; claim: Claim }
  | { kind: 'pass'; claim: Claim; pr: PrInfo; passed: PassedOver; passedBy: boolean }
  | { kind: 'keep'; claim: Claim; pr: PrInfo; passedBy: boolean }
  | { kind: 'back'; claim: Claim; pr: PrInfo; passedBy: boolean; why: string };

/**
 * One repository's version line, as the module's comment says: the marks to set and take off, the PRs to pass over,
 * those passed over still stuck (`passedBy`: main or a release reached their version), and those to take back. Pure.
 */
export function planLine(o: { branch: string; main: string | null; released: string[]; prs: PrInfo[]; claims: Claim[]; now: number }): Step[] {
  const steps: Step[] = [];
  const top = highest([o.main, ...o.released]);
  const passedBy = (v: string) => !!top && compareVersions(top, v) >= 0;
  const prOf = (c: Claim) => (c.branch ? o.prs.find((p) => p.head === c.branch && p.whose === 'team' && !p.fork && p.base === o.branch && !!p.headOid) : undefined);
  const entries = o.claims.flatMap((claim) => {
    const pr = prOf(claim);
    return pr ? [{ claim, pr }] : [];
  });
  for (const { claim, pr } of entries) {
    const p = claim.passed;
    if (!p) continue;
    const hold = holdOf(pr);
    const back =
      pr.headOid !== p.head && pr.headOid !== p.pushed
        ? 'its author pushed to it'
        : hold.kind === 'author' && p.kind !== 'author'
          ? `nothing holds it now but its author (${p.why}, before)`
          : p.kind === 'owner' && hold.kind !== 'owner'
            ? 'the owner is done'
            : p.kind === 'draft' && hold.kind !== 'draft'
              ? 'it is no longer a draft'
              : null;
    steps.push(back ? { kind: 'back', claim, pr, passedBy: passedBy(claim.version), why: back } : { kind: 'keep', claim, pr, passedBy: passedBy(claim.version) });
  }
  const at = new Date(o.now).toISOString();
  // Passed by main or a release before it was passed over, its authors merging out of order (CastellanSite#114):
  // passed over now, and re-versioned on the next round.
  for (const { claim, pr } of entries) {
    if (claim.passed || !passedBy(claim.version)) continue;
    const hold = holdOf(pr);
    const since = claim.line?.pr === pr.number ? claim.line.since : at;
    steps.push({ kind: 'pass', claim, pr, passedBy: true, passed: { pr: pr.number, url: pr.url, since, at, head: pr.headOid, kind: hold.kind, why: `${o.branch} reached v${claim.version} before it merged; ${hold.why}`, from: claim.version } });
  }
  const line = entries.filter((x) => !x.claim.passed && !passedBy(x.claim.version)).sort((a, b) => compareVersions(a.claim.version, b.claim.version));
  let i = 0;
  for (; i < line.length; i++) {
    const { claim, pr } = line[i];
    const hold = holdOf(pr);
    const l = claim.line;
    if (!l || l.pr !== pr.number || l.head !== pr.headOid || l.kind !== hold.kind || l.why !== hold.why) {
      steps.push({ kind: 'watch', claim, line: { pr: pr.number, since: at, head: pr.headOid, ...hold } });
      break;
    }
    if (o.now - Date.parse(l.since) < STUCK_MS) break;
    // Stuck: passed over, and the next one up is next in line.
    steps.push({ kind: 'pass', claim, pr, passedBy: false, passed: { pr: pr.number, url: pr.url, since: l.since, at, head: pr.headOid, ...hold, from: claim.version } });
  }
  for (const { claim } of line.slice(i + 1)) if (claim.line) steps.push({ kind: 'unwatch', claim });
  return steps;
}

/** The version a PR passed over would get now: the next above main's, the latest release, every open PR's and every claim's. Pure. */
export function nextFreeFor(row: Pick<LineRow, 'name' | 'main' | 'release' | 'prs'>, claims: Claim[]): string | null {
  const top = highest([row.main?.version, row.release?.version, ...titleVersions(row.name, row.prs.map((p) => p.title)), ...claims.map((c) => c.version)]);
  return top ? after(top) : null;
}

/** A PR passed over, for the page, the alarms and `steward claims`. */
export interface PassedLine {
  id: string;
  name: string;
  repo: string;
  branch: string;
  pr: number;
  url: string;
  /** Its claim's version now, and the one it had when passed over. */
  version: string;
  from: string;
  since: string;
  kind: Hold['kind'];
  why: string;
  /** The version it would be given now. */
  next: string | null;
  note?: string;
  /** Why the Steward leaves it to the owner or its author (leftAlone), or null. */
  alone: string | null;
}

/** The PRs passed over in the repositories of the staff's table, by their claims (every PC's copies). */
export function passedLines(rows: LineRow[], claims: Claim[] = loadClaims()): PassedLine[] {
  return rows.flatMap((row) => {
    const mine = claimsOn(row.repo, claims);
    return mine.flatMap((c) => {
      const pr = c.passed && row.prs.find((p) => p.head === c.branch && p.number === c.passed!.pr);
      if (!pr || !c.passed) return [];
      const p = c.passed;
      return [{ id: row.id, name: row.name, repo: row.repo, branch: row.branch, pr: p.pr, url: p.url, version: c.version, from: p.from, since: p.since, kind: p.kind, why: p.why, next: nextFreeFor(row, mine), ...(p.note ? { note: p.note } : {}), alone: leftAlone(row, pr, claims) }];
    });
  });
}

/**
 * "Fake #21 (v0.4.11): stuck since 14:05, passed over (its checks fail); will be re-versioned to 0.4.15", or once it
 * was, "Fake #21 (v0.4.15, from 0.4.11): stuck since 14:05, passed over (…); re-versioned, kept caught up with main".
 */
export function passedWords(l: PassedLine, now = Date.now()): string {
  const v = l.version === l.from ? `v${l.version}` : `v${l.version}, from ${l.from}`;
  const then = l.version === l.from ? `will be re-versioned to ${l.next ?? 'the next free version'}` : `re-versioned, kept caught up with ${l.branch}`;
  return `${l.name} #${l.pr} (${v}): stuck since ${whenWords(l.since, now)}, passed over (${l.why}); ${then}${l.alone ? `: ${l.alone}` : ''}`;
}

/** What takes a passed-over PR back into the line, for its alarm. */
function backLine(l: PassedLine): string {
  if (l.kind === 'owner') return `Do what it needs first (a migration to run, say), then label it ${OWNER_DONE_LABEL}: it is taken back into the line, re-versioned where main passed it. The Steward never merges it.`;
  if (l.kind === 'draft') return 'Mark it ready for review: it is taken back into the line, re-versioned where main passed it.';
  if (l.kind === 'author') return 'Push to it, or close it: once its author pushes, it is taken back into the line, re-versioned where main passed it.';
  return 'Fix it and push to its branch: it is taken back into the line once nothing holds it but its author, re-versioned where main passed it.';
}

/** Each PR passed over, as an alarm at once: the page's line, the Steward's last look, and what takes it back. */
export function passedConditions(lines: PassedLine[], now = Date.now()): Condition[] {
  return lines.map((l) => ({
    id: `passedover:${l.repo.toLowerCase()}#${l.pr}`,
    who: l.id,
    title: `${l.name} #${l.pr} is stuck, passed over: ${l.why}`,
    detail: [`${passedWords(l, now)}.`, ...(l.note ? [`The Steward's last look: ${l.note}.`] : []), backLine(l)],
    url: l.url,
    since: l.since,
    afterMs: 0,
  }));
}

export interface PassOverOptions {
  /** Settings' employees, and the Steward's own when it releases itself. */
  employees: Employee[];
  now?: number;
  /** A repository's claims ref (lease.ts remoteFor); none under node --test unless given. */
  remote?: (e: Employee) => Promise<RemoteRepo | null>;
}

/**
 * Each repository's version line looked at once a round, as the module's comment says, from the staff's table: what
 * was passed over, re-versioned or taken back, for the round's results. A repository whose turn is another PC's is left
 * to it. Never throws for one repository's trouble: it is logged, and the next round tries again.
 */
export async function passOver(ctx: Ctx, rows: LineRow[], o: PassOverOptions): Promise<EmployeeResult[]> {
  const now = o.now ?? Date.now();
  const out: EmployeeResult[] = [];
  const turns = loadTurns().repos;
  for (const row of rows) {
    const e = o.employees.find((x) => x.id === row.id && x.repo.toLowerCase() === row.repo.toLowerCase());
    if (!e || !row.main?.version) continue;
    if (turns[e.repo.toLowerCase()]?.status === 'elsewhere') continue;
    const steps = planLine({ branch: e.branch, main: row.main.version, released: row.release ? [row.release.version] : [], prs: row.prs, claims: claimsOn(e.repo), now });
    if (!steps.length) continue;
    const remote = o.remote ? await o.remote(e).catch(() => null) : process.env.NODE_TEST_CONTEXT ? null : await remoteFor(ctx.run, ctx.settings, e).catch(() => null);
    for (const s of steps) {
      try {
        const r = await take(ctx, e, row, s, remote, now);
        if (r) out.push(r);
      } catch (err) {
        ctx.log(`[${e.id}] its version line: ${(err as Error).message}`);
      }
    }
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One step of a repository's line taken. */
async function take(ctx: Ctx, e: Employee, row: LineRow, s: Step, remote: RemoteRepo | null, now: number): Promise<EmployeeResult | null> {
  const { run } = ctx;
  if (s.kind === 'watch') {
    if (await markClaim(run, remote, s.claim, { line: s.line })) ctx.log(`[${e.id}] #${s.line.pr} (v${s.claim.version}) is next in line: ${s.line.why}`);
    return null;
  }
  if (s.kind === 'unwatch') {
    await markClaim(run, remote, s.claim, { line: undefined });
    return null;
  }
  const host = hostFor(ctx, e);
  const say = (body: string) => host.commentPr(e.repo, s.pr.number, body).catch(() => null);
  if (s.kind === 'pass') {
    if (!(await markClaim(run, remote, s.claim, { passed: s.passed, line: undefined }))) return null;
    const alone = leftAlone(e, s.pr);
    const next = nextFreeFor(row, claimsOn(e.repo));
    const words = passedWords({ id: e.id, name: e.name, repo: e.repo, branch: e.branch, pr: s.pr.number, url: s.pr.url, version: s.claim.version, from: s.claim.version, since: s.passed.since, kind: s.passed.kind, why: s.passed.why, next, alone }, now);
    if (!ownerFirst(s.pr)) {
      const was = s.passedBy
        ? `${e.branch} reached v${s.claim.version} before this PR merged (${holdOf(s.pr).why}), so it needs a new version.`
        : `this PR has been next in line at v${s.claim.version} since ${whenWords(s.passed.since, now)} with no progress (${s.passed.why}), so the PRs above it in the version line merge first.`;
      const then = alone
        ? `${cap(alone)}.`
        : s.passedBy
          ? `On its next round the Steward claims it the next free version, catches it up with ${e.branch} and keeps it caught up: pull before you push to it.`
          : `Once ${e.branch} passes v${s.claim.version}, the Steward claims it the next free version, catches it up with ${e.branch} and keeps it caught up: pull before you push to it.`;
      await say(`Passed over by the Steward: ${was} ${then} It is taken back into the line once ${backWhen(s.passed.kind)}.`);
    }
    return result(e, 'done', words, { url: s.pr.url, version: s.claim.version });
  }
  const p = s.claim.passed!;
  const alone = leftAlone(e, s.pr);
  if (s.kind === 'keep') {
    if (alone || (!s.passedBy && row.main?.commit === p.main)) return null;
    const { claim, r } = await bringUp(ctx, e, s.claim, s.pr, s.passedBy, remote, `It was passed over at v${p.from}, stuck since ${p.since}: ${p.why}`);
    await markClaim(run, remote, claim, { passed: { ...p, main: row.main?.commit, note: r.note, ...(r.head ? { pushed: r.head } : {}) } });
    // Said on the PR the first time; after that, its commits say it.
    if (r.head && !p.pushed) await say(`Caught up by the Steward: ${r.note}. It is still passed over (stuck since ${whenWords(p.since, now)}: ${p.why}), and the Steward keeps it caught up with ${e.branch}, giving it the next free version whenever ${e.branch} passes its own: pull before you push to it. It is taken back into the line once ${backWhen(p.kind)}.`);
    return r.head || !r.done ? result(e, r.done ? 'done' : 'skipped', `#${s.pr.number}, passed over: ${r.note}`, { url: s.pr.url, version: claim.version }) : null;
  }
  // Taken back: re-versioned where main passed it, then its marks go. Its author's branch is left as it is otherwise.
  let claim = s.claim;
  let r: Reversioned | null = null;
  if (!alone && s.passedBy) ({ claim, r } = await bringUp(ctx, e, s.claim, s.pr, s.passedBy, remote, `It is taken back into the line: ${s.why}`));
  if (!(await markClaim(run, remote, claim, { passed: undefined, line: undefined }))) return null;
  const did = !r ? '' : r.head ? ` ${cap(r.note)}.` : r.done ? '' : ` The Steward couldn't catch it up (${r.note}): merge ${e.branch} into it${r.from && r.from !== claim.version ? ` and set v${claim.version} in its version files and changelog entry` : ''}.`;
  const left = alone && s.passedBy ? ` ${e.branch} has passed v${claim.version}: claim it a new version (claim-version) and set it in its version files and changelog entry.` : '';
  if (!ownerFirst(s.pr)) await say(`Taken back into the line by the Steward at v${claim.version}: ${s.why}.${did}${left} Vouch for it (steward vouch ${s.pr.number}) and merge it once the versions below it have merged: the Steward merges nothing.`);
  return result(e, 'done', `#${s.pr.number} taken back into the line at v${claim.version}: ${s.why}${r?.head ? `; ${r.note}` : ''}`, { url: s.pr.url, version: claim.version });
}

/**
 * A passed-over PR brought up to date: where main passed its version (`passedBy`), its claim moved to the next free one
 * (through the claims ref when there is one), then its branch caught up with main at its claim's version
 * (stages/catchup.ts). The claim it carries now, and what the catch-up did.
 */
async function bringUp(ctx: Ctx, e: Employee, claim: Claim, pr: PrInfo, passedBy: boolean, remote: RemoteRepo | null, why: string): Promise<{ claim: Claim; r: Reversioned }> {
  let c = claim;
  if (passedBy) {
    const moved = await claimVersion(ctx, e, { branch: pr.head, by: claim.by, for: claim.for, move: claim, marks: { passed: claim.passed }, remote });
    c = moved.claim;
    ctx.log(`[${e.id}] #${pr.number}: v${claim.version} was passed by ${e.branch}, so it is claimed v${c.version}`);
  }
  return { claim: c, r: await reversion(ctx, e, pr, c.version, { why }) };
}
