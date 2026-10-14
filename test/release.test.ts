import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Runner } from '../src/run.ts';
import type { Employee } from '../src/settings.ts';
import { STAFF as DEFAULT_EMPLOYEES } from './fixtures/staff.ts';
import { exchequerNote, networkLine } from '../src/stages/common.ts';
import { releaseNeedsPackages, releaseOne } from '../src/stages/release.ts';
import { ctxFor, ok, runner, sh } from './helpers.ts';

// fresh, so the Steward links the packages installed once for its lockfile there first (modules.ts), else npm ci, as bump does.
// fresh, so the Steward runs npm ci there first, as bump does.
// By its real path, as git and the work folder (workRootOf) spell it: the temporary folder may be on a Dev Drive mounted
// in a folder (C:\DevData\Temp is E:\Temp).
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'steward-release-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

// The release command: it fails without node_modules, as Reeve's does, and says what it saw.
const RELEASE = `import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync('node_modules')) { console.error("'vite' is not recognized"); process.exit(1); }
writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd() }));
`;

test("a Node agent's release worktree gets the packages installed once for its lockfile before its release command; a failed npm ci stops it", async () => {
  const origin = path.join(tmp, 'origin.git');
  const checkout = path.join(tmp, 'Reeve');
  sh(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '--quiet', origin, checkout);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false' })) sh(checkout, 'config', k, v);
  const files: Record<string, string> = {
    'package.json': '{\n  "name": "reeve",\n  "version": "0.3.1"\n}\n',
    'package-lock.json': '{\n  "name": "reeve",\n  "version": "0.3.1",\n  "lockfileVersion": 3,\n  "packages": { "": { "name": "reeve", "version": "0.3.1" } }\n}\n',
    'kit.json': '{\n  "kit": "1.2.1",\n  "parts": ["node", "spec"]\n}\n',
    'tools/release.mjs': RELEASE,
  };
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true });
    writeFileSync(path.join(checkout, f), t);
  }
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Reeve 0.3.1');
  sh(checkout, 'push', '--quiet', 'origin', 'main');

  const released = path.join(tmp, 'released.json');
  const reeve = DEFAULT_EMPLOYEES.find((x) => x.id === 'reeve')!;
  const e: Employee = { ...reeve, checkout, versionFiles: ['package.json'], release: `node tools/release.mjs "${released}"` };
  const work = path.join(tmp, 'work');
  const npm: string[][] = [];
  let npmFails = false;
  // GitHub has v0.3.1 once the release command has run: a release command that made none failed.
  const before = { tagName: 'v0.3.0', isDraft: false, publishedAt: '2026-10-02T00:00:00Z' };
  const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok(existsSync(released) ? [{ tagName: 'v0.3.1', isDraft: false }, before] : [before]) : undefined));
  // npm stands in: `npm ci` makes node_modules (or fails); everything else runs for real.
  const run: Runner = async (cmd, args, opts) => {
    if (cmd !== 'npm') return r.run(cmd, args, opts);
    npm.push(args);
    if (npmFails) return { code: 1, out: '', err: 'npm ERR! network' };
    mkdirSync(path.join(opts!.cwd!, 'node_modules'), { recursive: true });
    return ok('');
  };
  const ctx = ctxFor({ employees: [e], workRoot: work, run, neutralDir: tmp });

  const done = await releaseOne(ctx, e, { kit: '1.2.1' });
  assert.equal(done.outcome, 'done', `${done.message}\n${ctx.lines.join('\n')}`);
  assert.deepEqual(npm, [['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline']], 'once, for the shared set (modules.ts), with no install script run');
  assert.equal(path.resolve(JSON.parse(readFileSync(released, 'utf8')).cwd).toLowerCase(), path.join(work, 'reeve-release').toLowerCase());
  assert.ok(!existsSync(path.join(work, 'reeve-release')), 'the release worktree is removed');
  const sets = readdirSync(path.join(work, '_modules'));
  assert.equal(sets.length, 1, 'its packages are kept for the next release, and the bumps');
  assert.ok(existsSync(path.join(work, '_modules', sets[0], 'node_modules')), 'not removed with the worktree');

  // The next release links them: no npm at all.
  rmSync(released);
  assert.equal((await releaseOne(ctx, e, { kit: '1.2.1' })).outcome, 'done');
  assert.equal(npm.length, 1);

  // No set, and npm ci failing: for the set, then in the worktree itself.
  rmSync(path.join(work, '_modules'), { recursive: true, force: true });
  npmFails = true;
  npm.length = 0;
  rmSync(released);
  const failed = await releaseOne(ctx, e, { kit: '1.2.1' });
  assert.equal(failed.outcome, 'failed');
  assert.match(failed.message, /^npm ci failed \(exit 1\), so its release wasn't built$/);
  assert.deepEqual(npm, [['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], ['ci', '--ignore-scripts', '--no-audit', '--no-fund']]);
  assert.ok(!existsSync(released), 'its release command never ran');
});

test("a release needs packages only when it builds: a hire's runs the kit's own tools with Node, Reeve's builds with vite", () => {
  const dir = path.join(tmp, 'needs');
  mkdirSync(dir, { recursive: true });
  const pkg = (scripts: Record<string, string>, lock = true) => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0', scripts }));
    if (lock) writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    else rmSync(path.join(dir, 'package-lock.json'), { force: true });
  };
  pkg({ release: 'node tools/kit.ts && node src/kit/release.ts' });
  assert.equal(releaseNeedsPackages(dir, 'npm run release -- --publish'), false, "a hire's");
  pkg({ prerelease: 'node tools/kit.ts', release: 'node src\\kit\\release.ts' });
  assert.equal(releaseNeedsPackages(dir, 'npm run release -- --publish'), false, 'with a pre script, and Windows slashes');
  pkg({ prerelease: 'node tools/kit.ts', release: 'node tools/release.ts' });
  assert.equal(releaseNeedsPackages(dir, 'npm run release -- --publish'), true, "Reeve's: its own release.ts builds the dashboard");
  pkg({ release: 'node tools/kit.ts && vite build && node src/kit/release.ts' });
  assert.equal(releaseNeedsPackages(dir, 'npm run release -- --publish'), true, 'a build step');
  pkg({ release: 'node src/kit/release.ts', postrelease: 'tsc -p .' });
  assert.equal(releaseNeedsPackages(dir, 'npm run release'), true, 'a post script that needs TypeScript');
  assert.equal(releaseNeedsPackages(dir, 'npm run nothing-by-that-name'), true, "a script that isn't there: as before");
  assert.equal(releaseNeedsPackages(dir, 'node src/kit/release.ts --publish'), false, 'the kit release, run straight');
  assert.equal(releaseNeedsPackages(dir, 'powershell -File release.ps1'), true, 'anything else: as before');
  pkg({ release: 'node src/kit/release.ts' }, false);
  assert.equal(releaseNeedsPackages(dir, 'npm run release'), false, 'no lockfile: no npm ci at all');

  // Kit 2.16.0: the kit's release builds with esbuild, the agent's devDependency.
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0', scripts: { release: 'node tools/kit.ts && node src/kit/release.ts' }, devDependencies: { esbuild: '0.28.2' } }));
  writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  assert.equal(releaseNeedsPackages(dir, 'npm run release -- --publish'), true, "a hire with esbuild: the kit's release builds with it");
});

test("a hire's release worktree gets no npm ci: its release only packs files with Node", async () => {
  const origin = path.join(tmp, 'hire-origin.git');
  const checkout = path.join(tmp, 'Porter');
  sh(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '--quiet', origin, checkout);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false' })) sh(checkout, 'config', k, v);
  const files: Record<string, string> = {
    'package.json': '{\n  "name": "porter",\n  "version": "0.4.2",\n  "scripts": { "release": "node tools/kit.ts && node src/kit/release.ts" }\n}\n',
    'package-lock.json': '{\n  "name": "porter",\n  "version": "0.4.2",\n  "lockfileVersion": 3,\n  "packages": { "": { "name": "porter", "version": "0.4.2" } }\n}\n',
    'kit.json': '{\n  "kit": "2.9.0",\n  "parts": ["node", "web", "spec"]\n}\n',
  };
  for (const [f, t] of Object.entries(files)) writeFileSync(path.join(checkout, f), t);
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Porter 0.4.2');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const porter = DEFAULT_EMPLOYEES.find((x) => x.id === 'porter')!;
  const e: Employee = { ...porter, checkout, versionFiles: ['package.json'] };
  const npm: string[][] = [];
  const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok([...(npm.length ? [{ tagName: 'v0.4.2', isDraft: false }] : []), { tagName: 'v0.4.1', isDraft: false }]) : undefined));
  const run: Runner = async (cmd, args, opts) => {
    if (cmd !== 'npm') return r.run(cmd, args, opts);
    npm.push(args);
    return ok('');
  };
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-hire'), run, neutralDir: tmp });
  const done = await releaseOne(ctx, e, { kit: '2.9.0' });
  assert.equal(done.outcome, 'done', `${done.message}\n${ctx.lines.join('\n')}`);
  assert.deepEqual(npm, [['run', 'release', '--', '--publish']], 'its release, and no npm ci before it');
});

