import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP } from './app.ts';
import type { Condition, FailedRollout, Held } from './alarms.ts';
import { CONFLICTS, loadConflicts, type ConflictLook } from './conflicts.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import { redact, trimmed } from './redact.ts';
import type { Runner } from './run.ts';
import type { Employee, Settings } from './settings.ts';
import { checksLogOf, trialDirOf } from './stages/bump.ts';
import { latestTrial, standingFailures, trialFails } from './stages/trial.ts';
import { bumpBranch, bumpDirOf, checkoutOf, releaseDirOf, type StageResult } from './stages/common.ts';
import { showFile } from './git.ts';
import { compareVersions } from './kitfiles.ts';
import { readPin } from './stages/staff.ts';
import { hostFor } from './hosts/index.ts';

/**
 * Work for the Wright: what fails in a round that someone working in the employee's repository can fix, filed as an
 * issue in the manor's work queue (the Wright's), so the team does it and the person isn't asked. Its alarm then
 * waits while the Wright works on it.
 *
 * - **What counts as work** (code's choice, never a model's): an employee's bump to a new kit that failed its checks
 *   (rollout-failed.json, a bump's; a push GitHub refused isn't code), an employee's release that failed at a commit
 *   (round-failed.json), and one of Reeve's alerts that is code work in an employee's repository: a new high or
 *   critical security advisory (his dependency-health job), a Maestro flow that failed (maestro-runs). Reeve's other
 *   alerts (the NPU driver, the test phone, a job that crashed) are a person's, and stay alarms. So do the Steward's
 *   own releases: its repository isn't one the Wright works in. And a PR's conflict with its branch that its author was
 *   told about and left an hour (Settings: alarms.blockingHours) at the same head (conflictItem): the PR is told once
 *   that the Wright has it, and the issue closes by itself once the PR merges, closes, or no longer conflicts. And an
 *   agent one of the Steward's own kit PRs waits for, its trial done and failing it (kitTrialItem): the work is the
 *   agent's PR that pins the kit and passes with it, which lets the kit merge (stages/trial.ts's pairUp). Before Steward
 *   0.35.71 that waited for the kit PR's author, and Steward#214 held the whole Steward queue for it.
 * - **Where:** only an employee's repository (never one of the PC's other projects the Wright helps with), and only one
 *   the Wright's GET /api/work says it works in (`label`, `repos`), while it takes work,
 *   and only when gh here is signed in as one of its `team` (it takes no one else's issues), as the Surveyor and the
 *   Aletaster file.
 * - **How much:** each once, by a hidden marker in its body (<!-- steward:work:<id> -->, the id per employee, kind and
 *   kit version or commit), so an issue already open is never filed twice; at most PER_DAY a day, a kit's failed bumps
 *   counting as one (slotOf). A newer kit's failed bump takes over the employee's open bump issue for an older kit,
 *   closing any others, rather than filing one more (supersede).
 * - **The alarm:** held back for the alarms' while for a PR (waitingHours, a day) from when it was filed: by then the
 *   Wright's draft has been reviewed, merged and released, or bumped again, and the failure is gone. Raised at once
 *   when the Wright gets stuck on the issue (wright:stuck), its PR for it waits for a person (wright:needs-you), the
 *   Wright no longer works in that repository, or it couldn't be filed (the Wright's page not set, no queue for that
 *   repository, today's issues all filed, gh refusing): then it is an alarm as before, saying why.
 *
 * A bump issue whose failure is gone (the employee's branch pins that kit or a newer one now) is closed by itself
 * (closeResolved), rather than left for the Wright to find nothing to fix and get stuck on.
 *
 * Kept in work-filed.json: each issue filed, by its id, with when; the Settings switch is fileWork.
 */

export const PER_DAY = 3;

/**
 * What an issue counts as against the day's few: each its own, but a kit's failed bumps one between them. They are one
 * change's (the kit's), usually with one cause, so the bumps a kit breaks are all filed the day it breaks them, rather
 * than three a day while the rest are alarms.
 */
export function slotOf(id: string): string {
  const m = /^(bump|kittrial):[^:]+:(.+)$/.exec(id);
  return m ? `${m[1]}:${m[2]}` : id;
}
export const workFiledFile = () => dataFile('work-filed.json');

export interface WorkItem {
  /** The marker's id: bump:<employee>:<kit>, release:<employee>:<commit>, reeve:<alert id>:<repo>, conflict:<repo>#<pr>:<head>. */
  id: string;
  /** The alarm's condition it holds back. */
  condition: string;
  repo: string;
  title: string;
  body: string;
  /** A PR the work is about, told once, when the issue is filed, that the Wright has it (the issue's URL given). */
  pr?: { number: number; comment: (url: string) => string };
}

/** work-filed.json's entry: an issue filed for a work item (or found open with its marker: `adopted`). */
export interface FiledWork {
  url: string;
  number: number;
  repo: string;
  at: string;
  condition: string;
  adopted?: boolean;
}

/** Where one work item is: filed and in the Wright's hands, stuck or waiting for a person there, or not filed, and why. */
export type WorkState = { state: 'filed'; url: string; at: string } | { state: 'stuck'; url: string; at: string } | { state: 'needs-you'; url: string; at: string; pr: string } | { state: 'not-filed'; why: string };

export const marker = (id: string) => `<!-- steward:work:${id} -->`;

