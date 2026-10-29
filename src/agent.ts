import { readFileSync } from 'node:fs';
import { dismiss, getJson, loadAlarms, type GetJson } from './alarms.ts';
import { APP, dataDir, port } from './app.ts';
import { duty } from './kit/duty.ts';
import { LockTimeout } from './kit/lock.ts';
import { hasTour, pageShell, reactPage } from './kit/react-page.ts';
import { every } from './kit/schedule.ts';
import { updateHold } from './kit/update-hold.ts';
import { serve, type Handler } from './kit/server.ts';
import { currentWork, inWork, startWork, workTasks } from './kit/work-tasks.ts';
import { afterWords } from './after.ts';
import { gate, loadBudget } from './budget.ts';
import { run as realRun, type Runner } from './run.ts';
import { teamOf, type Owner } from './team.ts';
import { agentPages, loadSettings, SETTINGS_SPEC } from './settings.ts';
import type { Staff, StaffRow } from './stages/staff.ts';
import { approveJobsNow, context, loadLastStage, loadStaff, refreshStaff, reposHere, runStage, type StageAsk } from './steward.ts';
import { loadTending } from './tend.ts';
import type { StaffView, StewardView } from './web/types.ts';
import { allowUpdate } from './safeinstall.ts';
import { loadClaims } from './claims.ts';
import { testedView } from './tested.ts';
import { findRepos, foundStale, foundView, loadFound, lookAfterAll } from './found.ts';
import { handOver, turnsView, type TurnsDeps } from './lease.ts';
import { claimClashes } from './claims.ts';
import { passedLines, passedWords } from './passover.ts';
import { stewardEmployee } from './stages/selfmerge.ts';
import { rolloutsBeside } from './stages/rollout.ts';
import { buildTimeLine } from './buildtimes.ts';
import { endWholeOrphans, endWholeSuite, loadWholeJob, wholeSuitesBeside } from './stages/wholesuite.ts';
import { githubReady, hostOf, loadScm, type Host } from './scm.ts';
import { DEVELOPER_ONLY, PLAIN_ROLE, stewardActs } from './maker.ts';
import { noteFreshStart, watchWake } from './fresh-start.ts';
import { buildUnderWay, lateLine, loadPipeline, pipelineView } from './pipeline.ts';
import { holdForBuilds } from './build-hold.ts';
import { wakesPc } from './kit/wake.ts';
import { saverSleepLine, saverSleeps, type SaverSleeps } from './kit/sleep-cause.ts';
import { keepHeads } from './heads.ts';
import { withLane } from './stages/seneschal.ts';
import { workForOthers } from './stages/others.ts';
import { askAgain } from './stages/exchequer.ts';

/** Whether the GitHub CLI is signed in here, as the last look said (scm.ts); undefined before any look. */
const githubReadyHere = (): boolean | undefined => {
  const look = loadScm();
  return look ? githubReady(look) : undefined;
};

/**
 * The Steward at work on its page: the staff's table, and a button for each stage. Stages run in this process, as
 * many at once as Settings' stagesAtOnce allows (counting those run from a terminal: the stages' slots), each on a
 * repository only while no other is (stages/slots.ts), one round at a time; the page refreshes itself while they run.
 *
 * Its duty (start and stop, from Manor) works as every agent's does. Its round (stages/round.ts) comes every
 * few minutes while it's on duty, through the kit's every() in schedule.ts: while Settings say it merges and releases
 * by itself, every ready PR of its own and the team's merged, with what each asks for after, and every version not yet
 * released released; and while they say it keeps the staff's pages up, every agent on duty whose page doesn't answer
 * opened again through Manor (tend.ts). With no repositories here, that is the whole round. Run now does one round,
 * on duty or not.
 */

const ICON = readFileSync(new URL('../art/icon.svg', import.meta.url), 'utf8');

/**
 * The staff's table counts as stale after this long, and the page refreshes it in the background: one glance at GitHub
 * and each checkout's git. While the rounds run on duty they keep it current (each round's glance says whether
 * anything changed), so then a page view asks GitHub nothing.
 */
const STALE_MS = 10 * 60_000;

/** The wait before the first round after the Steward starts: this, and up to as long again. */
export const FIRST_ROUND_MS = 30_000;

/** The wait before a round that comes sooner: after one that left a PR waiting only on something brief (StageResult's soon). */
export const SOON_MS = 2 * 60_000;
/** At most this many rounds in a row come sooner; then one at Settings' interval, so checks that never end don't keep the rounds quick. */
export const SOON_IN_A_ROW = 3;

/** How often the Steward may ask the Seneschal for work beside the rounds (stages/others.ts), and the wait after an error. */
export const OTHERS_TICK_MS = 2_000;
export const OTHERS_AFTER_ERROR_MS = 60_000;

