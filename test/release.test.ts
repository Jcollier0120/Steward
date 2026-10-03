import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Runner } from '../src/run.ts';
import { DEFAULT_EMPLOYEES, type Employee } from '../src/settings.ts';
import { releaseOne } from '../src/stages/release.ts';
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
