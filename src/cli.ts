#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { APP, pageUrl } from './app.ts';
import { serveSteward } from './agent.ts';
import { installCli, TASK_NAME } from './kit/install.ts';
import { allowUpdate, safeInstallCli } from './safeinstall.ts';
import { claimVersion, employeeFor, loadClaims, releaseClaim } from './claims.ts';
import { anyRepo } from './found.ts';
import { addEmployee, employeeFor as employeeFromCheckout } from './employ.ts';
import { loadSettings, settingsFile, type Employee, type Settings } from './settings.ts';
import { LockTimeout } from './kit/lock.ts';
import { open, shutdown, start, status, stop } from './kit/service.ts';
import type { StageResult } from './stages/common.ts';
import type { Staff } from './stages/staff.ts';
import { context, refreshStaff, runStage, type StageAsk } from './steward.ts';
import { markMine } from './strangers.ts';

const USAGE = `${APP.id}: ${APP.role}

  Each stage reports for every repository it looks after (Settings). bump and push are Castellan's kit
  rollout, only on the PC that releases Castellan itself; elsewhere release takes each repository's
  own version, and merge merges only where Settings say yes (Merges your ready PRs).
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
                   Then what each merged PR's steward block asks for: release, install, and
                   approve-jobs (merging counts as reading the scripts it names)
  release [--kit <version>] [--employees a,b]
                   release each employee whose branch has the kit and an unreleased version, from its branch
  round [--employees a,b]
                   one round, as the Steward runs by itself on duty (Settings): merge --yes --team, with
                   what each merged PR asks for after, then a release of every version not yet released
  staff [--json] [--no-fetch]
                   each employee: its checkout, its branch's version and kit, its latest release and the
                   kit in it, the open PRs of the Steward and the team (--hires is the same as --employees,
                   everywhere)

  employ <its clone> [--branch <b>] [--dry-run]
                   take on a new agent: add it to Settings' employees from its clone (its id and name
                   from manor-agent.json or src/app.ts, its repository from origin, its kit parts, how
                   to fill, test, version and release it), so the page lists it and the rounds test,
                   merge and release it. One that announces itself is published; Manor's internal staff,
                   and one that doesn't announce itself, are built and installed here. --dry-run: only show it

  start            on duty, and its page up at ${pageUrl}
  stop             off duty: its rounds wait until it is back on duty (the page stays up)
  open             make sure its page is up, without changing duty
  shutdown         end its page process
  status [--json]  on duty or not; --json prints what Manor reads
  serve            run the page in this window (what start and open run in the background)
  install [--no-start] [--dry-run]
                   install this release: copy it to %USERPROFILE%\\.${APP.id}\\app, register the sign-in task
                   ${TASK_NAME} that brings its page up, and start it. An update keeps the version
                   before it, and goes back to it when the new one doesn't hold up for its probation;
                   that version is then flagged, and refused until allowed again
  claim-version <repository: id, name or owner/repo> [--branch <b>] [--for "<what>"] [--by <who>] [--minor] [--json]
                   before starting work on a repository: the next version no one has (above its branch,
                   its releases, its open PRs and every live claim), claimed for that work. The same
                   branch asking again gets the same version. Any repository works: one in Settings, one
                   Reeve found on this PC, or the clone this runs in
  release-version <employee or owner/repo> <version>
                   give a claimed version back (the work was dropped)
  claims [--json]  the versions claimed and not yet landed
  mine <employee> <#pr | v<version>> ...
                   mark a merge of one of the Steward's PRs, or a release, as yours, done by hand: on the PC
                   that releases Castellan, the alarm for merges and releases no round here made never
                   counts it, before or after (Dismiss on the alarm does the same for all it names)
  allow-update <version>
                   allow a version the install rolled back to be installed again
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
  round: ['--employees', '--hires'],
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
    const main = r.main ? `${r.branch} ${r.main.version ?? '?'} (${r.main.commit}), ${r.main.kit ? `kit ${r.main.kit}` : r.usesKit ? 'no kit.json' : 'no kit'}` : `${r.branch} unknown`;
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

async function stage(name: 'bump' | 'push' | 'merge' | 'release' | 'round'): Promise<number> {
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
    // A round asked for in a terminal looks at every employee, as Run now does.
    ...(name === 'round' ? { full: true } : {}),
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
  case 'round':
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
    process.exitCode = await safeInstallCli(rest);
    break;
  case 'uninstall':
    process.exitCode = await installCli(cmd, rest);
    break;
  case 'employ': {
    const where = rest[0] && !rest[0].startsWith('--') ? rest[0] : '';
    const bad = rest.slice(1).filter((a) => a.startsWith('--') && !['--branch', '--dry-run'].includes(a));
    if (!where || bad.length) {
      console.error(`employ takes the agent's clone, then --branch <b> --dry-run${bad.length ? `; not ${bad.join(' ')}` : ''}: employ C:\\Code\\Assayer`);
      process.exitCode = 2;
      break;
    }
    const got = employeeFromCheckout(where, loadSettings().employees, { branch: opt(rest, '--branch') });
    if ('error' in got) {
      console.error(got.error);
      process.exitCode = 1;
      break;
    }
    const e = got.employee;
    const dry = rest.includes('--dry-run');
    console.log(`${dry ? 'Would take on' : 'Took on'} ${e.name} (${e.id}): ${e.repo}, its clone ${e.checkout} on ${e.branch}.`);
    console.log(`  kit parts ${e.parts.join(', ') || 'none'}; fill ${e.fill || '-'}; test ${e.test.join(' && ') || '-'}`);
    console.log(`  version in ${e.versionFiles.join(', ') || '-'}; release ${e.release || '-'}; install ${e.install || '-'}`);
    for (const n of got.notes) console.log(`  ${n}`);
    if (got.missing.length) console.log(`  Not found, so fill it in on the Settings page: ${got.missing.join(', ')}.`);
    if (!dry) {
      addEmployee(settingsFile(), e);
      console.log(`Its next round looks after it; it is on the page at ${pageUrl}.`);
    }
    break;
  }
  case 'claim-version': {
    const who = rest[0] && !rest[0].startsWith('--') ? rest[0] : '';
    const bad = rest.slice(1).filter((a, i, all) => a.startsWith('--') && !['--branch', '--for', '--by', '--minor', '--json'].includes(a) && !['--branch', '--for', '--by'].includes(all[i - 1]));
    if (!who || bad.length) {
      console.error(`claim-version takes an employee (its id, name or owner/repo), then --branch <b> --for "<what>" --by <who> --minor --json${bad.length ? `; not ${bad.join(' ')}` : ''}`);
      process.exitCode = 2;
      break;
    }
    const ctx = await context({ glance: false, team: false });
    const e = employeeFor(ctx.settings, who) ?? anyRepo(who);
    if (!e) {
      console.error(`No repository ${who} here: an id, a name or owner/repo from Settings, one Reeve found on this PC, the clone this runs in, or the Steward's own (${ctx.settings.stewardRepo || 'named in Settings, or the Steward clone this runs in'}).`);
      process.exitCode = 2;
      break;
    }
    const { claim, again } = await claimVersion(ctx, e, { branch: opt(rest, '--branch') ?? null, by: opt(rest, '--by') ?? 'claude', for: opt(rest, '--for') ?? '', minor: rest.includes('--minor') });
    if (rest.includes('--json')) console.log(JSON.stringify({ ...claim, again }));
    else console.log(`${e.name} ${claim.version}${again ? ' (claimed already for this branch)' : ''}: yours. Set it in ${e.versionFiles.join(', ')}.`);
    break;
  }
  case 'release-version': {
    const ctx = await context({ glance: false, team: false });
    const e = rest[0] ? (employeeFor(ctx.settings, rest[0]) ?? anyRepo(rest[0])) : null;
    if (!e || !/^\d+\.\d+\.\d+$/.test(rest[1] ?? '')) {
      console.error('release-version takes an employee and a version: release-version porter 0.4.12');
      process.exitCode = 2;
      break;
    }
    console.log((await releaseClaim(e.repo, rest[1])) ? `${e.name} ${rest[1]} is free again.` : `${e.name} ${rest[1]} wasn't claimed.`);
    break;
  }
  case 'claims': {
    const all = loadClaims();
    if (rest.includes('--json')) console.log(JSON.stringify(all, null, 2));
    else if (!all.length) console.log('No versions are claimed.');
    else for (const c of all) console.log(`${c.repo} ${c.version}: ${c.by}${c.for ? `, for ${c.for}` : ''}${c.branch ? ` (${c.branch})` : ''}, since ${c.at}${c.source === 'exchequer' ? ', for every PC of the licence' : ''}`);
    break;
  }
  case 'mine': {
    const ctx = await context({ glance: false, team: false });
    const e = rest[0] ? employeeFor(ctx.settings, rest[0]) : null;
    if (!e || rest.length < 2) {
      console.error(`mine takes an employee and what you did by hand: mine porter v0.5.14, or mine porter #65${e || !rest[0] ? '' : ` (no employee ${rest[0]})`}`);
      process.exitCode = 2;
      break;
    }
    for (const ref of rest.slice(1)) {
      const r = markMine(e, ref);
      if ('error' in r) {
        console.error(r.error);
        process.exitCode = 2;
      } else console.log(`${e.name} ${ref}: yours, never counted as someone else's.`);
    }
    break;
  }
  case 'allow-update': {
    const v = rest[0] ?? '';
    if (!/^\d+\.\d+\.\d+$/.test(v) || rest.length > 1) {
      console.error('allow-update takes one version: allow-update 0.8.14');
      process.exitCode = 2;
    } else if (allowUpdate(v)) console.log(`${APP.name} ${v} may be installed again: Manor's next update installs it, behind the same fail-safe.`);
    else console.log(`${APP.name} ${v} isn't flagged: nothing to allow.`);
    break;
  }
  default:
    console.log(USAGE);
    process.exitCode = cmd && cmd !== 'help' ? 2 : 0;
}
