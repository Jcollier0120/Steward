import { CommandFailed } from '../git.ts';
import type { Ran } from '../run.ts';

/**
 * A source host: where a repository's pull requests, commit statuses, releases and issues live (GitHub today; GitLab,
 * Azure DevOps, Gitea/Forgejo and Bitbucket to come). Everything the Steward asks of one goes through this, so its
 * rounds (claims, version order, stamp, vouch, train, catch-up, branches in) are the same on any host. A repository
 * worked with plain git (scm.ts) has no host: it has no pull requests to ask about.
 *
 * Answers come in GitHub's words: a list of pull requests is what `gh pr list --json <fields>` prints, a commit's
 * statuses what GitHub's REST API gives, and so on, as the Steward has always read them. Another host's adapter says
 * its own answers in those same words (a GitLab merge request as a pull request, its pipeline status as a status), so
 * nothing that reads them changes. Each adapter uses its host's own signed-in tool where there is one (gh, glab, az,
 * tea): the Steward never keeps a token.
 *
 * Every call answers rather than throws: what it ran in words (`what`), its exit code and what it printed. `must`
 * turns a failed answer into a CommandFailed, for the callers that want one.
 */

export type PrState = 'open' | 'closed' | 'merged';

/** What a host was asked, and what it said. */
export interface Answer extends Ran {
  /** The request in words, as a CommandFailed names it ("gh pr list --repo …"). */
  what: string;
}

/** An answer's output, or CommandFailed when it failed. */
export function must(a: Answer): string {
  if (a.code !== 0) throw new CommandFailed(a.what, a);
  return a.out;
}

export interface SourceHost {
  /** Which host this is, as scm.ts names it. */
  readonly kind: 'github' | 'gitlab' | 'azure' | 'gitea' | 'bitbucket';
  /** Its name in words, for logs and the page ("GitHub"). */
  readonly name: string;

  // Pull requests. `fields` is the comma-separated list of GitHub's PR fields wanted; an adapter gives what it can.
  /** Pull requests in a state, optionally only those from one branch; at most `limit` (the host's default when absent). */
  listPrs(repo: string, q: { state: PrState; head?: string; limit?: number; fields: string }): Promise<Answer>;
  /** One pull request, by number or by its branch. */
  viewPr(repo: string, which: number | string, fields: string): Promise<Answer>;
  /** Opens a pull request; its URL is the last line of the answer. The description is written to a file, never inline. */
  createPr(repo: string, p: { base: string; head: string; title: string; body: string }): Promise<Answer>;
  /** Changes a pull request's title, description or base branch. */
  editPr(repo: string, n: number, p: { title?: string; body?: string; base?: string }): Promise<Answer>;
  commentPr(repo: string, n: number, body: string): Promise<Answer>;
  /** Takes a pull request out of draft. */
  readyPr(repo: string, n: number): Promise<Answer>;
  closePr(repo: string, n: number, p?: { comment?: string; deleteBranch?: boolean }): Promise<Answer>;
  /** Merges a pull request with a merge commit; only while its head is `matchHead`, when given. */
  mergePr(repo: string, n: number, p?: { matchHead?: string; deleteBranch?: boolean }): Promise<Answer>;

  // Commit statuses: the vouch (stages/vouch.ts).
  /** A commit's statuses, newest first, as GitHub's REST API lists them (state, context, description, creator.login). */
  statuses(repo: string, commit: string): Promise<Answer>;
  setStatus(repo: string, commit: string, s: { state: 'success' | 'failure' | 'pending'; context: string; description: string }): Promise<Answer>;

  // Releases.
  listReleases(repo: string, fields: string, limit?: number): Promise<Answer>;
  viewRelease(repo: string, tag: string, fields: string): Promise<Answer>;
  /** Publishes a release of `target`, its notes from a file, or the host's own from the commits when there's none. */
  createRelease(repo: string, r: { tag: string; target: string; title: string; notesFile: string | null }): Promise<Answer>;
  /** A release's files matching `patterns` into `dir`, replacing any there. */
  downloadRelease(repo: string, tag: string, d: { patterns: string[]; dir: string }): Promise<Answer>;

  // Issues: the Wright's work queue (work.ts).
  listIssues(repo: string, q: { label: string; state: 'open' | 'closed'; limit?: number; fields: string }): Promise<Answer>;
  /** Files an issue with a label; its URL is the last line of the answer. */
  createIssue(repo: string, i: { title: string; body: string; label: string }): Promise<Answer>;
  editIssue(repo: string, n: number, p: { title?: string; body?: string; removeLabel?: string }): Promise<Answer>;
  commentIssue(repo: string, n: number, body: string): Promise<Answer>;
  closeIssue(repo: string, n: number, p: { reason: 'completed' | 'not planned'; comment: string }): Promise<Answer>;
  createLabel(repo: string, label: string, l: { color: string; description: string }): Promise<Answer>;

  /** The account this PC is signed in to the host as (its login, alone on the answer's output). */
  whoAmI(): Promise<Answer>;

  /** The ref a pull request's head is fetched by from origin (a fork's too, where the host keeps one). */
  prRef(pr: { number: number; head: string }): string;

  /** A release's page, for the round's line and the page. */
  releaseUrl(repo: string, tag: string): string;
}
