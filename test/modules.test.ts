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

test("a lockfile's packages are one key: what it installs, so the hires share one set whatever their own entry says", () => {
  assert.equal(packagesKey(lock('porter', '0.4.1')), packagesKey(lock('pinder', '0.5.0')));
  // The project's own entry installs nothing: its bin, and a range the same package still meets, share the set.
  const own = (text: string, more: Record<string, unknown>) => {
    const l = JSON.parse(text);
    Object.assign(l.packages[''], more);
    return JSON.stringify(l);
  };
  assert.equal(packagesKey(own(lock('porter', '0.4.1'), { bin: { porter: 'src/cli.ts' } })), packagesKey(own(lock('wright', '0.5.8'), { bin: { wright: 'src/cli.ts' }, license: 'UNLICENSED' })));
  assert.equal(packagesKey(lock('porter', '0.4.1', { typescript: '^7.0.0' })), packagesKey(lock('porter', '0.4.1')));
  // Another package installed, or another version of one: its own set.
  const other = JSON.parse(lock('porter', '0.4.1'));
  other.packages['node_modules/typescript'].version = '7.1.0';
  assert.notEqual(packagesKey(JSON.stringify(other)), packagesKey(lock('porter', '0.4.1')));
  other.packages['node_modules/@types/node'] = { version: '22.20.4', dev: true };
  assert.notEqual(packagesKey(JSON.stringify(other)), packagesKey(lock('porter', '0.4.1')));
  // The order npm wrote them in doesn't matter.
  const turned = JSON.parse(JSON.stringify(other));
  turned.packages = Object.fromEntries(Object.entries(other.packages).reverse());
  assert.equal(packagesKey(JSON.stringify(turned)), packagesKey(JSON.stringify(other)));
  // A lockfile before `packages` (npm 6): keyed whole, its name and version aside.
  const v1 = (name: string, ts: string) => JSON.stringify({ name, version: '1.0.0', lockfileVersion: 1, dependencies: { typescript: { version: ts } } });
  assert.equal(packagesKey(v1('a', '7.0.2')), packagesKey(v1('b', '7.0.2')));
  assert.notEqual(packagesKey(v1('a', '7.0.2')), packagesKey(v1('a', '7.1.0')));
  assert.match(packagesKey(lock('porter', '0.4.1')), /^[0-9a-f]{16}$/);
});

test('sets for different packages asked for at once install one after the other', async () => {
  let now = 0;
  let most = 0;
  const r = runner();
  const run: Runner = async (cmd, args, opts) => {
    if (cmd !== 'npm') return r.run(cmd, args, opts);
    now++;
    most = Math.max(most, now);
    // Each install waits for the others to have asked: were two let in at once, both would be in here together.
    await new Promise((res) => setImmediate(res));
    mkdirSync(path.join(opts!.cwd!, 'node_modules'), { recursive: true });
    now--;
    return ok('');
  };
  const e = employee(tmp, { fill: '' });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-one-at-a-time'), run, neutralDir: tmp });
  const { linkSharedModules } = await import('../src/stages/modules.ts');
  const dirs = ['7.0.2', '7.1.0', '7.2.0'].map((v) => {
    const d = path.join(tmp, `one-${v}`);
    project(d, 'porter', '0.4.1');
    const l = JSON.parse(lock('porter', '0.4.1'));
    l.packages['node_modules/typescript'].version = v;
    writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify(l));
    return d;
  });
  const said: string[] = [];
  assert.deepEqual(await Promise.all(dirs.map((d) => linkSharedModules(ctx, d, (l) => said.push(l)))), [true, true, true], said.join('\n'));
  assert.equal(most, 1, 'never two installs at once');
  assert.equal(said.filter((l) => l.startsWith('npm ci, once')).length, 3);
});

