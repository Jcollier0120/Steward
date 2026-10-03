#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { APP, pageUrl } from './app.ts';
import { serveSteward } from './agent.ts';
import { installCli, TASK_NAME } from './kit/install.ts';
import { LockTimeout } from './kit/lock.ts';
import { open, shutdown, start, status, stop } from './kit/service.ts';
import type { StageResult } from './stages/common.ts';
import type { Staff } from './stages/staff.ts';
import { context, refreshStaff, runStage, type StageAsk } from './steward.ts';

const USAGE = `${APP.id}: ${APP.role}

  The kit's rollout, a stage at a time (each reports for every employee):
  bump [--kit <version>] [--employees a,b]
                   for each employee: a worktree of its branch on origin, on steward/kit-<version>, with
                   kit.json pinned to the kit and its patch version up; its kit filled, its checks run,
                   then a commit. Nothing is pushed. --kit defaults to the newest kit release.
                   --kit-from <dir> fills from a kit tree instead of the release; --base <ref> starts
                   from a local ref instead of origin (both for a trial)
  push [--kit <version>] [--employees a,b]
                   push each bump (never forced) and open its PR
  merge [--yes] [--team] [--employees a,b]
                   list the Steward's open PRs, with their checks and whether they merge; with --yes,
                   merge those that merge cleanly with no failing or running checks. --team: the team's
                   PRs too (the GitHub accounts in Settings), to any employee; their branches stay.
                   Then what each merged PR's steward block asks for: release, install (and the jobs
                   it names to approve, which stay yours)
  release [--kit <version>] [--employees a,b]
                   release each employee whose branch has the kit and an unreleased version, from its branch
  staff [--json] [--no-fetch]
                   each employee: its checkout, its branch's version and kit, its latest release and the
                   kit in it, the open PRs of the Steward and the team (--hires is the same as --employees,
                   everywhere)

  start            on duty, and its page up at ${pageUrl}
  stop             off duty (it has no rounds yet, so this only says so; the page stays up)
  open             make sure its page is up, without changing duty
  shutdown         end its page process
  status [--json]  on duty or not; --json prints what Manor reads
  serve            run the page in this window (what start and open run in the background)
  install [--no-start] [--dry-run]
                   install this release: copy it to %USERPROFILE%\\.${APP.id}\\app, register the sign-in task
                   ${TASK_NAME} that brings its page up, and start it
  uninstall [--purge] [--dry-run]
                   end its page, delete the sign-in task and remove the installed copy; --purge also its data
`;

/** --name value, or undefined. */
function opt(args: string[], ...names: string[]): string | undefined {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i >= 0) return args[i + 1];
  }
  return undefined;
}

const STAGE_FLAGS: Record<string, string[]> = {
  bump: ['--kit', '--employees', '--hires', '--kit-from', '--base'],
  push: ['--kit', '--employees', '--hires'],
  merge: ['--yes', '--team', '--employees', '--hires', '--kit'],
  release: ['--kit', '--employees', '--hires'],
  staff: ['--json', '--no-fetch'],
};
const VALUED = ['--kit', '--employees', '--hires', '--kit-from', '--base'];

/** An unknown flag is refused, so a mistyped --yes never merges and a mistyped --kit never bumps. */
function unknownFlags(cmd: string, args: string[]): string[] {
  const known = STAGE_FLAGS[cmd];
  const bad: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!known.includes(args[i])) bad.push(args[i]);
    else if (VALUED.includes(args[i])) i++;
  }
  return bad;
}

function printStage(r: StageResult): number {
  console.log(`\n${r.stage}${r.kit ? ` to kit ${r.kit}` : ''}:${r.error ? ` stopped: ${r.error}` : ''}`);
  const width = Math.max(0, ...r.results.map((x) => x.name.length));
  for (const x of r.results) console.log(`  ${x.name.padEnd(width)}  ${x.outcome.padEnd(7)}  ${x.message}${x.url ? `  ${x.url}` : ''}`);
  return r.error || r.results.some((x) => x.outcome === 'failed' || x.outcome === 'refused') ? 1 : 0;
}

