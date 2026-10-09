import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runner } from '../run.ts';
import type { Answer, SourceHost } from './host.ts';

const MINUTE = 60_000;

/**
 * GitHub, through the GitHub CLI (gh) as this PC has it signed in. Every call is the gh command the Steward has always
 * run, from `cwd`: a folder that is no employee's repository, so `--repo` alone says where.
 */
export class GitHub implements SourceHost {
  readonly kind = 'github' as const;
  readonly name = 'GitHub';

  private readonly run: Runner;
  private readonly cwd: string;

  constructor(run: Runner, cwd: string) {
    this.run = run;
    this.cwd = cwd;
  }

  private async gh(args: string[], timeoutMs = 5 * MINUTE): Promise<Answer> {
    const r = await this.run('gh', args, { cwd: this.cwd, timeoutMs });
    return { ...r, what: `gh ${args.join(' ')}` };
  }

  /** gh with a Markdown body written to a file (--body-file), never inline. */
  private async withBody(args: string[], body: string, timeoutMs = MINUTE): Promise<Answer> {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'steward-body-'));
    try {
      const file = path.join(dir, 'body.md');
      writeFileSync(file, body);
      return await this.gh([...args, '--body-file', file], timeoutMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  listPrs(repo: string, q: { state: 'open' | 'closed' | 'merged'; head?: string; limit?: number; fields: string }) {
    return this.gh(['pr', 'list', '--repo', repo, ...(q.head ? ['--head', q.head] : []), '--state', q.state, ...(q.limit ? ['--limit', String(q.limit)] : []), '--json', q.fields]);
  }

  viewPr(repo: string, which: number | string, fields: string) {
    return this.gh(['pr', 'view', String(which), '--repo', repo, '--json', fields]);
  }

  createPr(repo: string, p: { base: string; head: string; title: string; body: string }) {
    return this.withBody(['pr', 'create', '--repo', repo, '--base', p.base, '--head', p.head, '--title', p.title], p.body, 5 * MINUTE);
  }

  editPr(repo: string, n: number, p: { title?: string; body?: string; base?: string }) {
    const args = ['pr', 'edit', String(n), '--repo', repo, ...(p.title !== undefined ? ['--title', p.title] : []), ...(p.base !== undefined ? ['--base', p.base] : [])];
    return p.body !== undefined ? this.withBody(args, p.body) : this.gh(args, MINUTE);
  }

  commentPr(repo: string, n: number, body: string) {
    return this.gh(['pr', 'comment', String(n), '--repo', repo, '--body', body], MINUTE);
  }

  readyPr(repo: string, n: number) {
    return this.gh(['pr', 'ready', String(n), '--repo', repo], MINUTE);
  }

  closePr(repo: string, n: number, p: { comment?: string; deleteBranch?: boolean } = {}) {
    return this.gh(['pr', 'close', String(n), '--repo', repo, ...(p.deleteBranch ? ['--delete-branch'] : []), ...(p.comment !== undefined ? ['--comment', p.comment] : [])], 2 * MINUTE);
  }

  mergePr(repo: string, n: number, p: { matchHead?: string; deleteBranch?: boolean } = {}) {
    return this.gh(['pr', 'merge', String(n), '--repo', repo, '--merge', ...(p.matchHead ? ['--match-head-commit', p.matchHead] : []), ...(p.deleteBranch ? ['--delete-branch'] : [])]);
  }

  statuses(repo: string, commit: string) {
    return this.gh(['api', `repos/${repo}/commits/${commit}/statuses?per_page=100`], MINUTE);
  }

  setStatus(repo: string, commit: string, s: { state: 'success' | 'failure' | 'pending'; context: string; description: string }) {
    return this.gh(['api', '-X', 'POST', `repos/${repo}/statuses/${commit}`, '-f', `state=${s.state}`, '-f', `context=${s.context}`, '-f', `description=${s.description}`], MINUTE);
  }

  listReleases(repo: string, fields: string, limit = 100) {
    return this.gh(['release', 'list', '--repo', repo, '--limit', String(limit), '--json', fields]);
  }

  viewRelease(repo: string, tag: string, fields: string) {
    return this.gh(['release', 'view', tag, '--repo', repo, '--json', fields]);
  }

  createRelease(repo: string, r: { tag: string; target: string; title: string; notesFile: string | null }) {
    return this.gh(['release', 'create', r.tag, '--repo', repo, '--target', r.target, '--title', r.title, ...(r.notesFile ? ['--notes-file', r.notesFile] : ['--generate-notes'])]);
  }

  downloadRelease(repo: string, tag: string, d: { patterns: string[]; dir: string }) {
    return this.gh(['release', 'download', tag, '--repo', repo, ...d.patterns.flatMap((p) => ['--pattern', p]), '--dir', d.dir, '--clobber']);
  }

  listIssues(repo: string, q: { label: string; state: 'open' | 'closed'; limit?: number; fields: string }) {
    return this.gh(['issue', 'list', '--repo', repo, '--label', q.label, '--state', q.state, '--limit', String(q.limit ?? 100), '--json', q.fields], MINUTE);
  }

  createIssue(repo: string, i: { title: string; body: string; label: string }) {
    return this.withBody(['issue', 'create', '--repo', repo, '--title', i.title, '--label', i.label], i.body);
  }

  editIssue(repo: string, n: number, p: { title?: string; body?: string; removeLabel?: string }) {
    const args = ['issue', 'edit', String(n), '--repo', repo, ...(p.title !== undefined ? ['--title', p.title] : []), ...(p.removeLabel !== undefined ? ['--remove-label', p.removeLabel] : [])];
    return p.body !== undefined ? this.withBody(args, p.body) : this.gh(args, 2 * MINUTE);
  }

  commentIssue(repo: string, n: number, body: string) {
    return this.gh(['issue', 'comment', String(n), '--repo', repo, '--body', body], 2 * MINUTE);
  }

  closeIssue(repo: string, n: number, p: { reason: 'completed' | 'not planned'; comment: string }) {
    return this.gh(['issue', 'close', String(n), '--repo', repo, '--reason', p.reason, '--comment', p.comment], MINUTE);
  }

  createLabel(repo: string, label: string, l: { color: string; description: string }) {
    return this.gh(['label', 'create', label, '--repo', repo, '--color', l.color, '--description', l.description], MINUTE);
  }

  whoAmI() {
    return this.gh(['api', 'user', '--jq', '.login'], MINUTE);
  }

  prRef(n: number) {
    return `refs/pull/${n}/head`;
  }

  releaseUrl(repo: string, tag: string) {
    return `https://github.com/${repo}/releases/tag/${tag}`;
  }
}
