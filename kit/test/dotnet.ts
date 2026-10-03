#!/usr/bin/env node
/**
 * The kit's dotnet part, tested with the .NET 10 SDK (kit/test/dotnet: the spec's vectors against the core in
 * Jint, and turns, locks and failure markers on disk):
 *
 *   npm run test:dotnet                 dotnet test; fails without a .NET 10 SDK
 *   node kit/test/dotnet.ts --if-present    the same, but says so and passes when there is none (npm test's posttest)
 *   npm run test:dotnet-publish         the part published as Heiward publishes it (self-contained, single-file
 *                                       or not, Arm64 and x64, and trimmed), each exe run (kit/test/dotnet-publish)
 *
 * The SDK is the first with a 10.x SDK of: DOTNET_ROOT, a dotnet on PATH, C:\tools\dotnet10, %ProgramFiles%\dotnet.
 * It runs with DOTNET_ROOT set to it and it first on PATH.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const exe = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';

/** A folder holding a dotnet with a .NET 10 SDK, or null. */
function findSdk(): string | null {
  const dirs = [
    process.env.DOTNET_ROOT,
    ...(process.env.PATH ?? '').split(path.delimiter),
    process.platform === 'win32' ? 'C:\\tools\\dotnet10' : undefined,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'dotnet') : undefined,
  ].filter((d): d is string => !!d && existsSync(path.join(d, exe)));
  for (const dir of [...new Set(dirs)]) {
    const r = spawnSync(path.join(dir, exe), ['--list-sdks'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && /^10\./m.test(r.stdout)) return dir;
  }
  return null;
}

const sdk = findSdk();
if (!sdk) {
  const msg = 'kit/test/dotnet: no .NET 10 SDK here (DOTNET_ROOT, PATH, C:\\tools\\dotnet10 or %ProgramFiles%\\dotnet)';
  if (args.includes('--if-present')) {
    console.log(`${msg}: the dotnet part's tests are skipped. npm run test:dotnet runs them.`);
    process.exit(0);
  }
  console.error(`${msg}: install it, or set DOTNET_ROOT to it.`);
  process.exit(1);
}

const env = { ...process.env, DOTNET_ROOT: sdk, PATH: `${sdk}${path.delimiter}${process.env.PATH ?? ''}`, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' };
const dotnet = (cwd: string, ...a: string[]) => spawnSync(path.join(sdk, exe), a, { cwd, env, stdio: 'inherit', windowsHide: true }).status ?? 1;

if (args.includes('--publish')) {
  // As HEI.Agent\release.ps1 (the GitHub exe) and store.ps1 (the Store package's files) publish, and trimmed.
  const project = path.join(here, 'dotnet-publish');
  const single = ['-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true', '-p:EnableCompressionInSingleFile=true'];
  const builds: [string, string[]][] = [
    ['arm64-single-file', ['-r', 'win-arm64', '--self-contained', ...single]],
    ['arm64-files', ['-r', 'win-arm64', '--self-contained']],
    ['x64-single-file', ['-r', 'win-x64', '--self-contained', ...single]],
    ['x64-files', ['-r', 'win-x64', '--self-contained']],
    ['arm64-trimmed', ['-r', 'win-arm64', '--self-contained', '-p:PublishTrimmed=true', ...single]],
  ];
  const failed: string[] = [];
  for (const [name, flags] of builds) {
    const out = path.join(project, 'out', name);
    rmSync(out, { recursive: true, force: true });
    console.log(`\n=== ${name}: dotnet publish ${flags.join(' ')}`);
    if (dotnet(project, 'publish', '-c', 'Release', ...flags, '-o', out, '-nologo', '-v', 'q') !== 0) {
      failed.push(`${name} (publish)`);
      continue;
    }
    const r = spawnSync(path.join(out, 'kit-publish-check.exe'), [], { stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) failed.push(name);
  }
  console.log(failed.length ? `\nFailed: ${failed.join(', ')}` : `\nAll ${builds.length} publishes run.`);
  process.exit(failed.length ? 1 : 0);
}

process.exit(dotnet(path.join(here, 'dotnet'), 'test', '-nologo', '-v', 'q'));
