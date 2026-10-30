import { showFile } from './git.ts';
import { compareVersions } from './kitfiles.ts';
import { withLock } from './kit/lock.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { originRepo } from './kit/manor.ts';
import { claimRefused, makersPc, makersRepo } from './maker.ts';
import { stewardCloneAt } from './migrate.ts';
import type { Employee, Settings } from './settings.ts';
import { stewardEmployee } from './stages/selfmerge.ts';
import { checkoutOf, freshBranch, hostIs, releasedOf, type Ctx } from './stages/common.ts';
import { gh } from './git.ts';
import { agreedVersion, bumpPatch } from './versions.ts';
import { kitClaimKey, kitTitleVersions, KIT_VERSION_FILE } from './stages/kitpart.ts';
import { kitInfo } from './kitsource.ts';
import { CLAIMS_FILE, CLAIMS_REF, remoteFor } from './lease.ts';
import { pipelineOf } from './repoconfig.ts';
export { CLAIMS_FILE, CLAIMS_REF };
import { readRef, writeRef, type RemoteRepo } from './remote-ref.ts';
import type { Runner } from './run.ts';
import { hostFor, must } from './hosts/index.ts';
import { pushable } from './found.ts';

/**
 * Versions claimed up front. Two pieces of work started side by side on one repository each used to take "the next
 * version" when they began, the same one, and found out only when the second conflicted with the first on its way
 * in. Now a worker (a Claude Code session, the Wright, a person) asks the Steward for the version before it starts:
 * `node src\cli.ts claim-version <employee or owner/repo> --branch <its branch> --for "<what>"`. The Steward hands out
 * the next one no one has: above the branch's version, every release, every open PR's (by its title), and every live
 * claim; records it; and never hands it out again while the claim lives. One machine-wide lock makes claims one at a
 * time, so two workers asking at once get two versions. Asking again for the same branch returns the same claim.
 *
 * A claim lives until its version is on the branch or released (the work landed), until it is given back
 * (`release-version`), or for CLAIM_DAYS with no open PR that names it. The Steward merges no PRs (Steward 0.36.124):
 * whoever claimed a version merges their own PR, and a build releases main at the version main carries. A version
 * merged below one released already isn't released (release.ts's releaseDecision): claims come above main's version,
 * so the next build's stamp or claim carries it.
 *
 * The kit is claimed the same way, as a part of the Steward's repository (`claim-version kit`): kit/VERSION, its
 * kit-v<version> releases, the kit versions open PRs' titles name, and claims under `<repo>#kit` (stages/kitpart.ts).
 *
 * The maker's other development PCs (Steward 0.36.27) claim versions of the manor's repositories too, though nothing
 * else of them is theirs: GitHub says their account can push there (maker.ts' claimRefused). They run no rounds to
 * share a claim later, so theirs go through the repository's claims ref or not at all (sharedOnly).
 */

export interface Claim {
  /** owner/name on GitHub. */
  repo: string;
  version: string;
  /** The branch the work is on, when the worker said: the PR that sets this version from it is the claim's own. */
  branch: string | null;
  /** Who asked: "claude", "wright", a person. */
  by: string;
  /** What the work is. */
  for: string;
  at: string;
  /**
   * 'shared': a copy of a claim in the repository's claims ref (refs/manor/claims), for every PC that looks after it.
   * Left out: claimed here alone ('exchequer', from 0.24, counts as that).
   */
  source?: 'shared' | 'exchequer';
  /** Set when another PC claimed the same version while this PC couldn't reach the remote: what the page says. */
  clash?: string;
  /** A copy's: when it was copied here from the claims ref (keepCopies), in ms. Never shared. */
  copied?: number;
  /**
   * The PR this claim moved past the others in its version queue, before Steward 0.36.124 (whose version queues are
   * gone): kept so the claims ref other PCs share still reads.
   */
  moved?: number;
  /** Its PR is next in line on its repository (passover.ts): since when, at which head, held by what. Shared. */
  line?: InLine;
  /** Its PR was stuck next in line, and is passed over (passover.ts). Shared. */
  passed?: PassedOver;
}

