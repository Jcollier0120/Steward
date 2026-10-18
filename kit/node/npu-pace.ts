import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile } from './file-cache.ts';
import { acceleratorsDir } from './lock.ts';
import { manorHome } from './manor.ts';
import { serves, type Work } from './accelerators.ts';
import { Npu, NpuBusy } from './npu.ts';
import { CEILING_WORDS, LOAD, memoryInUse, PACE_CEILING } from './pace.ts';
import { powershell } from './ps.ts';
import { RULES } from './rules.ts';
import { outsideWork, withWork } from './work-tasks.ts';

/**
 * The NPU at full speed (kit 2.85.0, spec/ACCELERATORS.md's "The NPU at full speed"). The manor's gentle pace keeps
 * the processor, the graphics card, the disk and the network quiet; the NPU is the one part of the PC that is there
 * for this work, so model work an agent has more of than one round's calls runs back to back on it (`npuBacklog`),
 * outside the work line, for as long as the PC has room for it:
 *
 * - **plugged in**, and Windows' energy saver off;
 * - **cool**: no thermal zone holding the processor back (its passive limit under 100%);
 * - **nobody else on the NPU**: no program but the manor's model servers using it (Windows Studio Effects in a call,
 *   Live Captions, the person's own AI apps), over a second's look;
 * - **memory**: no more than the manor's ceiling of it in use (pace.ts' PACE_CEILING, 85%);
 * - **the processor**: under LOAD.busy (60%), whoever's work it is. The model server's own side (GenieX's 4 cores on
 *   the Snapdragon X2 while it answers back to back) counts in it, and the server runs apart, in the manor's ceiling;
 * - **one server**: requests go one after another to the server that's up (the NPU has one slot), each a turn of its
 *   own, so a person's request (the interactive lane) still goes first, and nothing starts or stops a server for it.
 *
 * Manor's settings.json `"npuPace": "gentle"` keeps the NPU at the rounds' own pace (each round's calls, no more);
 * anything else, or nothing, is full. Under node --test, gentle unless MANOR_NPU_PACE says: a test never works the PC's
 * real NPU. MANOR_NPU_PACE (full or gentle) says for any process.
 *
 * The look at the PC's power, heat and who uses the NPU is one PowerShell script, shared: the first agent that needs
 * it after RULES.npuPace.roomFreshMs looks, and writes `npu-room.json` in the accelerators folder for the others.
 */

export type NpuPaceSetting = 'full' | 'gentle';

/** What one look at the PC found: its power, its heat, and who else uses the NPU. */
export interface NpuRoom {
  /** When it was looked at, epoch ms. */
  at: number;
  /** On mains power (true), on its battery (false), or unknown (null). A PC with no battery is plugged in. */
  plugged: boolean | null;
  /** Windows' energy saver is on. */
  saver: boolean;
  /** The battery's charge, percent; null with no battery. */
  batteryPercent: number | null;
  /** The lowest passive limit among the thermal zones, percent (100: nothing held back); null when Windows has none to say. */
  passiveLimit: number | null;
  /** The programs using an NPU (a compute-only device) over the look's second, with how much of it. */
  npuUsers: { pid: number; name: string; percent: number }[];
  /** Why the look found nothing, when it failed. */
  problem?: string;
}

/** The NPU's pace now: full, or gentle and why. */
export interface NpuPaceNow {
  full: boolean;
  /** Why it's gentle, in words that end a sentence ("the NPU stays at the rounds' pace: <why>"); null at full. */
  why: string | null;
  room: NpuRoom | null;
}

export const NPU_ROOM_FRESH_MS = RULES.npuPace.roomFreshMs;
export const NPU_STRETCH_MS = RULES.npuPace.stretchMs;

/** The shared look's file, and its lock while someone looks. */
export const npuRoomFile = (dir = acceleratorsDir) => path.join(dir, 'npu-room.json');
const lookLock = (dir: string) => path.join(dir, 'npu-room.look');

/** The model servers the manor runs on an NPU: their use of it is the manor's own work, never another program's. */
export const MANOR_NPU_PROGRAMS = /^(geniex|llama-server|ovms|flm|npu-embed)$/i;

/** Manor's `npuPace`, MANOR_NPU_PACE over it; gentle under node --test unless MANOR_NPU_PACE says. */
export function npuPaceSetting(home = manorHome(), env: NodeJS.ProcessEnv = process.env): NpuPaceSetting {
  if (env.MANOR_NPU_PACE === 'full' || env.MANOR_NPU_PACE === 'gentle') return env.MANOR_NPU_PACE;
  if (env.NODE_TEST_CONTEXT) return 'gentle';
  const v = readJsonFile<Record<string, unknown> | null>(path.join(home, 'settings.json'), null)?.npuPace;
  return v === 'gentle' ? 'gentle' : 'full';
}

