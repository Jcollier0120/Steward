import { execFile } from 'node:child_process';
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
