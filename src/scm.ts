import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Field } from './kit/settings-kit.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { GlanceRelease, RepoGlance } from './glance.ts';
import type { Runner } from './run.ts';
import type { Employee, Settings } from './settings.ts';

/**
 * Source control, as this PC has it. GitHub is never required: the Steward looks for what is installed (once an hour,
 * kept in source-control.json) and works with what it finds, choosing by itself (Settings' Source control: Automatic)
 * unless the person picks one.
 *
 * Each repository is worked with one of three ways:
 * - **GitHub**: its repository is on GitHub (owner/name) and the GitHub CLI is installed and signed in. Everything as
 *   before: one GraphQL glance, pull requests merged, GitHub releases, issues filed for the Wright.
 * - **GitLab**: its repository is on a GitLab (gitlab.com/group/app, or a host whose name says gitlab) and the GitLab
 *   CLI (glab) is installed and signed in. As GitHub's way, merge requests standing for pull requests, with no glance:
 *   each repository is asked on its own.
 * - **Azure DevOps**: its repository is on Azure DevOps (dev.azure.com/org/project/_git/app, or the older
 *   org.visualstudio.com) and the Azure CLI (az) is installed and signed in (az login). As GitLab's way; a release is
 *   an annotated v<version> tag, Azure DevOps having no releases.
 * - **Git**: any other, on any host (Bitbucket, a server or shared folder of your own), or a GitHub, GitLab or Azure
 *   DevOps one where its CLI isn't there. Plain git against its own origin: its branch and its tags are read
 *   with `git ls-remote`, a release is a `v<version>` tag on origin (annotated, its message the version's CHANGELOG.md
 *   entry), pushed by the Steward once the release command has run, and there are no pull requests to merge: what
 *   lands on the branch is released.
 *
 * Other source control (Mercurial, Subversion, Perforce, Plastic SCM) is found and named, but not worked with yet.
 * Castellan's own release machinery (releasesCastellan) is GitHub's, whatever is chosen.
 *
 * GitHub, GitLab and Azure DevOps are asked through a source host (hosts/), the one interface for pull requests,
 * commit statuses, releases and issues, so other hosts with pull requests (Gitea/Forgejo, Bitbucket) can stand where
 * they do. Settings' Source control: GitHub means GitHub's way for every repository; GitLab's and Azure DevOps' are
 * chosen by Automatic.
 */

export type Host = 'github' | 'gitlab' | 'azure' | 'git';
export type SourceControl = 'auto' | 'github' | 'git';

export interface Tool {
  /** Its command. */
  cmd: string;
  name: string;
  /** Its first line of --version, or null when it isn't installed. */
  version: string | null;
  /** The GitHub, GitLab and Azure CLIs only: signed in (a token or account kept on this PC). */
  signedIn?: boolean;
  /** Whether the Steward works with it. */
  supported: boolean;
}

export interface ScmLook {
  at: string;
  tools: Tool[];
}

const KNOWN: { cmd: string; name: string; args: string[]; supported: boolean }[] = [
  { cmd: 'git', name: 'Git', args: ['--version'], supported: true },
  { cmd: 'gh', name: 'GitHub CLI', args: ['--version'], supported: true },
  { cmd: 'glab', name: 'GitLab CLI', args: ['--version'], supported: true },
  { cmd: 'az', name: 'Azure CLI', args: ['--version'], supported: true },
  { cmd: 'hg', name: 'Mercurial', args: ['--version', '--quiet'], supported: false },
  { cmd: 'svn', name: 'Subversion', args: ['--version', '--quiet'], supported: false },
  { cmd: 'p4', name: 'Perforce', args: ['-V'], supported: false },
  { cmd: 'cm', name: 'Plastic SCM', args: ['version'], supported: false },
];

export const scmFile = () => dataFile('source-control.json');
/** How often what is installed is looked at again. */
export const LOOK_EVERY_MS = 60 * 60_000;

export const loadScm = (): ScmLook | null => readJson<ScmLook | null>(scmFile(), null);