/**
 * The wait before the next round, after one that did (`soon`) or didn't ask for it sooner, with `run` rounds in a row
 * already sooner: SOON_MS, or null for Settings' interval (`everyMs`, when it is that short already, or after
 * SOON_IN_A_ROW). And the rounds in a row sooner, counting this one. Pure.
 */
export function soonAfter(soon: boolean, run: number, everyMs: number): { sooner: number | null; run: number } {
  if (!soon || run >= SOON_IN_A_ROW || everyMs <= SOON_MS) return { sooner: null, run: 0 };
  return { sooner: SOON_MS, run: run + 1 };
}

/**
 * Lines a quiet round says each time it runs, for as long as nothing changes (between builds, the alarms Manor keeps,
 * nothing here to release): every ten minutes they were most of serve.log, 277 times in two days on the makers' PC.
 */
export const STEADY_LINES = [
  /^Settings say it doesn't release by itself/,
  /^no repositories to look after on this PC/,
  /^this PC is offline, so the round waits/,
  /^between builds: /,
  /^\[steward\] kit \S+ on \S+ passed its trial on the agents/,
  /^alarms: Manor keeps the manor-wide alarms itself/,
  /^the staff's table is made again: /,
];

/**
 * The rounds' log as serve.log has it (Steward 0.36.141): a steady line (STEADY_LINES) is written when it is new, not
 * again while each round says it as the round before did, and again once it changes, or after a round without it. Every
 * other line is written as it comes. A round's own log (its stage record) keeps every line.
 */
export function steadyLog(write: (line: string) => void, steady: RegExp[] = STEADY_LINES): { say: (line: string) => void; roundDone: () => void } {
  let before = new Set<string>();
  let now = new Set<string>();
  return {
    say: (line) => {
      if (steady.some((re) => re.test(line))) {
        now.add(line);
        if (before.has(line)) return;
      }
      write(line);
    },
    roundDone: () => {
      before = now;
      now = new Set();
    },
  };
}

/** What a stage's POST asks: the ticked employees, the kit shown on the page. */
export function askOf(body: any): StageAsk {
  const employees = Array.isArray(body?.employees) ? body.employees.map(String).filter(Boolean).slice(0, 100) : [];
  const kit = typeof body?.kit === 'string' && /^\d+\.\d+\.\d+$/.test(body.kit) ? body.kit : null;
  return { employees, kit, ...(body?.hire === true ? { hire: true } : {}) };
}

/**
 * The staff's table as the page shows it: each PR with what its steward block asks for once merged, in words, and each
 * repository with how it is worked with (scm.ts's hostOf), so its PRs go by their host's name.
 */
export const staffView = (s: Staff | null, host?: (r: StaffRow) => Host): StaffView | null =>
  s && { ...s, rows: s.rows.map((r) => ({ ...r, ...(host ? { host: host(r) } : {}), prs:r.prs.map((p) => ({ ...p, afterText: p.after ? afterWords(p.after) : null })) })) };

/** /api/page's body with Developer options off, off the maker's laptop (maker.ts): the plain line, the rest empty. */
export const offView = (): StewardView => ({ off: DEVELOPER_ONLY, staff: null, last: null, running: null, runs: [], full: false, refreshing: false, team: [], round: { on: false, minutes: 0, onDuty: false, lastRunAt: null } });

/** With Developer options off off the maker's laptop, what Manor's two reads answer: their usual shape, empty. */
const OFF_GETS: Record<string, () => unknown> = {
  '/api/version-queues': () => ({ at: '', repos: [] }),
  '/api/alarms': () => ({ on: false, at: null, open: [], cleared: [], page: '/#alarms' }),
};

/**
 * The page's reads, each answering nothing of the repositories while the Steward may not act (maker.ts' stewardActs):
 * the page itself and /api/page draw the plain line (pageData), Manor's reads keep their shape, empty, and the rest say
 * why. Read per request, so flipping Developer options takes effect at once.
 */
export function gateGets(gets: Record<string, Handler>, acts: () => boolean = () => stewardActs()): Record<string, Handler> {
  return Object.fromEntries(Object.entries(gets).map(([p, h]): [string, Handler] => [p, p === '/' || p === '/api/page' ? h : (req) => (acts() ? h(req) : { json: OFF_GETS[p]?.() ?? { off: DEVELOPER_ONLY } })]));
}

/** The page's buttons and Manor's posts: refused in plain words while the Steward may not act; nothing is started. */
export function gatePosts(posts: Record<string, Handler>, acts: () => boolean = () => stewardActs()): Record<string, Handler> {
  return Object.fromEntries(Object.entries(posts).map(([p, h]): [string, Handler] => [p, (req) => (acts() ? h(req) : { json: { started: false, error: DEVELOPER_ONLY, message: DEVELOPER_ONLY }, status: 409 })]));
}

