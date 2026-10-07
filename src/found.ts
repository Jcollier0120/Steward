import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { GetJson } from './alarms.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { originRepo } from './kit/manor.ts';
import { originUrl, repoFromUrl } from './scm.ts';
import { branchTree, dotnetTests, folderTree, type Tree } from './migrate.ts';
import type { Runner } from './run.ts';
import { loadSettings, normalizeSettings, REEVE_URL, settingsFile, TAG_RELEASE, type Employee, type Settings } from './settings.ts';

/**
 * The person's own repositories, as Reeve finds them. Reeve lists every git repository on this PC (his GET /api/repos,
 * else the scan he keeps in %USERPROFILE%\.reeve\repos.json): its folder, branch, origin and lockfiles. The Steward
 * offers those whose origin is on GitHub and that the account gh is signed in as can push to (one gh query for all of
 * them, viewerPermission ADMIN, MAINTAIN or WRITE), less those it already looks after and those Reeve leaves alone. The
 * person picks: Look after adds one to Settings (lookAfter), with what can be read from its clone (how to test it, its
 * version files, its release script), and with merging and releasing off unless the person ticked them. Nothing is
 * merged, released or claimed for a repository that isn't in Settings, except a version claimed by name (claims.ts).
 *
 * The look is kept in repos-found.json, and made again at most every hour, or when the page asks (Refresh).
 */

/** One repository as Reeve lists it, as far as the Steward reads it. */
export interface ReeveRepo {
  name?: unknown;
  path?: unknown;
  slug?: unknown;
  web?: unknown;
  branch?: unknown;
  defaultBranch?: unknown;
  packages?: unknown;
  ignored?: unknown;
}

/** One repository the Steward could look after. */
export interface FoundRepo {
  /** owner/name on GitHub. */
  repo: string;
  /** Reeve's name for it (its folder's), lower case. */
  name: string;
  /** Its main worktree, the person's clone. */
  path: string;
  /** origin's default branch, else the one checked out. */
  branch: string;
  /** Its lockfiles, as Reeve lists them. */
  lockfiles: string[];
  /** Whether gh's account can push to it: null when GitHub couldn't say, or wasn't asked (byGit). */
  push: boolean | null;
  /**
   * Worked with plain git (scm.ts): its origin isn't on GitHub, or the GitHub CLI isn't signed in here. GitHub can't say
   * whether it can be pushed to, so it is offered, and the first push of a release tag says.
   */
  byGit?: boolean;
}

export interface FoundState {
  at: string | null;
  /** Where the list came from: Reeve's page, his scan on disk, or nowhere. */
  from: 'reeve' | 'file' | null;
  /** Why there's no list, or why push couldn't be asked. */
  error: string | null;
  repos: FoundRepo[];
}

export const foundFile = () => dataFile('repos-found.json');
export const loadFound = (): FoundState => ({ at: null, from: null, error: null, repos: [], ...readJson<Partial<FoundState>>(foundFile(), {}) });

/** Looked at again after this long, when the page is opened. */
export const FOUND_MAX_AGE_MS = 60 * 60_000;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** owner/name of a repository Reeve lists, when its origin is on GitHub. */
export function githubOf(r: ReeveRepo): string | null {
  const web = typeof r.web === 'string' ? r.web : '';
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(web);
  if (m) return m[1];
  return typeof r.slug === 'string' && REPO.test(r.slug) && /github\.com/i.test(web) ? r.slug : null;
}

/** Reeve's home: REEVE_HOME, else %USERPROFILE%\.reeve. */
const reeveHome = (env: NodeJS.ProcessEnv = process.env) => env.REEVE_HOME ?? path.join(os.homedir(), '.reeve');