/** What holds a PR in its version line (passover.ts's holdOf): its kind, and the words for it. */
export interface Hold {
  kind: 'owner' | 'draft' | 'conflict' | 'failing' | 'pending' | 'unknown' | 'author';
  why: string;
}

/** A claim's PR next in line (passover.ts): since when, at which head, held by what. */
export interface InLine extends Hold {
  pr: number;
  since: string;
  head: string;
}

/** A claim's PR stuck next in line, passed over (passover.ts). */
export interface PassedOver extends Hold {
  pr: number;
  url: string;
  /** Stuck since: when it was next in line with this head and hold. */
  since: string;
  /** When it was passed over. */
  at: string;
  /** Its head then. */
  head: string;
  /** Its version then. */
  from: string;
  /** The head the Steward last pushed to it, and main's commit it caught it up with: a head of neither is its author's. */
  pushed?: string;
  main?: string;
  /** What the Steward's last look did, or why it couldn't. */
  note?: string;
}

export const claimsFile = () => dataFile('version-claims.json');
const claimsLock = () => dataFile('locks', 'claims');
export const CLAIM_DAYS = 3;
const DAY = 86_400_000;

export const loadClaims = (): Claim[] => readJson<Claim[]>(claimsFile(), []);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The highest of some versions, or null. */
export const highest = (vs: (string | null | undefined)[]): string | null =>
  vs.filter((v): v is string => !!v && /^\d+\.\d+\.\d+$/.test(v)).reduce<string | null>((a, b) => (a === null || compareVersions(b, a) > 0 ? b : a), null);

/** The version after `v`: the next patch, or with `minor`, the next minor (x.y+1.0). */
export function after(v: string, minor = false): string {
  if (!minor) return bumpPatch(v);
  const [x, y] = v.split('.').map(Number);
  return `${x}.${y + 1}.0`;
}