/** `run` stands in for git, gh and the employees' commands in a test; `owner`, for the account gh is signed in as (team.ts). */
export async function serveSteward(o: { run?: Runner; owner?: Owner; getJson?: GetJson; turns?: TurnsDeps } = {}) {
  /** The stages running in this process, side by side (stages/slots.ts): at most Settings' stagesAtOnce. */
  let runs: { stage: string; since: string }[] = [];
  /**
   * A stage begun: it shows on the page until the returned end() is called, which starts what waited for a free slot.
   * It is a task in the work status (the kit's work-status.ts) meanwhile, `end.task`, whose parts are the work run in it
   * (inStage): a scheduled round is the schedule's task already (the kit's every()), and none of its own.
   */
  const begin = (stage: string) => {
    const r = { stage, since: new Date().toISOString() };
    const task = stage === 'round' && scheduledRound() ? null : startWork({ kind: 'stage', what: stage });
    runs = [...runs, r];
    const end = () => {
      task?.done();
      runs = runs.filter((x) => x !== r);
      afterRunning();
    };
    return Object.assign(end, { task });
  };
  /** Whether this runs in the schedule's round (the kit's every() makes each a task named for it, kind round). */
  const scheduledRound = () => {
    const now = currentWork();
    return !!now && workTasks().some((t) => t.id === now && t.kind === 'round' && /^round\b/.test(t.what));
  };
  /** `fn` run as the stage's work: what it starts, a check run among them, is the stage's part. */
  const inStage = <T,>(end: ReturnType<typeof begin>, fn: () => T): T => (end.task ? inWork(end.task, fn) : fn());
  /** Every slot taken: a stage asked for now waits, or is refused. */
  const slotsFull = () => runs.length >= loadSettings().stagesAtOnce;
  const rounding = () => runs.some((r) => r.stage === 'round');
  /** The stages running, in words: "round and release". */
  const runningWords = () => runs.map((r) => r.stage).join(' and ');
  const isAre = () => (runs.length === 1 ? 'is' : 'are');
  let refreshing: Promise<unknown> | null = null;
  /** Jobs to approve once a slot is free (POST /api/jobs/approve while all were taken): employee ids, none for all. */
  let approveAfter: string[] | null = null;

  /** The employees' jobs approved now (steward.ts's approveJobsNow), as the stage "jobs". */
  const approveNow = (ids: string[]) => {
    const end = begin('jobs');
    void inStage(end, () => approveJobsNow(ids, { run: o.run, owner: o.owner, log: (line) => console.log(`jobs: ${line}`) }))
      .then((done) => done.forEach((r) => console.log(`jobs: [${r.id}] ${r.message}`)))
      .catch((e) => console.error(`${new Date().toISOString()} jobs: ${(e as Error).message}`))
      .finally(end);
  };
  /** A round asked for (POST /api/round/soon) while one ran, or every slot was taken: it comes once it can. */
  let roundAfter = false;
  /** Employees the next round looks at whatever GitHub's glance says: those whose rollout bump or push failed. */
  let lookNext: string[] = [];
  /** What waited for a stage to end: jobs to approve, then a round asked for, each once a slot is free. */
  const afterRunning = () => {
    if (approveAfter && !slotsFull()) {
      const ids = approveAfter;
      approveAfter = null;
      approveNow(ids);
    }
    if (roundAfter && !slotsFull() && !rounding()) {
      roundAfter = false;
      startRound();
    }
  };

  /** The repositories Reeve finds (found.ts): looked at again in the background, at most one look at a time. */
  let finding: Promise<unknown> | null = null;
  const find = () =>
    // Under node --test only with a stand-in for the pages: a test never reads this PC's Reeve.
    process.env.NODE_TEST_CONTEXT && !o.getJson
      ? Promise.resolve()
      : (finding ??= findRepos({ run: o.run ?? realRun, cwd: dataDir, getJson: o.getJson ?? getJson, reeveUrl: agentPages().reeve, githubReady: githubReadyHere() })
      .catch((e) => console.error(`${new Date().toISOString()} finding the repositories: ${(e as Error).message}`))
      .finally(() => {
        finding = null;
      }));

  const refresh = () => {
    if (refreshing) return refreshing;
    // Not while GitHub's API budget says wait (budget.ts): the page shows the table it has, and a later look refreshes it.
    const b = loadBudget();
    if (!gate(b, b.glanceCost ?? loadSettings().employees.length + 1, new Date(), { paced: true }).go) return Promise.resolve();
    refreshing = (async () => {
      try {
        await refreshStaff(await context({ run: o.run, owner: o.owner }));
      } catch (e) {
        console.error(`${new Date().toISOString()} refreshing the staff: ${(e as Error).message}`);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  const start = (stage: 'bump' | 'push' | 'release', ask: StageAsk) => {
    if (slotsFull()) return { json: { started: false, message: `${runningWords()} ${isAre()} running, as many stages as Settings allow at once (Stages at once); wait for one to finish.` } };
    const end = begin(stage);
    void inStage(end, () => runStage(stage, ask, { run: o.run, owner: o.owner, log: (line) => console.log(`${stage}: ${line}`) }))
      .catch((e) => console.error(`${new Date().toISOString()} ${stage}: ${(e as Error).message}`))
      .finally(end);
    return { json: { started: true } };
  };

  const stagePost =
    (stage: 'bump' | 'push' | 'release'): Handler =>
    ({ body }) =>
      start(stage, askOf(body));

  // The table on the first visit, and again when it's old; the page shows the last one meanwhile.
  const staleTable = () => {
    const s = loadStaff();
    return !s || Date.now() - Date.parse(s.checked ?? s.at) > STALE_MS;
  };
  if (staleTable()) void refresh();
  /**
   * Whether the rounds are keeping the table current: scheduled, building and releasing by itself with repositories to
   * look at (a round that only keeps the staff's pages up asks GitHub nothing), on duty, and the last one not long ago.
   */
  const roundsKeepIt = () => {
    const last = rounds?.state?.lastRunAt;
    const s = loadSettings();
    return !!rounds && s.byItself && duty().onDuty && !!last && Date.now() - Date.parse(last) < 2 * s.roundMinutes * 60_000 + STALE_MS && reposHere(s);
  };

  /** The wait before the next round, when the last asked for it sooner (soonAfter); null: Settings' interval. */
  let sooner: number | null = null;
  /** The rounds in a row that came sooner: after SOON_IN_A_ROW, one at Settings' interval (soonAfter). */
  let soonRun = 0;
  /** The rounds' lines in serve.log: one that each quiet round says alike, once (steadyLog). */
  const roundLog = steadyLog((line) => console.log(`round: ${line}`));
  // The round (stages/round.ts): between builds it only looks; a build's rounds release each repository's main. It passes while a round runs, here or in a terminal, or every stage's slot is taken (stages/slots.ts).
  const roundJob = async (full = false, extra: Pick<StageAsk, 'buildNow' | 'employees'> = {}) => {
    // Off the maker's laptop with Developer options off, no round runs: a developer's work (maker.ts).
    if (rounding() || slotsFull() || !stewardActs()) return;
    const end = begin('round');
    sooner = null;
    try {
      // A scheduled round looks only at what's new on GitHub; Run now looks at everyone. Scheduled while Settings say it
      // doesn't merge and release by itself (it keeps the staff's pages up), it asks GitHub nothing.
      const look = lookNext;
      lookNext = [];
      const ask: StageAsk = full ? { full, ...extra } : loadSettings().byItself ? (look.length ? { look } : {}) : { tendOnly: true };
      // A person started it (Run now, Build now): its checks go in the Seneschal's first lane (stages/seneschal.ts).
      const stage = () => runStage('round', ask, { run: o.run, owner: o.owner, log: roundLog.say });
      const out = await inStage(end, () => (full ? withLane('person', stage) : stage()));
      roundLog.roundDone();
      ({ sooner, run: soonRun } = soonAfter(!!out.soon, soonRun, loadSettings().roundMinutes * 60_000));
    } catch (e) {
      if (!(e instanceof LockTimeout)) throw e;
    } finally {
      end();
    }
  };
  /**
   * A round as the schedule runs one, now, beside the schedule (whose next tick passes while it runs). While Manor has
   * an automatic update due for the Steward (the kit's update-hold.ts), none starts: the schedule's rounds wait a few
   * minutes for it, so Manor finds the Steward idle, and its next look runs the round this one would have been. Not
   * while its build is open (buildUnderWay): Manor puts no update in until it closes, so the build's rounds go on.
   */
  const startRound = () => {
    if (!buildUnderWay(loadPipeline()) && updateHold()) return;
    void roundJob().catch((e) => console.error(`${new Date().toISOString()} round: ${(e as Error).message}`));
  };
  // Beside the rounds (stages/others.ts): one of the Seneschal's workers, where it's on this PC (Seneschal 0.2.0). A PR
  // check or whole suite of a repository the Steward looks after, waiting for room here or on another PC on the licence,
  // runs here, one at a time; asked for again as soon as the Seneschal says to.
  let othersGoing = false;
  let othersNext = 0;
  const othersJob = async () => {
    if (othersGoing || Date.now() < othersNext || !loadSettings().byItself || !duty().onDuty || !stewardActs() || updateHold()) return;
    othersGoing = true;
    const log = (line: string) => console.log(`seneschal: ${line}`);
    try {
      const r = await workForOthers({ settings: loadSettings(), ctxOf: () => context({ run: o.run, owner: o.owner, glance: false, log }), say: log });
      othersNext = Date.now() + r.retryMs;
    } catch (e) {
      othersNext = Date.now() + OTHERS_AFTER_ERROR_MS;
      console.error(`${new Date().toISOString()} seneschal: ${(e as Error).message}`);
    } finally {
      othersGoing = false;
    }
  };
  /** Its tick, only while Settings say it builds and releases by itself (arrange): off, it read the settings every 2 s for nothing. */
  let othersTick: ReturnType<typeof setInterval> | null = null;
  // The whole suite before a kit's release runs beside the rounds (stages/wholesuite.ts): once it ends, a round releases
  // the kit, or holds it, at once. A run a Steward that is gone left behind is ended first.
  endWholeOrphans((line) => console.log(`whole suite: ${line}`));
  wholeSuitesBeside({
    log: (line) => console.log(`whole suite: ${line}`),
    ended: () => {
      if (!loadSettings().byItself || !duty().onDuty || !stewardActs()) return;
      if (rounding() || slotsFull()) roundAfter = true;
      else startRound();
    },
  });
  // And a kit's rollout (stages/rollout.ts): its bumps, checks, pushes and merges run beside the rounds. Once it ends, a
  // round at once: it reports what the rollout did, looks again at the employees whose bump or push failed, and releases
  // the build once it has settled.
  rolloutsBeside({
    log: (line) => console.log(`rollout: ${line}`),
    ended: ({ results }) => {
      if (!results.some((r) => r.outcome === 'done' || r.outcome === 'failed')) return;
      lookNext = [...new Set([...lookNext, ...results.filter((r) => r.outcome === 'failed').map((r) => r.id)])];
      if (!loadSettings().byItself || !duty().onDuty || !stewardActs()) return;
      if (rounding() || slotsFull()) roundAfter = true;
      else startRound();
    },
  });
  // On duty, every few minutes while Settings say it builds and releases by itself, or keeps the staff's pages up; the
  // kit's every() pauses off duty. Saving Settings starts, stops or re-times it. The first comes within a minute of the
  // start, not the kit's 2 to 15 minutes at a gentle pace: the Steward starts again whenever Manor updates it, often
  // halfway through a release and its rollout, which shouldn't stand still meanwhile (0.35.29). Outside the kit's work
  // line (`light`): its rounds keep their own limit, Settings' Stages at once, rather than queueing behind the agents'.
  let rounds: ReturnType<typeof every> | null = null;
  const arrange = () => {
    const s = loadSettings();
    const scheduled = s.byItself || s.tend;
    if (scheduled && !rounds) rounds = every(() => sooner ?? loadSettings().roundMinutes * 60_000, () => roundJob(), { name: 'round', firstDelayMs: FIRST_ROUND_MS + Math.random() * FIRST_ROUND_MS, light: true });
    else if (!scheduled && rounds) {
      rounds.stop();
      rounds = null;
    } else rounds?.reschedule();
    if (s.byItself && !othersTick && !process.env.NODE_TEST_CONTEXT) othersTick = setInterval(() => void othersJob(), OTHERS_TICK_MS).unref();
    else if (!s.byItself && othersTick) {
      clearInterval(othersTick);
      othersTick = null;
    }
    builds.look();
  };
  // The builds (build-hold.ts): the PC held up from a few minutes before each build time until its build closes, a round
  // at the build time, and the task that wakes the PC, plugged in, for each, kept in step with Settings and duty.
  const builds = holdForBuilds({
    pipeline: () => {
      if (!stewardActs() || !duty().onDuty) return null;
      const s = loadSettings();
      return s.byItself ? s.buildPipeline : null;
    },
    state: loadPipeline,
    onDue: () => {
      if (!rounds) return;
      if (rounding() || slotsFull()) roundAfter = true;
      else startRound();
    },
  });
  arrange();
  // Just started: the page may have been down with the PC (shut down, asleep, offline), so what failed before is tried
  // once more at the first round. The PC woke from sleep: the same before is tried again (fresh-start.ts), in a round now rather than at the next.
  noteFreshStart();
  // Whether a vendor's screen saver has been putting the PC to sleep (the kit's sleep-cause.ts): looked at two minutes
  // after the page starts and at each wake, never between. Read-only: the page says which setting to turn off.
  let saverSlept: SaverSleeps | null = null;
  const lookAtSleeps = () => void saverSleeps().then((s) => (saverSlept = s));
  setTimeout(lookAtSleeps, 2 * 60_000).unref();
  watchWake(() => {
    builds.look();
    lookAtSleeps();
    if (rounds) startRound();
  });
  // The manor's branch heads, shared with the other agents, kept fresh beside the rounds, however long one takes, and
  // a moment after each merge (heads.ts). Not on a test's page, whose runner is its own: no test asks GitHub.
  if (!o.run) keepHeads({ log: (line) => console.log(`heads: ${line}`) });

  /** What the page shows (src/web/types.ts's StewardView), in the kit's frame. */
  const pageData = () => {
    // Developer options off, off the maker's laptop: the plain line in its place, a role in plain words and no tour;
    // nothing of the repositories is even read (the kit's spec/DEVELOPER-OPTIONS.md).
    if (!stewardActs()) {
      const shell = pageShell({ busy: false, onboarding: null });
      return { shell: { ...shell, app: { ...shell.app, role: PLAIN_ROLE } }, body: offView() };
    }
    const s = loadSettings();
    const busy = runs.length > 0 || refreshing !== null;
    const pv = pipelineView(s.buildPipeline, loadPipeline());
    const round = { on: s.byItself, minutes: s.roundMinutes, onDuty: duty().onDuty, lastRunAt: rounds?.state?.lastRunAt ?? null, rollout: s.rollout, releaseSelf: s.releaseSelf, tend: s.tend && !!agentPages().manor, repos: reposHere(s), castellan: s.releasesCastellan, build: { times: pv.times, next: pv.next, building: pv.building, took: pv.last ? buildTimeLine(pv.last) : null, late: lateLine(pv.open ?? pv.last, new Date()), wakes: wakesPc() }, asleep: saverSlept ? saverSleepLine(saverSlept.saver, saverSlept.sleeps, Date.now()) : null };
    // Settings' team, or when they name none the account gh is signed in as (team.ts; the kit keeps it once known).
    const team = teamOf(s.team, o.owner);
    const self = s.stewardRepo ? [{ id: APP.id, name: APP.name, repo: s.stewardRepo }] : [];
    const scm = loadScm();
    const body: StewardView = { turns: turnsView([...s.employees, ...self]), claimClashes: claimClashes(), passedOver: passedLines(loadStaff()?.rows ?? []).map((l) => passedWords(l)), castellan: s.releasesCastellan, found: foundView(loadFound(), s), finding: finding !== null, staff: staffView(loadStaff(), (r) => hostOf(r, s, scm)), last: loadLastStage(), running: runs[0] ?? null, runs, full: slotsFull(), refreshing: refreshing !== null, team: team.team, teamNote: team.note, round, alarms: s.alarms.on ? loadAlarms() : undefined, tending: s.tend ? loadTending() : undefined, wholeSuite: loadWholeJob() };
    return { shell: pageShell({ busy, title: runs.length ? `(${runs.map((r) => r.stage).join(', ')}) ${APP.name}` : APP.name }), body };
  };

  const served = await serve({
    port,
    icon: ICON,
    // The whole suite beside the rounds ends with the Steward, with everything it started (stages/wholesuite.ts).
    onStop: () => endWholeSuite(),
    // Busy while a stage runs, and while its build is open, between the build's rounds too (buildUnderWay): Manor
    // installs an update only while the ping says idle, never mid-build (Steward 0.36.257).
    ping: () => {
      const build = !!buildUnderWay(loadPipeline());
      return { busy: runs.length > 0 || build, stage: runs.length ? runs.map((r) => r.stage).join(', ') : build ? 'build' : null, tour: hasTour() };
    },
    // Its work status (GET /api/peer/work, the kit's work-status.ts), for Manor's Work page: its stages' slots beside the
    // kit's. Nothing holds a repository's work up here: no PR waits for the Steward (Steward 0.36.124).
    work: () => ({ slots: [{ kind: 'stage', name: 'Stages at once', of: loadSettings().stagesAtOnce, used: runs.length }], blocked: [] }),
    get: gateGets({
      // The page is drawn in the browser (src/web, the kit's react part): its first data comes with it, and it asks
      // /api/page again every few seconds while a stage runs, and after each button.
      '/': ({ token }) => {
        if (stewardActs() && !runs.length && !roundsKeepIt() && staleTable()) void refresh();
        if (stewardActs() && foundStale(loadFound())) void find();
        return { html: reactPage({ token, data: pageData() }) };
      },
      '/api/page': () => ({ json: pageData() }),
      '/api/staff': () => ({ json: loadStaff() }),
      // The versions claimed up front and not yet landed (claims.ts): claim one with cli.ts claim-version.
      '/api/versions': () => ({ json: { claims: loadClaims(), claim: 'node %USERPROFILE%\\.steward\\app\\src\\cli.ts claim-version <employee> --branch <b> --for "<what>"' } }),
      '/api/last-stage': () => ({ json: loadLastStage() }),
      // The version queues are gone (Steward 0.36.124: everyone merges their own PRs). Answered empty, as Manor reads it.
      '/api/version-queues': () => ({ json: { at: '', repos: [] } }),
      // The commits whose tests passed here, the last 20 of each employee's (tested.ts): the Surveyor's, for its daily runs.
      '/api/tested': () => ({ json: testedView(loadSettings()) }),
      // What needs the person (alarms.ts): Manor shows the open ones that aren't dismissed.
      '/api/alarms': () => {
        const a = loadAlarms();
        return { json: { on: loadSettings().alarms.on, at: a.at, open: a.open, cleared: a.cleared, page: '/#alarms' } };
      },
      // The build pipeline (pipeline.ts): its times, the next build, and whether one is under way. Manor holds its
      // installs while `building`, and installs once, when the build has ended.
      '/api/pipeline': () => ({ json: pipelineView(loadSettings().buildPipeline, loadPipeline()) }),
    }),
    post: gatePosts({
      '/api/stage/bump': stagePost('bump'),
      '/api/stage/push': stagePost('push'),
      '/api/stage/release': stagePost('release'),
      // A round now, as the schedule would run one (the button asks first), on duty or not.
      '/api/run': () => {
        if (rounding()) return { json: { started: false, message: 'A round is running; wait for it to finish.' } };
        if (slotsFull()) return { json: { started: false, message: `${runningWords()} ${isAre()} running, as many stages as Settings allow at once (Stages at once); wait for one to finish.` } };
        void roundJob(true).catch((e) => console.error(`${new Date().toISOString()} round: ${(e as Error).message}`));
        return { json: { started: true } };
      },
      // The owner's Build now (pipeline.ts), asked first on Manor's page: a build at once, outside the schedule, for the
      // repositories named ({ employees: [id, …] }) or all, and with { toCustomers: true } its releases let out to
      // customers at once rather than on their release day. Never for a session: its urgent fix marks its changelog entry
      // "**Urgent fix:" and builds at once by itself (stages/urgent.ts), and the page's token is the owner's.
      '/api/pipeline/build': ({ body }) => {
        const employees: string[] = Array.isArray(body?.employees) ? body.employees.filter((x: unknown): x is string => typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(x)).slice(0, 100) : [];
        if (rounding()) return { json: { started: false, message: 'A round is running; press Build now again once it has finished.' } };
        if (slotsFull()) return { json: { started: false, message: `${runningWords()} ${isAre()} running, as many stages as Settings allow at once (Stages at once); wait for one to finish.` } };
        const open = loadPipeline().open;
        if (open && !open.finished) return { json: { started: false, message: 'A build is under way: what is ready goes into it.' } };
        void roundJob(true, { buildNow: { toCustomers: body?.toCustomers === true }, employees }).catch((e) => console.error(`${new Date().toISOString()} round: ${(e as Error).message}`));
        return { json: { started: true, message: `A build has begun${employees.length ? ` for ${employees.join(', ')}` : ''}${body?.toCustomers === true ? ': its releases go out to customers at once' : ''}.` } };
      },
      // An older `steward vouch` asks for a round once it has vouched. The Steward merges no PRs now (Steward 0.36.124):
      // whoever wrote one merges it once vouched, and the next build releases main. A round now only looks, and takes an
      // urgent fix (its changelog entry starting "**Urgent fix:") into a build of its own at once (stages/urgent.ts).
      '/api/round/soon': () => {
        const merge = 'The Steward merges no PRs: merge it yourself once vouched, and the next build releases main';
        if (!loadSettings().byItself || !duty().onDuty) return { json: { started: false, message: `${merge}.` } };
        if (rounding() || slotsFull()) {
          roundAfter = true;
          return { json: { started: false, queued: true, message: `${merge}: a round looks for an urgent fix as soon as it can.` } };
        }
        if (updateHold()) return { json: { started: false, queued: true, message: `${merge}: a round looks for an urgent fix once Manor has updated the Steward.` } };
        startRound();
        return { json: { started: true, message: `${merge}: a round looks for an urgent fix now.` } };
      },
      // Manor, right after it installs an update: the jobs whose scripts it changed, approved now when they are exactly
      // what was merged (stages/jobs.ts), not at the next round's end. While every slot is taken, once one is free.
      '/api/jobs/approve': ({ body }) => {
        const ids: string[] = Array.isArray(body?.ids) ? body.ids.filter((x: unknown): x is string => typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(x)).slice(0, 100) : [];
        if (slotsFull()) {
          approveAfter = approveAfter === null ? ids : !ids.length || !approveAfter.length ? [] : [...new Set([...approveAfter, ...ids])];
          return { json: { started: false, queued: true, message: `${runningWords()} ${isAre()} running; the jobs are approved once one ends.` } };
        }
        approveNow(ids);
        return { json: { started: true } };
      },
      '/api/alarms/dismiss': ({ body }) => {
        const id = typeof body?.id === 'string' ? body.id.slice(0, 300) : '';
        // An update the install rolled back: dismissing its alarm is looking at it, and allows that version again.
        if (id.startsWith('unsafe:')) allowUpdate(id.slice('unsafe:'.length));
        return dismiss(id) ? { json: { ok: true } } : { json: { error: 'no such alarm open' }, status: 404 };
      },
      // An alarm's button (its `action`), on the page or Manor's Needs you, asked first: { id }. One has it (0.36.139): a
      // release on GitHub that didn't reach the Exchequer (stages/exchequer.ts), whose "Publish it now" has a round try it
      // at once. Every other alarm is only dismissed.
      '/api/alarms/act': ({ body }) => {
        const id = typeof body?.id === 'string' ? body.id.slice(0, 300) : '';
        const a = loadAlarms().open.find((x) => x.id === id);
        if (a && id.startsWith('exchequer:')) {
          if (!askAgain(id)) return { json: { error: 'That release no longer waits for the Exchequer.' }, status: 404 };
          const what = "It's published to the Exchequer";
          if (!loadSettings().byItself || !duty().onDuty) return { json: { ok: true, message: `${what} at the next round you start.` } };
          if (rounding() || slotsFull()) {
            roundAfter = true;
            return { json: { ok: true, queued: true, message: `${what} by a round as soon as one can start.` } };
          }
          if (updateHold()) return { json: { ok: true, queued: true, message: `${what} by the next round, once Manor has updated the Steward.` } };
          startRound();
          return { json: { ok: true, message: `${what} by a round starting now.` } };
        }
        return { json: { error: a ? 'that alarm has nothing to do but be dismissed' : 'no such alarm open' }, status: 404 };
      },
      // Look after repositories Reeve found (found.ts): added to Settings, releasing only as ticked. One
      // ({ repo, merges, release }), or several at once ({ repos: [{ repo, merges, release }, …] }).
      '/api/repos/look-after': ({ body }) => {
        const many = Array.isArray(body?.repos);
        const picks = (many ? (body.repos as any[]).slice(0, 200) : [body]).map((p) => ({
          repo: typeof p?.repo === 'string' ? p.repo.trim().slice(0, 140) : '',
          merges: p?.merges === true,
          release: p?.release === true,
        }));
        if (!picks.length || picks.some((p) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repo)))
          return { json: { error: 'Send { "repo": "owner/name" }, or { "repos": [{ "repo": "owner/name" }, …] }, of the repositories the page offers.' }, status: 400 };
        const r = lookAfterAll(picks);
        if (r.employees.length && !runs.length) void refresh();
        if (!r.employees.length) return { json: { error: r.errors.join('\n') }, status: 409 };
        const ids = r.employees.map((e) => e.id);
        // Some added and some not: the page says which weren't, and why.
        return { json: { ok: true, ...(many ? { ids } : { id: ids[0] }), ...(r.errors.length ? { message: `Looked after ${ids.length}; not ${r.errors.length}:\n${r.errors.join('\n')}` } : {}) } };
      },
      // The release PC of a repository (lease.ts): "Do it here" ({ repo }), "Keep it on this PC" ({ repo, pin: true }), or
      // Unpin ({ repo, pin: false }), written to the repository's remote; then a round publishes what waits.
      '/api/turns/take': async ({ body }) => {
        const repo = typeof body?.repo === 'string' ? body.repo.trim().slice(0, 140) : '';
        const s = loadSettings();
        const self = s.stewardRepo ? [stewardEmployee(s, s.stewardCheckout)] : [];
        const e = [...s.employees, ...self].find((x) => x.repo.toLowerCase() === repo.toLowerCase());
        if (!e) return { json: { error: 'Send { "repo": "owner/name" }, a repository the Steward looks after.' }, status: 400 };
        const pin = body?.pin === true ? true : body?.pin === false ? false : undefined;
        const r = await handOver(e, { run: o.run ?? realRun, settings: s, deps: o.turns, pin });
        if (!r.ok) return { json: { error: r.message }, status: 409 };
        if (!rounding() && !slotsFull() && pin === undefined) void roundJob(true).catch((err) => console.error(`${new Date().toISOString()} round: ${(err as Error).message}`));
        return { json: { ok: true, message: r.message } };
      },
      '/api/repos/refresh': () => {
        void find();
        return { json: { started: true } };
      },
      '/api/staff/refresh': () => {
        if (runs.length) return { json: { started: false, message: `${runningWords()} ${isAre()} running; the table is refreshed when ${runs.length === 1 ? "it's" : "they're"} done.` } };
        void refresh();
        return { json: { started: true } };
      },
    }),
    settings: { ...SETTINGS_SPEC, onSaved: arrange },
  });
  console.log(`${APP.name} is serving http://${APP.id}.localhost:${port}/`);
  return {
    ...served,
    idle: async () => {
      while (runs.length || refreshing) await new Promise((r) => setTimeout(r, 25));
    },
    close: async () => {
      rounds?.stop();
      rounds = null;
      await served.close();
    },
  };
}
