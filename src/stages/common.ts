import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { NOT_PUBLISHED } from '../kit/exchequer.ts';
import { isNetworkError, online } from '../kit/net.ts';
import { expandEnv } from '../kit/settings-kit.ts';
import { commitOf, fetchBranch } from '../git.ts';
import type { Glance, RepoGlance } from '../glance.ts';
import { gitGlance, type Host } from '../scm.ts';
import type { TastingDeps } from '../tasting.ts';
import { appReleasesIn, type ReleaseInfo } from './staff.ts';
import type { KitInfo } from '../kitsource.ts';
import type { LeaseGuard } from '../lease.ts';
import type { Runner } from '../run.ts';
import { releasedHere, type Employee, type Settings } from '../settings.ts';
import { hostFor, must } from '../hosts/index.ts';

/** What a stage did for one employee. */
export type Outcome = 'done' | 'skipped' | 'refused' | 'failed';

export interface EmployeeResult {
  id: string;
  name: string;
  outcome: Outcome;
  /** One line, for the page's table. */
  message: string;
  /** A PR's URL, a commit, a new version: what the page can link or show. */
  url?: string;
  version?: string;
  commit?: string;
  /** The commit a bump started from (its branch on origin), so a kit's trial knows when the agent has moved on. */
  base?: string;
  /** The next round looks at it again, whatever GitHub says (a release the Aletaster's tasting holds). */
  again?: boolean;
  /** Its branch's version is released already (by this stage or another way): no failed release of it stands. */
  released?: boolean;
}

export type StageName = 'bump' | 'push' | 'merge' | 'release' | 'round' | 'staff';

export interface StageResult {
  stage: StageName;
  started: string;
  finished: string;
  /** The kit version it worked with, when it had one. */
  kit: string | null;
  /** What it was asked: which employees, which kit, --yes. */
  asked: Record<string, unknown>;
  /** A word for the whole stage, when it couldn't start (no kit, say). */
  error?: string;
  /** A round while this PC was offline (the kit's net.ts): nothing was asked of GitHub, and it waited for the network. */
  offline?: boolean;
  /** A round that asked GitHub nothing and only kept the staff's pages up (tend.ts): no repositories here, or Settings said so. */
  tendOnly?: boolean;
  /**
   * A round that left a PR waiting only on something that settles itself within minutes (merge.ts's waitsBriefly): its
   * checks running, at a head just caught up, or GitHub working out whether it merges. The next round comes sooner (agent.ts).
   */
  soon?: boolean;
  results: EmployeeResult[];
  log: string[];
}

export interface Ctx {
  settings: Settings;
  run: Runner;
  kit: KitInfo;
  /** A line for the stage's log (and the terminal). */
  log: (line: string) => void;
  /** Where gh runs from: no employee's repo, so --repo alone decides. */
  neutralDir: string;
  /**
   * GitHub at a glance (glance.ts), taken as the stage began: each employee's open PRs, releases and branch head, read
   * from here instead of asked for one by one. Null when GitHub couldn't be asked that way. An employee left out of it,
   * or dropped once the Steward changed its repository (a merge), is asked for one by one, as before.
   */
  glance?: Glance | null;
  /** Stands in for the Aletaster, its install and the clock, for the release gate (tasting.ts); tests only. */
  tasting?: TastingDeps;
  /** Whether this PC is online (the kit's net.ts); tests stand in for it. Under node --test, online unless given. */
  online?: () => Promise<boolean>;
  /** How each repository is worked with (scm.ts): GitHub's way, GitLab's, or plain git. Not given: GitHub's, as before. */
  host?: (e: Pick<Employee, 'repo'>) => Host;
  /**
   * The turns this stage took with this PC's others (lease.ts): asked before each merge and release whether this
   * PC still has its turn in that repository. None when there are no turns to take: every repository is this PC's.
   */
  lease?: LeaseGuard | null;
  /** Waits this long before asking GitHub something again (merge.ts); tests stand in for it. Not given: the clock's. */
  pause?: (ms: number) => Promise<void>;
}

/** How a repository is worked with in this stage (scm.ts). */
export const hostIs = (ctx: Pick<Ctx, 'host'>, e: Employee): Host => ctx.host?.(e) ?? 'github';

