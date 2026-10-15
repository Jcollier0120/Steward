import { clearAlarm, queueAlarmId } from './alarms.ts';
import { claimVersion } from './claims.ts';
import { compareVersions } from './kitfiles.ts';
import { writeJson } from './kit/store.ts';
import type { Employee } from './settings.ts';
import { isKitPr } from './stages/catchup.ts';
import { hostIs, type Ctx } from './stages/common.ts';
import { holdReason } from './stages/merge.ts';
import { openPrs, parsePrs, type PrInfo } from './stages/staff.ts';
import { hostFor } from './hosts/index.ts';
import { inLine, loadVersionQueues, placeOf, queueHold, upcomingDrafts, versionQueuesFile, type VersionQueue } from './version-queue.ts';

/**
 * A PR that holds its repository's version queue, moved past the others in one click (Steward 0.36.52): the button on
 * the queue's alarm (alarms.ts; Manor's Needs you shows it too), on the page's Version queues card, or
 * `move-past <repo> <PR number>`.
 *
 * The merges take the lowest version first, and a draft keeps its place (the owner's rule), so a PR that isn't ready
 * holds every ready one above it (version-queue.ts's queueHold). Moving it gives it a version above the rest: its
 * branch's claim (claims.ts) is made again, above every version the queue's PRs set and every claim, marked as moved;
 * and its author is told on its PR. Nothing is pushed to its branch, which is its author's (a fork's, it may be, or one
 * the Steward can't push to): its files keep the version they had, and the claim says the rest. The merge stage lets a
 * moved PR that isn't ready give up its turn, and one that is ready wait its turn at its new version (merge.ts's
 * movedPast); once the PRs below it have merged, its catch-up gives it the version it was moved to (catchup.ts), or, for
 * one the Steward doesn't catch up, its author sets it. Claims are shared through the repository's claims ref, so every
 * PC's merges see the move.
 *
 * The drafts above it that would hold the queue next (QueueHold.drafts) are moved with it, each above the last, so one
 * move frees the queue. The queue kept is changed at once and the alarm cleared: the next round merges the PRs that
 * waited.
 */

/** A PR moved: from the version its files say to the one claimed for its branch. */
export interface Moved {
  number: number;
  url: string;
  from: string;
  to: string;
  /** Moved there already (asked again): nothing claimed or said again. */
  again: boolean;
  /** Its author was told on its PR (a comment). */
  told: boolean;
}

export interface MoveAnswer {
  /** 200 when one was moved (or had been); 404 when the PR isn't in the queue; 409 when there was nothing to move; 502 when GitHub couldn't be asked. */
  status: 200 | 404 | 409 | 502;
  message: string;
  moved: Moved[];
}

const list = (ns: number[]) => {
  const xs = ns.map((n) => `#${n}`);
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
};

/**
 * The comment on a moved PR. `caughtUp`: the Steward catches it up to its new version once it is ready (a team PR from
 * the repository itself, with catch-up on); else its author sets that version. Pure.
 */
export function movedComment(o: { name: string; branch: string; from: string; to: string; behind: number[]; caughtUp: boolean; files: string[] }): string {
  const waited = o.behind.length ? ` ${list(o.behind)} ${o.behind.length === 1 ? 'was' : 'were'} ready and waited behind its v${o.from}.` : '';
  const next = o.caughtUp
    ? `Nothing was pushed here. Once it's ready, the Steward catches it up with \`${o.branch}\` and sets v${o.to} itself, and it merges after them.`
    : `Nothing was pushed here. Before it's marked ready, set its version to v${o.to}${o.files.length ? ` (${o.files.join(', ')})` : ''}, with its changelog entry, so it merges in its new place.`;
  return `**Moved past the others by the Steward:** this PR held ${o.name}'s version queue. The Steward merges the lowest version first, and one that isn't ready holds its place.${waited} It was moved past them: v${o.to} is claimed for this branch now, and the PRs behind it merge first.\n\n${next}`;
}

/** A version queue kept, with the moves made: each moved PR in its new place, and what holds the queue now. Pure. */
export function withMoves(r: VersionQueue, moved: Pick<Moved, 'number' | 'to'>[], at: string): VersionQueue {
  const queue = inLine(r.queue.map((q) => {
    const m = moved.find((x) => x.number === q.number);
    return m && compareVersions(m.to, q.version) > 0 ? { ...q, moved: m.to } : q;
  }));
  const hold = queueHold(queue, at, { before: r.held });
  const ready = queue.filter((q) => q.ready);
  const { held: _was, ...rest } = r;
  return { ...rest, queue, working: queue[0] ? placeOf(queue[0]) : null, latest: ready.length ? placeOf(ready[ready.length - 1]) : null, ...(hold ? { held: hold } : {}) };
}

/**
 * Moves PR `number` of `e` past the others in its version queue, with the drafts that would hold it next when it is the
 * one holding it, as the module's comment says. `by`: who asked, for the claim ("steward" when the person clicked).
 */
