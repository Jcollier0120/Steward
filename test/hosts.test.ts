import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Source hosts (src/hosts/): everything the Steward asks of where a repository lives goes through one interface.
// GitHub's adapter runs the gh commands the Steward always has, from a folder that is no employee's repository.
const { CommandFailed } = await import('../src/git.ts');
const { hostFor, must } = await import('../src/hosts/index.ts');
const { ok } = await import('./helpers.ts');
type Ran = import('../src/run.ts').Ran;

/** A host whose gh answers `answer`, and every gh command it ran, with its folder and any body file's text then. */
function recorded(answer: (args: string[]) => Ran = () => ok('')) {
  const ran: { args: string[]; cwd?: string; body?: string }[] = [];
  const host = hostFor({
    run: async (cmd, args, opts) => {
      assert.equal(cmd, 'gh');
      const i = args.indexOf('--body-file');
      ran.push({ args, cwd: opts?.cwd, ...(i >= 0 ? { body: readFileSync(args[i + 1], 'utf8') } : {}) });
      return answer(args);
    },
    neutralDir: 'C:/neutral',
  });
  return { host, ran };
}

const R = 'Jcollier0120/Fake';

test("GitHub's pull requests: the gh commands as the Steward has always run them, from the neutral folder", async () => {
  const { host, ran } = recorded();
  await host.listPrs(R, { state: 'open', limit: 100, fields: 'number,title' });
  await host.listPrs(R, { state: 'closed', head: 'claude/x', fields: 'number,headRefOid' });
  await host.viewPr(R, 31, 'state');
  await host.viewPr(R, 'claude/x', 'number');
  await host.editPr(R, 31, { title: 'T' });
  await host.editPr(R, 31, { base: 'main' });
  await host.commentPr(R, 31, 'hello');
  await host.readyPr(R, 31);
  await host.closePr(R, 31, { deleteBranch: true, comment: 'bye' });
  await host.closePr(R, 32, { comment: 'bye' });
  await host.mergePr(R, 31, { matchHead: 'abc', deleteBranch: true });
  await host.mergePr(R, 32);
  assert.deepEqual(
    ran.map((r) => r.args),
    [
      ['pr', 'list', '--repo', R, '--state', 'open', '--limit', '100', '--json', 'number,title'],
      ['pr', 'list', '--repo', R, '--head', 'claude/x', '--state', 'closed', '--json', 'number,headRefOid'],
      ['pr', 'view', '31', '--repo', R, '--json', 'state'],
      ['pr', 'view', 'claude/x', '--repo', R, '--json', 'number'],
      ['pr', 'edit', '31', '--repo', R, '--title', 'T'],
      ['pr', 'edit', '31', '--repo', R, '--base', 'main'],
      ['pr', 'comment', '31', '--repo', R, '--body', 'hello'],
      ['pr', 'ready', '31', '--repo', R],
      ['pr', 'close', '31', '--repo', R, '--delete-branch', '--comment', 'bye'],
      ['pr', 'close', '32', '--repo', R, '--comment', 'bye'],
      ['pr', 'merge', '31', '--repo', R, '--merge', '--match-head-commit', 'abc', '--delete-branch'],
      ['pr', 'merge', '32', '--repo', R, '--merge'],
    ],
  );
  assert.ok(ran.every((r) => r.cwd === 'C:/neutral'));
});

test('a description goes in a file, gone once gh has read it', async () => {
  const { host, ran } = recorded(() => ok('https://github.com/Jcollier0120/Fake/pull/31\n'));
  const url = must(await host.createPr(R, { base: 'main', head: 'claude/x', title: 'Fake 0.4.1: A feature', body: '**A feature.**\n\n- `code`, "quotes" and $dollars' })).trim().split('\n').pop();
  assert.equal(url, 'https://github.com/Jcollier0120/Fake/pull/31');
  const [create] = ran;
  assert.deepEqual(create.args.slice(0, 10), ['pr', 'create', '--repo', R, '--base', 'main', '--head', 'claude/x', '--title', 'Fake 0.4.1: A feature']);
  assert.equal(create.args[10], '--body-file');
  assert.equal(create.body, '**A feature.**\n\n- `code`, "quotes" and $dollars');
  assert.equal(existsSync(create.args[11]), false);

  await host.editPr(R, 31, { title: 'T', body: 'B' });
  await host.createIssue(R, { title: 'Bump', body: 'Do it', label: 'manor:work' });
  await host.editIssue(R, 7, { title: 'Bump', body: 'Again' });
  assert.deepEqual(ran.slice(1).map((r) => [r.args.slice(0, -1), r.body]), [
    [['pr', 'edit', '31', '--repo', R, '--title', 'T', '--body-file'], 'B'],
    [['issue', 'create', '--repo', R, '--title', 'Bump', '--label', 'manor:work', '--body-file'], 'Do it'],
    [['issue', 'edit', '7', '--repo', R, '--title', 'Bump', '--body-file'], 'Again'],
  ]);
});

