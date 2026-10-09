import { readFileSync } from 'node:fs';
import { dismiss, getJson, loadAlarms, type GetJson } from './alarms.ts';
import { APP, dataDir, port } from './app.ts';
import { duty } from './kit/duty.ts';
import { LockTimeout } from './kit/lock.ts';
import { hasTour, pageShell, reactPage } from './kit/react-page.ts';
import { every } from './kit/schedule.ts';
import { serve, type Handler } from './kit/server.ts';
import { afterWords } from './after.ts';
import { run as realRun, type Runner } from './run.ts';
import { teamOf, type Owner } from './team.ts';
import { loadSettings, SETTINGS_SPEC } from './settings.ts';
import type { Staff } from './stages/staff.ts';
import { approveJobsNow, context, loadLastStage, loadStaff, refreshStaff, reposHere, runStage, type StageAsk } from './steward.ts';
import { loadTending } from './tend.ts';
import type { StaffView, StewardView } from './web/types.ts';
import { allowUpdate } from './safeinstall.ts';
import { loadClaims } from './claims.ts';
import { testedView } from './tested.ts';
import { findRepos, foundStale, foundView, loadFound, lookAfter } from './found.ts';
import { handOver, turnsView, type TurnsDeps } from './lease.ts';
import { claimClashes } from './claims.ts';
import { loadConflicts } from './conflicts.ts';
import { stewardEmployee } from './stages/selfmerge.ts';
import { githubReady, loadScm } from './scm.ts';
import { loadVersionQueues } from './version-queue.ts';
import { DEVELOPER_ONLY, PLAIN_ROLE, stewardActs } from './maker.ts';

/** Whether the GitHub CLI is signed in here, as the last look said (scm.ts); undefined before any look. */
const githubReadyHere = (): boolean | undefined => {
  const look = loadScm();
  return look ? githubReady(look) : undefined;
};

/**
 * The Steward at work on its page: the staff's table, and a button for each stage. A stage runs in this
 * process, one at a time (and never beside one run from a terminal: the stage lock), and the page
 * refreshes itself while it runs.
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

/** The wait before a round that comes sooner: after one that left a PR waiting only on something brief (StageResult's soon). */
export const SOON_MS = 2 * 60_000;
/** At most this many rounds in a row come sooner; then one at Settings' interval, so checks that never end don't keep the rounds quick. */
export const SOON_IN_A_ROW = 3;

/**
 * The wait before the next round, after one that did (`soon`) or didn't ask for it sooner, with `run` rounds in a row
 * already sooner: SOON_MS, or null for Settings' interval (`everyMs`, when it is that short already, or after
 * SOON_IN_A_ROW). And the rounds in a row sooner, counting this one. Pure.
 */
export function soonAfter(soon: boolean, run: number, everyMs: number): { sooner: number | null; run: number } {
  if (!soon || run >= SOON_IN_A_ROW || everyMs <= SOON_MS) return { sooner: null, run: 0 };
  return { sooner: SOON_MS, run: run + 1 };
}

/** What a stage's POST asks: the ticked employees, the kit shown on the page. */
export function askOf(body: any): StageAsk {
  const employees = Array.isArray(body?.employees) ? body.employees.map(String).filter(Boolean).slice(0, 100) : [];
  const kit = typeof body?.kit === 'string' && /^\d+\.\d+\.\d+$/.test(body.kit) ? body.kit : null;
  return { employees, kit, ...(body?.hire === true ? { hire: true } : {}) };
}

/** The staff's table as the page shows it: each PR with what its steward block asks for once merged, in words. */
export const staffView = (s: Staff | null): StaffView | null =>
  s && { ...s, rows: s.rows.map((r) => ({ ...r, prs: r.prs.map((p) => ({ ...p, afterText: p.after ? afterWords(p.after) : null })) })) };

