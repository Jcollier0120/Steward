import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A trial's tests run in a profile of their own (Steward 0.36.180): USERPROFILE, HOME, LOCALAPPDATA and APPDATA point
 * at an empty folder beside the trial's worktree, made afresh for each run. Kit 2.100.0's trial failed Reeve's setup
 * test on this PC alone, because the kit's setup plan read the GenieX model this PC had in its real profile: a test
 * should find what its own fixtures give it, never what the PC that runs it happens to hold. The run's other variables
 * are kept (PATH, TEMP, git's), and so are the tools' own caches and settings that live in the profile (npm's,
 * git's global config, Rust's toolchains, Go's, NuGet's, pip's, Playwright's browsers), pinned where they are, so the
 * tools find what is installed and nothing is fetched again. Only the agent's test steps run there: its install and
 * the kit's fill run as before. A test that asks Windows itself for the profile (.NET's GetFolderPath, Rust's dirs)
 * still finds the real one. A test that does need the real profile fails on its main in the scratch one as well, so
 * the trial counts it as the agent's own failure (bump.ts's withoutTheKit), never the kit's; its rollout runs as before.
 */

/** The scratch profile beside a trial's worktree. Pure. */
export const trialProfileOf = (dir: string): string => `${dir}.profile`;

/** The scratch profile made afresh: empty, with the folders Windows has in every profile. */
export function freshProfile(profile: string): void {
  rmSync(profile, { recursive: true, force: true });
  for (const sub of [['AppData', 'Local'], ['AppData', 'Roaming']]) mkdirSync(path.join(profile, ...sub), { recursive: true });
}

/** The scratch profile and its folders removed, after a trial. */
export function removeProfile(profile: string): void {
  rmSync(profile, { recursive: true, force: true });
}

/**
 * The variables a test step runs with in the scratch profile `profile`, from the run's own `env` (process.env's by
 * default): the profile's four pointed there, and each tool's cache and settings that live in the real profile pinned
 * where they are, unless the run sets them already. Pure.
 */
export function trialProfileEnv(profile: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const local = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
  const roaming = env.APPDATA || p.join(home, 'AppData', 'Roaming');
  const cache = env.XDG_CACHE_HOME || p.join(home, '.cache');
  const gitConfig = [p.join(home, '.gitconfig'), p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'git', 'config')].find((f) => existsSync(f));
  const pins: Record<string, string | undefined> = {
    npm_config_cache: win ? p.join(local, 'npm-cache') : p.join(home, '.npm'),
    npm_config_userconfig: p.join(home, '.npmrc'),
    ...(win ? { npm_config_prefix: p.join(roaming, 'npm'), npm_config_devdir: p.join(local, 'node-gyp', 'Cache') } : { XDG_CACHE_HOME: cache }),
    GIT_CONFIG_GLOBAL: gitConfig,
    CARGO_HOME: p.join(home, '.cargo'),
    RUSTUP_HOME: p.join(home, '.rustup'),
    GOPATH: p.join(home, 'go'),
    GOCACHE: win ? p.join(local, 'go-build') : p.join(cache, 'go-build'),
    ...(win ? { GOENV: p.join(roaming, 'go', 'env') } : {}),
    NUGET_PACKAGES: p.join(home, '.nuget', 'packages'),
    ...(win ? { NUGET_HTTP_CACHE_PATH: p.join(local, 'NuGet', 'v3-cache') } : {}),
    DOTNET_CLI_HOME: home,
    PIP_CACHE_DIR: win ? p.join(local, 'pip', 'Cache') : p.join(cache, 'pip'),
    ...(win ? { PYTHONUSERBASE: p.join(roaming, 'Python') } : {}),
    PLAYWRIGHT_BROWSERS_PATH: win ? p.join(local, 'ms-playwright') : p.join(cache, 'ms-playwright'),
    PUPPETEER_CACHE_DIR: p.join(cache, 'puppeteer'),
  };
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(pins)) if (value && !env[name]) out[name] = value;
  Object.assign(out, { USERPROFILE: profile, HOME: profile, LOCALAPPDATA: p.join(profile, 'AppData', 'Local'), APPDATA: p.join(profile, 'AppData', 'Roaming') });
  if (win) Object.assign(out, { HOMEDRIVE: p.parse(profile).root.replace(/[\\/]$/, ''), HOMEPATH: profile.slice(p.parse(profile).root.length - 1) });
  return out;
}