test("a release command that exits 0 but made no GitHub release failed, on the PC that releases Castellan too", async () => {
  const origin = path.join(tmp, 'silent-origin.git');
  const checkout = path.join(tmp, 'Porter-silent');
  sh(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '--quiet', origin, checkout);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false' })) sh(checkout, 'config', k, v);
  writeFileSync(path.join(checkout, 'package.json'), '{\n  "name": "porter",\n  "version": "0.5.50",\n  "scripts": { "release": "node tools/kit.ts && node src/kit/release.ts" }\n}\n');
  writeFileSync(path.join(checkout, 'kit.json'), '{\n  "kit": "2.69.1",\n  "parts": ["node", "web", "spec"]\n}\n');
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Porter 0.5.50');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const porter = DEFAULT_EMPLOYEES.find((x) => x.id === 'porter')!;
  const e: Employee = { ...porter, checkout, versionFiles: ['package.json'] };
  // As kit 2.69.1's release.ts did under a work folder reached through a junction: it never started, and exited 0.
  const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok([{ tagName: 'v0.5.49', isDraft: false }]) : undefined));
  const run: Runner = async (cmd, args, opts) => (cmd === 'npm' ? ok('') : r.run(cmd, args, opts));
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-silent'), run, neutralDir: tmp });
  assert.equal(ctx.settings.releasesCastellan, true, "the owner's PC");
  const silent = await releaseOne(ctx, e, { kit: '2.69.1' });
  assert.equal(silent.outcome, 'failed', silent.message);
  assert.match(silent.message, /^npm run release -- --publish finished, but GitHub has no release v0\.5\.50 in Jcollier0120\/Porter: /);
});

