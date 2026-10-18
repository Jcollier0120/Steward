import { stayAwake } from './kit/awake.ts';
import { endWakeTask, keepWakeTask, type WakePlan } from './kit/wake.ts';
import { buildWhen, lastBuildTime, nextBuildTime, type BuildPipeline, type BuildRun, type PipelineState } from './pipeline.ts';

/**
 * Keeping the PC up for its builds (Steward 0.36.66). On a PC with only Modern Standby (a Snapdragon's), a sleep the
 * person chooses, the power button or Start's Sleep, or a program's turning the screen off, suspends the Steward with
 * every desktop app until something wakes the PC, whatever "sleep: never" says; that setting only stops the PC sleeping
 * on its own. A round's own holds (the kit's awake.ts) cover its work, and between builds a round only looks, so
 * nothing held the PC: on 2026-10-16 the owner's PC went into standby at 00:35 (30 s after ASUS's OLED Care screen
 * saver started: the kit's sleep-cause.ts), and the 08:00 build began at 08:39, when the mouse moved. So:
 * - From BEFORE_BUILD_MINUTES before each build time until its build closes, the Steward holds the PC (stayAwake), and
 *   at the build time it starts a round, so the build begins on time rather than at the next round.
 * - Plugged in, the PC is woken for each build: the kit's wake task (wake.ts) wakes it BEFORE_BUILD_MINUTES early, and
 *   runs until the build closes, when the Steward ends it (or for the most a build is held, by itself). While it runs,
 *   Task Scheduler keeps the PC out of sleep, which an app's hold doesn't on Modern Standby (kit/spec/ROUND.md). It's
 *   kept in step with Settings' build times, and removed when the Steward doesn't build here (off duty, not merging by
 *   itself).
 * Lean: nothing is held between builds, the display is never kept on, and a PC on battery is never woken. A build the
 * PC slept through anyway (on battery, say) still begins once it wakes, and says it was late (pipeline.ts' lateLine).
 */

export const BEFORE_BUILD_MINUTES = 5;
/** An open build is held this long past its window at most: its closing round's release holds the PC itself. */
export const AFTER_WINDOW_MS = 30 * 60_000;

/** "08:00", "08:00 and 18:00", "00:00, 06:00, 12:00 and 18:00". */
export function timesWords(times: string[]): string {
  return times.length <= 1 ? (times[0] ?? '') : `${times.slice(0, -1).join(', ')} and ${times.at(-1)}`;
}

/** A build's name in the log: "the 08:00 build", or the one under way when it wasn't a build time's. */
export const buildName = (run: BuildRun, now: Date): string => (run.by === 'schedule' ? `the ${buildWhen(new Date(run.due), now)} build` : 'the build under way');

/** What holds the PC for a build now. */
export interface BuildHold {
  /** "the 08:00 build". */
  what: string;
  /** Its build time has come and its build hasn't begun (ISO): a round now begins it. */
  due: string | null;
}

/**
 * What holds the PC for a build now, or null: a build under way (for its window, and AFTER_WINDOW_MS more at most); a
 * build time that has come whose build hasn't begun (for a window's length: a build the PC slept through longer begins
 * at its next round all the same); or the next build time, within BEFORE_BUILD_MINUTES. Pure.
 */
export function buildHold(p: BuildPipeline, state: PipelineState, now: Date): BuildHold | null {
  const t = now.getTime();
  const window = p.windowMinutes * 60_000;
  const open = state.open && !state.open.finished ? state.open : null;
  if (open) return t - Date.parse(open.started) < window + AFTER_WINDOW_MS ? { what: buildName(open, now), due: null } : null;
  const last = lastBuildTime(p, now);
  const lastDue = state.builds.filter((b) => b.by === 'schedule').at(-1)?.due;
  if (last && (!lastDue || Date.parse(lastDue) < last.getTime()) && t - last.getTime() < window) return { what: `the ${buildWhen(last, now)} build`, due: last.toISOString() };
  const next = nextBuildTime(p, now);
  if (next && next.getTime() - t <= BEFORE_BUILD_MINUTES * 60_000) return { what: `the ${buildWhen(next, now)} build`, due: null };
  return null;
}