const fence = (text: string) => ['```text', text.replace(/```/g, "'''"), '```'];
const footer = (id: string) => ['', `_Filed by the ${APP.name} ${APP.version} for the manor's work queue. Its alarm waits while this is worked on; it is raised if the work gets stuck, or nothing has landed in a day._`, '', marker(id)];

/** The end of a failed step's output kept beside a worktree (<worktree>.log), or null when there is none. */
function outputBeside(dir: string): string | null {
  const file = checksLogOf(dir);
  try {
    return existsSync(file) ? trimmed(readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

/** A release command as a person tries it without publishing: `npm run release -- --publish` is `npm run release`. */
export const withoutPublish = (line: string) => line.replace(/\s+-{1,2}publish\b/i, '').replace(/\s+--\s*$/, '').trim();

/** A failed bump to a kit, as an issue in the employee's repository. */
export function bumpItem(e: Employee, f: FailedRollout, settings: Settings): WorkItem {
  const id = `bump:${e.id}:${f.kit}`;
  const branch = bumpBranch(f.kit);
  const output = outputBeside(bumpDirOf(settings, e));
  const tests = e.test.join(' && ') || '(Settings give it no checks)';
  return {
    id,
    condition: `rollout:${e.id}:${f.kit}`,
    repo: e.repo,
    title: `${e.name}'s bump to kit ${f.kit} fails its checks`,
    body: [
      `${e.name}'s bump to the Steward's kit ${f.kit} failed its checks in the Steward's round, so the new kit waits for it.`,
      '',
      '**What failed**',
      '',
      `The Steward bumps each employee to a new kit release by itself: a fresh worktree of origin/${e.branch} at ${f.head.slice(0, 7)}, on the branch \`${branch}\`, with kit.json pinned to ${f.kit}, tools/kit.ts the Steward's, and the patch version raised; then its kit filled (\`${e.fill}\`) and its checks run (\`${tests}\`), and run again when they fail. They failed both times:`,
      '',
      `> ${redact(f.message)}`,
      '',
      ...(output ? ['**What it printed** (the end of it, secrets taken out)', '', ...fence(output)] : ["Its whole output wasn't kept here: the next bump's will be."]),
      '',
      `**Where the fix goes:** ${e.branch}, in a pull request of its own. \`${branch}\` was never pushed: the Steward makes it afresh from ${e.branch} once a new commit lands there, so a fix on ${e.branch} is what lets its next bump pass. Make ${e.name} work with kit ${f.kit} without moving kit.json's pin or changing tools/kit.ts (the bump does both). To see the failure as the Steward did: set kit.json's "kit" to "${f.kit}", run \`${e.fill}\` and then \`${tests}\`; put kit.json back before you commit.`,
      '',
      `**Done means:** with your fix on ${e.branch}, the Steward's next bump to kit ${f.kit} passes its checks (its rounds try again once ${e.branch} moves), and its PR merges.`,
      ...footer(id),
    ].join('\n'),
  };
}

/** A failed release at a commit, as an issue in the employee's repository. `said`: the round's message, when this round failed it. */
export function releaseItem(e: Employee, commit: string, settings: Settings, said?: string): WorkItem {
  const id = `release:${e.id}:${commit}`;
  const output = outputBeside(releaseDirOf(settings, e));
  const tryIt = withoutPublish(e.release);
  return {
    id,
    condition: `release:${e.id}:${commit}`,
    repo: e.repo,
    title: `${e.name}'s release at ${commit} fails`,
    body: [
      `${e.name}'s release from ${e.branch} at ${commit} failed in the Steward's round, and its rounds won't try that commit again.`,
      '',
      '**What failed**',
      '',
      `The Steward releases each employee's new version from its branch by itself: a fresh worktree of origin/${e.branch} at ${commit}, its packages installed when its release builds (\`npm ci\`), then \`${e.release}\`. It failed${said ? ':' : '.'}`,
      ...(said ? ['', `> ${redact(said)}`] : []),
      '',
      ...(output ? ['**What it printed** (the end of it, secrets taken out)', '', ...fence(output)] : ["Its output wasn't kept here; the Steward's stages.log has the round's lines."]),
      '',
      `**Where the fix goes:** ${e.branch}, in a pull request of its own. A release is only ever made from ${e.branch}, and the Steward's rounds release the next commit that lands there.`,
      '',
      `**Done means:** \`${tryIt}\` (without publishing, which only the Steward's round does) builds the release in a clean worktree of ${e.branch} with your fix, and the Steward's next round releases it.`,
      ...footer(id),
    ].join('\n'),
  };
}

/** Reeve's jobs whose alerts are code work in a repository, and how to tell their findings from a job that crashed. */
const REEVE_WORK: Record<string, { finding: RegExp; what: string; done: string }> = {
  'dependency-health': {
    finding: /new high\/critical security alert/i,
    what: 'a new high or critical security advisory for one of its packages',
    done: "the advisory no longer applies on main: the package upgraded to a fixed version (or its vulnerable use removed), with the tests passing; Reeve's next dependency-health run no longer lists it",
  },
  'maestro-runs': {
    finding: /Maestro FAILED/i,
    what: 'a Maestro UI flow that failed',
    done: 'the flow passes again on a build from main, with the tests passing; Reeve\'s maestro-runs job reports it passed',
  },
};

/** The employees an alert's own words name: by their repository's name or their id, as whole words, case aside. */
function named(text: string, employees: Employee[]): Employee[] {
  const lower = text.toLowerCase();
  const word = (w: string) => new RegExp(`(^|[^a-z0-9-])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9-])`).test(lower);
  return employees.filter((e) => word(e.repo.split('/')[1] ?? e.id) || word(e.id));
}

/**
 * Reeve's alerts that are code work (REEVE_WORK), each as an issue in every employee's repository its words name. One
 * that names none (a Maestro flow of another project's) is no work here: its alarm stands.
 */
export function reeveItems(answer: unknown, employees: Employee[]): WorkItem[] {
  const alerts = (answer as any)?.alerts;
  if (!Array.isArray(alerts)) return [];
  const out: WorkItem[] = [];
  for (const a of alerts) {
    if (!a || typeof a.id !== 'string' || !a.id || typeof a.job !== 'string' || typeof a.title !== 'string') continue;
    const kind = REEVE_WORK[a.job];
    if (!kind) continue;
    const detail: string[] = Array.isArray(a.detail) ? a.detail.map(String) : [];
    // Its summary, less "Reeve's <job> job: ", and the lines that are its findings: never his name, nor a log's path.
    const summary = a.title.replace(/^Reeve's \S+ job: /, '');
    const findings = [summary, ...detail].filter((l) => kind.finding.test(l));
    if (!findings.length) continue;
    for (const e of named(findings.join('\n'), employees)) {
      const id = `reeve:${a.id}:${e.repo}`;
      out.push({
        id,
        condition: `reeve:${a.id}`,
        repo: e.repo,
        title: `${e.name}: ${summary}`.slice(0, 200),
        body: [
          `Reeve's ${a.job} job found ${kind.what} in ${e.name}.`,
          '',
          '**What Reeve says** (secrets taken out)',
          '',
          ...fence(trimmed([summary, ...detail].join('\n'), 40, 4000)),
          '',
          ...(typeof a.url === 'string' ? [`Its job on Reeve's page: ${a.url}`, ''] : []),
          `**Where the fix goes:** ${e.repo}'s own branch, in a pull request of its own.`,
          '',
          `**Done means:** ${kind.done}.`,
          ...footer(id),
        ].join('\n'),
      });
    }
  }
  return out;
}

/**
 * A PR's conflict with its branch, which its author was told about (stages/kickback.ts) and left, as an issue for the
 * Wright. The Wright's jobs start from the branch on a wright/ branch of their own, never on someone else's: so the work
 * is the PR's branch merged into the job's branch, the conflict resolved there, as a merge commit. Once the Wright's draft
 * merges, the PR's own commits are on the branch, and GitHub marks the PR merged too. Should its author resolve it first,
 * the issue is closed (closeResolved), and a job that starts anyway finds nothing left to do.
 */
export function conflictItem(e: Employee, look: ConflictLook): WorkItem {
  const id = `conflict:${e.repo}#${look.number}:${look.headOid.slice(0, 7)}`;
  const files = look.needs.map((f) => `\`${f}\``).join(', ');
  return {
    id,
    condition: `waiting:${e.repo}#${look.number}`,
    repo: e.repo,
    title: `Resolve #${look.number}'s conflict with ${e.branch} (${look.needs.join(', ')})`.slice(0, 200),
    body: [
      `#${look.number} (${look.title}, on \`${look.head}\`) conflicts with \`${e.branch}\` in ${files}, beyond what the Steward resolves by itself (version lines, and a new entry at the top of CHANGELOG.md). Its author was told on the PR, and nothing has been pushed to it since, so it waits; meanwhile the PRs above it in the version queue merge without it.`,
      '',
      '**The work**',
      '',
      `Your branch starts from \`${e.branch}\`. Merge \`origin/${look.head}\` into it (\`git fetch origin ${look.head}\`, then \`git merge --no-ff origin/${look.head}\`), resolve the conflicts in ${files} so that both sides keep what they meant, and run the tests. Keep it a merge commit: never squash or rebase #${look.number}'s commits, so they land with yours. Its version lines and changelog entry give way to your own version.`,
      '',
      `**Done means:** your draft carries #${look.number}'s change on top of \`${e.branch}\` as it is now, with no conflicts and the tests passing. Once it merges, #${look.number}'s commits are on \`${e.branch}\`, and GitHub marks it merged too. If #${look.number} no longer conflicts when you start (its author resolved it), there is nothing left to do: say so.`,
      ...footer(id),
    ].join('\n'),
    pr: { number: look.number, comment: (url) => `Still conflicting with \`${e.branch}\` in ${files}, so the Steward handed it to the Wright: ${url}. Its draft will carry this PR's commits with the conflict resolved; pushing a resolution here first is just as good (the issue then closes by itself).` },
  };
}

/**
 * The conflicts to hand to the Wright this round: each PR the merge stage held for a conflict (`held`) whose last look
 * (conflicts.ts) sent it back to its author `hours` or more ago at the head it has now, and found files that need
 * judgement. Never one of the Wright's own (those are closed and queued again: kickback.ts), nor a draft.
 */
export function conflictItems(o: { held: { employee: Employee; prs: Held[] }[]; hours: number; now: Date; looks?: ConflictLook[] }): WorkItem[] {
  const looks = o.looks ?? loadConflicts(o.now.getTime());
  const out: WorkItem[] = [];
  for (const { employee: e, prs } of o.held) {
    for (const pr of prs) {
      if (pr.draft || !pr.why.startsWith(CONFLICTS)) continue;
      const look = looks.find((l) => l.repo.toLowerCase() === e.repo.toLowerCase() && l.number === pr.number);
      if (!look || look.outcome !== 'sent-back' || !look.needs.length || !look.headOid || look.head.startsWith('wright/')) continue;
      if (o.now.getTime() - Date.parse(look.at) < o.hours * 3_600_000) continue;
      out.push(conflictItem(e, look));
    }
  }
  return out;
}

/**
 * An agent a new kit fails, as an issue in the agent's repository: the Steward's PR that raises the kit (`steward`'s
 * #number) waits for it in its trial (stages/trial.ts). The work is the agent's PR that pins the kit and passes with it:
 * once it is ready, the trial tries it at its head (pairUp), the kit merges and is released, and that PR merges after
 * it. The kit itself being at fault is the Wright's to say on the issue, not to fix: the kit is the Steward's repository.
 */
export function kitTrialItem(e: Employee, f: { message: string; main?: string | null }, kit: string, steward: Employee, pr: { number: number; url: string; title: string }, settings: Settings): WorkItem {
  const id = `kittrial:${e.id}:${kit}`;
  const output = outputBeside(trialDirOf(settings, e));
  const tests = e.test.join(' && ') || '(Settings give it no checks)';
  return {
    id,
    condition: `waiting:${steward.repo}#${pr.number}`,
    repo: e.repo,
    title: `Make ${e.name} pass with kit ${kit} (the ${APP.name}'s #${pr.number} waits for it)`.slice(0, 200),
    body: [
      `The ${APP.name}'s ${pr.url} (${pr.title}) raises its kit to ${kit}. Before it merges, the ${APP.name} tries the new kit on every agent, and ${e.name}'s checks fail with it, so that PR waits, and every ${APP.name} PR above it in the version queue with it.`,
      '',
      '**What failed**',
      '',
      `${e.name}'s ${e.branch}${f.main ? ` at ${f.main.slice(0, 7)}` : ''}, with kit.json pinned to ${kit} and its kit filled from that PR's kit\\ (\`${e.fill}\`), then its checks (\`${tests}\`), twice:`,
      '',
      `> ${redact(f.message)}`,
      '',
      ...(output ? ['**What it printed** (the end of it, secrets taken out)', '', ...fence(output)] : ["Its whole output wasn't kept here."]),
      '',
      `**The work:** a pull request to ${e.name}'s ${e.branch} that pins kit ${kit} in kit.json and passes its checks with it. Kit ${kit} isn't released yet, so fill it from the PR: in a clone of ${steward.repo}, \`git fetch origin pull/${pr.number}/head\` and \`git worktree add <folder> FETCH_HEAD\`; then here \`node tools/kit.ts --from <folder>\\kit\`. Change ${e.name} so its checks pass with the new kit, as the kit's changelog entry for ${kit} (kit\\CHANGELOG.md there) says the agents must.`,
      '',
      `**If the kit is at fault** (it breaks what it shouldn't, and no change here is right): make no change, and say so on this issue with what you found. The kit is fixed in its own PR, by its author.`,
      '',
      `**Done means:** your PR is ready (not a draft) and passes with kit ${kit}. The ${APP.name}'s next round tries it at its head with that PR's kit; passing, the kit merges and is released, and your PR is tested with the released kit and merged after it. Should ${e.branch} pass with kit ${kit} as it is by the time you start (another fix landed), there is nothing to do: say so.`,
      ...footer(id),
    ].join('\n'),
  };
}

/**
 * The agents each of the Steward's own kit PRs waits for, as the merge stage held them (trialFails): the standing
 * failures of its latest trial, done (kit-trials.json), each one's work in its own repository. Not a draft's.
 */
export function kitTrialItems(o: { held: { employee: Employee; prs: Held[] }[]; employees: Employee[]; settings: Settings; trials?: Parameters<typeof latestTrial>[2] }): WorkItem[] {
  const out: WorkItem[] = [];
  for (const { employee: steward, prs } of o.held) {
    if (steward.id !== APP.id) continue;
    for (const pr of prs) {
      const kit = pr.draft ? null : trialFails(pr.why);
      const t = kit ? latestTrial(pr.number, kit, o.trials) : null;
      if (!kit || !t || t.pending?.length) continue;
      for (const f of standingFailures(t)) {
        const e = o.employees.find((x) => x.id === f.id);
        if (e && e.id !== APP.id) out.push(kitTrialItem(e, f, kit, steward, pr, o.settings));
      }
    }
  }
  return out;
}

/** This round's work: its failed bumps (while rollout is on) and releases, Reeve's alerts that are code work, conflicts left a while (conflictItems), and the agents a kit PR's trial waits for (kitTrialItems). Not the Steward's own. */
export function workItems(o: { failedReleases: Record<string, string>; failedRollouts?: Record<string, FailedRollout>; reeve?: unknown; round?: StageResult; employees: Employee[]; settings: Settings; held?: { employee: Employee; prs: Held[] }[]; now?: Date }): WorkItem[] {
  const out: WorkItem[] = [];
  if (o.settings.rollout) {
    for (const [id, f] of Object.entries(o.failedRollouts ?? {})) {
      const e = o.employees.find((x) => x.id === id);
      if (e && f.stage === 'bump') out.push(bumpItem(e, f, o.settings));
    }
  }
  for (const [id, commit] of Object.entries(o.failedReleases)) {
    const e = o.employees.find((x) => x.id === id);
    if (!e) continue;
    const said = o.round?.results.find((r) => r.id === id && r.outcome === 'failed' && r.message.startsWith('release: '))?.message.slice('release: '.length);
    out.push(releaseItem(e, commit, o.settings, said));
  }
  if (o.reeve) out.push(...reeveItems(o.reeve, o.employees));
  if (o.held?.length) out.push(...conflictItems({ held: o.held, hours: o.settings.alarms.blockingHours, now: o.now ?? new Date() }));
  if (o.held?.length) out.push(...kitTrialItems({ held: o.held, employees: o.employees, settings: o.settings }));
  return out;
}

/** Why nothing goes to the Wright when its page isn't read: it isn't on this PC (or Settings name no page for it). */
export const NO_WRIGHT = "the Wright isn't on this PC, so it waits for a person (hire the Wright in Manor to hand such work to it)";

/** The Wright's queue as its GET /api/work says, or why work can't go to it. */
export function readQueue(work: unknown): { label: string; repos: string[]; team: string[] } | { why: string } {
  if (work === null || work === undefined) return { why: NO_WRIGHT };
  const w = work as any;
  if (typeof w !== 'object' || Array.isArray(w)) return { why: "the Wright's page doesn't answer" };
  if (Object.keys(w).length === 1 && 'error' in w) return { why: `the Wright's page doesn't answer (${String(w.error)})` };
  if (w.takesWork === false) return { why: 'the Wright takes no work now (its "Takes work" is off)' };
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
  const repos = strings(w.repos);
  const team = strings(w.team);
  if (typeof w.label !== 'string' || !w.label.trim() || !repos || !team) return { why: "the Wright's page doesn't say where work goes (a Wright before 0.1.5)" };
  return { label: w.label.trim(), repos, team };
}

/** Whether the Wright got stuck on an issue, or its PR for it waits for a person, from its /api/work. */
export function wrightSays(work: unknown, f: FiledWork): { state: 'stuck' } | { state: 'needs-you'; pr: string } | null {
  const w = work as any;
  const same = (repo: unknown) => typeof repo === 'string' && repo.toLowerCase() === f.repo.toLowerCase();
  const needs: any[] = Array.isArray(w?.needsYou) ? w.needsYou : [];
  if (needs.some((n) => n?.kind === 'stuck' && same(n.repo) && n.number === f.number)) return { state: 'stuck' };
  const review = new Set(needs.filter((n) => n?.kind === 'review' && same(n.repo) && typeof n.url === 'string').map((n) => n.url));
  const job = (Array.isArray(w?.recent) ? w.recent : []).find((j: any) => same(j?.repo) && j.issue === f.number && typeof j.pr === 'string' && review.has(j.pr));
  return job ? { state: 'needs-you', pr: job.pr } : null;
}

const localDay = (t: number) => new Date(t).toDateString();
const lastLine = (r: { out: string; err: string }) => (r.err || r.out).trim().split('\n').pop() ?? '';

/** Whether gh refused to file an issue because the repository has no such label: "could not add label: 'manor:work' not found". */
const labelMissing = (r: { out: string; err: string }, label: string) => {
  const text = `${r.err}\n${r.out}`;
  return /could not add label/i.test(text) && text.includes(`'${label}' not found`);
};

/** The Wright's queue label made in a repository that hasn't it, as the others have it; one there already is as good. */
async function createLabel(o: { run: Runner; cwd: string; log: (line: string) => void }, repo: string, label: string): Promise<boolean> {
  const r = await hostFor({ run: o.run, neutralDir: o.cwd }).createLabel(repo, label, { color: '1d76db', description: 'Queued for the Wright' });
  if (r.code === 0) {
    o.log(`work: created the ${label} label in ${repo}, which hadn't it`);
    return true;
  }
  if (/already exists/i.test(`${r.err}\n${r.out}`)) return true;
  o.log(`work: couldn't create the ${label} label in ${repo}: ${redact(lastLine(r))}`);
  return false;
}

/** `bump:<employee>:`, the start of every bump item's id for that employee, or null for any other item. */
export const bumpPrefixOf = (id: string) => /^(bump:[^:]+:)/.exec(id)?.[1] ?? null;

/**
 * A newer kit's failed bump, where an older kit's bump issue for the same employee is still open: the same agent
 * failing its checks, which one fix on its branch makes pass for both. The newest such issue becomes this one (its
 * title and body this kit's, its marker too), and any others close as superseded, rather than an issue for each kit
 * while the Wright hasn't got to the first. Its URL when it was taken over; null when there's none, or gh refused (a new
 * issue is filed then, as before). Not a new issue, so it counts for no day.
 */
async function supersede(o: { run: Runner; cwd: string; log: (line: string) => void }, item: WorkItem, list: { number: number; url: string; body: string }[], filed: Record<string, FiledWork>, at: string): Promise<string | null> {
  const prefix = bumpPrefixOf(item.id);
  if (!prefix) return null;
  const older = list.filter((i) => String(i.body ?? '').includes(`<!-- steward:work:${prefix}`)).sort((a, b) => b.number - a.number);
  if (!older.length) return null;
  const [keep, ...rest] = older;
  const kit = item.id.slice(prefix.length);
  const host = hostFor({ run: o.run, neutralDir: o.cwd });
  const r = await host.editIssue(item.repo, keep.number, { title: item.title, body: item.body });
  if (r.code !== 0) {
    o.log(`work: couldn't make ${keep.url} the bump to kit ${kit}: ${redact(lastLine(r))}`);
    return null;
  }
  const closed: number[] = [];
  for (const x of rest) {
    const c = await host.closeIssue(item.repo, x.number, { reason: 'not planned', comment: `Superseded by #${keep.number}, now the bump to kit ${kit}: one fix on the branch makes both pass.` });
    if (c.code === 0) closed.push(x.number);
    else o.log(`work: couldn't close ${x.url} as superseded: ${redact(lastLine(c))}`);
  }
  const numbers = new Set([keep.number, ...closed]);
  for (const [id, f] of Object.entries(filed)) if (id.startsWith(prefix) && f.repo.toLowerCase() === item.repo.toLowerCase() && numbers.has(f.number)) delete filed[id];
  filed[item.id] = { url: keep.url, number: keep.number, repo: item.repo, at, condition: item.condition, adopted: true };
  o.log(`work: ${keep.url} is now the bump to kit ${kit}${closed.length ? `; ${closed.map((n) => `#${n}`).join(', ')} closed as superseded` : ''}`);
  return keep.url;
}

/**
 * One round's filing: each item already filed looked up in the Wright's work, each new one filed where the Wright works,
 * as the module's comment says, or an older kit's open bump issue taken over (supersede). What each item's state is
 * comes back by its id; work-filed.json is kept.
 */
export async function fileWork(o: { items: WorkItem[]; work: unknown; employees: Employee[]; run: Runner; cwd: string; now: Date; log: (line: string) => void; perDay?: number }): Promise<Map<string, WorkState>> {
  const filed = readJson<Record<string, FiledWork>>(workFiledFile(), {});
  const before = JSON.stringify(filed);
  const states = new Map<string, WorkState>();
  const q = readQueue(o.work);
  const takes = 'why' in q ? null : new Set(q.repos.map((r) => r.toLowerCase()));
  const perDay = o.perDay ?? PER_DAY;
  const at = o.now.toISOString();
  const today = new Set(Object.entries(filed).filter(([, f]) => !f.adopted && localDay(Date.parse(f.at)) === localDay(o.now.getTime())).map(([id]) => slotOf(id)));
  const host = hostFor({ run: o.run, neutralDir: o.cwd });
  let login: string | null | undefined;
  const open = new Map<string, { number: number; url: string; body: string }[] | null>();

  for (const item of o.items) {
    const f = filed[item.id];
    if (f) {
      // A Wright that no longer works there, or is gone from this PC, leaves it to a person; one that doesn't answer is the Wright's own alarm.
      if (o.work === null || o.work === undefined) states.set(item.id, { state: 'not-filed', why: `${NO_WRIGHT}; ${f.url} was filed` });
      else if (takes && !takes.has(f.repo.toLowerCase())) states.set(item.id, { state: 'not-filed', why: `the Wright no longer works in ${f.repo} (${f.url} was filed)` });
      else {
        const says = wrightSays(o.work, f);
        states.set(item.id, says ? { ...says, url: f.url, at: f.at } : { state: 'filed', url: f.url, at: f.at });
      }
      continue;
    }
    if ('why' in q) {
      states.set(item.id, { state: 'not-filed', why: q.why });
      continue;
    }
    // Never a repository the Wright works in that isn't the Steward's employee's (a project of this PC's own): the Steward doesn't act on those.
    if (!o.employees.some((e) => e.repo.toLowerCase() === item.repo.toLowerCase())) {
      states.set(item.id, { state: 'not-filed', why: `${item.repo} isn't one of the Steward's employees` });
      continue;
    }
    if (!takes!.has(item.repo.toLowerCase())) {
      states.set(item.id, { state: 'not-filed', why: `the Wright doesn't work in ${item.repo}` });
      continue;
    }
    if (login === undefined) {
      const r = await host.whoAmI();
      login = r.code === 0 ? r.out.trim() || null : null;
      if (!login) o.log(`work: gh couldn't say who it's signed in as (${redact(lastLine(r))})`);
    }
    if (!login || !q.team.some((t) => t.toLowerCase() === login!.toLowerCase())) {
      states.set(item.id, { state: 'not-filed', why: login ? `the Wright takes issues only from its team (${q.team.join(', ') || 'nobody'}), and gh is signed in as ${login}` : "gh couldn't say who it's signed in as" });
      continue;
    }
    if (!open.has(item.repo)) {
      const r = await host.listIssues(item.repo, { label: q.label, state: 'open', limit: 100, fields: 'number,url,body' });
      let list: { number: number; url: string; body: string }[] | null = null;
      try {
        list = r.code === 0 ? JSON.parse(r.out || '[]') : null;
      } catch {
        list = null;
      }
      if (!list) o.log(`work: couldn't list ${item.repo}'s open work: ${redact(lastLine(r))}`);
      open.set(item.repo, list);
    }
    const list = open.get(item.repo);
    if (!list) {
      states.set(item.id, { state: 'not-filed', why: `gh couldn't list ${item.repo}'s open issues` });
      continue;
    }
    const already = list.find((i) => String(i.body ?? '').includes(marker(item.id)));
    if (already) {
      filed[item.id] = { url: already.url, number: already.number, repo: item.repo, at, condition: item.condition, adopted: true };
      states.set(item.id, { state: 'filed', url: already.url, at });
      continue;
    }
    const taken = await supersede(o, item, list, filed, at);
    if (taken) {
      states.set(item.id, { state: 'filed', url: taken, at });
      continue;
    }
    if (!today.has(slotOf(item.id)) && today.size >= perDay) {
      states.set(item.id, { state: 'not-filed', why: `today's ${perDay} issues for the Wright are filed; this one waits for tomorrow` });
      continue;
    }
    const create = () => host.createIssue(item.repo, { title: item.title, body: item.body, label: q.label });
    let r = await create();
    // A repository new to the Wright's queue (an employee just taken on) hasn't its label yet, and gh won't file without it.
    if (r.code !== 0 && labelMissing(r, q.label) && (await createLabel(o, item.repo, q.label))) r = await create();
    const url = /https:\/\/github\.com\/\S+\/issues\/(\d+)/.exec(r.out);
    if (r.code !== 0 || !url) {
      o.log(`work: couldn't file "${item.title}" in ${item.repo}: ${redact(lastLine(r))}`);
      states.set(item.id, { state: 'not-filed', why: `gh couldn't file it in ${item.repo}` });
      continue;
    }
    filed[item.id] = { url: url[0], number: Number(url[1]), repo: item.repo, at, condition: item.condition };
    today.add(slotOf(item.id));
    o.log(`work: filed ${url[0]} for the Wright: ${item.title}`);
    // The PR it is about, told once, now: a later round finds the issue filed, and says nothing.
    if (item.pr) {
      const c = await host.commentPr(item.repo, item.pr.number, item.pr.comment(url[0]));
      if (c.code !== 0) o.log(`work: couldn't say on ${item.repo}#${item.pr.number} that ${url[0]} has it: ${redact(lastLine(c))}`);
    }
    states.set(item.id, { state: 'filed', url: url[0], at });
  }
  // An issue whose failure is gone is forgotten after a month; until then it still counts for its day.
  const current = new Set(o.items.map((i) => i.id));
  for (const [id, f] of Object.entries(filed)) if (!current.has(id) && o.now.getTime() - Date.parse(f.at) > 30 * 24 * 3_600_000) delete filed[id];
  if (JSON.stringify(filed) !== before) writeJson(workFiledFile(), filed);
  return states;
}

/**
 * Each bump issue filed whose failure is gone, closed: the employee's branch on origin now pins that kit or a newer one
 * (a later bump passed, or a fix landed and its bump merged), so there is nothing left to do. Left open, it waits in the
 * Wright's queue for the Wright to find nothing to fix, make no commit, and get stuck: an alarm for nothing. Not one
 * this round's failures still name (`items`), and only bump issues: a release's failure ends with a new commit, which
 * says nothing of the old one. And each conflict issue whose PR no longer needs it (closeConflict). Forgotten in
 * work-filed.json once closed, or found closed already.
 */
export async function closeResolved(o: { items: WorkItem[]; employees: Employee[]; run: Runner; cwd: string; log: (line: string) => void }): Promise<void> {
  const filed = readJson<Record<string, FiledWork>>(workFiledFile(), {});
  const current = new Set(o.items.map((i) => i.id));
  let changed = false;
  for (const [id, f] of Object.entries(filed)) {
    if (current.has(id)) continue;
    const pr = /^conflict:([^#]+)#(\d+):/.exec(id);
    if (pr) {
      if (await closeConflict(o, f, pr[1], Number(pr[2]))) {
        delete filed[id];
        changed = true;
      }
      continue;
    }
    const kt = /^kittrial:([^:]+):(\d+\.\d+\.\d+)$/.exec(id);
    if (kt) {
      if (await closeKitTrial(o, f, kt[1], kt[2])) {
        delete filed[id];
        changed = true;
      }
      continue;
    }
    const m = /^bump:([^:]+):(\d+\.\d+\.\d+)$/.exec(id);
    if (!m) continue;
    const e = o.employees.find((x) => x.id === m[1]);
    if (!e || !existsSync(checkoutOf(e))) continue;
    const pin = readPin(await showFile(o.run, checkoutOf(e), `origin/${e.branch}`, 'kit.json'));
    if (!pin || compareVersions(pin.kit, m[2]) < 0) continue;
    const r = await hostFor({ run: o.run, neutralDir: o.cwd }).closeIssue(f.repo, f.number, { reason: 'completed', comment: `Nothing left to do: ${e.branch} now carries kit ${pin.kit}, so ${e.name}'s bump to kit ${m[2]} has passed. Closed by the ${APP.name}.` });
    const gone = r.code === 0 || /already closed/i.test(`${r.out}\n${r.err}`);
    if (!gone) {
      o.log(`work: couldn't close ${f.url}, whose failure is gone: ${redact(lastLine(r))}`);
      continue;
    }
    delete filed[id];
    changed = true;
    if (r.code === 0) o.log(`work: closed ${f.url}: ${e.name} carries kit ${pin.kit} now`);
  }
  if (changed) writeJson(workFiledFile(), filed);
}

/**
 * A kit trial's issue whose kit PR no longer waits for the agent, closed: the kit's latest trial, done, passes the agent
 * or lets it move with its own PR (pairUp), or the kit PR merged or was closed. A trial going on (the PR caught up or
 * pushed to) is no answer: the issue stays open until it ends. True once it is closed, or found closed already.
 */
async function closeKitTrial(o: { employees: Employee[]; run: Runner; cwd: string; log: (line: string) => void }, f: FiledWork, agent: string, kit: string): Promise<boolean> {
  const c = /^waiting:([^#]+)#(\d+)$/.exec(f.condition ?? '');
  if (!c) return false;
  const n = Number(c[2]);
  const name = o.employees.find((e) => e.id === agent)?.name ?? agent;
  const host = hostFor({ run: o.run, neutralDir: o.cwd });
  const t = latestTrial(n, kit);
  let why: string | null = t && !t.pending?.length && !standingFailures(t).some((x) => x.id === agent) ? `kit ${kit}'s trial on ${c[1]}#${n} no longer waits for ${name}` : null;
  if (!why) {
    const v = await host.viewPr(c[1], n, 'state');
    if (v.code !== 0) return false;
    let state = '';
    try {
      state = String(JSON.parse(v.out).state ?? '').toUpperCase();
    } catch {
      return false;
    }
    if (state === 'OPEN') return false;
    why = `${c[1]}#${n} ${state === 'MERGED' ? 'has merged (a failing bump to the released kit is work of its own)' : 'was closed'}`;
  }
  const r = await host.closeIssue(f.repo, f.number, { reason: 'completed', comment: `Nothing left to do: ${why}. Closed by the ${APP.name}.` });
  const gone = r.code === 0 || /already closed/i.test(`${r.out}\n${r.err}`);
  if (!gone) {
    o.log(`work: couldn't close ${f.url}, whose kit trial no longer waits: ${redact(lastLine(r))}`);
    return false;
  }
  if (r.code === 0) o.log(`work: closed ${f.url}: ${why}`);
  return true;
}

/**
 * A conflict issue whose PR no longer needs it, closed: the PR merged, was closed, or merges cleanly now (its author
 * resolved it), as its host says now. True once it is closed, or found closed already; false while the PR still
 * conflicts (the Wright's draft is still to land, say), or its host couldn't be asked.
 */
async function closeConflict(o: { run: Runner; cwd: string; log: (line: string) => void }, f: FiledWork, repo: string, n: number): Promise<boolean> {
  const host = hostFor({ run: o.run, neutralDir: o.cwd });
  const v = await host.viewPr(repo, n, 'state,mergeable');
  if (v.code !== 0) return false;
  let now: { state?: unknown; mergeable?: unknown };
  try {
    now = JSON.parse(v.out);
  } catch {
    return false;
  }
  const state = String(now.state ?? '').toUpperCase();
  if (state === 'OPEN' && now.mergeable !== 'MERGEABLE') return false;
  const why = state === 'MERGED' ? 'has merged' : state === 'CLOSED' ? 'was closed' : 'no longer conflicts';
  const r = await host.closeIssue(f.repo, f.number, { reason: 'completed', comment: `Nothing left to do: #${n} ${why}. Closed by the ${APP.name}.` });
  const gone = r.code === 0 || /already closed/i.test(`${r.out}\n${r.err}`);
  if (!gone) {
    o.log(`work: couldn't close ${f.url}, whose conflict is gone: ${redact(lastLine(r))}`);
    return false;
  }
  if (r.code === 0) o.log(`work: closed ${f.url}: #${n} ${why}`);
  return true;
}

const hours = (h: number) => `${h} hour${h === 1 ? '' : 's'}`;

/**
 * The alarms' conditions, with those whose work the Wright has held back: from when it was filed, for `holdHours`; at
 * once, saying why, when the Wright is stuck on it or its PR waits for a person; and as they were, saying why, when it
 * couldn't be filed. A condition with work in several repositories waits only while all of it is filed. Pure.
 */
export function holdForWork(conditions: Condition[], items: WorkItem[], states: Map<string, WorkState>, holdHours: number): Condition[] {
  return conditions.map((c) => {
    const mine = items.filter((i) => i.condition === c.id).map((i) => states.get(i.id)).filter((s): s is WorkState => !!s);
    if (!mine.length) return c;
    const raised = mine.find((s): s is Extract<WorkState, { state: 'stuck' | 'needs-you' }> => s.state === 'stuck' || s.state === 'needs-you');
    if (raised) {
      const line = raised.state === 'stuck' ? `The Wright got stuck on ${raised.url}: its comment there says why. Remove the wright:stuck label to have it tried again.` : `The Wright's fix for ${raised.url}, ${raised.pr}, waits for your review.`;
      return { ...c, detail: [line, ...c.detail], url: raised.state === 'needs-you' ? raised.pr : raised.url, since: undefined, afterMs: 0 };
    }
    const waiting = mine.filter((s): s is Extract<WorkState, { state: 'not-filed' }> => s.state === 'not-filed');
    if (waiting.length) return { ...c, detail: [...c.detail, `Not handed to the Wright: ${[...new Set(waiting.map((s) => s.why))].join('; ')}.`] };
    const filed = mine as Extract<WorkState, { state: 'filed' }>[];
    const since = filed.map((s) => s.at).sort().at(-1)!;
    return {
      ...c,
      detail: [`Handed to the Wright: ${filed.map((s) => s.url).join(', ')}. An alarm only if it gets stuck there, its PR waits for your review, or nothing has landed ${hours(holdHours)} after it was filed.`, ...c.detail],
      url: filed[0].url,
      since,
      afterMs: holdHours * 3_600_000,
    };
  });
}
