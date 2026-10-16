import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { APP, devCheckout } from '../app.ts';
import { awakeHelperExe } from './awake.ts';
import { taskUser, utf16, WAKE_TASK_NAME, type Ran } from './install.ts';
import { dataFile, readJson, writeJson } from './store.ts';

/**
 * Waking the PC for work due at set times (kit 2.78.2): the Steward's builds, say. A PC with only Modern Standby (S0, a
 * Snapdragon's) has no classic sleep, and a sleep the person chooses (the power button, Start's Sleep) suspends every
 * desktop app until something wakes it; the owner's PC slept so from 00:35 to 08:39 on 2026-10-16, past its 08:00 build.
 *
 * One Task Scheduler task per agent, \<Name>\Wake, with a trigger a few minutes before each time and "wake the computer
 * to run this task". It runs the awake helper (awake.cs) for a while (`--for`), which keeps the woken PC up until the
 * agent's own holds (awake.ts) take over. Kept in step with the agent's times by `keepWakeTask`, and removed when there
 * is nothing to wake for (and at uninstall).
 *
 * Lean: never on battery. The task starts only on AC power and stops if the PC goes on battery, and Windows' own
 * "Allow wake timers" on battery (off unless the person turned it on) keeps the PC from waking at all. It never turns
 * the display on. A development checkout, a test, and other platforms register nothing.
 */

/** A week's days, as the kit's schedules name them. */
export const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekDay = (typeof WEEK)[number];
const TASK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** What an agent wants the PC woken for. */
export interface WakePlan {
  /** The times work is due, local HH:MM, on each of `days`. */
  times: string[];
  days: readonly WeekDay[];
  /** How many minutes before each time the PC is woken. */
  beforeMinutes: number;
  /** How long the woken PC is held up, at most, if the agent's own holds don't take over (minutes). */
  holdMinutes: number;
  /** What it wakes for, in the task's description: "the 00:00, 06:00, 12:00 and 18:00 builds". */
  why: string;
}

/**
 * When the task wakes the PC: each time `beforeMinutes` earlier, on the day that makes (00:00 on a Monday wakes at
 * 23:55 on the Sunday), grouped by time, its days in the week's order.
 */
export function wakeTimes(plan: Pick<WakePlan, 'times' | 'days' | 'beforeMinutes'>): { time: string; days: WeekDay[] }[] {
  const at = new Map<string, Set<number>>();
  for (const t of plan.times) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) continue;
    for (const d of plan.days) {
      const day = WEEK.indexOf(d);
      if (day < 0) continue;
      const minute = day * 1440 + Number(m[1]) * 60 + Number(m[2]) - plan.beforeMinutes;
      const w = (minute + 7 * 1440) % (7 * 1440);
      const time = `${String(Math.floor((w % 1440) / 60)).padStart(2, '0')}:${String(w % 60).padStart(2, '0')}`;
      if (!at.has(time)) at.set(time, new Set());
      at.get(time)!.add(Math.floor(w / 1440));
    }
  }
  return [...at.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([time, days]) => ({ time, days: [...days].sort((a, b) => a - b).map((d) => WEEK[d]) }));
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The task: a calendar trigger for each wake time (daily, or on its days), waking the PC on AC to run the helper. */
export function wakeTaskXml(plan: WakePlan, o: { exe: string; user: string }): string {
  const triggers = wakeTimes(plan)
    .map(({ time, days }) => {
      const schedule =
        days.length === 7
          ? '<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>'
          : `<ScheduleByWeek><DaysOfWeek>${days.map((d) => `<${TASK_DAYS[WEEK.indexOf(d)]} />`).join('')}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>`;
      return `
    <CalendarTrigger>
      <StartBoundary>2020-01-01T${time}:00</StartBoundary>
      <Enabled>true</Enabled>
      ${schedule}
    </CalendarTrigger>`;
    })
    .join('');
  const hold = Math.max(1, Math.round(plan.holdMinutes));
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(`Wakes the PC, when it's plugged in, ${plan.beforeMinutes} minutes before ${plan.why}, and keeps it up for at most ${hold} minutes, until ${APP.name} holds it itself. Never on battery, and never the display. ${APP.name} keeps this task in step with its Settings.`)}</Description>
    <URI>${xmlEscape(WAKE_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>${triggers}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(o.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT${hold + 5}M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(o.exe)}</Command>
      <Arguments>--for ${hold * 60}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** Everything keepWakeTask reaches outside itself, so a test can stand in for each. */
export interface WakeDeps {
  /** Whether a task is registered here at all: Windows, an installed copy, not a test. */
  registers: boolean;
  schtasks(args: string[]): Promise<Ran>;
  /** The awake helper, built if it isn't yet; null when it can't be. */
  exe(log: (line: string) => void): Promise<string | null>;
  user: string;
  /** Where the task's definition is written for schtasks. */
  xmlFile: string;
  now(): number;
}

const SCHTASKS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe');

function runSchtasks(args: string[]): Promise<Ran> {
  return new Promise((resolve) =>
    execFile(SCHTASKS, args, { windowsHide: true, timeout: 60_000, encoding: 'utf8' }, (e, out, err) =>
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: `${out ?? ''}${err ?? ''}`.trim() }),
    ),
  );
}

