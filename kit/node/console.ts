import { closeSync, openSync } from 'node:fs';

/**
 * Whether this process has a console that the console programs it starts (git, gh) can share (kit 2.72.2): a
 * terminal's, or the windowless one a page keeps from the way it's started (service.ts's open).
 *
 * On Windows a console program started with windowsHide, or from a process with no console, gets a console host
 * (conhost.exe) of its own: a second process for every git, all day. Started without windowsHide from a process that
 * has a console, it shares that one, and opens no window (the page's has none). So: `windowsHide: !sharesConsole()`.
 *
 * Asked again each time while the answer is yes (kit 2.86.1): a console can go while its process runs on. Once its host
 * has ended (the terminal it came from was closed, or Task Scheduler ended the job the host was in), every console
 * program started to share it fails before it runs: exit 3221225794 (0xC0000142, DLL_INIT_FAILED). On 2026-10-17
 * Manor's update ended its task, and with it every agent page's console host: the Smith, Pinder, the Warrener and the
 * Toller failed every git and PowerShell for 23 hours. The look is one open of `\\.\CONOUT$`, no process. Once the
 * console has gone the answer is no for good (a process doesn't get one back), and what it starts is hidden, as with
 * none. False elsewhere, where there's no console host to save.
 */
export function sharesConsole(): boolean {
  if (shares !== false) shares = hasConsole();
  return shares;
}
let shares: boolean | undefined;

/** 0xC0000142 (STATUS_DLL_INIT_FAILED), as Node gives the exit code of a console program that couldn't share a console that has gone. */
export const DLL_INIT_FAILED = 3221225794;

/**
 * Whether a program started to share this process's console (`windowsHide` false) failed only because the console had
 * gone: it exited DLL_INIT_FAILED, on Windows. When it did, sharesConsole says no from then on (the console went between
 * its look and the start), so the caller starts the program again, hidden.
 */
export function startFailed(code: number | null | undefined, windowsHide: boolean | undefined, platform: string = process.platform): boolean {
  if (platform !== 'win32' || windowsHide || code !== DLL_INIT_FAILED) return false;
  shares = false;
  return true;
}

/**
 * Whether this process has a console on Windows: the console's screen buffer, `\\.\CONOUT$`, opens only in a process
 * that has one, its output redirected or not, and not once the console's host has ended (EPIPE). False elsewhere (where
 * that name would be a file's).
 */
export function hasConsole(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    closeSync(openSync('\\\\.\\CONOUT$', 'w'));
    return true;
  } catch {
    return false;
  }
}
