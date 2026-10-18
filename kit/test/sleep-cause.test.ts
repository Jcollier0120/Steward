import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Sleeps a vendor's screen saver brings on (node/sleep-cause.ts): ASUS's OLED Care log and Windows' Kernel-Power 506
// entries paired, and the line that tells the person which setting to turn off. Windows' event log is stood in for.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-sleep-cause-'));
after(() => rmSync(home, { recursive: true, force: true }));

const S = await import('./fixture/src/kit/sleep-cause.ts');

/** Local time on 2026-10-<day>, as the screen saver's log writes it. */
const at = (day: number, h: number, m: number, s = 0, ms = 0) => new Date(2026, 9, day, h, m, s, ms).getTime();
const logLine = (t: number, what: string) => {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}|INFO|${what}`;
};
const start = (t: number) => `${logLine(t, '/s')}\n${logLine(t, 'Starts Window')}`;
const close = (t: number) => logLine(t, 'CloseScreenSaver ');
const event = (id: number, t: number, reason: number) =>
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-Power' Guid='{331c3b3a-2005-44c2-ac5e-77220c37d6b4}'/><EventID>${id}</EventID><Version>0</Version><TimeCreated SystemTime='${new Date(t).toISOString().replace('Z', '0000Z')}'/></System><EventData><Data Name='Reason'>${reason}</Data><Data Name='LidOpenState'>true</Data></EventData></Event>`;

const NOW = at(18, 12, 0);

test("the screen saver's log: its starts and closes, in local time", () => {
  const text = [start(at(17, 13, 6, 4, 307)), start(at(17, 17, 38, 44, 223)), close(at(17, 17, 39, 10, 848)), 'garbage', '2026-10-17 18:00:00.000|INFO|Something else'].join('\r\n');
  assert.deepEqual(S.saverEvents(text), [
    { at: at(17, 13, 6, 4, 307), kind: 'start' },
    { at: at(17, 17, 38, 44, 223), kind: 'start' },
    { at: at(17, 17, 39, 10, 848), kind: 'close' },
  ]);
});

test("Windows' 506 entries: when, and their reason; other events left out", () => {
  const xml = [event(506, at(18, 11, 10, 59), 3), event(566, at(18, 11, 10, 59), 3), event(506, at(17, 23, 41, 20), 12)].join('');
  assert.deepEqual(S.standbysOf(xml), [
    { at: at(17, 23, 41, 20), reason: 12 },
    { at: at(18, 11, 10, 59), reason: 3 },
  ]);
  assert.deepEqual(S.standbysOf(''), []);
});

test("a sleep is the screen saver's when the screen went off by a program 15 to 45 s after a start that hadn't closed", () => {
  const events = [
    { at: at(17, 13, 6, 4), kind: 'start' as const }, // slept 29 s later: counts
    { at: at(17, 14, 0, 0), kind: 'start' as const }, // closed after 26 s, then a sleep: not its
    { at: at(17, 14, 0, 26), kind: 'close' as const },
    { at: at(17, 15, 0, 0), kind: 'start' as const }, // a sleep 10 s later is too soon, 60 s too late
    { at: at(17, 16, 0, 0), kind: 'start' as const }, // the lid, then idle: not a program's
    { at: at(17, 16, 9, 54), kind: 'start' as const }, // 22 s, the quickest measured: counts
  ];
  const standbys = [
    { at: at(17, 9, 39, 25), reason: 3 }, // a sleep with no screen saver before it (the probe's)
    { at: at(17, 13, 6, 33), reason: 3 },
    { at: at(17, 14, 0, 30), reason: 3 },
    { at: at(17, 15, 0, 10), reason: 3 },
    { at: at(17, 15, 1, 0), reason: 3 },
    { at: at(17, 16, 0, 30), reason: 15 },
    { at: at(17, 16, 0, 31), reason: 12 },
    { at: at(17, 16, 10, 16), reason: S.SC_MONITORPOWER },
  ];
  assert.deepEqual(S.pairSleeps(events, standbys), [at(17, 13, 6, 33), at(17, 16, 10, 16)]);
});

