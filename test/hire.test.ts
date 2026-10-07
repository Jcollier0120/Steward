import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Runner } from '../src/run.ts';
import type { Employee } from '../src/settings.ts';
import { STAFF as DEFAULT_EMPLOYEES } from './fixtures/staff.ts';
import { releaseOne } from '../src/stages/release.ts';
import { ctxFor, ok, runner, sh } from './helpers.ts';

// A hire: the first install on this PC of one of its own agents (Manor's staff.local.json), built here from its clone.
// A release never installs one that isn't installed (it was fired, or never hired); Manor's Hire asks for this instead.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-hire-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** The release command: it says it ran, and where. */
const RELEASE = `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(3) }));
`;

function clone(): string {
  const origin = path.join(tmp, 'origin.git');
  const checkout = path.join(tmp, 'Crier');
  sh(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '--quiet', origin, checkout);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false' })) sh(checkout, 'config', k, v);
  const files: Record<string, string> = {
    'package.json': '{\n  "name": "crier",\n  "version": "0.1.0"\n}\n',
    'kit.json': '{\n  "kit": "2.32.1",\n  "parts": ["node", "web", "spec", "react"]\n}\n',
    'tools/release.mjs': RELEASE,
  };
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true });
    writeFileSync(path.join(checkout, f), t);
  }
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Crier 0.1.0');
  sh(checkout, 'push', '--quiet', 'origin', 'main');
  return checkout;
}

const checkout = clone();
const marker = path.join(tmp, 'released.json');
const installed = path.join(tmp, 'home', '.crier', 'app');
const base = DEFAULT_EMPLOYEES.find((x) => x.id === 'wright')!;
// Built and installed here: its release command carries --install (settings.ts's releasedHere).
const crier: Employee = { ...base, id: 'crier', name: 'Crier', repo: 'me/Crier', checkout, branch: 'main', usesKit: true, versionFiles: ['package.json'], release: `node tools/release.mjs "${marker}" --install`, installed };
// v0.1.0 is released already (as GitHub has it): a release alone would build nothing.
const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok([{ tagName: 'v0.1.0', isDraft: false, publishedAt: '2026-10-07T00:00:00Z' }]) : undefined));
const run: Runner = async (cmd, args, opts) => {
  if (cmd !== 'npm') return r.run(cmd, args, opts);
  mkdirSync(path.join(opts!.cwd!, 'node_modules'), { recursive: true });
  return ok('');
};
const ctx = () => ctxFor({ employees: [crier], workRoot: path.join(tmp, 'work'), run, neutralDir: tmp });

test('a release never installs one of its own agents that is not installed here; a hire does, at its branch version, released or not', async () => {
  const plain = await releaseOne(ctx(), crier, { kit: null });
  assert.equal(plain.outcome, 'skipped');
  assert.match(plain.message, /isn't installed on this PC .* hire it in Manor/);
  assert.ok(!existsSync(marker), 'nothing built');

  const c = ctx();
  const hired = await releaseOne(c, crier, { kit: null, hire: true });
  assert.equal(hired.outcome, 'done', `${hired.message}\n${c.lines.join('\n')}`);
  const ran = JSON.parse(readFileSync(marker, 'utf8'));
  assert.deepEqual(ran.args, ['--install'], 'its own release command, which installs it');
  assert.equal(path.resolve(ran.cwd).toLowerCase(), path.join(tmp, 'work', 'crier-release').toLowerCase());
});

test('a hire installs only what is not installed, only an agent built here, and only one whose install folder Settings name', async () => {
  rmSync(marker, { force: true });
  mkdirSync(installed, { recursive: true });
  const twice = await releaseOne(ctx(), crier, { kit: null, hire: true });
  assert.deepEqual([twice.outcome, twice.message], ['skipped', `Crier is installed here already (${installed})`]);
  rmSync(installed, { recursive: true });

  const published = await releaseOne(ctx(), { ...crier, release: 'npm run release -- --publish' }, { kit: null, hire: true });
  assert.equal(published.outcome, 'refused');
  assert.match(published.message, /installed from its published release, not built here: hire it in Manor/);

  const nowhere = await releaseOne(ctx(), { ...crier, installed: '' }, { kit: null, hire: true });
  assert.equal(nowhere.outcome, 'refused');
  assert.match(nowhere.message, /Settings name no install folder for Crier/);
  assert.ok(!existsSync(marker), 'nothing built for any of them');
});
