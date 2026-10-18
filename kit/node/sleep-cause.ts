import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Sleeps a vendor's screen saver brings on (kit 2.84.0; spec/ROUND.md, "A vendor's screen saver can put the PC to
 * sleep"). On a Modern Standby PC, a program that turns the screen off (the SC_MONITORPOWER message) puts the PC to
 * sleep as the power button does, whatever an app holds, and the staff stop until someone comes back. Since Windows'
 * update KB5127646 (2026-10-14), ASUS's OLED Care screen saver (MyASUS's Pixel Refresh) does so about 30 s after it
 * starts: on the owner's Zenbook, 15 sleeps in four days, every one 22 to 30 s after a start in the screen saver's log.
 *
 * `saverSleeps()` pairs the two: each of Windows' Kernel-Power 506 entries ("entering Modern Standby") whose reason is
 * SC_MONITORPOWER, with a start of the screen saver 15 to 45 s before it that hadn't closed. Its `line` says so in the
 * person's words, and which setting to turn off, once it has happened twice in the last week and once in the last 3 days.
 *
 * Read-only and cheap: a few small log files, and Windows' event log asked once (wevtutil, about 60 ms) only when the
 * screen saver started in the week. A PC without the vendor's log reads one folder name and nothing more. It changes
 * no setting of the vendor's or Windows': the person turns it off, or doesn't. Not Windows, or under node --test
 * without a test's own folder and events: null.
 */

/** 506's `Reason` for a program turning the screen off (SC_MONITORPOWER); the lid is 15, idle 12. */
export const SC_MONITORPOWER = 3;
/** A sleep counts as the screen saver's when it came this long after a start (ms): measured 22 to 30 s. */
export const AFTER_START_MS: readonly [number, number] = [15_000, 45_000];
/** How far back it looks, in days. */
export const LOOK_DAYS = 7;
/** It says so once there are this many in the week... */
export const SAY_AFTER = 2;
/** ...and the last was within this many days: once the setting is off, the line goes by itself. */
export const SAY_WITHIN_DAYS = 3;

const DAY_MS = 24 * 3_600_000;

/** A vendor's screen saver that logs its starts, and what turns it off, in the person's words. */
export interface Saver {
  maker: string;
  app: string;
  setting: string;
  where: string;
  /** Its log for a local day (yyyy-mm-dd), under %ProgramData%. */
  log: (programData: string, day: string) => string;
}

/** ASUS's OLED Care (MyASUS's Pixel Refresh): its log is ARMOURY CRATE's, its name spelt so. */
export const ASUS_OLED_CARE: Saver = {
  maker: 'ASUS',
  app: 'OLED Care',
  setting: 'Pixel Refresh',
  where: 'MyASUS → OLED Care',
  log: (programData, day) => path.join(programData, 'ASUS', 'ARMOURY CRATE Diagnosis', 'ROGScreenSaver', `ROGSreenSaver_${day}.log`),
};

export interface SaverEvent {
  at: number;
  kind: 'start' | 'close';
}

/** The starts and closes in a day's log ("2026-10-17 13:06:04.307|INFO|Starts Window", "…|CloseScreenSaver"), in local time. */
export function saverEvents(text: string): SaverEvent[] {
  const out: SaverEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\|[^|]*\|\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const kind = m[8] === 'Starts Window' ? 'start' : /^CloseScreenSaver\b/.test(m[8]) ? 'close' : null;
    if (!kind) continue;
    const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] ?? '0').padEnd(3, '0')).getTime();
    if (Number.isFinite(at)) out.push({ at, kind });
  }
  return out;
}

export interface Standby {
  at: number;
  reason: number;
}