/** Said where a repository worked with plain git meets what only GitHub has: pull requests. */
export const NO_PRS = 'worked with plain git (Source control, in Settings): there are no pull requests to merge, and what lands on its branch is released';

/**
 * Whether a failure is only the network's: its words say so, or this PC is offline now (the kit's net.ts). Such a
 * failure is no fault of the commit: nothing is held against it (round-failed.json, self-failed.json,
 * rollout-failed.json), and the next round tries again. A message rarely carries the command's output ("npm ci
 * failed (exit 1)"), so being offline right now counts too.
 */
export async function networkFailure(ctx: Pick<Ctx, 'online'>, message: string): Promise<boolean> {
  if (passingFailure(message)) return true;
  const look = ctx.online ?? (process.env.NODE_TEST_CONTEXT ? async () => true : online);
  return !(await look().catch(() => true));
}

/**
 * Whether a failure's words say it was the network's, or GitHub's own (a 5xx, a dropped connection): it passes, and
 * the next round tries again. On 2026-10-07 GitHub answered every push with "Internal Server Error" for a while, and
 * nine kit bumps were held for a person to press Push, an alarm each.
 */
export const passingFailure = (message: string) => isNetworkError(message) || MORE_NET_WORDS.test(message) || SERVER_WORDS.test(message);

/** Network failures the kit's words miss: Go's (gh's) TLS and HTTP client timeouts, and Windows' connect failure. */
const MORE_NET_WORDS = /tls handshake timeout|net\/http: (?:request canceled|timeout)|client\.timeout exceeded|connection attempt failed|could not establish (?:a )?connection/i;

/**
 * GitHub's side failing, in git's words ("[remote rejected] … (Internal Server Error)", "RPC failed; HTTP 502", "The
 * requested URL returned error: 503", "the remote end hung up unexpectedly") and gh's ("HTTP 500", "HTTP 504").
 */
const SERVER_WORDS = /internal server error|bad gateway|service unavailable|gateway time-?out|\bHTTP[ /]?(?:\d(?:\.\d)? )?5\d\d\b|returned error: 5\d\d\b|rpc failed|the remote end hung up unexpectedly|unexpected disconnect while reading sideband|early EOF/i;

/**
 * The line of a command's output that says the network failed, if one does: a command's failure message carries it
 * ("npm run release -- --publish failed (exit 1): the network: ... TLS handshake timeout"), so networkFailure sees
 * what a bare exit code hides. The Developer Herald's 0.5.6 was held at a commit for a TLS handshake timeout.
 */
export function networkLine(output: string): string | null {
  for (const raw of output.split(/\r?\n/).reverse()) {
    const line = raw.trim();
    // The Exchequer's line is never why a release failed (exchequer.ts): it runs after GitHub's, and fails nothing.
    if (line.startsWith(NOT_PUBLISHED)) continue;
    if (line && passingFailure(line)) return line.slice(0, 200);
  }
  return null;
}

/** ", the network: <its line>" for a failure message, when the output says the network failed; else nothing. */
export const networkNote = (output: string) => {
  const line = networkLine(output);
  return line ? `; the network: ${line}` : '';
};

/**
 * "; Not published to the Exchequer: …" for a release's message, when the kit's release (kit 2.30.0, exchequer.ts)
 * says it reached GitHub but not the Exchequer: no publisher key, or the Exchequer failed. Never a failure, nor an
 * alarm: the release on GitHub stands, and `npm run release -- --exchequer` in the agent's checkout finishes it.
 */
export function exchequerNote(output: string): string {
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith(NOT_PUBLISHED));
  return line ? `; ${line.slice(0, 300)}` : '';
}

/** An employee's repository from the stage's glance at GitHub, while it still says how things are. */
export const glanceOf = (ctx: Ctx, e: Employee): RepoGlance | null => ctx.glance?.repos[e.id] ?? null;

/** Once the Steward has changed an employee's repository (a merge), the glance no longer says how it is. */
export const forgetGlance = (ctx: Ctx, e: Employee) => {
  if (ctx.glance) delete ctx.glance.repos[e.id];
};

/**
 * An employee's released versions: from the glance while it says how things are, else asked of GitHub. One released
 * only on this PC (releasedHere) has no release anywhere else: the version its installed copy was built as counts too,
 * or every round would build and install it again.
 */
