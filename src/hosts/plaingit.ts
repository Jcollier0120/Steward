import type { Answer, PrState, SourceHost } from './host.ts';

/**
 * A repository worked with plain git (scm.ts) that isn't on GitHub: on a host whose CLI isn't signed in here, a server of
 * your own, or no host at all. It has no pull requests, commit statuses, releases or issues the Steward can ask for, so
 * every question is answered as refused, in words that say why, rather than asked of GitHub about a repository that
 * isn't there (Steward 0.36.266: hostFor fell back to GitHub's for every one). The stages pass over such a repository
 * before they would ask; this is what answers one that didn't.
 */
export class PlainGit implements SourceHost {
  readonly kind = 'git' as const;
  readonly name = 'plain git';
  private readonly repo: string;
  constructor(repo: string) {
    this.repo = repo;
  }

  private no(what: string): Promise<Answer> {
    return Promise.resolve({ code: 1, out: '', err: `${this.repo} is worked with plain git here, which has no ${what}: sign in to its host's CLI for the Steward to work with them (docs/PIPELINE.md)`, what: `${what} of ${this.repo}` });
  }

  listPrs(_repo: string, _q: { state: PrState; head?: string; limit?: number; fields: string }) {
    return this.no('pull requests');
  }
  viewPr(_repo: string, _which: number | string, _fields: string) {
    return this.no('pull requests');
  }
  createPr(_repo: string, _p: { base: string; head: string; title: string; body: string }) {
    return this.no('pull requests');
  }
  editPr(_repo: string, _n: number, _p: { title?: string; body?: string; base?: string }) {
    return this.no('pull requests');
  }
  commentPr(_repo: string, _n: number, _body: string) {
    return this.no('pull requests');
  }
  closePr(_repo: string, _n: number, _p?: { comment?: string; deleteBranch?: boolean }) {
    return this.no('pull requests');
  }
  mergePr(_repo: string, _n: number, _p?: { matchHead?: string; deleteBranch?: boolean }) {
    return this.no('pull requests');
  }
  statuses(_repo: string, _commit: string) {
    return this.no('commit statuses');
  }
  setStatus(_repo: string, _commit: string, _s: { state: 'success' | 'failure' | 'pending'; context: string; description: string }) {
    return this.no('commit statuses');
  }
  listReleases(_repo: string, _fields: string, _limit?: number) {
    return this.no('releases (its releases are its tags)');
  }
  viewRelease(_repo: string, _tag: string, _fields: string) {
    return this.no('releases (its releases are its tags)');
  }
  createRelease(_repo: string, _r: { tag: string; target: string; title: string; notesFile: string | null }) {
    return this.no('releases (its releases are its tags)');
  }
  listIssues(_repo: string, _q: { label: string; state: 'open' | 'closed'; limit?: number; fields: string }) {
    return this.no('issues');
  }
  createIssue(_repo: string, _i: { title: string; body: string; label: string }) {
    return this.no('issues');
  }
  editIssue(_repo: string, _n: number, _p: { title?: string; body?: string; removeLabel?: string }) {
    return this.no('issues');
  }
  commentIssue(_repo: string, _n: number, _body: string) {
    return this.no('issues');
  }
  closeIssue(_repo: string, _n: number, _p: { reason: 'completed' | 'not planned'; comment: string }) {
    return this.no('issues');
  }
  createLabel(_repo: string, _label: string, _l: { color: string; description: string }) {
    return this.no('issues');
  }
  whoAmI() {
    return this.no('account to sign in to');
  }
  /** None: its release is a tag, with no page of its own to link to. */
  releaseUrl(_repo: string, _tag: string) {
    return '';
  }
}