test("a release that reached GitHub but not the Exchequer is done, with the kit's line as a note; never a failure", async () => {
  const origin = path.join(tmp, 'exchequer-origin.git');
  const checkout = path.join(tmp, 'Clerk');
  sh(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '--quiet', origin, checkout);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false' })) sh(checkout, 'config', k, v);
  const files: Record<string, string> = {
    'package.json': '{\n  "name": "clerk",\n  "version": "0.3.4",\n  "scripts": { "release": "node tools/kit.ts && node src/kit/release.ts" }\n}\n',
    'kit.json': '{\n  "kit": "2.30.0",\n  "parts": ["node", "web", "spec"]\n}\n',
  };
  for (const [f, t] of Object.entries(files)) writeFileSync(path.join(checkout, f), t);
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Clerk 0.3.4');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  const clerk = DEFAULT_EMPLOYEES.find((x) => x.id === 'clerk')!;
  const e: Employee = { ...clerk, checkout, versionFiles: ['package.json'] };
  const said = "Not published to the Exchequer: couldn't reach https://api.castellan-software.com: fetch failed (ECONNREFUSED). The GitHub release stands; npm run release -- --exchequer finishes it.";
  let ran = false;
  const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok([...(ran ? [{ tagName: 'v0.3.4', isDraft: false }] : []), { tagName: 'v0.3.3', isDraft: false }]) : undefined));
  const run: Runner = async (cmd, args, opts) => (cmd === 'npm' ? (ran = true) && { code: 0, out: 'Clerk 0.3.4 (abc1234, kit 2.30.0): artifacts\\clerk\\Clerk-0.3.4.zip\n', err: `${said}\n` } : r.run(cmd, args, opts));
  const ctx = ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-exchequer'), run, neutralDir: tmp });
  const done = await releaseOne(ctx, e, { kit: '2.30.0' });
  assert.equal(done.outcome, 'done', `${done.message}\n${ctx.lines.join('\n')}`);
  assert.ok(done.message.endsWith(`, with kit 2.30.0; ${said}`), done.message);
});