/** /api/page's body with Developer options off, off the maker's laptop (maker.ts): the plain line, the rest empty. */
export const offView = (): StewardView => ({ off: DEVELOPER_ONLY, staff: null, last: null, running: null, refreshing: false, team: [], round: { on: false, minutes: 0, onDuty: false, lastRunAt: null } });

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
  let running: { stage: string; since: string } | null = null;
  let refreshing: Promise<unknown> | null = null;
  /** Jobs to approve once what's running ends (POST /api/jobs/approve while it ran): employee ids, none for all. */
  let approveAfter: string[] | null = null;

  /** The employees' jobs approved now (steward.ts's approveJobsNow), as the stage "jobs". */
  const approveNow = (ids: string[]) => {
    running = { stage: 'jobs', since: new Date().toISOString() };
    void approveJobsNow(ids, { run: o.run, owner: o.owner, log: (line) => console.log(`jobs: ${line}`) })
      .then((done) => done.forEach((r) => console.log(`jobs: [${r.id}] ${r.message}`)))
      .catch((e) => console.error(`${new Date().toISOString()} jobs: ${(e as Error).message}`))
      .finally(() => {
        running = null;
        afterRunning();
      });
  };
  /** What waited for the stage that just ended: jobs to approve. */
  const afterRunning = () => {
    if (running || !approveAfter) return;
    const ids = approveAfter;
    approveAfter = null;
    approveNow(ids);
  };

  /** The repositories Reeve finds (found.ts): looked at again in the background, at most one look at a time. */
  let finding: Promise<unknown> | null = null;
  const find = () =>
    // Under node --test only with a stand-in for the pages: a test never reads this PC's Reeve.
    process.env.NODE_TEST_CONTEXT && !o.getJson
      ? Promise.resolve()
      : (finding ??= findRepos({ run: o.run ?? realRun, cwd: dataDir, getJson: o.getJson ?? getJson, reeveUrl: loadSettings().alarms.reeveUrl, githubReady: githubReadyHere() })
      .catch((e) => console.error(`${new Date().toISOString()} finding the repositories: ${(e as Error).message}`))
      .finally(() => {
        finding = null;
      }));

  const refresh = () => {
    if (refreshing) return refreshing;
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

  const start = (stage: 'bump' | 'push' | 'merge' | 'release', ask: StageAsk) => {
    if (running) return { json: { started: false, message: `${running.stage} is running; wait for it to finish.` } };
    running = { stage, since: new Date().toISOString() };
    void runStage(stage, ask, { run: o.run, owner: o.owner, log: (line) => console.log(`${stage}: ${line}`) })
      .catch((e) => console.error(`${new Date().toISOString()} ${stage}: ${(e as Error).message}`))
      .finally(() => {
        running = null;
        afterRunning();
      });
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
   * Whether the rounds are keeping the table current: scheduled, merging and releasing by itself with repositories to
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
  // The round (stages/round.ts): merge what's ready, the team's too, with what each PR asks for after; then
  // release what isn't. It passes while a stage runs here or in a terminal (the stage lock).
  const roundJob = async (full = false) => {
    // Off the maker's laptop with Developer options off, no round runs: a developer's work (maker.ts).
    if (running || !stewardActs()) return;
    running = { stage: 'round', since: new Date().toISOString() };
    sooner = null;
    try {
      // A scheduled round looks only at what's new on GitHub; Run now looks at everyone. Scheduled while Settings say it
      // doesn't merge and release by itself (it keeps the staff's pages up), it asks GitHub nothing.
      const ask: StageAsk = full ? { full } : loadSettings().byItself ? {} : { tendOnly: true };
      const out = await runStage('round', ask, { run: o.run, owner: o.owner, log: (line) => console.log(`round: ${line}`) });
      ({ sooner, run: soonRun } = soonAfter(!!out.soon, soonRun, loadSettings().roundMinutes * 60_000));
    } catch (e) {
      if (!(e instanceof LockTimeout)) throw e;
    } finally {
      running = null;
      afterRunning();
    }
  };
  // On duty, every few minutes while Settings say it merges and releases by itself, or keeps the staff's pages up; the
  // kit's every() pauses off duty. Saving Settings starts, stops or re-times it.
  let rounds: ReturnType<typeof every> | null = null;
  const arrange = () => {
    const s = loadSettings();
    const scheduled = s.byItself || s.tend;
    if (scheduled && !rounds) rounds = every(() => sooner ?? loadSettings().roundMinutes * 60_000, () => roundJob(), { name: 'round' });
    else if (!scheduled && rounds) {
      rounds.stop();
      rounds = null;
    } else rounds?.reschedule();
  };
  arrange();

  /** What the page shows (src/web/types.ts's StewardView), in the kit's frame. */
  const pageData = () => {
    // Developer options off, off the maker's laptop: the plain line in its place, a role in plain words and no tour;
    // nothing of the repositories is even read (the kit's spec/DEVELOPER-OPTIONS.md).
    if (!stewardActs()) {
      const shell = pageShell({ busy: false, onboarding: null });
      return { shell: { ...shell, app: { ...shell.app, role: PLAIN_ROLE } }, body: offView() };
    }
    const s = loadSettings();
    const busy = running !== null || refreshing !== null;
    const round = { on: s.byItself, minutes: s.roundMinutes, onDuty: duty().onDuty, lastRunAt: rounds?.state?.lastRunAt ?? null, rollout: s.rollout, releaseSelf: s.releaseSelf, tend: s.tend && !!s.alarms.manorUrl, repos: reposHere(s), castellan: s.releasesCastellan };
    // Settings' team, or when they name none the account gh is signed in as (team.ts; the kit keeps it once known).
    const team = teamOf(s.team, o.owner);
    const self = s.stewardRepo ? [{ id: APP.id, name: APP.name, repo: s.stewardRepo }] : [];
    const body: StewardView = { turns: turnsView([...s.employees, ...self]), claimClashes: claimClashes(), castellan: s.releasesCastellan, found: foundView(loadFound(), s), finding: finding !== null, staff: staffView(loadStaff()), conflicts: loadConflicts(), last: loadLastStage(), running, refreshing: refreshing !== null, team: team.team, teamNote: team.note, round, alarms: s.alarms.on ? loadAlarms() : undefined, tending: s.tend ? loadTending() : undefined };
    return { shell: pageShell({ busy, title: running ? `(${running.stage}) ${APP.name}` : APP.name }), body };
  };

  const served = await serve({
    port,
    icon: ICON,
    ping: () => ({ busy: running !== null, stage: running?.stage ?? null, tour: hasTour() }),
    get: gateGets({
      // The page is drawn in the browser (src/web, the kit's react part): its first data comes with it, and it asks
      // /api/page again every few seconds while a stage runs, and after each button.
      '/': ({ token }) => {
        if (stewardActs() && !running && !roundsKeepIt() && staleTable()) void refresh();
        if (stewardActs() && foundStale(loadFound())) void find();
        return { html: reactPage({ token, data: pageData() }) };
      },
      '/api/page': () => ({ json: pageData() }),
      '/api/staff': () => ({ json: loadStaff() }),
      // The versions claimed up front and not yet landed (claims.ts): claim one with cli.ts claim-version.
      '/api/versions': () => ({ json: { claims: loadClaims(), claim: 'node %USERPROFILE%\\.steward\\app\\src\\cli.ts claim-version <employee> --branch <b> --for "<what>"' } }),
      '/api/last-stage': () => ({ json: loadLastStage() }),
      // Each repository's version on its branch and the PR versions queued above it, lowest first (version-queue.ts): Manor's.
      '/api/version-queues': () => ({ json: loadVersionQueues() }),
      // The commits whose tests passed here, the last 20 of each employee's (tested.ts): the Surveyor's, for its daily runs.
      '/api/tested': () => ({ json: testedView(loadSettings()) }),
      // What needs the person (alarms.ts): Manor shows the open ones that aren't dismissed.
      '/api/alarms': () => {
        const a = loadAlarms();
        return { json: { on: loadSettings().alarms.on, at: a.at, open: a.open, cleared: a.cleared, page: '/#alarms' } };
      },
    }),
    post: gatePosts({
      '/api/stage/bump': stagePost('bump'),
      '/api/stage/push': stagePost('push'),
      // The page's buttons asked first: that is merge --yes, and merge --yes --team.
      '/api/stage/merge': ({ body }) => start('merge', { ...askOf(body), yes: true }),
      '/api/stage/merge-team': ({ body }) => start('merge', { ...askOf(body), yes: true, team: true }),
      '/api/stage/release': stagePost('release'),
      // A round now, as the schedule would run one (the button asks first), on duty or not.
      '/api/run': () => {
        if (running) return { json: { started: false, message: `${running.stage} is running; wait for it to finish.` } };
        void roundJob(true).catch((e) => console.error(`${new Date().toISOString()} round: ${(e as Error).message}`));
        return { json: { started: true } };
      },
      // Manor, right after it installs an update: the jobs whose scripts it changed, approved now when they are exactly
      // what was merged (stages/jobs.ts), not at the next round's end. While a stage runs, once it ends.
      '/api/jobs/approve': ({ body }) => {
        const ids: string[] = Array.isArray(body?.ids) ? body.ids.filter((x: unknown): x is string => typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(x)).slice(0, 100) : [];
        if (running) {
          approveAfter = approveAfter === null ? ids : !ids.length || !approveAfter.length ? [] : [...new Set([...approveAfter, ...ids])];
          return { json: { started: false, queued: true, message: `${running.stage} is running; the jobs are approved once it ends.` } };
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
      // Look after a repository Reeve found (found.ts): added to Settings, merging and releasing only as ticked.
      '/api/repos/look-after': ({ body }) => {
        const repo = typeof body?.repo === 'string' ? body.repo.trim().slice(0, 140) : '';
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return { json: { error: 'Send { "repo": "owner/name" }, one of the repositories the page offers.' }, status: 400 };
        const r = lookAfter(repo, { merges: body?.merges === true, release: body?.release === true });
        if ('error' in r) return { json: { error: r.error }, status: 409 };
        if (!running) void refresh();
        return { json: { ok: true, id: r.employee.id } };
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
        if (!running && pin === undefined) void roundJob(true).catch((err) => console.error(`${new Date().toISOString()} round: ${(err as Error).message}`));
        return { json: { ok: true, message: r.message } };
      },
      '/api/repos/refresh': () => {
        void find();
        return { json: { started: true } };
      },
      '/api/staff/refresh': () => {
        if (running) return { json: { started: false, message: `${running.stage} is running; the table is refreshed when it's done.` } };
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
      while (running || refreshing) await new Promise((r) => setTimeout(r, 25));
    },
    close: async () => {
      rounds?.stop();
      rounds = null;
      await served.close();
    },
  };
}