test('the line: twice in the week and once in the last 3 days, in plain words with the setting to turn off', () => {
  const sleeps = [at(14, 16, 54, 10), at(17, 18, 28, 49), at(18, 11, 10, 59)];
  assert.equal(
    S.saverSleepLine(S.ASUS_OLED_CARE, sleeps, NOW),
    "This PC went to sleep 3 times since Wednesday at 16:54, the last today at 11:10, each about 30 seconds after ASUS's OLED Care screen saver came on. The staff stop while it sleeps: to keep them working while you're away, turn off Pixel Refresh in MyASUS → OLED Care.",
  );
  assert.match(S.saverSleepLine(S.ASUS_OLED_CARE, sleeps.slice(0, 2), NOW)!, /2 times since Wednesday at 16:54, the last yesterday at 18:28,/);
  assert.equal(S.saverSleepLine(S.ASUS_OLED_CARE, sleeps.slice(2), NOW), null, 'once is not yet worth saying');
  assert.equal(S.saverSleepLine(S.ASUS_OLED_CARE, [at(13, 9, 0), at(14, 16, 54)], NOW), null, 'none in the last 3 days: turned off, say');
  assert.equal(S.saverSleepLine(S.ASUS_OLED_CARE, [], NOW), null);
  assert.doesNotMatch(S.saverSleepLine(S.ASUS_OLED_CARE, sleeps, NOW)!, /agent/i);
});

test("the week's logs read, and Windows' log asked once, only when the screen saver started", async () => {
  const programData = path.join(home, 'ProgramData');
  const dir = path.dirname(S.ASUS_OLED_CARE.log(programData, '2026-10-18'));
  const asked: number[] = [];
  const standbys = async (ms: number) => {
    asked.push(ms);
    return [event(506, at(10, 9, 0, 30), 3), event(506, at(16, 0, 35, 57), 3), event(506, at(17, 18, 28, 49), 3), event(506, at(17, 23, 41, 20), 12)].join('');
  };

  // No folder: nothing more is read, and Windows' log isn't asked.
  assert.equal(await S.saverSleeps({ programData, standbys, now: NOW }), null);
  assert.equal(asked.length, 0);

  // A folder, but no start in the week: still not asked.
  mkdirSync(dir, { recursive: true });
  writeFileSync(S.ASUS_OLED_CARE.log(programData, '2026-10-10'), start(at(10, 9, 0, 0)));
  assert.equal(await S.saverSleeps({ programData, standbys, now: NOW }), null);
  assert.equal(asked.length, 0);

  writeFileSync(S.ASUS_OLED_CARE.log(programData, '2026-10-16'), start(at(16, 0, 35, 27, 696)));
  writeFileSync(S.ASUS_OLED_CARE.log(programData, '2026-10-17'), [start(at(17, 17, 38, 44)), close(at(17, 17, 39, 10)), start(at(17, 18, 28, 19, 910))].join('\n'));
  const found = await S.saverSleeps({ programData, standbys, now: NOW });
  assert.deepEqual(found?.sleeps, [at(16, 0, 35, 57), at(17, 18, 28, 49)], "the week's two; the 10th's is too old");
  assert.match(found!.line!, /^This PC went to sleep 2 times since Friday at 00:35, the last yesterday at 18:28,/);
  assert.equal(asked.length, 1);
  assert.ok(asked[0] >= NOW - at(16, 0, 35, 27, 696) && asked[0] <= 3 * 86_400_000, 'back to the first start, a little more');

  // Windows' log unreadable: nothing to say, never a throw.
  assert.equal(await S.saverSleeps({ programData, standbys: async () => '', now: NOW }), null);
  assert.equal(await S.saverSleeps({ programData, standbys: async () => Promise.reject(new Error('no')), now: NOW }), null);
});

test('under node --test, nothing of the PC is read without a test of its own', async () => {
  assert.equal(await S.saverSleeps({ now: NOW }), null);
});
