import { readFileSync } from 'node:fs';
import { dismiss, loadAlarms } from './alarms.ts';
import { APP, port } from './app.ts';
import { duty } from './kit/duty.ts';
import { LockTimeout } from './kit/lock.ts';
import { page } from './kit/page.ts';
import { every } from './kit/schedule.ts';
import { serve, type Handler } from './kit/server.ts';
import type { Runner } from './run.ts';
import { loadSettings, SETTINGS_SPEC } from './settings.ts';
import { context, loadLastStage, loadStaff, refreshStaff, runStage, type StageAsk } from './steward.ts';
import { renderBody } from './view.ts';

/**
 * The Steward at work on its page: the staff's table, and a button for each stage. A stage runs in this
 * process, one at a time (and never beside one run from a terminal: the stage lock), and the page
 * refreshes itself while it runs.
 *
 * Its duty (start and stop, from Manor) works as every agent's does. Its round (stages/round.ts) comes every
 * few minutes while it's on duty and Settings say it merges and releases by itself, through the kit's every()
 * in schedule.ts: every ready PR of its own and the team's merged, with what each asks for after, and every
 * version not yet released released. Run now does one round, on duty or not.
 */

const ICON = readFileSync(new URL('../art/icon.svg', import.meta.url), 'utf8');

/** The staff's table counts as stale after this long, and the page refreshes it in the background. */
const STALE_MS = 10 * 60_000;

/** What a stage's POST asks: the ticked employees, the kit shown on the page. */
export function askOf(body: any): StageAsk {
  const employees = Array.isArray(body?.employees) ? body.employees.map(String).filter(Boolean).slice(0, 100) : [];
  const kit = typeof body?.kit === 'string' && /^\d+\.\d+\.\d+$/.test(body.kit) ? body.kit : null;
  return { employees, kit };
}

/** `run` stands in for git, gh and the employees' commands in a test. */
export async function serveSteward(o: { run?: Runner } = {}) {
  let running: { stage: string; since: string } | null = null;
  let refreshing: Promise<unknown> | null = null;

  const refresh = () => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        await refreshStaff(await context({ run: o.run }));
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
    void runStage(stage, ask, { run: o.run, log: (line) => console.log(`${stage}: ${line}`) })
      .catch((e) => console.error(`${new Date().toISOString()} ${stage}: ${(e as Error).message}`))
      .finally(() => (running = null));
    return { json: { started: true } };
  };

  const stagePost =
    (stage: 'bump' | 'push' | 'release'): Handler =>
    ({ body }) =>
      start(stage, askOf(body));

  // The table on the first visit, and again when it's old; the page shows the last one meanwhile.
  const staleTable = () => {
    const s = loadStaff();
    return !s || Date.now() - Date.parse(s.at) > STALE_MS;
  };
  if (staleTable()) void refresh();

  // The round (stages/round.ts): merge what's ready, the team's too, with what each PR asks for after; then
  // release what isn't. It passes while a stage runs here or in a terminal (the stage lock).
  const roundJob = async () => {
    if (running) return;
    running = { stage: 'round', since: new Date().toISOString() };
    try {
      await runStage('round', {}, { run: o.run, log: (line) => console.log(`round: ${line}`) });
    } catch (e) {
      if (!(e instanceof LockTimeout)) throw e;
    } finally {
      running = null;
    }
  };
  // On duty, every few minutes while Settings say it merges and releases by itself; the kit's every() pauses off
  // duty. Saving Settings starts, stops or re-times it.
  let rounds: ReturnType<typeof every> | null = null;
  const arrange = () => {
    const s = loadSettings();
    if (s.byItself && !rounds) rounds = every(() => loadSettings().roundMinutes * 60_000, roundJob, { name: 'round' });
    else if (!s.byItself && rounds) {
      rounds.stop();
      rounds = null;
    } else rounds?.reschedule();
  };
  arrange();

  const served = await serve({
    port,
    icon: ICON,
    ping: () => ({ busy: running !== null, stage: running?.stage ?? null }),
    get: {
      '/': ({ token }) => {
        if (!running && staleTable()) void refresh();
        const s = loadSettings();
        const state = rounds?.state;
        const round = { on: s.byItself, minutes: s.roundMinutes, onDuty: duty().onDuty, lastRunAt: state?.lastRunAt ?? null };
        const body = renderBody({ staff: loadStaff(), last: loadLastStage(), running, refreshing: refreshing !== null, team: s.team, round, alarms: s.alarms.on ? loadAlarms() : undefined });
        return { html: page({ token, body, busy: running !== null || refreshing !== null, title: running ? `(${running.stage}) ${APP.name}` : APP.name }) };
      },
      '/api/staff': () => ({ json: loadStaff() }),
      '/api/last-stage': () => ({ json: loadLastStage() }),
      // What needs the person (alarms.ts): Manor shows the open ones that aren't dismissed.
      '/api/alarms': () => {
        const a = loadAlarms();
        return { json: { on: loadSettings().alarms.on, at: a.at, open: a.open, cleared: a.cleared, page: '/#alarms' } };
      },
    },
    post: {
      '/api/stage/bump': stagePost('bump'),
      '/api/stage/push': stagePost('push'),
      // The page's buttons asked first: that is merge --yes, and merge --yes --team.
      '/api/stage/merge': ({ body }) => start('merge', { ...askOf(body), yes: true }),
      '/api/stage/merge-team': ({ body }) => start('merge', { ...askOf(body), yes: true, team: true }),
      '/api/stage/release': stagePost('release'),
      // A round now, as the schedule would run one (the button asks first), on duty or not.
      '/api/run': () => {
        if (running) return { json: { started: false, message: `${running.stage} is running; wait for it to finish.` } };
        void roundJob().catch((e) => console.error(`${new Date().toISOString()} round: ${(e as Error).message}`));
        return { json: { started: true } };
      },
      '/api/alarms/dismiss': ({ body }) => {
        const id = typeof body?.id === 'string' ? body.id.slice(0, 300) : '';
        return dismiss(id) ? { json: { ok: true } } : { json: { error: 'no such alarm open' }, status: 404 };
      },
      '/api/staff/refresh': () => {
        if (running) return { json: { started: false, message: `${running.stage} is running; the table is refreshed when it's done.` } };
        void refresh();
        return { json: { started: true } };
      },
    },
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
