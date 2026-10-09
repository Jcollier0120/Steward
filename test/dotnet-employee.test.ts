import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Employee } from '../src/settings.ts';

// A .NET employee, as Heiward is: C#, its branch master, its version a .csproj's <VersionPrefix>, no package.json,
// and its kit\ filled by a PowerShell script of its own. It goes through every stage (bump, push, merge, release,
// staff) with git for real and gh standing in, and gets nothing of a Node agent's: no npm, no tools/kit.ts. A bump's
// version is claimed (claims.ts), in a Steward home of the test's own.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'steward-dotnet-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
process.env.STEWARD_HOME = path.join(tmp, 'home');
const { STAFF: DEFAULT_EMPLOYEES } = await import('./fixtures/staff.ts');
const { bumpOne, needsNpmCi } = await import('../src/stages/bump.ts');
const { mergeOne } = await import('../src/stages/merge.ts');
const { pushOne } = await import('../src/stages/push.ts');
const { releaseOne } = await import('../src/stages/release.ts');
const { staffRow } = await import('../src/stages/staff.ts');
const { ctxFor, ok, runner, sh } = await import('./helpers.ts');

const heiward = DEFAULT_EMPLOYEES.find((e) => e.id === 'heiward')!;
const CSPROJ = (v: string) => `<Project Sdk="Microsoft.NET.Sdk.Web">\r\n  <PropertyGroup>\r\n    <AssemblyName>hei</AssemblyName>\r\n    <VersionPrefix>${v}</VersionPrefix>\r\n  </PropertyGroup>\r\n</Project>\r\n`;

/** Its tools\kit.ps1, cut down: the kit tree STEWARD_KIT names (a bump with --kit-from sets it) into kit\. */
const KIT_PS1 = [
  "$ErrorActionPreference = 'Stop'",
  "if (-not $env:STEWARD_KIT) { [Console]::Error.WriteLine('tools\\kit.ps1: no STEWARD_KIT'); exit 1 }",
  "$kit = Join-Path (Split-Path $PSScriptRoot -Parent) 'kit'",
  'if (Test-Path $kit) { Remove-Item $kit -Recurse -Force }',
  'New-Item -ItemType Directory $kit | Out-Null',
  "Copy-Item (Join-Path $env:STEWARD_KIT 'spec') (Join-Path $kit 'spec') -Recurse",
  "Copy-Item (Join-Path $env:STEWARD_KIT 'VERSION') (Join-Path $kit 'VERSION')",
  "Write-Host \"kit\\: the Steward's kit $((Get-Content (Join-Path $kit 'VERSION')).Trim()) (spec)\"",
  '',
].join('\r\n');

/** Stands in for `dotnet test HEI.Core.Tests`: its tests read the queue's vectors from kit\spec. */
const CHECK = `import { existsSync, readFileSync } from 'node:fs';
const vectors = 'kit/spec/npu-queue-vectors.json';
if (!existsSync(vectors)) { console.error('no ' + vectors + ': run tools\\\\kit.ps1'); process.exit(1); }
console.log('kit ' + readFileSync('kit/VERSION', 'utf8').trim() + ', ' + Object.keys(JSON.parse(readFileSync(vectors, 'utf8'))).join(' '));
`;

/** Stands in for HEI.Agent\release.ps1 -Publish: says where it ran, and what it found there. */
const RELEASE = `import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({
  cwd: process.cwd(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  version: /<VersionPrefix>([^<]+)</.exec(readFileSync('HEI.Agent/HEI.Agent.csproj', 'utf8'))[1],
  kit: JSON.parse(readFileSync('kit.json', 'utf8')).kit,
}));
`;

/** The kit tree a trial bump fills from: 1.0.1, its spec part. */
const kitFrom = path.join(tmp, 'kit-1.0.1');
mkdirSync(path.join(kitFrom, 'spec'), { recursive: true });
writeFileSync(path.join(kitFrom, 'VERSION'), '1.0.1\n');
writeFileSync(path.join(kitFrom, 'spec', 'npu-queue-vectors.json'), '{ "nowUs": 1, "order": [], "dead": [], "slots": [] }\n');