export async function releasedOf(ctx: Ctx, e: Employee): Promise<ReleaseInfo[]> {
  const g = glanceOf(ctx, e) ?? (hostIs(ctx, e) === 'git' ? await gitGlance(ctx.run, { branch: e.branch, checkout: checkoutOf(e) }) : null);
  const out = appReleasesIn(g ? JSON.stringify(g.releases) : must(await hostFor(ctx, e).listReleases(e.repo, 'tagName,isDraft,publishedAt')));
  const here = installedRelease(e);
  return here && !out.some((r) => r.version === here.version) ? [{ tag: `v${here.version}`, version: here.version, published: here.built }, ...out] : out;
}

/** The release installed here of an employee released only on this PC: its install folder's release.json, unless a development build. */
export function installedRelease(e: Pick<Employee, 'release' | 'installed'>): { version: string; built: string | null } | null {
  if (!releasedHere(e) || !e.installed) return null;
  try {
    const r = JSON.parse(readFileSync(path.join(path.resolve(expandEnv(e.installed)), 'release.json'), 'utf8').replace(/^﻿/, '')) as { version?: unknown; dirty?: unknown; built?: unknown };
    if (typeof r.version !== 'string' || r.dirty === true) return null;
    return { version: r.version, built: typeof r.built === 'string' ? r.built : null };
  } catch {
    return null;
  }
}

/**
 * origin/<branch> fresh in the employee's checkout, and its commit: fetched, unless the glance says GitHub's branch is
 * at the commit the checkout already has (then there's nothing to fetch).
 */
export async function freshBranch(ctx: Ctx, e: Employee, repo: string): Promise<string | null> {
  const head = glanceOf(ctx, e)?.head;
  const remote = `origin/${e.branch}`;
  if (head && (await commitOf(ctx.run, repo, remote)) === head) return head;
  await fetchBranch(ctx.run, repo, e.branch);
  return commitOf(ctx.run, repo, remote);
}

/** The employees a stage is asked about: all, or those named (by id, ignoring case). Unknown names are an error. */
export function pick(all: Employee[], only?: string[] | null): { employees: Employee[] } | { error: string } {
  if (!only?.length) return { employees: all };
  const want = only.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = want.filter((w) => !all.some((e) => e.id === w));
  if (unknown.length) return { error: `no employee called ${unknown.join(', ')} (they are ${all.map((e) => e.id).join(', ')})` };
  return { employees: all.filter((e) => want.includes(e.id)) };
}

export const checkoutOf = (e: Employee) => path.resolve(expandEnv(e.checkout));

/**
 * Why an employee isn't hired on this PC, or null when it is (or Settings name no install folder): its install folder
 * is gone, so it was removed (Manor's Fire, or by hand). The Steward still looks after its code, but never installs it
 * again by itself, by a release built here or an install: only Manor's Hire brings it back.
 */
export function notHiredHere(e: Pick<Employee, 'installed' | 'name'>): string | null {
  if (!e.installed) return null;
  const app = path.resolve(expandEnv(e.installed));
  return existsSync(app) ? null : `${e.name} isn't installed on this PC (no ${e.installed}), and the Steward doesn't install it again by itself: hire it in Manor to have it back`;
}
export const workRootOf = (s: Settings) => path.resolve(expandEnv(s.workRoot));
/** The Steward's worktree for an employee's bump, and the one for its release. */
export const bumpDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), e.id);
export const releaseDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-release`);
/** The branch a bump to a kit version is prepared on. */
export const bumpBranch = (kit: string) => `steward/kit-${kit}`;
/**
 * The Steward's kit PR still open for an older kit, which a newer kit goes onto instead of a PR of its own (the rollout's
 * fold): its number, its branch (steward/kit-<the kit it was opened for>) and the kit its branch pins now.
 */
export interface KitFold {
  number: number;
  head: string;
  kit: string;
}
export const NOT_ON_KIT = 'not using the kit yet';

/** Runs `fn` on each item, at most `limit` at once, keeping the order of the results. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export const result = (e: Employee, outcome: Outcome, message: string, more: Partial<EmployeeResult> = {}): EmployeeResult => ({ id: e.id, name: e.name, outcome, message, ...more });
