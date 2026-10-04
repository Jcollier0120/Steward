import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { removeWorktree } from '../src/git.ts';
import type { Runner } from '../src/run.ts';
import { runChecks } from '../src/stages/bump.ts';
import { KEEP_SETS, modulesRootOf, packagesKey, pruneSets } from '../src/stages/modules.ts';
import { ctxFor, employee, fakeEmployee, ok, runner, sh } from './helpers.ts';

// One node_modules for every worktree whose packages are the same: installed once, linked into each with a junction,
// and only the link removed with the worktree.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-modules-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const lock = (name: string, version: string, deps: Record<string, string> = { typescript: '^7.0.2' }) =>
  JSON.stringify({ name, version, lockfileVersion: 3, requires: true, packages: { '': { name, version, devDependencies: deps }, 'node_modules/typescript': { version: '7.0.2' } } }, null, 2);

/** npm stands in: `npm ci` puts a marker in node_modules where it runs (or fails); every other command runs for real. */
function npmStandIn(o: { fails?: boolean } = {}) {
  const ci: string[] = [];
  const r = runner();
  const run: Runner = async (cmd, args, opts) => {
    if (cmd !== 'npm') return r.run(cmd, args, opts);
    ci.push(opts!.cwd!);
    if (o.fails) return { code: 1, out: '', err: 'npm ERR! network' };
    mkdirSync(path.join(opts!.cwd!, 'node_modules', 'typescript'), { recursive: true });
    writeFileSync(path.join(opts!.cwd!, 'node_modules', 'typescript', 'marker.txt'), 'installed');
    return ok('');
  };
  return { run, ci };
}

function project(dir: string, name: string, version: string, deps?: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, scripts: { prepare: 'node -e process.exit(9)' }, devDependencies: deps ?? { typescript: '^7.0.2' } }));
  writeFileSync(path.join(dir, 'package-lock.json'), lock(name, version, deps));
}

test("a lockfile's packages are one key: its own name and version aside, so the hires share one set", () => {
  assert.equal(packagesKey(lock('porter', '0.4.1')), packagesKey(lock('pinder', '0.5.0')));
  assert.notEqual(packagesKey(lock('porter', '0.4.1')), packagesKey(lock('porter', '0.4.1', { typescript: '^7.1.0' })));
  assert.match(packagesKey(lock('porter', '0.4.1')), /^[0-9a-f]{16}$/);
});

test('two worktrees with the same packages: npm ci once, in the shared set, and each linked to it', async () => {
  const { run, ci } = npmStandIn();
  const e = employee(tmp, { test: ['node -e "require(\'fs\').accessSync(\'node_modules/typescript/marker.txt\')"'] });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work'), run, neutralDir: tmp });
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  project(a, 'porter', '0.4.1');
  project(b, 'pinder', '0.5.0');
  const lines: string[] = [];
  assert.equal(await runChecks(ctx, { ...e, fill: '' }, a, { say: (l) => lines.push(l) }), null, lines.join('\n'));
  assert.equal(await runChecks(ctx, { ...e, fill: '' }, b, { say: (l) => lines.push(l) }), null, lines.join('\n'));
  assert.equal(ci.length, 1, 'installed once');
  assert.ok(ci[0].startsWith(path.join(modulesRootOf(ctx.settings), packagesKey(lock('porter', '0.4.1')))), 'in the shared set');
  for (const d of [a, b]) {
    assert.ok(lstatSync(path.join(d, 'node_modules')).isSymbolicLink(), 'a junction');
    assert.equal(readFileSync(path.join(d, 'node_modules', 'typescript', 'marker.txt'), 'utf8'), 'installed');
  }
  const set = path.join(modulesRootOf(ctx.settings), packagesKey(lock('porter', '0.4.1')));
  assert.equal(JSON.parse(readFileSync(path.join(set, 'package.json'), 'utf8')).scripts, undefined, "the project's own scripts don't run in the set");
});

test('a set that fails to install leaves the worktree to npm ci itself, as before', async () => {
  const { run, ci } = npmStandIn({ fails: true });
  const e = employee(tmp, { fill: '' });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-fails'), run, neutralDir: tmp });
  const c = path.join(tmp, 'c');
  project(c, 'clerk', '0.4.0', { typescript: '^7.9.9' });
  const lines: string[] = [];
  assert.equal(await runChecks(ctx, e, c, { say: (l) => lines.push(l) }), 'npm ci --no-audit --no-fund failed (exit 1)');
  assert.equal(ci.length, 2, 'once for the set, once in the worktree');
  assert.equal(path.resolve(ci[1]).toLowerCase(), path.resolve(c).toLowerCase());
});

test('removing a worktree removes its link, never the packages it points to', async () => {
  const f = fakeEmployee(path.join(tmp, 'fake'));
  const set = path.join(tmp, 'set', 'node_modules');
  mkdirSync(path.join(set, 'typescript'), { recursive: true });
  writeFileSync(path.join(set, 'typescript', 'marker.txt'), 'kept');
  const wt = path.join(tmp, 'wt');
  sh(f.checkout, 'worktree', 'add', '--quiet', '--detach', wt, 'HEAD');
  const { symlinkSync } = await import('node:fs');
  symlinkSync(set, path.join(wt, 'node_modules'), 'junction');
  const { run } = runner();
  assert.deepEqual(await removeWorktree(run, f.checkout, wt), [`removed the worktree ${wt}`]);
  assert.ok(!existsSync(wt), 'the worktree is gone');
  assert.equal(readFileSync(path.join(set, 'typescript', 'marker.txt'), 'utf8'), 'kept');
});

test('the sets most lately used are kept, and a half-done install a day old goes', () => {
  const root = path.join(tmp, 'prune');
  const now = Date.now();
  const sets = Array.from({ length: KEEP_SETS + 2 }, (_, i) => (i.toString(16).padStart(16, '0')));
  sets.forEach((s, i) => {
    mkdirSync(path.join(root, s), { recursive: true });
    const t = new Date(now - i * 60_000);
    utimesSync(path.join(root, s), t, t);
  });
  mkdirSync(path.join(root, `${sets[0]}.tmp-1-abc`));
  const old = new Date(now - 2 * 24 * 3600_000);
  utimesSync(path.join(root, `${sets[0]}.tmp-1-abc`), old, old);
  assert.deepEqual(pruneSets(root, undefined, now).sort(), [...sets.slice(KEEP_SETS), `${sets[0]}.tmp-1-abc`].sort());
  assert.ok(existsSync(path.join(root, sets[0])));
});