/** Reeve's list: his page's, else the scan he keeps on disk. */
export async function reeveRepos(o: { getJson: GetJson; reeveUrl?: string; home?: string }): Promise<{ repos: ReeveRepo[]; from: 'reeve' | 'file' } | { error: string }> {
  const answer = (await o.getJson(new URL('/api/repos', o.reeveUrl || REEVE_URL).href)) as any;
  if (Array.isArray(answer?.repos)) return { repos: answer.repos, from: 'reeve' };
  const file = path.join(o.home ?? reeveHome(), 'repos.json');
  const scan = readJson<any>(file, null);
  if (Array.isArray(scan?.repos)) return { repos: scan.repos, from: 'file' };
  return { error: existsSync(path.join(o.home ?? reeveHome(), 'app')) ? "Reeve's page didn't answer, and he has no list of repositories yet" : "Reeve isn't installed: he finds the repositories on this PC" };
}

/** Whether gh's account can push to each repository: one GraphQL query for up to 40 at a time. */
export async function pushable(run: Runner, cwd: string, repos: string[]): Promise<{ push: Map<string, boolean>; error: string | null }> {
  const push = new Map<string, boolean>();
  let error: string | null = null;
  for (let i = 0; i < repos.length; i += 40) {
    const batch = repos.slice(i, i + 40);
    const fields = batch.map((r, j) => {
      const [owner, name] = r.split('/');
      return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { viewerPermission }`;
    });
    const r = await run('gh', ['api', 'graphql', '-f', `query=query { ${fields.join(' ')} }`], { cwd, timeoutMs: 60_000 });
    let data: any = null;
    try {
      data = JSON.parse(r.out || 'null')?.data ?? null;
    } catch {
      data = null;
    }
    if (!data) {
      error = (r.err || r.out).trim().split('\n').pop() || `gh exited ${r.code}`;
      continue;
    }
    batch.forEach((repo, j) => {
      const p = data[`r${j}`]?.viewerPermission;
      if (typeof p === 'string') push.set(repo.toLowerCase(), ['ADMIN', 'MAINTAIN', 'WRITE'].includes(p));
    });
  }
  return { push, error };
}

/** The repositories Reeve finds, with whether gh's account can push to each, kept in repos-found.json. */
export async function findRepos(o: { run: Runner; cwd: string; getJson: GetJson; reeveUrl?: string; home?: string; now?: Date; githubReady?: boolean }): Promise<FoundState> {
  const at = (o.now ?? new Date()).toISOString();
  const listed = await reeveRepos(o);
  if ('error' in listed) {
    const state: FoundState = { at, from: null, error: listed.error, repos: [] };
    writeJson(foundFile(), state);
    return state;
  }
  const seen = new Set<string>();
  const repos: FoundRepo[] = [];
  for (const r of listed.repos) {
    // On GitHub, owner/name; anywhere else, its origin's host/path (scm.ts): GitHub isn't required.
    const onGithub = githubOf(r);
    const url = !onGithub && typeof r.path === 'string' ? originUrl(r.path) : null;
    const repo = onGithub ?? (url ? repoFromUrl(url) : null);
    if (!repo || r.ignored === true || typeof r.path !== 'string' || seen.has(repo.toLowerCase())) continue;
    seen.add(repo.toLowerCase());
    const branch = typeof r.defaultBranch === 'string' && r.defaultBranch ? r.defaultBranch : typeof r.branch === 'string' && r.branch ? r.branch : 'main';
    const lockfiles = Array.isArray(r.packages) ? r.packages.map((p: any) => (typeof p?.lockfile === 'string' ? `${p.dir ? `${p.dir}/` : ''}${p.lockfile}` : '')).filter(Boolean) : [];
    const byGit = !onGithub || o.githubReady === false;
    repos.push({ repo, name: typeof r.name === 'string' ? r.name : (repo.split('/').pop() ?? repo).toLowerCase(), path: r.path, branch, lockfiles, push: null, ...(byGit ? { byGit } : {}) });
  }
  const asked = repos.filter((r) => !r.byGit);
  const { push, error } = asked.length ? await pushable(o.run, o.cwd, asked.map((r) => r.repo)) : { push: new Map<string, boolean>(), error: null };
  for (const r of asked) r.push = push.get(r.repo.toLowerCase()) ?? null;
  const state: FoundState = { at, from: listed.from, error: error ? `GitHub couldn't say which you can push to: ${error}` : null, repos };
  writeJson(foundFile(), state);
  return state;
}

/** Whether the list is old enough to look again. */
export const foundStale = (s: FoundState, now = Date.now()) => !s.at || now - Date.parse(s.at) > FOUND_MAX_AGE_MS;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** The repositories offered: ones gh's account can push to, that Settings don't already name (by repository or clone). */
export function candidates(s: FoundState, employees: Pick<Employee, 'repo' | 'checkout'>[]): FoundRepo[] {
  return s.repos.filter((r) => (r.push === true || (r.byGit === true && r.push === null)) && !employees.some((e) => (e.repo && same(e.repo, r.repo)) || (e.checkout && samePath(e.checkout, r.path))));
}

/** The npm default test script, which only fails: not a test. */
const NO_TEST = /no test specified/i;

/** How to test a clone, the files that carry its version, and whether it has a release script of its own: read at its branch's tip. */
export function readClone(checkout: string, branch: string): { test: string[]; versionFiles: string[]; releaseScript: boolean } {
  const t: Tree = branchTree(checkout, branch) ?? folderTree(checkout);
  let pkg: { version?: unknown; scripts?: Record<string, unknown> } | null = null;
  try {
    pkg = JSON.parse(t.read('package.json') ?? 'null');
  } catch {
    pkg = null;
  }
  const scripts = pkg?.scripts ?? {};
  const test: string[] = [];
  const versionFiles: string[] = [];
  if (pkg) {
    if (typeof scripts.typecheck === 'string') test.push('npm run typecheck');
    if (typeof scripts.test === 'string' && !NO_TEST.test(scripts.test)) test.push('npm test');
    if (typeof pkg.version === 'string') {
      versionFiles.push('package.json');
      if (t.has('package-lock.json')) versionFiles.push('package-lock.json');
      // A .ts beside it that carries the same version (version: 'x.y.z', or VERSION = 'x.y.z'), kept in step.
      const v = pkg.version.replaceAll('.', '\\.');
      const ts = t.list('src').filter((f) => f.endsWith('.ts')).sort();
      const at = ts.find((f) => new RegExp(`(?:\\bversion\\s*:|\\bVERSION\\s*=)\\s*['"]${v}['"]`).test(t.read(`src/${f}`) ?? ''));
      if (at) versionFiles.push(`src/${at}`);
    }
  } else {
    if (t.has('Cargo.toml')) test.push('cargo test');
    if (t.has('go.mod')) test.push('go test ./...');
    test.push(...dotnetTests(t));
    if (/<VersionPrefix>/.test(t.read('Directory.Build.props') ?? '')) versionFiles.push('Directory.Build.props');
    else
      for (const d of t.list('').filter((d) => t.isDir(d))) {
        for (const f of t.list(d).filter((f) => f.endsWith('.csproj'))) if (/<VersionPrefix>/.test(t.read(`${d}/${f}`) ?? '')) versionFiles.push(`${d}/${f}`);
      }
  }
  return { test, versionFiles, releaseScript: typeof scripts.release === 'string' };
}

/** An id for a repository that no employee has yet: its name, lower case, letters, digits and dashes. */
export function idFor(repo: string, taken: string[]): string {
  const base = (repo.split('/').pop() ?? repo).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '') || 'repo';
  let id = base.slice(0, 40);
  for (let n = 2; taken.includes(id); n++) id = `${base.slice(0, 36)}-${n}`;
  return id;
}

/**
 * A repository as Settings would look after it: its clone and branch, what its clone says (tests, version files), no
 * kit, nothing installed; merging and releasing only as asked. Released with its own release script when it has one,
 * else by a release the Steward makes (tag): a GitHub release, or a v<version> tag pushed to origin when it is worked with
 * plain git (scm.ts).
 */
export function employeeFromFound(r: FoundRepo, o: { taken: string[]; merges: boolean; release: boolean }): Employee {
  const read = readClone(r.path, r.branch);
  return {
    id: idFor(r.repo, o.taken),
    name: r.repo.split('/').pop() ?? r.repo,
    repo: r.repo,
    checkout: r.path,
    branch: r.branch,
    merges: o.merges,
    usesKit: false,
    parts: [],
    fill: '',
    test: read.test,
    versionFiles: read.versionFiles,
    release: o.release && read.versionFiles.length ? (read.releaseScript ? 'npm run release' : TAG_RELEASE) : '',
    install: '',
    approve: '',
    installed: '',
  };
}

/**
 * Look after: the found repository added to Settings (settings.json's employees, the rest of the file as it was). An
 * error in words when it isn't one the Steward can offer.
 */
export function lookAfter(repo: string, o: { merges: boolean; release: boolean; found?: FoundState; file?: string }): { employee: Employee } | { error: string } {
  // Settings read once first, so a new install is known as one before this writes its settings.json (migrate.ts).
  if (!o.file) loadSettings();
  const file = o.file ?? settingsFile();
  const raw = readJson<Record<string, unknown>>(file, {});
  const current = normalizeSettings(raw).settings.employees;
  const found = o.found ?? loadFound();
  const r = candidates(found, current).find((x) => same(x.repo, repo));
  if (!r) {
    if (current.some((e) => same(e.repo, repo))) return { error: `${repo} is looked after already: see Settings, under Repositories.` };
    return { error: `${repo} isn't one Reeve found here that you can push to. Refresh the list, or add it in Settings.` };
  }
  const employee = employeeFromFound(r, { taken: current.map((e) => e.id), merges: o.merges, release: o.release });
  const employees = Array.isArray(raw.employees) ? raw.employees : [];
  writeJson(file, { ...raw, employees: [...employees, employee] });
  return { employee };
}

/**
 * A repository for a version claim that Settings don't name (claim-version works for any repository): owner/repo, or a
 * name, among the ones Reeve found, else the clone the command runs in when its origin is that repository. Null when
 * there's no clone of it here.
 */
export function anyRepo(who: string, o: { found?: FoundState; cwd?: string } = {}): Employee | null {
  const found = o.found ?? loadFound();
  const w = who.toLowerCase();
  const r = found.repos.find((x) => x.repo.toLowerCase() === w || x.repo.split('/')[1].toLowerCase() === w || x.name === w);
  if (r) return employeeFromFound(r, { taken: [], merges: false, release: false });
  const cwd = o.cwd ?? process.cwd();
  const origin = originRepo(cwd);
  if (!origin || !(origin.toLowerCase() === w || origin.split('/')[1].toLowerCase() === w)) return null;
  // Its top folder, where the version files are.
  let top = path.resolve(cwd);
  while (!existsSync(path.join(top, '.git')) && path.dirname(top) !== top) top = path.dirname(top);
  let branch = 'main';
  try {
    branch = execFileSync('git', ['-C', top, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^origin\//, '') || 'main';
  } catch {
    // origin/HEAD isn't known here: main.
  }
  return employeeFromFound({ repo: origin, name: origin.split('/')[1].toLowerCase(), path: top, branch, lockfiles: [], push: null }, { taken: [], merges: false, release: false });
}

/** The page's view of it: what Reeve found that could be looked after, and why nothing can when nothing can. */
export function foundView(s: FoundState, settings: Pick<Settings, 'employees'>): { at: string | null; error: string | null; from: FoundState['from']; offered: FoundRepo[]; found: number } {
  return { at: s.at, error: s.error, from: s.from, offered: candidates(s, settings.employees), found: s.repos.length };
}