test("a set's rename waits while Windows says its files are in use, and only then", async () => {
  const { renameWhenFree } = await import('../src/stages/modules.ts');
  const busy = (code: string, times: number) => {
    let tries = 0;
    const rename = () => {
      tries++;
      if (tries <= times) throw Object.assign(new Error(code), { code });
    };
    return { rename, tries: () => tries };
  };
  const to = path.join(tmp, 'rename-to');
  // In use a few times (Defender reading the new files), then free: renamed.
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const b = busy(code, 2);
    await renameWhenFree('from', to, { rename: b.rename });
    assert.equal(b.tries(), 3, code);
  }
  // Anything else isn't waited for.
  const gone = busy('ENOENT', 1);
  await assert.rejects(renameWhenFree('from', to, { rename: gone.rename }), /ENOENT/);
  assert.equal(gone.tries(), 1);
  // Still in use when the time is up: its error.
  const stuck = busy('EPERM', Number.POSITIVE_INFINITY);
  await assert.rejects(renameWhenFree('from', to, { rename: stuck.rename, budgetMs: 100 }), /EPERM/);
  assert.ok(stuck.tries() > 1, 'it tried again');
  // Another process finished the set meanwhile: no wait, the caller takes theirs.
  mkdirSync(to, { recursive: true });
  writeFileSync(path.join(to, '.ready'), 'theirs');
  const theirs = busy('EPERM', Number.POSITIVE_INFINITY);
  await assert.rejects(renameWhenFree('from', to, { rename: theirs.rename }), /EPERM/);
  assert.equal(theirs.tries(), 1);
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
  assert.equal(await runChecks(ctx, e, c, { say: (l) => lines.push(l) }), 'npm ci --ignore-scripts --no-audit --no-fund failed (exit 1)');
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

test('the sets most lately used are kept, and a half-done install goes: a day old, or its process gone', () => {
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
  // One from a process that's gone, an hour old; one from a process still at it.
  mkdirSync(path.join(root, `${sets[1]}.tmp-2-def`));
  mkdirSync(path.join(root, `${sets[1]}.tmp-3-fed`));
  const alive = (pid: number) => pid === 3;
  assert.deepEqual(pruneSets(root, undefined, now, alive).sort(), [...sets.slice(KEEP_SETS), `${sets[0]}.tmp-1-abc`, `${sets[1]}.tmp-2-def`].sort());
  assert.ok(existsSync(path.join(root, sets[0])));
  assert.ok(existsSync(path.join(root, `${sets[1]}.tmp-3-fed`)), 'an install going on is left');
});

test("a Next.js project's packages aren't linked from a shared set: its build refuses a link out of the project", async () => {
  const { sharesModules } = await import('../src/stages/modules.ts');
  const site = path.join(tmp, 'next-site');
  mkdirSync(site, { recursive: true });
  writeFileSync(path.join(site, 'package.json'), JSON.stringify({ name: 'site', version: '0.1.0', dependencies: { next: '^16.4.0' } }));
  writeFileSync(path.join(site, 'package-lock.json'), lock('site', '0.1.0', { next: '^16.4.0' }));
  assert.equal(sharesModules(site), false);
  const said: string[] = [];
  const ctx = ctxFor({ employees: [], workRoot: path.join(tmp, 'next-work'), run: runner().run, neutralDir: tmp });
  const { linkSharedModules } = await import('../src/stages/modules.ts');
  assert.equal(await linkSharedModules(ctx, site, (l) => said.push(l)), false, 'its own npm ci instead');
  assert.equal(existsSync(path.join(site, 'node_modules')), false);
  assert.match(said.join('\n'), /its own \(npm ci\)/);
  writeFileSync(path.join(site, 'package.json'), JSON.stringify({ name: 'agent', version: '0.1.0', devDependencies: { typescript: '^7.0.2' } }));
  assert.equal(sharesModules(site), true, 'any other project shares, as before');
});

test("a repository's checks run with git signing nothing (kit/unsigned-git.ts), after the settings its caller gives", async () => {
  const seen: (Record<string, string | undefined> | undefined)[] = [];
  const run: Runner = async (_cmd, _args, opts) => {
    seen.push(opts?.env);
    return ok('');
  };
  const e = employee(tmp, { fill: '', test: ['npm test'] });
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-unsigned'), run, neutralDir: tmp });
  const d = path.join(tmp, 'unsigned');
  mkdirSync(d, { recursive: true });
  assert.equal(await runChecks(ctx, e, d, { env: { STEWARD_TRIAL: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' }, say: () => {} }), null);
  assert.deepEqual(seen, [{ STEWARD_TRIAL: '1', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'commit.gpgsign', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'tag.gpgsign', GIT_CONFIG_VALUE_2: 'false' }]);
});