/** What is installed, asked of each command (its version; the GitHub, GitLab and Azure CLIs whether they are signed in). */
export async function findScm(run: Runner, now = new Date()): Promise<ScmLook> {
  const tools = await Promise.all(
    KNOWN.map(async (k): Promise<Tool> => {
      const r = await run(k.cmd, k.args, { timeoutMs: 20_000 }).catch(() => ({ code: 1, out: '', err: '' }));
      const line = `${r.out}\n${r.err}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
      const version = r.code === 0 && line ? line.slice(0, 120) : null;
      const tool: Tool = { cmd: k.cmd, name: k.name, version, supported: k.supported };
      // A token kept on this PC: GitHub isn't asked, and the token itself is never kept or shown.
      if (k.cmd === 'gh' && version) tool.signedIn = (await run('gh', ['auth', 'token', '--hostname', 'github.com'], { timeoutMs: 20_000 }).catch(() => ({ code: 1 }))).code === 0;
      // glab says whether it holds a token for its hosts; it may check one with its host, never shows it.
      if (k.cmd === 'glab' && version) tool.signedIn = (await run('glab', ['auth', 'status'], { timeoutMs: 20_000 }).catch(() => ({ code: 1 }))).code === 0;
      // az has an account when `az login` was run; Azure isn't asked.
      if (k.cmd === 'az' && version) tool.signedIn = (await run('az', ['account', 'show', '--output', 'none'], { timeoutMs: 30_000 }).catch(() => ({ code: 1 }))).code === 0;
      return tool;
    }),
  );
  return { at: now.toISOString(), tools };
}

/** What is installed, as last looked at; looked at again when it's an hour old, or never was. Never throws. */
export async function scmNow(run: Runner, o: { now?: Date; force?: boolean } = {}): Promise<ScmLook | null> {
  const now = o.now ?? new Date();
  const kept = loadScm();
  if (kept && !o.force && now.getTime() - Date.parse(kept.at) < LOOK_EVERY_MS) return kept;
  try {
    const look = await findScm(run, now);
    writeJson(scmFile(), look);
    return look;
  } catch {
    return kept;
  }
}

const has = (look: ScmLook | null, cmd: string) => !!look?.tools.find((t) => t.cmd === cmd && t.version);
/** The GitHub CLI installed and signed in: the GitHub way works. */
export const githubReady = (look: ScmLook | null) => !!look?.tools.find((t) => t.cmd === 'gh' && t.version && t.signedIn);

/** The GitLab CLI installed and signed in: GitLab's way works. */
export const gitlabReady = (look: ScmLook | null) => !!look?.tools.find((t) => t.cmd === 'glab' && t.version && t.signedIn);

/** The Azure CLI installed and signed in: Azure DevOps' way works. */
export const azureReady = (look: ScmLook | null) => !!look?.tools.find((t) => t.cmd === 'az' && t.version && t.signedIn);

/** A repository on Azure DevOps, as repoFromUrl names one: dev.azure.com/…, ssh.dev.azure.com/v3/… or org.visualstudio.com/…. Pure. */
export const isAzureRepo = (repo: string) => /^(ssh\.)?dev\.azure\.com\/|^[^./]+\.visualstudio\.com\//i.test(repo);

/** A repository on a GitLab, as repoFromUrl names one: gitlab.com/group/app, or a host whose name says gitlab. Pure. */
export const isGitlabRepo = (repo: string) => /^[^/]*gitlab[^/]*\/[^/]+\/.+$/i.test(repo);

/** A repository named as GitHub names one (owner/name), not a host's path (gitlab.com/group/name). */
export const isGithubRepo = (repo: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !/\./.test(repo.split('/')[0]);

/**
 * How the Steward works with a repository (see above). With no look at what is installed yet (null), as before:
 * GitHub for a GitHub repository. Pure.
 */
export function hostOf(e: Pick<Employee, 'repo'>, s: Pick<Settings, 'sourceControl' | 'releasesCastellan'>, look: ScmLook | null): Host {
  if (s.releasesCastellan) return 'github';
  if (s.sourceControl === 'git') return 'git';
  if (s.sourceControl === 'github') return 'github';
  if (isGitlabRepo(e.repo)) return look && gitlabReady(look) ? 'gitlab' : 'git';
  if (isAzureRepo(e.repo)) return look && azureReady(look) ? 'azure' : 'git';
  if (!isGithubRepo(e.repo)) return 'git';
  return !look || githubReady(look) ? 'github' : 'git';
}

/** What Automatic comes to on this PC, in words, for Settings and the page. Pure. */
export function autoWords(look: ScmLook | null): string {
  if (!look) return "Automatic: the Steward hasn't looked at this PC's source control yet";
  const ways = [...(githubReady(look) ? ['GitHub for repositories on GitHub (the GitHub CLI is signed in)'] : []), ...(gitlabReady(look) ? ['GitLab for repositories on GitLab (the GitLab CLI is signed in)'] : []), ...(azureReady(look) ? ['Azure DevOps for repositories on Azure DevOps (the Azure CLI is signed in)'] : [])];
  if (ways.length) return `Automatic: ${ways.join(', ')}, Git for any other`;
  const unsigned = [...(has(look, 'gh') ? ['the GitHub CLI is installed, but not signed in: gh auth login'] : []), ...(has(look, 'glab') ? ['the GitLab CLI is installed, but not signed in: glab auth login'] : []), ...(has(look, 'az') ? ['the Azure CLI is installed, but not signed in: az login'] : [])];
  if (has(look, 'git')) return `Automatic: Git for every repository, on any host${unsigned.length ? ` (${unsigned.join('; ')})` : ''}`;
  return 'Automatic: no source control the Steward works with is installed (Git, say)';
}

/** What was found on this PC, in words. Pure. */
export function foundWords(look: ScmLook | null): string {
  if (!look) return '';
  const found = look.tools.filter((t) => t.version);
  if (!found.length) return 'None found on this PC.';
  const works = found.filter((t) => t.supported).map((t) => `${t.name}${t.cmd === 'gh' || t.cmd === 'glab' || t.cmd === 'az' ? (t.signedIn ? ', signed in' : ', not signed in') : ''}`);
  const not = found.filter((t) => !t.supported).map((t) => t.name);
  return [`Found on this PC: ${works.join('; ') || 'nothing the Steward works with'}.`, ...(not.length ? [`Not worked with yet: ${not.join(', ')}.`] : [])].join(' ');
}

/**
 * Settings' Source control as this PC offers it: Automatic, and each way whose tools are installed (usually one); a
 * way already chosen stays offered, so a saved choice is never refused. Its help says what was found. Pure.
 */
export function sourceControlField(base: Field, look: ScmLook | null, chosen: string): Field {
  if (base.kind !== 'choice') return base;
  const offered = base.options.filter((o) => o.value === 'auto' || o.value === chosen || !look || (o.value === 'git' ? has(look, 'git') : has(look, 'gh') && has(look, 'git')));
  const options = offered.map((o) => (o.value === 'auto' ? { ...o, label: autoWords(look) } : o));
  return { ...base, options, help: [base.help, foundWords(look)].filter(Boolean).join(' ') };
}

/** A clone's origin URL, read from its git config (a worktree's .git file followed), or null. */
export function originUrl(checkout: string): string | null {
  try {
    let git = path.join(checkout, '.git');
    if (statSync(git).isFile()) {
      const to = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, 'utf8'))?.[1]?.trim();
      if (!to) return null;
      git = path.resolve(checkout, to);
      const common = path.join(git, 'commondir');
      if (existsSync(common)) git = path.resolve(git, readFileSync(common, 'utf8').trim());
    }
    const config = readFileSync(path.join(git, 'config'), 'utf8');
    return /\[remote "origin"\][^[]*?^\s*url\s*=\s*(.+)$/m.exec(config)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * A repository's name from its origin URL: owner/name on GitHub; host/path anywhere else
 * (gitlab.com/group/app, dev.azure.com/org/project/_git/app), or the folder's name for a path. Pure.
 */
export function repoFromUrl(url: string): string | null {
  const u = url.trim().replace(/\.git\/*$/i, '').replace(/\/+$/, '');
  const gh = /github\.com[:/]+([^/\s]+)\/([^/\s]+)$/i.exec(u);
  if (gh) return `${gh[1]}/${gh[2]}`;
  const web = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  if (web) return `${web[1].toLowerCase()}/${web[2]}`;
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(u);
  if (scp && !/^[A-Za-z]$/.test(scp[1])) return `${scp[1].toLowerCase()}/${scp[2]}`;
  const name = u.split(/[\\/]/).filter(Boolean).pop();
  return name ? `local/${name}` : null;
}

const VERSION_TAG = /^v\d+\.\d+\.\d+$/;

/** A repository's branch head and v<x.y.z> tags, from `git ls-remote` in its clone: the Git way's glance. Pure. */
export function readLsRemote(out: string, branch: string): RepoGlance {
  let head: string | null = null;
  const tags = new Map<string, { oid: string; peeled: string | null }>();
  for (const line of out.split(/\r?\n/)) {
    const [oid, ref] = line.trim().split(/\s+/);
    if (!oid || !ref) continue;
    if (ref === `refs/heads/${branch}`) head = oid;
    const m = /^refs\/tags\/(.+?)(\^\{\})?$/.exec(ref);
    if (!m || !VERSION_TAG.test(m[1])) continue;
    const t = tags.get(m[1]) ?? { oid, peeled: null };
    if (m[2]) t.peeled = oid;
    else t.oid = oid;
    tags.set(m[1], t);
  }
  const num = (tag: string) => tag.slice(1).split('.').map(Number);
  const releases: GlanceRelease[] = [...tags]
    .sort(([a], [b]) => {
      const [x, y] = [num(a), num(b)];
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    })
    .map(([tagName, t]) => ({ tagName, isDraft: false, publishedAt: null, commit: t.peeled ?? t.oid }));
  return { head, prs: [], releases };
}

/** The Git way's glance at one repository: one `git ls-remote` of origin in its clone. */
export async function gitGlance(run: Runner, e: Pick<Employee, 'branch'> & { checkout: string }): Promise<RepoGlance> {
  if (!existsSync(e.checkout)) throw new Error(`no clone at ${e.checkout}`);
  const r = await run('git', ['ls-remote', 'origin', `refs/heads/${e.branch}`, 'refs/tags/v*'], { cwd: e.checkout, timeoutMs: 2 * 60_000 });
  if (r.code !== 0) throw new Error(`git ls-remote origin failed (${r.code}): ${(r.err || r.out).trim().split('\n').pop() || 'no output'}`);
  return readLsRemote(r.out, e.branch);
}
