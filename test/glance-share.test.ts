import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'steward-glance-share-'));
process.env.STEWARD_HOME = path.join(home, 'steward');
process.env.MANOR_HOME = path.join(home, 'manor');
after(() => rmSync(home, { recursive: true, force: true }));

const { tryGlance } = await import('../src/steward.ts');
const { PER_QUERY } = await import('../src/glance.ts');
const { employee } = await import('./helpers.ts');
type Runner = import('../src/run.ts').Runner;

const sharedFile = path.join(home, 'manor', 'remote-heads.json');
const many = Array.from({ length: PER_QUERY + 1 }, (_, i) => employee('C:\\nowhere', { id: `e${i}x`, repo: `Jcollier0120/E${i}` }));
const settings = (employees = many) => ({ employees, stewardRepo: null }) as any;
const noRun: Runner = async (cmd, args) => assert.fail(`nothing is run: ${cmd} ${args.join(' ')}`);
const refs = (i: number) => ({ totalCount: 1, nodes: [{ name: 'main', target: { oid: String(i % 10).repeat(40) } }] });
/** GitHub's API as the round asks it: each repository in the query answered, with its branch heads. */
const answer = (query: string) => {
  const n = (query.match(/ e\d+: repository\(owner: "Jcollier0120", name: "E(\d+)"/g) ?? []).map((m) => Number(/"E(\d+)"/.exec(m)![1]));
  return JSON.stringify({ data: Object.fromEntries(n.map((k, i) => [`e${i}`, { ref: { target: { oid: 'a'.repeat(40) } }, pullRequests: { totalCount: 0, nodes: [] }, releases: { nodes: [] }, refs: refs(k) }])) });
};

test("the round shares every branch head it read in Manor's remote-heads.json, for Reeve and the rest to skip their own ls-remote", async () => {
  rmSync(sharedFile, { force: true });
  const lines: string[] = [];
  const g = await tryGlance(noRun, settings(), (l) => lines.push(l), undefined, () => new Date('2026-10-12T20:00:00Z'), async (q) => answer(q));
  assert.ok(g, lines.join('\n'));
  const shared = JSON.parse(readFileSync(sharedFile, 'utf8'));
  assert.equal(Object.keys(shared).length, many.length);
  assert.deepEqual(shared['github.com/jcollier0120/e3'], { at: '2026-10-12T20:00:00.000Z', heads: { main: '3'.repeat(40) }, complete: true });
});

test('a query GitHub gives up on (502 after its 10 seconds) is asked again in halves, and the heads are shared all the same', async () => {
  rmSync(sharedFile, { force: true });
  const sizes: number[] = [];
  const lines: string[] = [];
  const g = await tryGlance(noRun, settings(), (l) => lines.push(l), undefined, undefined, async (q) => {
    const n = (q.match(/ e\d+: repository/g) ?? []).length;
    sizes.push(n);
    if (n > 3) throw Object.assign(new Error('GitHub POST graphql: 502 <html>'), { status: 502 });
    return answer(q);
  });
  assert.ok(g, lines.join('\n'));
  assert.equal(sizes[0], PER_QUERY);
  assert.deepEqual(sizes.slice(1, 3), [Math.ceil(PER_QUERY / 2), Math.floor(PER_QUERY / 2)], 'then its halves');
  assert.equal(sizes.filter((n) => n <= 3).reduce((a, b) => a + b, 0), many.length, 'every repository answered once');
  assert.equal(Object.keys(g.repos).length, many.length);
  assert.deepEqual(lines, []);
  assert.equal(Object.keys(JSON.parse(readFileSync(sharedFile, 'utf8'))).length, many.length);
});

test("a glance that fails shares nothing and says so as before; a test's runner through gh never writes Manor's file", async () => {
  rmSync(sharedFile, { force: true });
  const lines: string[] = [];
  assert.equal(await tryGlance(noRun, settings(), (l) => lines.push(l), undefined, undefined, async () => { throw new Error('GitHub POST graphql: 401 Bad credentials'); }), null);
  assert.match(lines.join('\n'), /couldn't ask GitHub about everyone at once \(GitHub POST graphql: 401/);
  const gh: Runner = async (_cmd, args) => ({ code: 0, out: answer(args[3]), err: '' });
  assert.ok(await tryGlance(gh, settings(), () => {}));
  assert.equal(existsSync(sharedFile), false);
});