/**
 * Why the NPU stays at the rounds' pace, or null when it may run at full speed: the rule, from the setting, a look at
 * the room, and the memory and processor now (0 to 1). Pure.
 */
export function whyGentle(o: { setting: NpuPaceSetting; npuFirst?: boolean; room: NpuRoom | null; memory: number; busy: number | null; now?: number }): string | null {
  if (o.setting === 'gentle') return "Manor's Settings keep it at the rounds' pace";
  if (o.npuFirst === false) return 'no NPU here takes this work first';
  const r = o.room;
  if (!r) return "the PC's power, heat and NPU haven't been looked at yet";
  if (r.problem) return `the PC's power, heat and NPU couldn't be looked at (${r.problem})`;
  if (o.now !== undefined && o.now - r.at > 5 * NPU_ROOM_FRESH_MS) return "the last look at the PC's power, heat and NPU is too old";
  if (r.plugged === false) return 'the PC is on its battery';
  if (r.plugged === null) return "it isn't known whether the PC is plugged in";
  if (r.saver) return "Windows' energy saver is on";
  if (r.passiveLimit !== null && r.passiveLimit < 100) return `the PC is holding its processor back to cool down (to ${r.passiveLimit}%)`;
  const others = r.npuUsers.filter((u) => !MANOR_NPU_PROGRAMS.test(u.name) && u.percent >= RULES.npuPace.otherUsePercent);
  if (others.length) return `another program is using the NPU (${[...new Set(others.map((u) => u.name || `process ${u.pid}`))].join(', ')})`;
  if (o.memory > PACE_CEILING) return `more than ${CEILING_WORDS} of the memory is in use`;
  if (o.busy !== null && o.busy >= LOAD.busy) return `the processor is busy (${Math.round(o.busy * 100)}%)`;
  return null;
}

/** The look itself: one Windows PowerShell 5.1 script, its answer one line of JSON. */
export const ROOM_SCRIPT = `
$power = @{ supply = ''; battery = ''; percent = -1; saver = '' }
try {
  $null = [Windows.System.Power.PowerManager, Windows.System.Power, ContentType = WindowsRuntime]
  $pm = [Windows.System.Power.PowerManager]
  $power = @{ supply = [string]$pm::PowerSupplyStatus; battery = [string]$pm::BatteryStatus; percent = [int]$pm::RemainingChargePercent; saver = [string]$pm::EnergySaverStatus }
} catch { }
$zones = @(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction SilentlyContinue | Where-Object { $_.Temperature -gt 0 })
$passive = if ($zones.Count) { [int]($zones | Measure-Object PercentPassiveLimit -Minimum).Minimum } else { $null }
$graphics = @{}
$sample = {
  $out = @{}
  foreach ($e in @(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue)) {
    if ($e.Name -match 'luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_.*engtype_3D') { $graphics[$Matches[1]] = $true }
    if ($e.Name -match '^pid_(\\d+)_luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_.*engtype_Compute') { $out[$e.Name] = @([int]$Matches[1], $Matches[2], [double]$e.UtilizationPercentage, [double]$e.Timestamp_Sys100NS) }
  }
  $out
}
$a = & $sample
Start-Sleep -Milliseconds 1000
$b = & $sample
$use = @{}
foreach ($k in $b.Keys) {
  $x = $b[$k]; $y = $a[$k]
  if (-not $y -or $graphics[$x[1]]) { continue }
  $span = $x[3] - $y[3]
  if ($span -le 0) { continue }
  $pct = [math]::Round(100 * ($x[2] - $y[2]) / $span)
  if ($pct -gt 0) { $use[$x[0]] = [math]::Max([int]$use[$x[0]], [int]$pct) }
}
$users = @(foreach ($id in $use.Keys) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; [pscustomobject]@{ pid = [int]$id; name = if ($p) { $p.ProcessName } else { '' }; percent = [int]$use[$id] } })
[pscustomobject]@{ power = $power; passive = $passive; users = $users } | ConvertTo-Json -Depth 4 -Compress
`;

/** The script's answer as a room. Pure. */
export function roomOf(text: string, at: number): NpuRoom {
  const line = text.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  let j: any;
  try {
    j = JSON.parse(line);
  } catch {
    return { at, plugged: null, saver: false, batteryPercent: null, passiveLimit: null, npuUsers: [], problem: (line || 'no answer').slice(0, 200) };
  }
  const p = j?.power ?? {};
  const noBattery = p.battery === 'NotPresent';
  // PowerSupplyStatus: Adequate or Inadequate on mains, NotPresent on the battery. A PC with no battery is plugged in.
  const plugged = noBattery ? true : p.supply === 'Adequate' || p.supply === 'Inadequate' ? true : p.supply === 'NotPresent' ? false : null;
  const users = (Array.isArray(j?.users) ? j.users : j?.users ? [j.users] : []) as { pid: number; name: string; percent: number }[];
  return {
    at,
    plugged,
    saver: p.saver === 'On',
    batteryPercent: noBattery || typeof p.percent !== 'number' || p.percent < 0 ? null : p.percent,
    passiveLimit: typeof j?.passive === 'number' ? j.passive : null,
    npuUsers: users.map((u) => ({ pid: Number(u.pid) || 0, name: String(u.name ?? ''), percent: Number(u.percent) || 0 })),
  };
}