test("GitHub's statuses, releases and issues", async () => {
  const { host, ran } = recorded();
  await host.statuses(R, 'abc');
  await host.setStatus(R, 'abc', { state: 'success', context: 'steward/tested', description: 'npm test passed at abc' });
  await host.listReleases(R, 'tagName,isDraft');
  await host.viewRelease(R, 'v0.4.0', 'targetCommitish');
  await host.createRelease(R, { tag: 'v0.4.1', target: 'abc', title: 'Fake 0.4.1', notesFile: 'C:/notes.md' });
  await host.createRelease(R, { tag: 'v0.4.2', target: 'def', title: 'Fake 0.4.2', notesFile: null });
  await host.downloadRelease(R, 'v0.4.1', { patterns: ['*.zip', 'SHA256SUMS.txt'], dir: 'C:/d' });
  await host.listIssues(R, { label: 'manor:work', state: 'open', fields: 'number,url,body' });
  await host.editIssue(R, 7, { removeLabel: 'wright:done' });
  await host.commentIssue(R, 7, 'again');
  await host.closeIssue(R, 7, { reason: 'not planned', comment: 'superseded' });
  await host.createLabel(R, 'manor:work', { color: '1d76db', description: 'Queued for the Wright' });
  await host.whoAmI();
  assert.deepEqual(
    ran.map((r) => r.args),
    [
      ['api', `repos/${R}/commits/abc/statuses?per_page=100`],
      ['api', '-X', 'POST', `repos/${R}/statuses/abc`, '-f', 'state=success', '-f', 'context=steward/tested', '-f', 'description=npm test passed at abc'],
      ['release', 'list', '--repo', R, '--limit', '100', '--json', 'tagName,isDraft'],
      ['release', 'view', 'v0.4.0', '--repo', R, '--json', 'targetCommitish'],
      ['release', 'create', 'v0.4.1', '--repo', R, '--target', 'abc', '--title', 'Fake 0.4.1', '--notes-file', 'C:/notes.md'],
      ['release', 'create', 'v0.4.2', '--repo', R, '--target', 'def', '--title', 'Fake 0.4.2', '--generate-notes'],
      ['release', 'download', 'v0.4.1', '--repo', R, '--pattern', '*.zip', '--pattern', 'SHA256SUMS.txt', '--dir', 'C:/d', '--clobber'],
      ['issue', 'list', '--repo', R, '--label', 'manor:work', '--state', 'open', '--limit', '100', '--json', 'number,url,body'],
      ['issue', 'edit', '7', '--repo', R, '--remove-label', 'wright:done'],
      ['issue', 'comment', '7', '--repo', R, '--body', 'again'],
      ['issue', 'close', '7', '--repo', R, '--reason', 'not planned', '--comment', 'superseded'],
      ['label', 'create', 'manor:work', '--repo', R, '--color', '1d76db', '--description', 'Queued for the Wright'],
      ['api', 'user', '--jq', '.login'],
    ],
  );
});

test('a host answers rather than throws; must makes a failure a CommandFailed that names the request', async () => {
  const { host } = recorded(() => ({ code: 1, out: '', err: 'HTTP 404: Not Found' }));
  const a = await host.viewPr(R, 31, 'state');
  assert.equal(a.code, 1);
  assert.equal(a.what, `gh pr view 31 --repo ${R} --json state`);
  assert.throws(() => must(a), (err: unknown) => err instanceof CommandFailed && /^gh pr view 31 .* failed \(1\): HTTP 404: Not Found$/.test((err as Error).message));
  assert.equal(must({ ...a, code: 0, out: '{}' }), '{}');
  assert.equal(host.kind, 'github');
});