/** The wake task's plan for Settings' build times: it holds the PC as long as a build is held at most (buildHold). */
export function buildWakePlan(p: BuildPipeline): WakePlan {
  return {
    times: p.times,
    days: p.days,
    beforeMinutes: BEFORE_BUILD_MINUTES,
    holdMinutes: BEFORE_BUILD_MINUTES + p.windowMinutes + AFTER_WINDOW_MS / 60_000,
    why: `the ${timesWords(p.times)} build${p.times.length === 1 ? '' : 's'}`,
  };
}

/** What holdForBuilds reaches outside itself, so a test can stand in for each. */
export interface BuildHoldDeps {
  /** Settings' build pipeline while the Steward builds at set times here (on duty, merging by itself); else null. */
  pipeline: () => BuildPipeline | null;
  state: () => PipelineState;
  /** A build time has come and its build hasn't begun: a round now. Once per build time. */
  onDue: () => void;
  log?: (line: string) => void;
  now?: () => Date;
  /** Holds the PC up until the function it returns is called (the kit's stayAwake). */
  hold?: (what: string) => () => void;
  /** Puts the wake task in step (the kit's keepWakeTask). */
  wake?: (plan: WakePlan | null, log: (line: string) => void) => Promise<unknown>;
  /** Ends the wake task's run, if it runs, once a build is let go (the kit's endWakeTask). */
  endWake?: (log: (line: string) => void) => Promise<unknown>;
  /** How often it looks (30 s); a test calls look() itself. */
  everyMs?: number;
}

/**
 * Holds the PC for each build and keeps the wake task in step, looking every 30 s (and when asked: at a wake, a
 * Settings save). The page's (agent.ts); returns look and stop. Never throws.
 */
export function holdForBuilds(d: BuildHoldDeps): { look: () => void; stop: () => void; holding: () => string | null } {
  const log = d.log ?? console.log;
  const now = d.now ?? (() => new Date());
  const hold = d.hold ?? ((what: string) => stayAwake(what, log));
  const wake = d.wake ?? keepWakeTask;
  const endWake = d.endWake ?? endWakeTask;
  let held: { what: string; letGo: () => void } | null = null;
  /** The build time a round was started for. */
  let nudged: string | null = null;
  /** The wake task's last putting in step, so two never run at once. */
  let waking: Promise<unknown> = Promise.resolve();
  const look = () => {
    try {
      const p = d.pipeline();
      const plan = p ? buildWakePlan(p) : null;
      waking = waking.then(() => wake(plan, log)).catch(() => {});
      const at = now();
      const h = p ? buildHold(p, d.state(), at) : null;
      if (h && held?.what !== h.what) {
        const before = held;
        held = { what: h.what, letGo: hold(h.what) };
        before?.letGo();
        log(`${at.toISOString()} the PC is held up for ${h.what}, until it has closed`);
      } else if (!h && held) {
        held.letGo();
        // The wake task that woke the PC for it, if it still runs, lets go too. A Steward that stops (an update, say)
        // leaves it running, so the PC stays up for the build until the Steward is back.
        waking = waking.then(() => endWake(log)).catch(() => {});
        log(`${at.toISOString()} the PC is let go after ${held.what}`);
        held = null;
      }
      if (h?.due && nudged !== h.due) {
        nudged = h.due;
        d.onDue();
      }
    } catch (e) {
      log(`${now().toISOString()} holding the PC for the builds: ${(e as Error).message}`);
    }
  };
  const timer = setInterval(look, d.everyMs ?? 30_000);
  timer.unref();
  return {
    look,
    stop: () => {
      clearInterval(timer);
      held?.letGo();
      held = null;
    },
    holding: () => held?.what ?? null,
  };
}
