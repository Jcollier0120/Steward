import type { Host } from './scm.ts';

/**
 * A repository's pages on its host (its own, a release's, a commit's, a compare's), for the Steward's page and its
 * results: Steward 0.36.266, when each was GitHub's whatever the host. Pure, with no node imports, so the page's bundle
 * takes it too. A repository is named as scm.ts names it: owner/name on GitHub, host/path anywhere else, local/<folder>
 * for one on this PC alone. Null where there is no such page: a local one, or a host whose pages aren't known.
 */

type Kind = Exclude<Host, 'git'>;

const OWNER_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The kind of host a repository is on: the one it's worked with, else (plain git) the one its name says, if any. */
export function kindOf(repo: string, host: Host | null | undefined): Kind | null {
  if (host && host !== 'git') return host;
  if (OWNER_NAME.test(repo) && !/\./.test(repo.split('/')[0])) return /^local\//i.test(repo) ? null : 'github';
  const name = repo.split('/')[0].toLowerCase();
  if (name === 'github.com' || /(^|\.)github\./.test(name)) return 'github';
  if (/(^|\.)gitlab\./.test(name)) return 'gitlab';
  if (name === 'bitbucket.org') return 'bitbucket';
  if (name === 'dev.azure.com' || name.endsWith('.visualstudio.com')) return 'azure';
  if (name === 'codeberg.org' || /(^|\.)(gitea|forgejo)\./.test(name)) return 'gitea';
  return null;
}

/** A repository's own page. A host/path one is at https on its host, whatever its host is; a local one has none. */
export function repoUrl(repo: string): string | null {
  if (!repo || /^local\//i.test(repo)) return null;
  if (OWNER_NAME.test(repo) && !/\./.test(repo.split('/')[0])) return `https://github.com/${repo}`;
  return /^[^/\s]+\.[^/\s]+\/\S+/.test(repo) ? `https://${repo}` : null;
}

/** A release's page, by its tag: the host's release, or its tag's tree where the host keeps no releases. */
export function releaseUrl(repo: string, host: Host | null | undefined, tag: string): string | null {
  const base = repoUrl(repo);
  const t = encodeURIComponent(tag);
  switch (base ? kindOf(repo, host) : null) {
    case 'github':
    case 'gitea':
      return `${base}/releases/tag/${t}`;
    case 'gitlab':
      return `${base}/-/releases/${t}`;
    case 'bitbucket':
      return `${base}/src/${t}`;
    case 'azure':
      return `${base}?version=GT${t}`;
    default:
      return null;
  }
}

/** A commit's page. */
export function commitUrl(repo: string, host: Host | null | undefined, sha: string): string | null {
  const base = repoUrl(repo);
  switch (base ? kindOf(repo, host) : null) {
    case 'github':
    case 'gitea':
    case 'azure':
      return `${base}/commit/${sha}`;
    case 'gitlab':
      return `${base}/-/commit/${sha}`;
    case 'bitbucket':
      return `${base}/commits/${sha}`;
    default:
      return null;
  }
}

/** The commits from one to another (a tag or a commit to a branch), where the host shows them on one page. */
export function compareUrl(repo: string, host: Host | null | undefined, from: string, to: string): string | null {
  const base = repoUrl(repo);
  switch (base ? kindOf(repo, host) : null) {
    case 'github':
    case 'gitea':
      return `${base}/compare/${from}...${to}`;
    case 'gitlab':
      return `${base}/-/compare/${from}...${to}`;
    default:
      return null;
  }
}

/** What a host calls itself, for words on the page: "GitHub", "GitLab", or "its host" where it isn't known. */
export function hostWord(repo: string, host?: Host | null): string {
  const k = kindOf(repo, host);
  return k ? { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', azure: 'Azure DevOps', gitea: 'Gitea' }[k] : /^local\//i.test(repo) ? 'this PC' : 'its host';
}