/** Kernel-Power 506 entries as wevtutil gives them (/f:xml): when, and why (506's `Reason`). */
export function standbysOf(xml: string): Standby[] {
  const out: Standby[] = [];
  for (const ev of xml.match(/<Event[\s>][\s\S]*?<\/Event>/g) ?? []) {
    const id = /<EventID[^>]*>(\d+)<\/EventID>/.exec(ev)?.[1];
    const time = /<TimeCreated\s+SystemTime=['"]([^'"]+)['"]/.exec(ev)?.[1];
    const reason = /<Data\s+Name=['"]Reason['"]>(\d+)<\/Data>/.exec(ev)?.[1];
    if (id !== '506' || !time || reason === undefined) continue;
    const at = Date.parse(time);
    if (Number.isFinite(at)) out.push({ at, reason: Number(reason) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The sleeps (ms) that came AFTER_START_MS after a start of the screen saver, with no close between. */
export function pairSleeps(events: SaverEvent[], standbys: Standby[]): number[] {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const out: number[] = [];
  for (const s of standbys) {
    if (s.reason !== SC_MONITORPOWER) continue;
    const before = sorted.filter((e) => e.at <= s.at).at(-1);
    if (before?.kind !== 'start') continue;
    const after = s.at - before.at;
    if (after >= AFTER_START_MS[0] && after <= AFTER_START_MS[1]) out.push(s.at);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "today at 11:10", "yesterday at 18:28", "Wednesday at 16:54": within the week, local time. */
export function whenWords(ms: number, now: number): string {
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = localDay(ms);
  if (day === localDay(now)) return `today at ${time}`;
  if (day === localDay(now - DAY_MS)) return `yesterday at ${time}`;
  return `${WEEKDAYS[d.getDay()]} at ${time}`;
}

/**
 * What the person is told, or null while there's nothing to say (fewer than SAY_AFTER in the week, or none in the last
 * SAY_WITHIN_DAYS days).
 */
export function saverSleepLine(saver: Saver, sleeps: number[], now: number): string | null {
  const last = sleeps.at(-1);
  if (sleeps.length < SAY_AFTER || last === undefined || now - last > SAY_WITHIN_DAYS * DAY_MS) return null;
  return `This PC went to sleep ${sleeps.length} times since ${whenWords(sleeps[0], now)}, the last ${whenWords(last, now)}, each about 30 seconds after ${saver.maker}'s ${saver.app} screen saver came on. The staff stop while it sleeps: to keep them working while you're away, turn off ${saver.setting} in ${saver.where}.`;
}

export interface SaverSleeps {
  saver: Saver;
  /** Each sleep the screen saver brought on in the week (ms), oldest first. */
  sleeps: number[];
  /** saverSleepLine's, or null. */
  line: string | null;
}

export interface SleepCauseDeps {
  /** %ProgramData%. */
  programData: string;
  /** Windows' Kernel-Power 506 entries of the last `ms`, as wevtutil's XML. */
  standbys: (ms: number) => Promise<string>;
}

const WEVTUTIL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wevtutil.exe');

/** The 506 entries of the last `ms`, newest first, 500 at most; '' when the log can't be read. */
function queryStandbys(ms: number): Promise<string> {
  const q = `*[System[Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=506) and TimeCreated[timediff(@SystemTime) <= ${Math.ceil(ms)}]]]`;
  return new Promise((resolve) =>
    execFile(WEVTUTIL, ['qe', 'System', `/q:${q}`, '/f:xml', '/rd:true', '/c:500'], { windowsHide: true, timeout: 30_000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (e, out) => resolve(e ? '' : String(out ?? ''))),
  );
}

/**
 * The sleeps a vendor's screen saver brought on in the last LOOK_DAYS days, or null when there were none (or this PC
 * has no such screen saver, or it isn't Windows). Never throws.
 */
export async function saverSleeps(o: Partial<SleepCauseDeps> & { now?: number; saver?: Saver } = {}): Promise<SaverSleeps | null> {
  try {
    const own = o.programData !== undefined && o.standbys !== undefined;
    if (!own && (process.platform !== 'win32' || process.env.NODE_TEST_CONTEXT)) return null;
    const now = o.now ?? Date.now();
    const saver = o.saver ?? ASUS_OLED_CARE;
    const programData = o.programData ?? process.env.ProgramData ?? 'C:\\ProgramData';
    const from = now - LOOK_DAYS * DAY_MS;
    // No folder: no such screen saver here, and nothing more to read.
    if (!existsSync(path.dirname(saver.log(programData, localDay(now))))) return null;
    const events: SaverEvent[] = [];
    for (let t = from; localDay(t) <= localDay(now); t += DAY_MS) {
      let text = '';
      try {
        text = readFileSync(saver.log(programData, localDay(t)), 'utf8');
      } catch {}
      events.push(...saverEvents(text).filter((e) => e.at >= from && e.at <= now));
    }
    const starts = events.filter((e) => e.kind === 'start');
    if (!starts.length) return null;
    const since = Math.min(...starts.map((e) => e.at));
    const standbys = standbysOf(await (o.standbys ?? queryStandbys)(now - since + AFTER_START_MS[1] + 60_000));
    const sleeps = pairSleeps(events, standbys.filter((s) => s.at >= from && s.at <= now));
    if (!sleeps.length) return null;
    return { saver, sleeps, line: saverSleepLine(saver, sleeps, now) };
  } catch {
    return null;
  }
}