/** A bare origin with a master branch, and the person's clone of it. */
function fakeDotnetEmployee(dir: string): { origin: string; checkout: string } {
  const origin = path.join(dir, 'origin.git');
  const checkout = path.join(dir, 'Heiward');
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '--quiet', '--bare', '-b', 'master', origin);
  sh(dir, 'clone', '--quiet', origin, checkout);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'core.autocrlf': 'false' })) sh(checkout, 'config', k, v);
  const files: Record<string, string> = {
    'HEI.Agent/HEI.Agent.csproj': CSPROJ('1.7.0'),
    'kit.json': '{\n  "kit": "1.0.0",\n  "parts": ["spec"]\n}\n',
    'tools/kit.ps1': KIT_PS1,
    'tools/check.mjs': CHECK,
    'tools/release.mjs': RELEASE,
    '.gitignore': '/kit/\n',
  };
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(checkout, f)), { recursive: true });
    writeFileSync(path.join(checkout, f), t);
  }
  sh(checkout, 'add', '-A');
  sh(checkout, 'commit', '--quiet', '-m', 'Heiward 1.7.0: the Steward\'s kit 1.0.0');
  sh(checkout, 'push', '--quiet', 'origin', 'master');
  return { origin, checkout };
}

test("Heiward's defaults take the kit: its own fill, dotnet test, a .csproj, its release script, on master", () => {
  assert.equal(heiward.usesKit, true);
  assert.equal(heiward.branch, 'master');
  assert.equal(heiward.fill, 'powershell -NoProfile -File tools\\kit.ps1');
  assert.deepEqual(heiward.test, ['dotnet test HEI.Core.Tests']);
  assert.deepEqual(heiward.versionFiles, ['HEI.Agent/HEI.Agent.csproj']);
  assert.equal(heiward.release, 'powershell -NoProfile -File HEI.Agent\\release.ps1 -Publish');
});

test('npm ci only for a Node project without node_modules: never for one with no package.json', () => {
  const dir = path.join(tmp, 'npm');
  const at = (files: string[]) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      if (f.endsWith('/')) mkdirSync(path.join(dir, f), { recursive: true });
      else writeFileSync(path.join(dir, f), '{}');
    }
    return needsNpmCi(dir);
  };
  assert.equal(at(['package.json', 'package-lock.json']), true);
  assert.equal(at(['package.json', 'package-lock.json', 'node_modules/']), false);
  assert.equal(at(['package-lock.json']), false, 'a lockfile left lying about makes no Node project');
  assert.equal(at(['package.json']), false, 'npm ci needs a lockfile');
  assert.equal(at(['kit.json', 'Heiward.sln']), false);
});