/** The versions an employee's open PRs set, read from their titles ("Porter 0.4.12: …"). */
export const titleVersions = (name: string, titles: string[]): string[] =>
  titles.flatMap((t) => {
    const m = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+\\.\\d+\\.\\d+)\\b`, 'i').exec(t);
    return m ? [m[1]] : [];
  });

/**
 * Whether a claim still holds, given what is known of its repository now: its version not yet on the branch or
 * released, and either younger than CLAIM_DAYS or named by an open PR (its branch, or a title). A repository's claim
 * whose branch's PR is open holds though the branch or a release passes it, so passover.ts can re-version that PR.
 */
export function stillHeld(c: Claim, o: { branchVersion: string | null; released: string[]; openBranches: string[]; openVersions: string[]; now: number }): boolean {
  if (c.branch && !isKitKey(c.repo) && o.openBranches.includes(c.branch)) return true;
  // Released, or overtaken by a release: either way it's no longer free work's to hold.
  if (overtaken(c, o)) return false;
  if (o.now - Date.parse(c.at) < CLAIM_DAYS * DAY) return true;
  return (!!c.branch && o.openBranches.some((b) => b === c.branch)) || o.openVersions.includes(c.version);
}

/** Whether the branch's version or a release has reached a claim's. Pure. */
export function overtaken(c: Pick<Claim, 'version'>, o: { branchVersion: string | null; released: string[] }): boolean {
  const top = highest([o.branchVersion, ...o.released]);
  return !!top && compareVersions(top, c.version) >= 0;
}

/** Whether a claims key is a repository's kit's (stages/kitpart.ts' kitClaimKey). */
const isKitKey = (key: string) => key.endsWith(kitClaimKey(''));

/** The live claims on a repository, for a build's stamp: versions taken by work that hasn't landed. */
export const claimsOn = (repo: string, all = loadClaims()): Claim[] => all.filter((c) => same(c.repo, repo));

/**
 * Why a repository's versions aren't claimed, or null when they are: its pipeline (repoconfig.ts) keeps them by hand
 * (versioning: files), by its tags, or not at all. Pure.
 */
export function notClaimed(e: Employee): string | null {
  const p = pipelineOf(e);
  if (p.versioning === 'claim') return null;
  const how = { files: `its version is set by hand in ${p.versionFiles.join(', ') || 'its version files'}`, tags: 'each release takes the patch after its newest release tag', none: 'it has no versions' }[p.versioning];
  return `${e.name}'s versions aren't claimed: its pipeline says versioning ${p.versioning} (${p.from.versioning}), so ${how}`;
}

/**
 * A version for new work on an employee, claimed: as the module's comment says. Where the repository's remote can be
 * reached, through its claims ref (refs/manor/claims), for every PC that looks after it; else in this PC's store alone,
 * as always, and shared on the next round that reaches the remote (shareClaims). `now`, the facts it reads and `remote`
 * stand in for tests (under node --test there's no remote unless given).
 *
 * `move`: the branch's claim this one takes the place of (a PR passed over, re-versioned: passover.ts), given up in the
 * same write; its marks (`marks`) go with the new one.
 */
export async function claimVersion(ctx: Ctx, e: Employee, o: { branch?: string | null; by: string; for: string; minor?: boolean; now?: number; part?: 'kit'; remote?: RemoteRepo | null; canPush?: (repo: string) => Promise<boolean>; move?: Claim; marks?: Pick<Claim, 'passed'> }): Promise<{ claim: Claim; again: boolean }> {
  const now = o.now ?? Date.now();
  const kit = o.part === 'kit';
  // Off the maker's laptop, no version of Castellan's own repositories or kit is claimed, unless GitHub says this PC's
  // account can push there: one of the maker's other development PCs (maker.ts).
  const theirs = await claimRefused(e, { kit, canPush: o.canPush ?? pushesHere(ctx) });
  if (theirs) throw new Error(theirs);
  // Its own pipeline (repoconfig.ts) may keep its version some other way: then there is nothing to claim.
  const unclaimed = kit ? null : notClaimed(e);
  if (unclaimed) throw new Error(unclaimed);
  const key = kit ? kitClaimKey(e.repo) : e.repo;
  const files = kit ? [KIT_VERSION_FILE] : e.versionFiles;
  // What GitHub and the branch say, read before the lock is taken: the lock is held only to choose and write.
  const repo = checkoutOf(e);
  await freshBranch(ctx, e, repo);
  const read = agreedVersion(await Promise.all(files.map(async (f) => [f, await showFile(ctx.run, repo, `origin/${e.branch}`, f)] as [string, string | null])));
  const branchVersion = 'version' in read ? read.version : null;
  const released = kit ? (await kitInfo(ctx.run, ctx.neutralDir, e.repo)).released : (await releasedOf(ctx, e)).map((r) => r.version);
  // Worked with plain git (scm.ts): no pull requests, so none sets a version.
  const prs = hostIs(ctx, e) === 'git' ? [] : (JSON.parse(must(await hostFor(ctx, e).listPrs(e.repo, { state: 'open', limit: 100, fields: 'title,headRefName' })) || '[]') as { title: string; headRefName: string }[]);
  const openVersions = kit ? kitTitleVersions(prs.map((p) => p.title)) : titleVersions(e.name, prs.map((p) => p.title));
  const openBranches = prs.map((p) => p.headRefName);
  const facts = { branchVersion, released, openBranches, openVersions, now };
  const ask: Ask = { key, branch: o.branch ?? null, by: o.by, for: o.for, minor: !!o.minor, now, facts, what: kit ? 'The kit' : e.name, files, from: `origin/${e.branch}`, move: o.move, marks: o.marks };
  const remote = o.remote !== undefined ? o.remote : process.env.NODE_TEST_CONTEXT ? null : await remoteFor(ctx.run, ctx.settings, e).catch(() => null);
  if (remote) {
    const shared = await claimShared(ctx.run, remote, ask);
    if (shared) return shared;
  }
  if (sharedOnly(e)) throw new Error(`${ask.what}'s claims on GitHub (${CLAIMS_REF}) couldn't be read or written from here, and a claim kept on this PC alone would be seen by no other: nothing was claimed. Try again once GitHub answers.`);
  return withLock(claimsLock(), async () => {
    const all = loadClaims();
    const live = all.filter((c) => !same(c.repo, key) || (!moving(ask, c) && stillHeld(c, facts)));
    const r = choose(live.filter((c) => same(c.repo, key)), ask);
    writeJson(claimsFile(), r.again ? live : [...live, r.claim]);
    return { claim: r.claim, again: r.again };
  });
}

/**
 * Whether a claim here must go through the repository's claims ref: one of the maker's repositories (or its kit) from
 * a PC that isn't the maker's laptop. Kept here alone, it would be shared by no round and seen by no other PC.
 */
export const sharedOnly = (e: Pick<Employee, 'repo'>, makers = makersPc()): boolean => !makers && makersRepo(e.repo);

/**
 * Whether gh's account can push to a repository, asked of GitHub (found.ts' pushable) once per repository for the
 * function this returns: false when GitHub can't be asked.
 */
export function pushesHere(ctx: Pick<Ctx, 'run' | 'neutralDir'>): (repo: string) => Promise<boolean> {
  const asked = new Map<string, Promise<boolean>>();
  return (repo) => {
    const k = repo.toLowerCase();
    if (!asked.has(k)) asked.set(k, pushable(ctx.run, ctx.neutralDir, [repo]).then((r) => r.push.get(k) === true));
    return asked.get(k)!;
  };
}

type Ask = {
  key: string;
  branch: string | null;
  by: string;
  for: string;
  minor: boolean;
  now: number;
  facts: Parameters<typeof stillHeld>[1];
  what: string;
  files: string[];
  from: string;
  /** The claim this one takes the place of, and the marks it carries over (claimVersion's move). */
  move?: Claim;
  marks?: Pick<Claim, 'passed'>;
};

/**
 * Whether `c` is the claim an ask takes the place of: its move, or the branch's own claim that the branch or a release
 * passed while its PR stayed open (stillHeld), which a new claim for the branch replaces.
 */
const moving = (a: Pick<Ask, 'move' | 'key' | 'branch' | 'facts'>, c: Claim) =>
  (!!a.move && same(c.repo, a.move.repo) && c.version === a.move.version && c.branch === a.move.branch) || (!!a.branch && c.branch === a.branch && same(c.repo, a.key) && overtaken(c, a.facts));

/**
 * The claim for this work, from the live claims on its repository: the branch's own again, or the next free version. Pure.
 */
function choose(mine: Claim[], a: Ask): { claim: Claim; again: boolean } {
  const had = a.branch ? mine.find((c) => c.branch === a.branch) : undefined;
  if (had) return { claim: had, again: true };
  const f = a.facts;
  const top = highest([f.branchVersion, ...f.released, ...f.openVersions, ...mine.map((c) => c.version)]);
  if (!top) throw new Error(`${a.what} has no version to count from (${a.files.join(', ')} on ${a.from})`);
  return { claim: { repo: a.key, version: after(top, a.minor), branch: a.branch, by: a.by, for: a.for, at: new Date(a.now).toISOString(), ...(a.marks?.passed ? { passed: a.marks.passed } : {}) }, again: false };
}


/** The claims ref's claims, read from its file; nothing when it can't be read. */
export function parseClaims(text: string | null | undefined): Claim[] {
  try {
    const j = JSON.parse(text ?? '[]');
    return (Array.isArray(j) ? j : [])
      .filter((c) => typeof c?.repo === 'string' && typeof c?.version === 'string' && /^\d+\.\d+\.\d+$/.test(c.version) && typeof c?.at === 'string')
      .map((c) => {
        const line = inLineOf(c.line);
        const passed = passedOf(c.passed);
        return { repo: c.repo, version: c.version, branch: typeof c.branch === 'string' ? c.branch : null, by: String(c.by ?? ''), for: String(c.for ?? ''), at: c.at, ...(Number.isInteger(c.moved) && c.moved > 0 ? { moved: c.moved as number } : {}), ...(line ? { line } : {}), ...(passed ? { passed } : {}) };
      });
  } catch {
    return [];
  }
}

const HOLDS: Hold['kind'][] = ['owner', 'draft', 'conflict', 'failing', 'pending', 'unknown', 'author'];
const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

/** A claim's line mark as the claims ref has it, or null when it doesn't read. */
function inLineOf(x: any): InLine | null {
  if (!x || !Number.isInteger(x.pr) || ![x.since, x.head, x.why].every(str) || !HOLDS.includes(x.kind)) return null;
  return { pr: x.pr, since: x.since, head: x.head, kind: x.kind, why: x.why };
}

/** A claim's passed-over mark as the claims ref has it, or null when it doesn't read. */
function passedOf(x: any): PassedOver | null {
  if (!x || !Number.isInteger(x.pr) || ![x.url, x.since, x.at, x.head, x.why, x.from].every(str) || !HOLDS.includes(x.kind)) return null;
  const opt = (k: 'pushed' | 'main' | 'note') => (str(x[k]) ? { [k]: x[k] as string } : {});
  return { pr: x.pr, url: x.url, since: x.since, at: x.at, head: x.head, kind: x.kind, why: x.why, from: x.from, ...opt('pushed'), ...opt('main'), ...opt('note') };
}

const sharedText = (list: Claim[]) => `${JSON.stringify(list.map(({ source: _s, clash: _c, copied: _k, ...c }) => c), null, 2)}\n`;
/** Whether a claim is this repository's: its own, or its kit's. */
const belongs = (c: Pick<Claim, 'repo'>, repo: string) => same(c.repo, repo) || same(c.repo, kitClaimKey(repo));
/** The repository a claim's key names (a kit's key is `<repo>#kit`). */
const repoOfKey = (key: string) => key.replace(/#kit$/i, '');

/**
 * A claim through the repository's claims ref, by compare-and-swap, tried again when another PC wrote first: chosen
 * as here, from the shared live claims and this PC's own (those it made while it couldn't reach the remote), which go
 * up with it. Kept here too, as copies (source: shared). Null when the remote can't be reached or refuses the ref.
 */
async function claimShared(run: Runner, remote: RemoteRepo, a: Ask): Promise<{ claim: Claim; again: boolean } | null> {
  for (let i = 0; i < 8; i++) {
    const readAt = Date.now();
    const read = await readRef(run, remote, CLAIMS_REF, CLAIMS_FILE);
    if (read.kind === 'unreachable') return null;
    const there = read.kind === 'found' ? parseClaims(read.text) : [];
    const sharedLive = there.filter((c) => same(c.repo, a.key) && !moving(a, c) && stillHeld(c, a.facts));
    const mineOnly = loadClaims().filter((c) => same(c.repo, a.key) && !moving(a, c) && c.source !== 'shared' && !c.clash && stillHeld(c, a.facts));
    // One of this PC's own whose version another PC has meanwhile stays here, marked: its work claims a new one.
    const going = mineOnly.filter((c) => !sharedLive.some((s) => s.version === c.version));
    const r = choose([...sharedLive, ...going], a);
    const list = [...there.filter((c) => !same(c.repo, a.key)), ...sharedLive, ...going, ...(r.again ? [] : [r.claim])];
    const unchanged = r.again && !going.length && sharedLive.length === there.filter((c) => same(c.repo, a.key)).length;
    if (!unchanged) {
      const w = await writeRef(run, remote, CLAIMS_REF, CLAIMS_FILE, sharedText(list), read.kind === 'found' ? read.sha : null, `${a.key} ${r.claim.version}: claimed${a.branch ? ` for ${a.branch}` : ''}`);
      if (w.kind === 'stale') {
        // Another PC (or worker) wrote first: a moment's wait, so two never keep colliding.
        await new Promise((ok) => setTimeout(ok, 50 + Math.random() * 250));
        continue;
      }
      if (w.kind !== 'ok') return null;
    }
    await keepCopies(repoOfKey(a.key), list, readAt, [], (c) => moving(a, c));
    const { source: _s, ...claim } = r.claim;
    return { claim: { ...claim, source: 'shared' }, again: r.again };
  }
  return null;
}

/**
 * A repository's shared claims, copied here in place of the copies before; this PC's own that went up become copies.
 * `readAt`: when `shared` was read from the ref. A copy made since (another process here claiming meanwhile, which
 * wrote the ref after this read) isn't in it yet, and stays. `gone`: a claim of this PC's own that a new one took the
 * place of (a PR passed over, re-versioned: passover.ts), which goes.
 */
async function keepCopies(repo: string, shared: Claim[], readAt: number, clashes: Claim[] = [], gone: (c: Claim) => boolean = () => false): Promise<void> {
  await withLock(claimsLock(), async () => {
    const copied = Date.now();
    const mine = shared.filter((c) => belongs(c, repo));
    const went = (c: Claim) => gone(c) || mine.some((s) => same(s.repo, c.repo) && s.version === c.version && s.branch === c.branch);
    // This PC's own stay, unless they went up (the same version, for the same branch); so do copies newer than the read.
    const rest = loadClaims().filter((c) => !belongs(c, repo) || (!went(c) && (c.source !== 'shared' || (c.copied ?? 0) >= readAt)));
    const marked = rest.map((c) => {
      const clash = clashes.find((x) => same(x.repo, c.repo) && x.version === c.version && x.branch === c.branch);
      if (!clash) return c;
      const what = c.repo.endsWith('#kit') ? `The kit ${c.version}` : `${c.repo} ${c.version}`;
      return { ...c, clash: `${what} was claimed on another PC too (for ${clash.clash}) while this PC couldn't reach the remote: claim a new version for ${c.branch ?? 'this work'} (claim-version) before you merge it` };
    });
    writeJson(claimsFile(), [...marked, ...mine.map((c) => ({ ...c, source: 'shared' as const, copied }))]);
  });
}

/** Gives a claim back, here and in its repository's claims ref when that can be reached; false when there was none. */
export async function releaseClaim(repo: string, version: string, o: { remote?: RemoteRepo | null; run?: Runner } = {}): Promise<boolean> {
  let shared = false;
  if (o.remote && o.run) {
    for (let i = 0; i < 8; i++) {
      const read = await readRef(o.run, o.remote, CLAIMS_REF, CLAIMS_FILE);
      if (read.kind !== 'found') break;
      const there = parseClaims(read.text);
      const left = there.filter((c) => !(same(c.repo, repo) && c.version === version));
      if (left.length === there.length) break;
      const w = await writeRef(o.run, o.remote, CLAIMS_REF, CLAIMS_FILE, sharedText(left), read.sha, `${repo} ${version}: given back`);
      if (w.kind === 'stale') {
        // Another PC (or worker) wrote first: a moment's wait, so two never keep colliding.
        await new Promise((ok) => setTimeout(ok, 50 + Math.random() * 250));
        continue;
      }
      shared = w.kind === 'ok';
      break;
    }
  }
  const local = await withLock(claimsLock(), async () => {
    const all = loadClaims();
    const left = all.filter((c) => !(same(c.repo, repo) && c.version === version));
    if (left.length === all.length) return false;
    writeJson(claimsFile(), left);
    return true;
  });
  return local || shared;
}

/**
 * A claim's marks (passover.ts) set as `marks` says, a mark given as undefined taken off: in its repository's claims ref
 * by compare-and-swap where `remote` is given and the ref has the claim, and here. False when the ref couldn't be
 * written, or neither has the claim: then nothing changed, and the next round tries again.
 */
export async function markClaim(run: Runner, remote: RemoteRepo | null, c: Pick<Claim, 'repo' | 'version' | 'branch'>, marks: { line?: InLine; passed?: PassedOver }): Promise<boolean> {
  const is = (x: Claim) => same(x.repo, c.repo) && x.version === c.version && x.branch === c.branch;
  const apply = (x: Claim): Claim => {
    const y: Claim = { ...x, ...marks };
    for (const k of Object.keys(marks) as (keyof typeof marks)[]) if (marks[k] === undefined) delete y[k];
    return y;
  };
  const what = Object.entries(marks).map(([k, v]) => (v ? k : `no ${k}`)).join(', ');
  let shared = false;
  if (remote) {
    for (let i = 0; ; i++) {
      const read = await readRef(run, remote, CLAIMS_REF, CLAIMS_FILE);
      if (read.kind === 'unreachable' || (read.kind === 'found' && read.text === null)) return false;
      const there = read.kind === 'found' ? parseClaims(read.text) : [];
      // Made here alone (the remote out of reach then): marked here, and shared with it on the next round.
      if (!there.some(is)) break;
      const w = await writeRef(run, remote, CLAIMS_REF, CLAIMS_FILE, sharedText(there.map((x) => (is(x) ? apply(x) : x))), (read as { sha: string }).sha, `${c.repo} ${c.version}: ${what}`);
      if (w.kind === 'ok') {
        shared = true;
        break;
      }
      if (w.kind !== 'stale' || i >= 7) return false;
      // Another PC (or worker) wrote first: a moment's wait, so two never keep colliding.
      await new Promise((ok) => setTimeout(ok, 50 + Math.random() * 250));
    }
  }
  return withLock(claimsLock(), async () => {
    const all = loadClaims();
    if (!all.some(is)) return shared;
    writeJson(claimsFile(), all.map((x) => (is(x) ? apply(x) : x)));
    return true;
  });
}

type Row = { repo: string; name: string; main: { version: string | null } | null; release: { version: string } | null; prs: { head: string; title: string }[] };

/** Whether a claim still holds by what the staff's table says (a kit's by its age and PRs); true when the table says nothing of it. */
function holdsBy(rows: Row[], c: Claim, now: number): boolean {
  const k = c.repo.endsWith('#kit') ? rows.find((x) => same(kitClaimKey(x.repo), c.repo)) : undefined;
  if (k) return now - Date.parse(c.at) < CLAIM_DAYS * DAY || (!!c.branch && k.prs.some((p) => p.head === c.branch)) || kitTitleVersions(k.prs.map((p) => p.title)).includes(c.version);
  const r = rows.find((x) => same(x.repo, c.repo));
  if (!r) return true;
  return stillHeld(c, { branchVersion: r.main?.version ?? null, released: r.release ? [r.release.version] : [], openBranches: r.prs.map((p) => p.head), openVersions: titleVersions(r.name, r.prs.map((p) => p.title)), now });
}

/**
 * The claims that still hold after a round, by what the staff's table says of each repository: those whose work
 * landed, or that went stale with no PR, are dropped.
 */
export async function pruneClaims(rows: Row[], now = Date.now()): Promise<void> {
  await withLock(claimsLock(), async () => {
    const all = loadClaims();
    const kept = all.filter((c) => holdsBy(rows, c, now));
    if (kept.length !== all.length) writeJson(claimsFile(), kept);
  });
}

const claimsSeenFile = () => dataFile('claims-seen.json');

/**
 * Each round that took turns: each repository's claims ref, where it moved since the last look or this PC holds claims
 * of its own there (made while it couldn't reach the remote). Its live claims are copied here; this PC's own go up,
 * but one whose version another PC claimed meanwhile stays here, marked, and the page says to claim a new version for
 * its work before it is merged (claim-version, through the claims ref, passes a marked claim by). Since Steward
 * 0.36.124 no merge stage holds its PR for it.
 * Landed and stale claims are let go there too. A repository out of reach is left for the next round.
 */
export async function shareClaims(run: Runner, rows: Row[], repos: { repo: string; remote: RemoteRepo; sha: string | null }[], now = Date.now()): Promise<void> {
  const seen = readJson<Record<string, string | null>>(claimsSeenFile(), {});
  for (const { repo, remote, sha } of repos) {
    const k = repo.toLowerCase();
    const mineOnly = loadClaims().filter((c) => belongs(c, repo) && c.source !== 'shared' && !c.clash);
    if (k in seen && seen[k] === sha && !mineOnly.length) continue;
    try {
      // Read as it is now, not at `sha`: that is the ref as the round's turns found it when it began, and a claim made
      // since (a worker's claim-version, mid-round) would be missing from it, and from the copies kept here after it.
      // Missing here, a catch-up handed its version to another PR.
      const readAt = Date.now();
      const read = await readRef(run, remote, CLAIMS_REF, CLAIMS_FILE);
      if (read.kind === 'unreachable' || (read.kind === 'found' && read.text === null)) continue;
      const current = read.kind === 'found' ? read.sha : null;
      const there = read.kind === 'found' ? parseClaims(read.text) : [];
      const live = there.filter((c) => !belongs(c, repo) || holdsBy(rows, c, now));
      const clashes: Claim[] = [];
      const going: Claim[] = [];
      for (const c of mineOnly.filter((x) => holdsBy(rows, x, now))) {
        const other = live.find((s) => same(s.repo, c.repo) && s.version === c.version);
        if (!other) going.push(c);
        else if (other.branch !== c.branch) clashes.push({ ...c, clash: other.for || other.branch || 'other work' });
      }
      const list = [...live, ...going];
      let at = current;
      if (going.length || live.length !== there.length) {
        const w = await writeRef(run, remote, CLAIMS_REF, CLAIMS_FILE, sharedText(list), current, `${repo}: claims shared`);
        if (w.kind !== 'ok') continue;
        at = w.sha;
      }
      await keepCopies(repo, list, readAt, clashes);
      seen[k] = at;
    } catch {
      // Left for the next round.
    }
  }
  writeJson(claimsSeenFile(), seen);
}

/** This PC's claims that clash with another PC's (made while it couldn't reach the remote): the page says so. */
export const claimClashes = (): string[] => loadClaims().flatMap((c) => (c.clash ? [c.clash] : []));


/**
 * The Steward's own, for a claim: its repository and clone from Settings; else the Steward clone this runs in (a
 * session's worktree of it), and that clone's origin. Null when there's neither.
 */
export function selfFor(s: Settings, cwd = process.cwd()): Employee | null {
  const checkout = s.stewardCheckout || stewardCloneAt(cwd) || '';
  const repo = s.stewardRepo || (checkout ? (originRepo(checkout) ?? '') : '');
  return repo && checkout ? stewardEmployee({ ...s, stewardRepo: repo }, checkout) : null;
}

/** An employee by its id, its name or its repository; the Steward's own repository too. */
export function employeeFor(s: Settings, who: string, cwd = process.cwd()): Employee | null {
  const w = who.toLowerCase();
  const self = selfFor(s, cwd);
  const all = [...s.employees, ...(self ? [self] : [])];
  return all.find((e) => e.id.toLowerCase() === w || e.name.toLowerCase() === w || e.repo.toLowerCase() === w || e.repo.split('/')[1]?.toLowerCase() === w) ?? null;
}
