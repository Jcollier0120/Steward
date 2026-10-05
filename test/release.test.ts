import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Runner } from '../src/run.ts';
import { DEFAULT_EMPLOYEES, type Employee } from '../src/settings.ts';
import { releaseNeedsPackages, releaseOne } from '../src/stages/release.ts';
import { ctxFor, ok, runner, sh } from './helpers.ts';

// A Node agent's release needs its packages: Reeve's builds its dashboard with vite. The release worktree is
// fresh, so the Steward runs npm ci there first, as bump does.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-release-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// The release command: it fails without node_modules, as Reeve's does, and says what it saw.
const RELEASE = `import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync('node_modules')) { console.error("'vite' is not recognized"); process.exit(1); }
writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd() }));
`;

test("a Node agent's release worktree gets npm ci before its release command; a failed npm ci stops it", async () => {
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
  const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok([{ tagName: 'v0.3.0', isDraft: false, publishedAt: '2026-10-02T00:00:00Z' }]) : undefined));
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
  assert.deepEqual(npm, [['ci', '--no-audit', '--no-fund']]);
  assert.equal(path.resolve(JSON.parse(readFileSync(released, 'utf8')).cwd).toLowerCase(), path.join(work, 'reeve-release').toLowerCase());
  assert.ok(!existsSync(path.join(work, 'reeve-release')), 'the release worktree is removed');

  npmFails = true;
  rmSync(released);
  const failed = await releaseOne(ctx, e, { kit: '1.2.1' });
  assert.equal(failed.outcome, 'failed');
  assert.match(failed.message, /^npm ci failed \(exit 1\), so its release wasn't built$/);
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
  const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok([{ tagName: 'v0.4.1', isDraft: false }]) : undefined));
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