const defaults = (): WakeDeps => ({
  registers: process.platform === 'win32' && !devCheckout && !process.env.NODE_TEST_CONTEXT,
  schtasks: runSchtasks,
  exe: awakeHelperExe,
  user: taskUser(),
  xmlFile: dataFile('wake.task.xml'),
  now: Date.now,
});
let deps: WakeDeps = defaults();

/** For tests: Task Scheduler and the helper stood in for; null puts the real ones back (and forgets what was set). */
export function setWakeDeps(d: Partial<WakeDeps> | null): void {
  deps = d ? { ...defaults(), ...d } : defaults();
  applied = undefined;
  failedAt = 0;
}

/** What this process last put in place: the task's key, 'none' once there is none, undefined before it looked. */
let applied: string | undefined;
/** When registering last failed: tried again an hour later, not at every look. */
let failedAt = 0;
let failedKey: string | undefined;
export const WAKE_RETRY_MS = 60 * 60_000;

const stateFile = () => dataFile('wake-task.json');

/** Whether this process put a wake task in place (or found it there): the PC is woken for the agent's times. */
export const wakesPc = (): boolean => applied !== undefined && applied !== 'none';

/** What keepWakeTask did. */
export type WakeOutcome = 'set' | 'same' | 'removed' | 'none' | 'failed';

/**
 * Puts the wake task in step with `plan`: registered (or replaced) when the plan changed, removed when there is none.
 * Cheap to call often: it asks Task Scheduler only when the plan changed since it last looked, and once per process.
 * Never throws; a failure is said in the log, and tried again an hour later.
 */
export async function keepWakeTask(plan: WakePlan | null, log: (line: string) => void = console.log): Promise<WakeOutcome> {
  if (!deps.registers) return 'none';
  try {
    if (!plan || !plan.times.length || !plan.days.length) {
      if (applied === 'none') return 'same';
      if (failedKey === 'none' && deps.now() - failedAt < WAKE_RETRY_MS) return 'failed';
      const had = readJson<{ key?: string }>(stateFile(), {}).key;
      if (had === undefined && (await deps.schtasks(['/Query', '/TN', WAKE_TASK_NAME])).code !== 0) {
        applied = 'none';
        return 'none';
      }
      const del = await deps.schtasks(['/Delete', '/TN', WAKE_TASK_NAME, '/F']);
      if (del.code !== 0 && (await deps.schtasks(['/Query', '/TN', WAKE_TASK_NAME])).code === 0) {
        failedKey = 'none';
        failedAt = deps.now();
        log(`${new Date(deps.now()).toISOString()} couldn't remove the task that wakes the PC (${WAKE_TASK_NAME}): ${del.out.slice(0, 300)}`);
        return 'failed';
      }
      applied = 'none';
      writeJson(stateFile(), {});
      log(`${new Date(deps.now()).toISOString()} removed the task that woke the PC (${WAKE_TASK_NAME}): nothing to wake it for`);
      return 'removed';
    }
    const exe = await deps.exe(log);
    if (!exe) return 'failed';
    const xml = wakeTaskXml(plan, { exe, user: deps.user });
    const key = createHash('sha256').update(xml).digest('hex').slice(0, 16);
    if (applied === key) return 'same';
    if (failedKey === key && deps.now() - failedAt < WAKE_RETRY_MS) return 'failed';
    if (applied === undefined && readJson<{ key?: string }>(stateFile(), {}).key === key && (await deps.schtasks(['/Query', '/TN', WAKE_TASK_NAME])).code === 0) {
      applied = key;
      return 'same';
    }
    writeFileSync(deps.xmlFile, utf16(xml));
    const made = await deps.schtasks(['/Create', '/TN', WAKE_TASK_NAME, '/XML', deps.xmlFile, '/F']);
    if (made.code !== 0) {
      failedKey = key;
      failedAt = deps.now();
      log(`${new Date(deps.now()).toISOString()} couldn't register the task that wakes the PC for ${plan.why} (${WAKE_TASK_NAME}): ${made.out.slice(0, 300)}`);
      return 'failed';
    }
    applied = key;
    writeJson(stateFile(), { key });
    const times = wakeTimes(plan).map((w) => w.time);
    log(`${new Date(deps.now()).toISOString()} the PC, plugged in, wakes at ${times.join(', ')} for ${plan.why} (${WAKE_TASK_NAME})`);
    return 'set';
  } catch (e) {
    log(`${new Date(deps.now()).toISOString()} couldn't keep the task that wakes the PC (${WAKE_TASK_NAME}): ${(e as Error).message.slice(0, 300)}`);
    return 'failed';
  }
}