test('a .NET employee on master, through every stage: bump, push, merge, release and staff', async () => {
  const dir = path.join(tmp, 'cycle');
  const f = fakeDotnetEmployee(dir);
  const released = path.join(dir, 'released.json');
  // Heiward's own fill, as Settings have it, but for the execution policy, which this PC's may not leave open.
  const e: Employee = {
    ...heiward,
    checkout: f.checkout,
    fill: heiward.fill.replace('-File', '-ExecutionPolicy Bypass -File'),
    test: ['node tools/check.mjs'],
    release: `node tools/release.mjs "${released}"`,
  };
  const work = path.join(dir, 'work');
  const branch = 'steward/kit-1.0.1';

  // bump: a worktree of origin/master, kit.json and the .csproj changed, the kit filled by its PowerShell, checked, committed.
  const b = runner((a) => (a[1] === 'list' ? ok([]) : undefined));
  const ctx = ctxFor({ employees: [e], workRoot: work, run: b.run, released: ['1.0.0', '1.0.1'], neutralDir: dir });
  // A tools/kit.ts the Steward would hand a Node agent: Heiward must not get it.
  const nodeTool = path.join(dir, 'kit.ts');
  writeFileSync(nodeTool, "console.log('the Steward\\'s tools/kit.ts');\n");
  const bumped = await bumpOne(ctx, e, { kit: '1.0.1', kitFrom, tool: nodeTool });
  assert.equal(bumped.outcome, 'done', `${bumped.message}\n${ctx.lines.join('\n')}`);
  assert.equal(bumped.version, '1.7.1');
  assert.match(bumped.message, /^1\.7\.1 on steward\/kit-1\.0\.1 \([0-9a-f]+\): kit 1\.0\.0 → 1\.0\.1, checks passed with the kit from /);
  assert.deepEqual(sh(f.checkout, 'diff', '--name-only', 'origin/master', branch).split('\n').sort(), ['CHANGELOG.md', 'HEI.Agent/HEI.Agent.csproj', 'kit.json']);
  assert.equal(sh(f.checkout, 'show', `${branch}:kit.json`), '{\n  "kit": "1.0.1",\n  "parts": ["spec"]\n}');
  assert.equal(execFileSync('git', ['show', `${branch}:HEI.Agent/HEI.Agent.csproj`], { cwd: f.checkout, encoding: 'utf8' }), CSPROJ('1.7.1'), 'only the version changed, CRLF and all');
  assert.equal(sh(f.checkout, 'log', '-1', '--format=%s', branch), "Heiward 1.7.1: the Steward's kit 1.0.1");
  assert.match(sh(f.checkout, 'log', '-1', '--format=%b', branch), /the version is 1\.7\.1 in HEI\.Agent\/HEI\.Agent\.csproj, and CHANGELOG\.md has its entry\. Made by steward bump\./);
  const workTree = path.join(work, 'heiward');
  assert.equal(readFileSync(path.join(workTree, 'kit', 'VERSION'), 'utf8').trim(), '1.0.1', 'its own tools\\kit.ps1 filled kit\\ from the kit tree');
  assert.ok(existsSync(path.join(workTree, 'kit', 'spec', 'npu-queue-vectors.json')));
  assert.ok(!existsSync(path.join(workTree, 'tools', 'kit.ts')), 'no tools/kit.ts for an employee that fills its kit another way');
  assert.ok(!existsSync(path.join(workTree, 'node_modules')));
  const steps = ctx.lines.filter((l) => /: (ok|exit \d+) \(\d+ s\)$/.test(l)).map((l) => l.replace(/^\[heiward\] /, '').replace(/: (ok|exit \d+) \(\d+ s\)$/, ''));
  assert.deepEqual(steps, [e.fill, 'node tools/check.mjs'], 'no npm ci: the fill, then the tests');
  assert.equal(sh(f.checkout, 'branch', '--show-current'), 'master', "the person's checkout is as it was");
  assert.equal(sh(f.checkout, 'status', '--porcelain'), '');

  // push: the branch to origin, and a PR against master.
  const p = runner((args) => (args[1] === 'list' ? ok([]) : args[1] === 'create' ? ok('https://github.com/Jcollier0120/Heiward/pull/60\n') : undefined));
  const pushed = await pushOne({ ...ctx, run: p.run }, e, { kit: '1.0.1', changelog: '## 1.0.1\n\n- new vectors\n' });
  assert.equal(pushed.outcome, 'done', pushed.message);
  assert.equal(sh(f.origin, 'rev-parse', `refs/heads/${branch}`), sh(f.checkout, 'rev-parse', branch));
  const create = p.gh.find((a) => a[1] === 'create')!;
  assert.equal(create[create.indexOf('--base') + 1], 'master');
  assert.equal(create[create.indexOf('--repo') + 1], 'Jcollier0120/Heiward');
  assert.equal(create[create.indexOf('--title') + 1], "Heiward 1.7.1: the Steward's kit 1.0.1");
  const body = create[create.indexOf('--body-file') + 1];
  assert.match(body, /the version is 1\.7\.1 in HEI\.Agent\/HEI\.Agent\.csproj\. The kit itself isn't in the repo: `powershell -NoProfile -ExecutionPolicy Bypass -File tools\\kit\.ps1` fills it/);
  assert.doesNotMatch(body, /tools\/kit\.ts/);
  assert.match(body, /- new vectors/);

  // merge --yes: GitHub (standing in) merges the PR into master, and the Steward's worktree goes.
  const pr = { number: 60, title: "Heiward 1.7.1: the Steward's kit 1.0.1", url: 'https://github.com/Jcollier0120/Heiward/pull/60', headRefName: branch, baseRefName: 'master', isCrossRepository: false, author: { login: 'Jcollier0120', is_bot: false }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false, statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const m = runner((args) => {
    if (args[1] === 'list') return ok([pr]);
    if (args[1] === 'merge') {
      sh(f.checkout, 'push', '--quiet', 'origin', `${branch}:master`);
      return ok('');
    }
  });
  const merged = await mergeOne({ ...ctx, run: m.run }, e, { yes: true });
  assert.equal(merged.outcome, 'done', merged.message);
  assert.deepEqual(m.gh.filter((a) => a[1] === 'merge'), [['pr', 'merge', '60', '--repo', 'Jcollier0120/Heiward', '--merge', '--delete-branch']]);
  assert.ok(!existsSync(workTree), "the bump's worktree is removed after the merge");

  // release: from origin/master at the merged commit, in a worktree of its own, with its release command.
  const r = runner((args) => (args[0] === 'release' && args[1] === 'list' ? ok([{ tagName: 'v1.7.0', isDraft: false, publishedAt: '2026-10-02T00:00:00Z' }]) : undefined));
  const rel = await releaseOne({ ...ctx, run: r.run }, e, { kit: '1.0.1' });
  assert.equal(rel.outcome, 'done', `${rel.message}\n${ctx.lines.join('\n')}`);
  assert.equal(rel.version, '1.7.1');
  assert.equal(rel.url, 'https://github.com/Jcollier0120/Heiward/releases/tag/v1.7.1');
  const ran = JSON.parse(readFileSync(released, 'utf8'));
  sh(f.checkout, 'fetch', '--quiet', 'origin');
  assert.equal(ran.head, sh(f.checkout, 'rev-parse', 'origin/master'));
  assert.equal(path.resolve(ran.cwd).toLowerCase(), path.join(work, 'heiward-release').toLowerCase());
  assert.deepEqual([ran.version, ran.kit], ['1.7.1', '1.0.1']);
  assert.ok(!existsSync(path.join(work, 'heiward-release')), 'the release worktree is removed');
  // Released already: skipped.
  const again = runner((args) => (args[1] === 'list' ? ok([{ tagName: 'v1.7.1', isDraft: false }]) : undefined));
  assert.match((await releaseOne({ ...ctx, run: again.run }, e, { kit: '1.0.1' })).message, /v1\.7\.1 is already released/);

  // staff: its row reads the .csproj and kit.json on master, and asks nothing about tools/kit.ts.
  const target = sh(f.checkout, 'rev-parse', 'origin/master');
  const s = runner((args) => {
    if (args[1] === 'list' && args[0] === 'pr') return ok([]);
    if (args[0] === 'release' && args[1] === 'list') return ok([{ tagName: 'v1.7.1', isDraft: false, publishedAt: '2026-10-03T00:00:00Z' }]);
    if (args[0] === 'release' && args[1] === 'view') return ok({ targetCommitish: target });
  });
  const row = await staffRow({ ...ctx, run: s.run }, e, { fetch: true, kit: '1.0.1', tool: readFileSync(nodeTool, 'utf8') });
  assert.equal(row.branch, 'master');
  assert.equal(row.main?.version, '1.7.1');
  assert.equal(row.main?.kit, '1.0.1');
  assert.deepEqual(row.main?.parts, ['spec']);
  assert.equal(row.main?.tool, null);
  assert.deepEqual(row.release, { tag: 'v1.7.1', version: '1.7.1', published: '2026-10-03T00:00:00Z', kit: '1.0.1' });
  assert.equal(row.releaseNeeded, false);
  assert.deepEqual(row.notes, []);
});

test("a .NET employee whose branch doesn't pin the kit yet is refused with the reason, and its version still read", async () => {
  const dir = path.join(tmp, 'unconverted');
  const f = fakeDotnetEmployee(dir);
  sh(f.checkout, 'rm', '--quiet', 'kit.json');
  sh(f.checkout, 'commit', '--quiet', '-m', 'before the kit');
  sh(f.checkout, 'push', '--quiet', 'origin', 'master');
  const e: Employee = { ...heiward, checkout: f.checkout };
  const r = runner(() => ok([]));
  const ctx = ctxFor({ employees: [e], workRoot: path.join(dir, 'work'), run: r.run, neutralDir: dir });
  const bumped = await bumpOne(ctx, e, { kit: '1.0.1', kitFrom });
  assert.equal(bumped.outcome, 'refused');
  assert.equal(bumped.message, 'origin/master has no kit.json');
  const row = await staffRow(ctx, e, { fetch: true, kit: '1.0.1', tool: 'x' });
  assert.equal(row.main?.version, '1.7.0');
  assert.deepEqual(row.notes, ['no kit.json on origin/master']);
  assert.match((await releaseOne(ctx, e, { kit: '1.0.1' })).message, /its branch has no kit\.json/);
});