function readRoom(file: string): NpuRoom | null {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    return r && typeof r.at === 'number' ? r : null;
  } catch {
    return null;
  }
}

/**
 * The room as it stands: the shared look when it's under roomFreshMs old (and not from the future), else a new look,
 * written for every agent. While another agent looks (its lock folder under lookWaitMs old), the last look, however
 * old, or none. `look` and `now` are for tests.
 */
export async function npuRoom(o: { dir?: string; now?: () => number; look?: () => Promise<string> } = {}): Promise<NpuRoom | null> {
  const dir = o.dir ?? acceleratorsDir;
  const now = o.now ?? Date.now;
  const file = npuRoomFile(dir);
  const last = readRoom(file);
  const t = now();
  if (last && t - last.at < NPU_ROOM_FRESH_MS && last.at - t < 10_000) return last;
  const lock = lookLock(dir);
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(lock);
  } catch {
    // Someone looks now: theirs, when it's written. A lock left by a look that died is taken back after lookWaitMs.
    try {
      if (Date.now() - statSync(lock).mtimeMs < RULES.npuPace.lookWaitMs) return last;
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
    } catch {
      return last;
    }
  }
  try {
    const text = await (o.look ?? (() => powershell(ROOM_SCRIPT, { timeoutMs: RULES.npuPace.lookWaitMs })))().catch((e: Error) => `problem: ${e.message}`);
    const room = roomOf(text, now());
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(room) + '\n');
    renameSync(tmp, file);
    return room;
  } catch {
    return last;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** The room as last looked at, without looking: for a status (work-status.ts). */
export const lastNpuRoom = (dir = acceleratorsDir): NpuRoom | null => readRoom(npuRoomFile(dir));

interface CpuMark {
  idle: number;
  total: number;
  at: number;
}
const cpuMark = (): CpuMark => {
  let idle = 0;
  let total = 0;
  for (const { times: c } of os.cpus()) {
    idle += c.idle;
    total += c.user + c.nice + c.sys + c.idle + c.irq;
  }
  return { idle, total, at: Date.now() };
};
let mark: CpuMark | null = null;
let lastBusy: number | null = null;

/** The processor's use since the last ask (a second or more ago), else what it was then; a quarter second's look the first time. */
async function processorBusy(): Promise<number | null> {
  try {
    if (mark && Date.now() - mark.at < 1000) return lastBusy;
    let before = mark;
    if (!before || Date.now() - before.at > 120_000) {
      before = cpuMark();
      await new Promise((r) => setTimeout(r, 250));
    }
    const after = cpuMark();
    mark = after;
    const total = after.total - before.total;
    lastBusy = total > 0 ? Math.min(1, Math.max(0, 1 - (after.idle - before.idle) / total)) : null;
    return lastBusy;
  } catch {
    return null;
  }
}

const firstLooks = new Map<Work, { at: number; npu: boolean }>();

/**
 * Whether an NPU takes `work` first here: the first accelerator that serves it, in the order requests try them (Npu's
 * accelerators: Manor's "Use the graphics card for models when there's an NPU" applied), is an NPU. Full speed is the
 * NPU's alone: on a PC whose work goes to a graphics card or the processor, the rounds' pace stays. Kept a minute.
 */
export function npuTakesFirst(work: Work = 'chat'): boolean {
  const had = firstLooks.get(work);
  if (had && Date.now() - had.at < NPU_ROOM_FRESH_MS) return had.npu;
  let npu = false;
  try {
    npu = new Npu().accelerators.find((a) => a.enabled !== false && serves(a, work))?.kind === 'npu';
  } catch {}
  firstLooks.set(work, { at: Date.now(), npu });
  return npu;
}

/** The NPU's pace now for `work` (whyGentle, with the shared room and this moment's memory and processor). `o` is for tests. */
export async function npuPace(
  o: { work?: Work; setting?: NpuPaceSetting; npuFirst?: () => boolean; room?: () => Promise<NpuRoom | null>; memory?: () => number; busy?: () => Promise<number | null>; now?: () => number } = {},
): Promise<NpuPaceNow> {
  const setting = o.setting ?? npuPaceSetting();
  const npuFirst = setting === 'gentle' ? true : (o.npuFirst ?? (() => npuTakesFirst(o.work ?? 'chat')))();
  if (setting === 'gentle' || !npuFirst) return { full: false, why: whyGentle({ setting, npuFirst, room: null, memory: 0, busy: null }), room: null };
  const room = await (o.room ?? (() => npuRoom()))();
  const why = whyGentle({ setting, room, memory: (o.memory ?? memoryInUse)(), busy: await (o.busy ?? processorBusy)(), now: (o.now ?? Date.now)() });
  return { full: why === null, why, room };
}

/** How a stretch of an agent's backlog ended. */
export interface BacklogRun {
  /** The items it did. */
  done: number;
  ms: number;
  /** `done`: nothing left; `gentle`: the PC had no room for it (`why`); `budget`: its stretchMs were up; `busy`: the NPU's line was full or slow (NpuBusy); `failed`: an item failed (`why`); `stopping`: the agent is stopping; `running`: one by that name was under way already. */
  stopped: 'done' | 'gentle' | 'budget' | 'busy' | 'failed' | 'stopping' | 'running';
  why: string | null;
}

const underWay = new Set<string>();

/**
 * Model work an agent has more of than its round's calls (`name`: "notes", "captions"), done back to back on the NPU
 * while it may run at full speed (npuPace, for `work`: chat unless it says), `next` does one item, a request and keeping what it answered, and says
 * whether there was one (false: nothing left). Each item is a turn of its own in the NPU's line, so a person's request
 * and the other agents' get theirs in between. It stops when nothing is left, when the NPU is to be gentle (looked at
 * again before each item: a look is shared and stands a minute), after `budgetMs` (RULES.npuPace.stretchMs, 15
 * minutes), at an NpuBusy (the line full, or no turn in time: the next round tries again), at any other failure, and
 * when `signal` aborts. One by a name at a time in the agent: a second call while one runs returns at once. A task in
 * the agent's work status while it runs (work-tasks.ts). Never throws.
 */
export async function npuBacklog(
  name: string,
  next: () => Promise<boolean>,
  o: { work?: Work; budgetMs?: number; signal?: AbortSignal; pace?: () => Promise<Pick<NpuPaceNow, 'full' | 'why'>>; now?: () => number } = {},
): Promise<BacklogRun> {
  if (underWay.has(name)) return { done: 0, ms: 0, stopped: 'running', why: `its ${name} are under way already` };
  underWay.add(name);
  const now = o.now ?? Date.now;
  const started = now();
  let done = 0;
  const end = (stopped: BacklogRun['stopped'], why: string | null): BacklogRun => ({ done, ms: now() - started, stopped, why });
  try {
    return await withWork({ kind: 'model-backlog', what: `Its ${name}, on the NPU at full speed` }, async () => {
      for (;;) {
        if (o.signal?.aborted) return end('stopping', null);
        if (now() - started >= (o.budgetMs ?? NPU_STRETCH_MS)) return end('budget', `${Math.round((o.budgetMs ?? NPU_STRETCH_MS) / 60_000)} minutes of it at a time; the rest waits for its next round`);
        const p = await (o.pace ?? (() => npuPace({ work: o.work })))();
        if (!p.full) return end('gentle', p.why);
        let did: boolean;
        try {
          did = await next();
        } catch (e) {
          return e instanceof NpuBusy ? end('busy', (e as Error).message) : end('failed', (e as Error).message);
        }
        if (!did) return end('done', null);
        done++;
      }
    });
  } catch (e) {
    return end('failed', (e as Error).message);
  } finally {
    underWay.delete(name);
  }
}

/** A stretch's end, said in a line for the agent's log. */
export function backlogLine(name: string, r: BacklogRun): string {
  const did = `${r.done} of its ${name} on the NPU in ${Math.round(r.ms / 1000)} s`;
  switch (r.stopped) {
    case 'done':
      return `${did}: nothing left`;
    case 'running':
      return `its ${name}: under way already`;
    case 'stopping':
      return `${did}: it stopped with the agent`;
    case 'budget':
      return `${did}: ${r.why}`;
    case 'gentle':
      return `${did}; the rest waits for its next round: ${r.why}`;
    default:
      return `${did}; the rest waits for its next round (${r.why})`;
  }
}

/**
 * npuBacklog started beside the round that found it, outside the round (its own task, not the round's part), so the
 * round ends and gives back its place in the work line while the NPU works through the rest. Its end is said in the
 * agent's log. Returns at once, with the stretch's promise for whoever wants to wait on it.
 */
export function startNpuBacklog(name: string, next: () => Promise<boolean>, o: Parameters<typeof npuBacklog>[2] & { log?: (line: string) => void } = {}): Promise<BacklogRun> {
  const log = o.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  return outsideWork(() =>
    npuBacklog(name, next, o).then((r) => {
      if (r.stopped !== 'running' && (r.done || r.stopped !== 'gentle')) log(backlogLine(name, r));
      return r;
    }),
  );
}
