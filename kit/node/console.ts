import { closeSync, openSync } from 'node:fs';

/**
 * Whether this process has a console that the console programs it starts (git, gh) can share (kit 2.72.2): a
 * terminal's, or the windowless one a page keeps from the way it's started (service.ts's open).
 *
 * On Windows a console program started with windowsHide, or from a process with no console, gets a console host
 * (conhost.exe) of its own: a second process for every git, all day. Started without windowsHide from a process that
 * has a console, it shares that one, and opens no window (the page's has none). So: `windowsHide: !sharesConsole()`.
 *
 * Asked once, as a process's console doesn't come and go. False elsewhere, where there's no console host to save.
 */
export function sharesConsole(): boolean {
  shares ??= hasConsole();
  return shares;
}
let shares: boolean | undefined;

/**
 * Whether this process has a console on Windows: the console's screen buffer, `\\.\CONOUT$`, opens only in a process
 * that has one, its output redirected or not. False elsewhere (where that name would be a file's).
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
