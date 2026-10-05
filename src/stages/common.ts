import path from 'node:path';
import { isNetworkError, online } from '../kit/net.ts';
import { expandEnv } from '../kit/settings-kit.ts';
import { commitOf, fetchBranch, gh } from '../git.ts';
import type { Glance, RepoGlance } from '../glance.ts';
import type { TastingDeps } from '../tasting.ts';
import { appReleasesIn, type ReleaseInfo } from './staff.ts';
import type { KitInfo } from '../kitsource.ts';
import type { Runner } from '../run.ts';
import type { Employee, Settings } from '../settings.ts';

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
  /** The next round looks at it again, whatever GitHub says (a release the Aletaster's tasting holds). */
  again?: boolean;
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
}

/**
 * Whether a failure is only the network's: its words say so, or this PC is offline now (the kit's net.ts). Such a
 * failure is no fault of the commit: nothing is held against it (round-failed.json, self-failed.json,
 * rollout-failed.json), and the next round tries again. A message rarely carries the command's output ("npm ci
 * failed (exit 1)"), so being offline right now counts too.
 */
export async function networkFailure(ctx: Pick<Ctx, 'online'>, message: string): Promise<boolean> {
  if (isNetworkError(message) || MORE_NET_WORDS.test(message)) return true;
  const look = ctx.online ?? (process.env.NODE_TEST_CONTEXT ? async () => true : online);
  return !(await look().catch(() => true));
}

/** Network failures the kit's words miss: Go's (gh's) TLS and HTTP client timeouts, and Windows' connect failure. */
const MORE_NET_WORDS = /tls handshake timeout|net\/http: (?:request canceled|timeout)|client\.timeout exceeded|connection attempt failed|could not establish (?:a )?connection/i;

/**
 * The line of a command's output that says the network failed, if one does: a command's failure message carries it
 * ("npm run release -- --publish failed (exit 1): the network: ... TLS handshake timeout"), so networkFailure sees
 * what a bare exit code hides. The Developer Herald's 0.5.6 was held at a commit for a TLS handshake timeout.
 */
export function networkLine(output: string): string | null {
  for (const raw of output.split(/\r?\n/).reverse()) {
    const line = raw.trim();
    if (line && (isNetworkError(line) || MORE_NET_WORDS.test(line))) return line.slice(0, 200);
  }
  return null;
}

/** ", the network: <its line>" for a failure message, when the output says the network failed; else nothing. */
export const networkNote = (output: string) => {
  const line = networkLine(output);
  return line ? `; the network: ${line}` : '';
};

/** An employee's repository from the stage's glance at GitHub, while it still says how things are. */
export const glanceOf = (ctx: Ctx, e: Employee): RepoGlance | null => ctx.glance?.repos[e.id] ?? null;

/** Once the Steward has changed an employee's repository (a merge), the glance no longer says how it is. */
export const forgetGlance = (ctx: Ctx, e: Employee) => {
  if (ctx.glance) delete ctx.glance.repos[e.id];
};

/** An employee's released versions: from the glance while it says how things are, else asked of GitHub. */
export async function releasedOf(ctx: Ctx, e: Employee): Promise<ReleaseInfo[]> {
  const g = glanceOf(ctx, e);
  return appReleasesIn(g ? JSON.stringify(g.releases) : await gh(ctx.run, ctx.neutralDir, 'release', 'list', '--repo', e.repo, '--limit', '100', '--json', 'tagName,isDraft,publishedAt'));
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
export const workRootOf = (s: Settings) => path.resolve(expandEnv(s.workRoot));
/** The Steward's worktree for an employee's bump, and the one for its release. */
export const bumpDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), e.id);
export const releaseDirOf = (s: Settings, e: Employee) => path.join(workRootOf(s), `${e.id}-release`);
/** The branch a bump to a kit version is prepared on. */
export const bumpBranch = (kit: string) => `steward/kit-${kit}`;
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