function printStaff(s: Staff): void {
  console.log(`The kit the Steward hands out: ${s.kit ?? 'none'}${s.kitNote ? ` (${s.kitNote})` : ''}`);
  for (const r of s.rows) {
    const main = r.main ? `${r.branch} ${r.main.version ?? '?'} (${r.main.commit}), ${r.main.oldKitFiles.length ? `old kit (${r.main.oldKitFiles.length} files)` : r.main.kit ? `kit ${r.main.kit}` : 'no kit.json'}` : `${r.branch} unknown`;
    const rel = r.release ? `${r.release.tag}${r.release.kit === 'unknown' ? '' : r.release.kit ? ` with kit ${r.release.kit}` : ' with no kit'}` : 'no release';
    const prs = r.prs.length ? `; PRs ${r.prs.map((p) => `#${p.number} ${p.checks}/${p.mergeable.toLowerCase()}${p.whose === 'team' ? ` (${p.author}'s)` : ''}`).join(', ')}` : '';
    console.log(`\n${r.name} (${r.repo})`);
    console.log(`  checkout ${r.checkout.path}${r.checkout.exists ? ` on ${r.checkout.branch}${r.checkout.changes ? `, ${r.checkout.changes} changed` : ''}` : ' (missing)'}`);
    console.log(`  ${main}; latest release ${rel}${r.releaseNeeded ? `; ${r.main?.version} not released` : ''}${prs}`);
    if (r.prepared) console.log(`  prepared here: ${r.prepared.branch}, ${r.prepared.ahead} ahead`);
    for (const n of r.notes) console.log(`  - ${n}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const cliFile = fileURLToPath(import.meta.url);

async function stage(name: 'bump' | 'push' | 'merge' | 'release'): Promise<number> {
  const bad = unknownFlags(name, rest);
  if (bad.length) {
    console.error(`${name}: unknown ${bad.join(' ')} (it takes ${STAGE_FLAGS[name].join(' ')})`);
    return 2;
  }
  const list = opt(rest, '--employees', '--hires');
  const ask: StageAsk = {
    employees: list ? list.split(',') : null,
    kit: opt(rest, '--kit') ?? null,
    base: opt(rest, '--base') ?? null,
    kitFrom: opt(rest, '--kit-from') ?? null,
    yes: rest.includes('--yes'),
    team: rest.includes('--team'),
  };
  try {
    return printStage(await runStage(name, ask, { log: (line) => console.log(line) }));
  } catch (e) {
    if (e instanceof LockTimeout) {
      console.error('Another stage is running (on the page, or in another terminal). Try again when it has finished.');
      return 1;
    }
    throw e;
  }
}

switch (cmd) {
  case 'serve':
    await serveSteward();
    break;
  case 'start':
    process.exitCode = await start(cliFile);
    break;
  case 'stop':
    process.exitCode = await stop();
    break;
  case 'open':
    process.exitCode = await open(cliFile);
    break;
  case 'shutdown':
    process.exitCode = await shutdown();
    break;
  case 'status':
    process.exitCode = await status(rest.includes('--json'));
    break;
  case 'bump':
  case 'push':
  case 'merge':
  case 'release':
    process.exitCode = await stage(cmd);
    break;
  case 'staff': {
    const bad = unknownFlags('staff', rest);
    if (bad.length) {
      console.error(`staff: unknown ${bad.join(' ')} (it takes --json --no-fetch)`);
      process.exitCode = 2;
      break;
    }
    const s = await refreshStaff(await context(), { fetch: !rest.includes('--no-fetch') });
    if (rest.includes('--json')) console.log(JSON.stringify(s, null, 2));
    else printStaff(s);
    break;
  }
  case 'install':
  case 'uninstall':
    process.exitCode = await installCli(cmd, rest);
    break;
  default:
    console.log(USAGE);
    process.exitCode = cmd && cmd !== 'help' ? 2 : 0;
}
