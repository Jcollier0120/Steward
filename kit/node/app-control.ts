import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Windows' application control (kit 2.88.4): Smart App Control on a home PC, or an organization's own policy. Smart App
 * Control lets a program or library run only when its maker signed it or Microsoft's cloud knows it. llama.cpp's builds
 * (ggml-org's) and GenieX's aren't signed, so where it's on, one of their files can be blocked. On the owner's gaming
 * desktop (2026-10-19) it blocked ggml-cpu-ivybridge.dll, one of the processor variants ggml loads at each start to
 * choose the best (setup.ts keepCpuVariant), and nothing else.
 *
 * A block is in the Code Integrity log: events 3033 and 3077 name the file (3077 its policy too:
 * VerifiedAndReputableDesktop is Smart App Control). The log is readable without elevation, by an interactive or a
 * batch logon (its channelAccess), so a server that can't start can say why.
 */

/** One file Windows' application control blocked: its path as the log gives it, and its policy when the log names it. */
export interface Block {
  file: string;
  policy: string | null;
}

/** Asks the Code Integrity log an XPath query: its events as XML, or null when it can't be read. */
export type ReadLog = (query: string) => Promise<string | null>;

const WEVTUTIL = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wevtutil.exe');
const LOG = 'Microsoft-Windows-CodeIntegrity/Operational';

const readLog: ReadLog = (query) =>
  new Promise((resolve) =>
    execFile(WEVTUTIL, ['qe', LOG, `/q:${query}`, '/c:50', '/rd:true', '/f:xml'], { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (e, stdout) => resolve(e ? null : stdout)),
  );

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The blocks in wevtutil's XML: each 3033 or 3077 event's file, and its policy when it names one. */
export function parseBlocks(xml: string): Block[] {
  const blocks: Block[] = [];
  for (const ev of xml.split('</Event>')) {
    const id = /<EventID[^>]*>(\d+)<\/EventID>/.exec(ev)?.[1];
    if (id !== '3033' && id !== '3077') continue;
    const data = (name: string) => {
      const m = new RegExp(`<Data Name=['"]${name}['"]>([^<]*)</Data>`).exec(ev);
      return m ? unescape(m[1]) : null;
    };
    const file = data('File Name') ?? data('FileNameBuffer');
    if (file) blocks.push({ file, policy: data('PolicyName') || null });
  }
  return blocks;
}

/** A path as the log gives it (\Device\HarddiskVolume3\Users\…, \??\C:\…) or as Node does (C:\Users\…), without its volume, in lower case. */
const volumeless = (p: string) =>
  p.replace(/\//g, '\\').replace(/^\\Device\\HarddiskVolume\d+/i, '').replace(/^\\\?\?\\/, '').replace(/^[a-z]:/i, '').toLowerCase();

/** The blocks of files in `folder` or below it, one per file (3033 and 3077 come in pairs, and again at each start), its policy kept. */
export function blocksIn(blocks: Block[], folder: string): Block[] {
  const under = `${volumeless(folder).replace(/\\+$/, '')}\\`;
  const byFile = new Map<string, Block>();
  for (const b of blocks) {
    const key = volumeless(b.file);
    if (!key.startsWith(under)) continue;
    const had = byFile.get(key);
    byFile.set(key, { file: b.file, policy: had?.policy ?? b.policy });
  }
  return [...byFile.values()];
}

/**
 * The files in `folder` (or below it) Windows' application control blocked in the last `withinMs`. None when it blocked
 * nothing there, off Windows, or when the log can't be read: a block is said only when the log says it.
 */
export async function blockedIn(folder: string, withinMs: number, read?: ReadLog): Promise<Block[]> {
  // Tests pass their own log: the real one isn't asked from a test run.
  if (!read && (process.platform !== 'win32' || process.env.NODE_TEST_CONTEXT)) return [];
  const query = `*[System[(EventID=3033 or EventID=3077) and TimeCreated[timediff(@SystemTime) <= ${Math.max(1000, Math.round(withinMs))}]]]`;
  const xml = await (read ?? readLog)(query).catch(() => null);
  return xml ? blocksIn(parseBlocks(xml), folder) : [];
}

/** Smart App Control's policy, by the name the log gives it (VerifiedAndReputableDesktop, and its evaluation's). */
const smartAppControl = (policy: string | null) => !!policy && /VerifiedAndReputable/i.test(policy);

/** Whether Smart App Control blocked any of `blocks`, by the policy the log names. */
export const bySmartAppControl = (blocks: Block[]) => blocks.some((b) => smartAppControl(b.policy));

/**
 * Smart App Control's state on this PC (kit 2.93.1): on, evaluation (Windows is weighing whether to turn it on, and may
 * at any time), or off. Windows keeps it in the registry, readable without elevation: VerifiedAndReputablePolicyState
 * under CI\Policy, 1 on, 2 evaluation, 0 off.
 */
export type SacState = 'on' | 'evaluation' | 'off';

/** reg query's answer for VerifiedAndReputablePolicyState, as a state; null when it gives none Windows defines. */
export function parseSacState(out: string): SacState | null {
  const m = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
  const v = m ? parseInt(m[1], 16) : -1;
  return v === 1 ? 'on' : v === 2 ? 'evaluation' : v === 0 ? 'off' : null;
}

const REG = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');

const readSac = (): string | null => {
  try {
    return execFileSync(REG, ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', '/v', 'VerifiedAndReputablePolicyState'], {
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
};

/**
 * Smart App Control's state; null off Windows, on a Windows without it, or when it can't be read. One reg.exe, about
 * 20 ms: asked where something compiled on this PC (unsigned, so Smart App Control would block it) is about to run.
 */
export function smartAppControlState(read: () => string | null = readSac, platform: NodeJS.Platform = process.platform): SacState | null {
  if (platform !== 'win32') return null;
  const out = read();
  return out ? parseSacState(out) : null;
}

/**
 * Why `program` couldn't run, in the person's words, when Windows blocked part of it; null when it blocked nothing. Smart
 * App Control is named when the log names it; another policy (an organization's) by its name.
 */
export function blockedSay(blocks: Block[], program: string): string | null {
  if (!blocks.length) return null;
  const files = [...new Set(blocks.map((b) => path.win32.basename(b.file)))];
  const list = files.length === 1 ? files[0] : `${files.slice(0, -1).join(', ')} and ${files[files.length - 1]}`;
  const policy = blocks.find((b) => b.policy)?.policy ?? null;
  if (smartAppControl(policy))
    return `Windows' Smart App Control blocked ${list}, part of ${program}: its maker doesn't sign it, and Smart App Control blocks unsigned files it doesn't know`;
  if (!policy) return `Windows blocked ${list}, part of ${program}, because its maker doesn't sign it (Smart App Control, or a policy like it)`;
  return `Windows' application control (the policy ${policy}) blocked ${list}, part of ${program}`;
}

/**
 * The processor variant ggml chose as it started (`load_backend: loaded CPU backend from …\ggml-cpu-haswell.dll`), its
 * file name; null when it didn't say (a build with one ggml-cpu.dll, or output lost). x64's b11734 never says it, with
 * its output redirected as setup runs it (the gaming desktop, 2026-10-19): there the running server's modules tell
 * (loadedCpuVariant).
 */
export function cpuVariantLoaded(text: string): string | null {
  const m = /loaded CPU backend from (.*?ggml-cpu-[^\\/\s]+\.dll)/i.exec(text);
  return m ? path.win32.basename(m[1]) : null;
}

/**
 * Keeps only the processor variant ggml chose in a llama.cpp build's folder (kit 2.88.4), and returns the files
 * removed. ggml loads every ggml-cpu-*.dll at each start to choose the best for this processor, so one that Smart App
 * Control blocks (app-control.ts) is blocked again, and its notice shown again, at every start. The one chosen is the
 * one it would choose again, so nothing changes but that, and a quicker start. Nothing is removed when `chosen` isn't
 * there, nor a variant that can't be removed now.
 */
export function keepCpuVariant(folder: string, chosen: string | null): string[] {
  if (!chosen || !existsSync(path.join(folder, chosen))) return [];
  const removed: string[] = [];
  for (const f of readdirSync(folder)) {
    if (!/^ggml-cpu-.+\.dll$/i.test(f) || f.toLowerCase() === chosen.toLowerCase()) continue;
    try {
      rmSync(path.join(folder, f));
      removed.push(f);
    } catch { /* in use: kept, and asked of again by the next setup */ }
  }
  return removed;
}

/** How many processor variants a llama.cpp build's folder holds. */
export function cpuVariants(folder: string): number {
  try {
    return readdirSync(folder).filter((f) => /^ggml-cpu-.+\.dll$/i.test(f)).length;
  } catch {
    return 0;
  }
}

/** The ggml-cpu variant in `tasklist /m ggml-cpu-* /fo csv /nh`'s line for a process; null when it has none loaded. */
export function parseLoadedVariant(csv: string): string | null {
  const m = /"ggml-cpu-[^",\s]+\.dll/i.exec(csv);
  return m ? m[0].slice(1) : null;
}

const TASKLIST = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe');

/**
 * The processor variant a running llama-server loaded (kit 2.90.0): ggml loads every variant at the start, keeps the
 * best for this processor, and lets the others go, so once the server is ready its one ggml-cpu-*.dll is the choice
 * (ggml-cpu-alderlake.dll on the gaming desktop's Intel processor). Null off Windows, or when tasklist can't say.
 */
export function loadedCpuVariant(pid: number): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) =>
    execFile(TASKLIST, ['/m', 'ggml-cpu-*', '/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 15_000 }, (e, stdout) => resolve(e ? null : parseLoadedVariant(stdout))),
  );
}
