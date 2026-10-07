import { showFile } from './git.ts';
import { compareVersions } from './kitfiles.ts';
import { withLock } from './kit/lock.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { originRepo } from './kit/manor.ts';
import { stewardCloneAt } from './migrate.ts';
import type { Employee, Settings } from './settings.ts';
import { stewardEmployee } from './stages/selfmerge.ts';
import { checkoutOf, freshBranch, hostIs, releasedOf, type Ctx } from './stages/common.ts';
import { gh } from './git.ts';
import { agreedVersion, bumpPatch } from './versions.ts';
import { kitClaimKey, kitTitleVersions, KIT_VERSION_FILE } from './stages/kitpart.ts';
import { kitInfo } from './kitsource.ts';
import { ask, coordHere, type Coord } from './lease.ts';

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
 * (`release-version`), or for CLAIM_DAYS with no open PR that names it. While it lives, the merge stage holds another
 * PR that sets that version and catches it up to a free one (stages/merge.ts, stages/catchup.ts). When a catch-up gives a
 * PR a new version after all (another PR with a higher claim merged first), its branch's claim moves to it (reclaim).
 *
 * The kit is claimed the same way, as a part of the Steward's repository (`claim-version kit`): kit/VERSION, its
 * kit-v<version> releases, the kit versions open PRs' titles name, and claims under `<repo>#kit` (stages/kitpart.ts).
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
   * 'exchequer': claimed through the Exchequer, for every PC of the licence (lease.ts's Coord), and kept here as a
   * copy, so the merge stage sees it. Left out: claimed here alone.
   */
  source?: 'exchequer';
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
 * released, and either younger than CLAIM_DAYS or named by an open PR (its branch, or a title).
 */
export function stillHeld(c: Claim, o: { branchVersion: string | null; released: string[]; openBranches: string[]; openVersions: string[]; now: number }): boolean {
  // Released, or overtaken by a release: either way it's no longer free work's to hold.
  const top = highest(o.released);
  if (top && compareVersions(top, c.version) >= 0) return false;
  if (o.branchVersion && compareVersions(o.branchVersion, c.version) >= 0) return false;
  if (o.now - Date.parse(c.at) < CLAIM_DAYS * DAY) return true;
  return (!!c.branch && o.openBranches.some((b) => b === c.branch)) || o.openVersions.includes(c.version);
}

/** The live claims on a repository, for the merge stage: versions taken by work that hasn't landed. */
export const claimsOn = (repo: string, all = loadClaims()): Claim[] => all.filter((c) => same(c.repo, repo));

/**
 * A version for new work on an employee, claimed: as the module's comment says. `now` and the facts it reads stand
 * in for tests through ctx.run.
 */
export async function claimVersion(ctx: Ctx, e: Employee, o: { branch?: string | null; by: string; for: string; minor?: boolean; now?: number; part?: 'kit'; coord?: Coord | null }): Promise<{ claim: Claim; again: boolean }> {
  const now = o.now ?? Date.now();
  const kit = o.part === 'kit';
  const key = kit ? kitClaimKey(e.repo) : e.repo;
  const files = kit ? [KIT_VERSION_FILE] : e.versionFiles;
  // What GitHub and the branch say, read before the lock is taken: the lock is held only to choose and write.
  const repo = checkoutOf(e);
  await freshBranch(ctx, e, repo);
  const read = agreedVersion(await Promise.all(files.map(async (f) => [f, await showFile(ctx.run, repo, `origin/${e.branch}`, f)] as [string, string | null])));
  const branchVersion = 'version' in read ? read.version : null;
  const released = kit ? (await kitInfo(ctx.run, ctx.neutralDir, e.repo)).released : (await releasedOf(ctx, e)).map((r) => r.version);
  // Worked with plain git (scm.ts): no pull requests, so none sets a version.
  const prs = hostIs(ctx, e) === 'git' ? [] : (JSON.parse((await gh(ctx.run, ctx.neutralDir, 'pr', 'list', '--repo', e.repo, '--state', 'open', '--limit', '100', '--json', 'title,headRefName')) || '[]') as { title: string; headRefName: string }[]);
  const openVersions = kit ? kitTitleVersions(prs.map((p) => p.title)) : titleVersions(e.name, prs.map((p) => p.title));
  const openBranches = prs.map((p) => p.headRefName);
  // With a licence, the Exchequer hands it out for every PC of the licence; with none, or no Exchequer, it's this PC's alone.
  const coord = o.coord !== undefined ? o.coord : coordHere();
  if (coord) {
    const shared = await claimShared(coord, e, { key, branch: o.branch ?? null, by: o.by, for: o.for, minor: !!o.minor, now, facts: { branchVersion, released, openBranches, openVersions, now } });
    if (shared) return shared;
  }
  return withLock(claimsLock(), async () => {
    const all = loadClaims();
    const facts = { branchVersion, released, openBranches, openVersions, now };
    const live = all.filter((c) => !same(c.repo, key) || stillHeld(c, facts));
    const mine = live.filter((c) => same(c.repo, key));
    const had = o.branch ? mine.find((c) => c.branch === o.branch) : undefined;
    if (had) {
      writeJson(claimsFile(), live);
      return { claim: had, again: true };
    }
    const top = highest([branchVersion, ...released, ...openVersions, ...mine.map((c) => c.version)]);
    if (!top) throw new Error(`${kit ? 'The kit' : e.name} has no version to count from (${files.join(', ')} on origin/${e.branch})`);
    const claim: Claim = { repo: key, version: after(top, o.minor), branch: o.branch ?? null, by: o.by, for: o.for, at: new Date(now).toISOString() };
    writeJson(claimsFile(), [...live, claim]);
    return { claim, again: false };
  });
}

/**
 * A branch's claim moved to the version a catch-up gave its PR (stages/catchup.ts): the old one is free again and the
 * new one held, so the next worker counts from it and the branch's worker, asking again, gets it. A branch with no
 * claim gets one now, as the Steward's. `key` is the repository, or its kit's (kitClaimKey).
 */
export async function reclaim(key: string, branch: string, version: string, now = Date.now()): Promise<void> {
  await withLock(claimsLock(), async () => {
    const all = loadClaims();
    const had = all.find((c) => same(c.repo, key) && c.branch === branch);
    if (had?.version === version) return;
    const rest = all.filter((c) => !(same(c.repo, key) && (c.branch === branch || c.version === version)));
    const claim: Claim = { repo: key, version, branch, by: had?.by ?? 'steward', for: had?.for ?? 'caught up by the Steward', at: new Date(now).toISOString() };
    writeJson(claimsFile(), [...rest, claim]);
  });
}

/**
 * A claim through the Exchequer (POST /claims), as claimVersion would make it here: the facts, and the versions only this
 * PC has claimed (from before claims were shared) as taken. Kept here too, as a copy. Null when the Exchequer doesn't
 * hand it out (no coordination, out of reach, or refused): then it's claimed here, as before.
 */
async function claimShared(coord: Coord, e: Employee, o: { key: string; branch: string | null; by: string; for: string; minor: boolean; now: number; facts: Parameters<typeof stillHeld>[1] }): Promise<{ claim: Claim; again: boolean } | null> {
  const mineOnly = loadClaims().filter((c) => same(c.repo, o.key) && c.source !== 'exchequer' && stillHeld(c, o.facts));
  // A claim this PC made alone for the same branch stands: the same version again.
  const had = o.branch ? mineOnly.find((c) => c.branch === o.branch) : undefined;
  if (had) return { claim: had, again: true };
  const f = o.facts;
  const r = await ask(coord, 'POST', '/claims', { repo: o.key, branch: o.branch, by: o.by, for: o.for, minor: o.minor, branchVersion: f.branchVersion, released: f.released, openBranches: f.openBranches, openVersions: f.openVersions, taken: mineOnly.map((c) => c.version) });
  if (r.kind === 'refused' && r.body?.error === 'no-version') throw new Error(`${e.name} has no version to count from (${e.versionFiles.join(', ')} on origin/${e.branch})`);
  const c = r.kind === 'ok' ? r.body?.claim : null;
  if (!c || typeof c.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(c.version)) return null;
  const claim: Claim = { repo: o.key, version: c.version, branch: c.branch ?? null, by: String(c.by ?? o.by), for: String(c.for ?? o.for), at: String(c.at ?? new Date(o.now).toISOString()), source: 'exchequer' };
  await withLock(claimsLock(), async () => {
    writeJson(claimsFile(), [...loadClaims().filter((x) => !(same(x.repo, claim.repo) && x.version === claim.version)), claim]);
  });
  return { claim, again: r.kind === 'ok' && r.body?.again === true };
}

/** Gives a claim back, on the Exchequer too when this PC holds a licence; false when there was none. */
export async function releaseClaim(repo: string, version: string, o: { coord?: Coord | null } = {}): Promise<boolean> {
  const coord = o.coord !== undefined ? o.coord : coordHere();
  const shared = coord ? await ask(coord, 'DELETE', '/claims', { repo, version }) : null;
  const local = await withLock(claimsLock(), async () => {
    const all = loadClaims();
    const left = all.filter((c) => !(same(c.repo, repo) && c.version === version));
    if (left.length === all.length) return false;
    writeJson(claimsFile(), left);
    return true;
  });
  return local || (shared?.kind === 'ok' && shared.body?.released === true);
}

/**
 * Each round with a licence: the licence's claims on the Exchequer copied here (those of every PC), so the merge stage
 * holds a PR that takes another work's version whichever PC claimed it. The copies made before are replaced; claims
 * made here alone are kept. Nothing changes when the Exchequer doesn't answer.
 */
export async function syncClaims(coord: Coord | null): Promise<void> {
  if (!coord) return;
  const r = await ask(coord, 'GET', '/claims');
  if (r.kind !== 'ok' || !Array.isArray(r.body?.claims)) return;
  const shared: Claim[] = r.body.claims
    .filter((c: any) => typeof c?.repo === 'string' && typeof c?.version === 'string' && /^\d+\.\d+\.\d+$/.test(c.version))
    .map((c: any) => ({ repo: c.repo, version: c.version, branch: c.branch ?? null, by: String(c.by ?? ''), for: String(c.for ?? ''), at: String(c.at ?? new Date().toISOString()), source: 'exchequer' as const }));
  await withLock(claimsLock(), async () => {
    const alone = loadClaims().filter((c) => c.source !== 'exchequer' && !shared.some((s) => same(s.repo, c.repo) && s.version === c.version));
    writeJson(claimsFile(), [...alone, ...shared]);
  });
}

/**
 * The claims that still hold after a round, by what the staff's table says of each repository: those whose work
 * landed, or that went stale with no PR, are dropped.
 */
export async function pruneClaims(rows: { repo: string; name: string; main: { version: string | null } | null; release: { version: string } | null; prs: { head: string; title: string }[] }[], now = Date.now(), o: { coord?: Coord | null } = {}): Promise<void> {
  const dropped = await withLock(claimsLock(), async () => {
    const all = loadClaims();
    const kept = all.filter((c) => {
      const r = rows.find((x) => same(x.repo, c.repo));
      // A kit's claim (`<repo>#kit`): kept while young, or while an open PR on its repository names it.
      const k = c.repo.endsWith('#kit') ? rows.find((x) => same(kitClaimKey(x.repo), c.repo)) : undefined;
      if (k) return now - Date.parse(c.at) < CLAIM_DAYS * DAY || (!!c.branch && k.prs.some((p) => p.head === c.branch)) || kitTitleVersions(k.prs.map((p) => p.title)).includes(c.version);
      if (!r) return true;
      return stillHeld(c, { branchVersion: r.main?.version ?? null, released: r.release ? [r.release.version] : [], openBranches: r.prs.map((p) => p.head), openVersions: titleVersions(r.name, r.prs.map((p) => p.title)), now });
    });
    if (kept.length !== all.length) writeJson(claimsFile(), kept);
    return all.filter((c) => !kept.includes(c));
  });
  // Those the Exchequer handed out are given back there too: their work landed, or went stale.
  if (o.coord) for (const c of dropped.filter((x) => x.source === 'exchequer')) await ask(o.coord, 'DELETE', '/claims', { repo: c.repo, version: c.version });
}

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