test('a release whose entry, or one it brings, starts "**Urgent fix:" is let out to customers at once; any other is left for its release day', async () => {
  const origin = path.join(tmp, 'urgent-origin.git');
  const checkout = path.join(tmp, 'Clerk-urgent');
  sh(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '--quiet', origin, checkout);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false' })) sh(checkout, 'config', k, v);
  const commit = (version: string, changelog: string) => {
    writeFileSync(path.join(checkout, 'package.json'), `{\n  "name": "clerk",\n  "version": "${version}",\n  "scripts": { "release": "node tools/kit.ts && node src/kit/release.ts" }\n}\n`);
    writeFileSync(path.join(checkout, 'kit.json'), '{\n  "kit": "2.58.0",\n  "parts": ["node", "web", "spec"]\n}\n');
    writeFileSync(path.join(checkout, 'CHANGELOG.md'), changelog);
    sh(checkout, 'add', '-A');
    sh(checkout, 'commit', '--quiet', '-m', `Clerk ${version}`);
    sh(checkout, 'push', '--quiet', 'origin', 'main');
  };
  const clerk = DEFAULT_EMPLOYEES.find((x) => x.id === 'clerk')!;
  const e: Employee = { ...clerk, checkout, versionFiles: ['package.json'] };
  let released = ['v0.3.3'];
  const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok(released.map((tagName) => ({ tagName, isDraft: false }))) : undefined));
  // The release command makes the GitHub release of the version it builds.
  const versionIn = (dir: string) => (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string }).version;
  const run: Runner = async (cmd, args, opts) => {
    if (cmd !== 'npm') return r.run(cmd, args, opts);
    const v = versionIn(opts!.cwd!);
    released.push(`v${v}`);
    return ok(`Published to the Exchequer: clerk-v${v}.\n`);
  };
  const asked: string[] = [];
  const exchequer = {
    env: { EXCHEQUER_URL: 'http://exchequer.invalid', EXCHEQUER_PUBLISHER_KEY: 'test-key' },
    home: tmp,
    fetch: (async (url: string, init?: RequestInit) => {
      asked.push(`${init?.method} ${url} ${(init?.headers as Record<string, string>)?.authorization}`);
      return new Response(JSON.stringify({ release: { outAt: '2026-10-12T20:00:00.000Z' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  };
  const ctx = { ...ctxFor({ employees: [e], workRoot: path.join(tmp, 'work-urgent'), run, neutralDir: tmp }), exchequer };

  // 0.3.4, never released on its own, was the urgent one: 0.3.5 brings it, so it goes out at once.
  const entry = (v: string, line: string) => `## ${v}\n\n${line}\n\n### Before you update\n\n- Nothing: it updates itself as usual.\n`;
  commit('0.3.5', `# Clerk\n\n${entry('0.3.5', '**Faster lists.**')}\n${entry('0.3.4', '**Urgent fix: files are kept again.**')}\n${entry('0.3.3', '**Before.**')}`);
  const done = await releaseOne(ctx, e, { kit: '2.58.0' });
  assert.equal(done.outcome, 'done', `${done.message}\n${ctx.lines.join('\n')}`);
  assert.deepEqual(asked, ['POST http://exchequer.invalid/api/v1/admin/releases/clerk/0.3.5/out Bearer test-key']);
  assert.ok(done.message.endsWith('; an urgent fix: clerk-v0.3.5 is out to customers now (since 2026-10-12T20:00:00.000Z): every PC entitled to it is offered it at its next look.'), done.message);

  // Not marked: nothing asked, it waits for its release day.
  released = ['v0.3.3', 'v0.3.5'];
  asked.length = 0;
  commit('0.3.6', `# Clerk\n\n${entry('0.3.6', '**Calmer.**')}\n${entry('0.3.5', '**Faster lists.**')}\n${entry('0.3.4', '**Urgent fix: files are kept again.**')}`);
  const calm = await releaseOne(ctx, e, { kit: '2.58.0' });
  assert.equal(calm.outcome, 'done', calm.message);
  assert.deepEqual(asked, [], 'the urgent 0.3.4 went out with 0.3.5 already');
  assert.doesNotMatch(calm.message, /urgent/);
});

test("the Exchequer's line: a note when it says the release didn't get there, and never the network's reason a release failed", () => {
  assert.equal(exchequerNote('Published to the Exchequer: porter-v0.4.26 (Porter-0.4.26.zip).'), '');
  assert.equal(exchequerNote("The Exchequer: heiward isn't sold there, so heiward-v1.7.2 is on GitHub alone."), '');
  const noKey = 'Not published to the Exchequer: no publisher key at C:\\Users\\someone\\.steward\\exchequer-publisher.key (or EXCHEQUER_PUBLISHER_KEY).';
  assert.equal(exchequerNote(`built\r\n  ${noKey}\r\n`), `; ${noKey}`);
  const failedOwn = 'HTTP 422: Validation Failed\nNot published to the Exchequer: couldn\'t reach https://api.castellan-software.com: fetch failed (ENOTFOUND).';
  assert.equal(networkLine(failedOwn), null, "GitHub's own refusal was why, not the Exchequer's network");
});