export async function movePast(ctx: Ctx, e: Employee, number: number, o: { by?: string; now?: () => Date } = {}): Promise<MoveAnswer> {
  const at = (o.now?.() ?? new Date()).toISOString();
  if (hostIs(ctx, e) === 'git') return { status: 409, message: `${e.name} is worked with plain git: it has no pull requests to move`, moved: [] };
  const kept = loadVersionQueues();
  const r = kept.repos.find((x) => x.id === e.id);
  const first = r?.queue.find((q) => q.number === number);
  if (!r || !first) return { status: 404, message: `#${number} isn't in ${e.name}'s version queue as the last round found it: it sets no version above ${e.branch}'s, or it has merged or closed`, moved: [] };
  if (first.outside) return { status: 409, message: `#${number} isn't the team's or the Steward's: the merges never take it, so it holds nothing back`, moved: [] };
  const numbers = [number, ...(r.held?.number === number ? (r.held.drafts ?? []) : [])];
  // As GitHub has them now: still open, and still not ready. Everyone's, not only the team's, as the queue lists them.
  let raw: unknown[];
  try {
    raw = JSON.parse((await openPrs(hostFor(ctx, e), e.repo)) || '[]');
  } catch (err) {
    return { status: 502, message: `${e.name}'s pull requests couldn't be listed: ${(err as Error).message}`, moved: [] };
  }
  const authors = [...new Set(raw.map((p: any) => String(p?.author?.login ?? '')).filter(Boolean))];
  const prs = parsePrs(JSON.stringify(raw), authors);
  // The ones the Steward catches up itself (catchup.ts): a team PR from the repository itself, or a kit PR of its own.
  const caught = new Set(ctx.settings.catchUp ? parsePrs(JSON.stringify(raw), ctx.settings.team).filter((p) => (p.whose === 'team' || isKitPr(p)) && !p.fork).map((p) => p.number) : []);
  const behind = r.held?.number === number ? r.held.behind : r.queue.filter((q) => q.ready && compareVersions(placeOf(q), first.version) > 0).map((q) => q.number);
  const moved: Moved[] = [];
  const left: string[] = [];
  for (const n of numbers) {
    const pr: PrInfo | undefined = prs.find((p) => p.number === n);
    const q = r.queue.find((x) => x.number === n);
    if (!pr || !q) {
      left.push(`#${n} is no longer open`);
      continue;
    }
    if (n !== number && !pr.draft) {
      left.push(`#${n} isn't a draft any more`);
      continue;
    }
    if (holdReason(pr, e.branch) === null) {
      left.push(`#${n} is ready now: it merges in its turn, at v${q.version}`);
      continue;
    }
    // Above every version in line (the moves just made too), every claim, every release and the branch's.
    const above = [...r.queue.map(placeOf), ...moved.map((m) => m.to)];
    let claim;
    try {
      claim = await claimVersion(ctx, e, { branch: pr.head, by: o.by ?? 'steward', for: `#${n} moved past the others in ${e.name}'s version queue`, moved: n, above });
    } catch (err) {
      return { status: 502, message: `${moved.length ? `${movedWords(moved)}; but ` : ''}#${n} couldn't be given a version: ${(err as Error).message}`, moved: keep(e, r, moved, at) };
    }
    let told = claim.again;
    if (!claim.again) {
      const said = await hostFor(ctx, e)
        .commentPr(e.repo, n, movedComment({ name: e.name, branch: e.branch, from: q.version, to: claim.claim.version, behind, caughtUp: caught.has(n), files: e.versionFiles }))
        .catch(() => null);
      told = said?.code === 0;
    }
    moved.push({ number: n, url: pr.url, from: q.version, to: claim.claim.version, again: claim.again, told });
  }
  if (!moved.length) return { status: 409, message: `Nothing was moved: ${left.join('; ')}`, moved: [] };
  keep(e, r, moved, at);
  const unsaid = moved.filter((m) => !m.told).map((m) => m.number);
  const words = [
    `${movedWords(moved)}: ${behind.length ? `${list(behind)} ${behind.length === 1 ? 'merges' : 'merge'} at the next round` : 'the PRs behind merge at the next round'}`,
    ...(unsaid.length ? [`${list(unsaid)} couldn't be commented on: tell ${unsaid.length === 1 ? 'its author' : 'their authors'} the new version`] : []),
    ...left,
  ];
  return { status: 200, message: `${words.join('. ')}.`, moved };
}

/** What was moved, in words: "#233 is moved to v0.36.45 (from v0.36.41)". */
function movedWords(moved: Moved[]): string {
  return moved.map((m) => `#${m.number} ${m.again ? 'was moved already, to' : 'is moved to'} v${m.to}${m.again ? '' : ` (from v${m.from})`}`).join(', ');
}

/** The moves kept in the queue, the queue's alarm (and any of the moved drafts') cleared at once. */
function keep(e: Employee, r: VersionQueue, moved: Moved[], at: string): Moved[] {
  if (!moved.length) return moved;
  // Read again: a round may have kept the queues meanwhile.
  const now = loadVersionQueues();
  const repos = now.repos.map((x) => (x.id === r.id ? withMoves(x, moved, at) : x));
  writeJson(versionQueuesFile(), { ...now, repos, upcoming: upcomingDrafts(repos) });
  for (const m of moved) clearAlarm(queueAlarmId(r.repo ?? e.repo, m.number));
  return moved;
}
