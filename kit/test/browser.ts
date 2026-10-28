import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A page run in a real browser, for a test of what only a browser does (focus, a fieldset's disabled, a click's way
 * through the document): the Chromium on this PC (Edge, Chrome or Chromium; KIT_TEST_BROWSER names another), headless,
 * driven over its DevTools protocol. A PC without one gets null, and its test is skipped.
 */

export function findBrowser(): string | null {
  const named = process.env.KIT_TEST_BROWSER;
  if (named) return existsSync(named) ? named : null;
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const places =
    process.platform === 'win32'
      ? pf.flatMap((p) => [path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')])
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return places.find((p) => existsSync(p)) ?? null;
}

/** Waits for `look` to give something, every few milliseconds, until `ms` have passed: then fails with `what`. */
export async function until<T>(look: () => T | undefined | null | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = look();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface Tab {
  /** An expression evaluated in the page, awaited when it's a promise; its value as JSON. Throws what the page threw. */
  run<T = unknown>(expression: string): Promise<T>;
  /** The browser closed, and its profile removed. */
  close(): Promise<void>;
}

/** A headless browser with one tab at `url`, once the page has loaded. */
export async function openTab(browser: string, url: string): Promise<Tab> {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'kit-browser-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  const gone = () => {
    child.kill();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  try {
    const file = path.join(profile, 'DevToolsActivePort');
    const port = await until(() => existsSync(file) && readFileSync(file, 'utf8').split('\n')[0].trim(), 20_000, 'the browser to start');
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('the browser has no tab');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, no) => {
      ws.onopen = ok;
      ws.onerror = () => no(new Error('could not reach the browser'));
    });
    let id = 0;
    const waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const w = msg.id === undefined ? undefined : waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id!);
      if (msg.error) w.no(new Error(msg.error.message));
      else w.ok(msg.result);
    };
    const send = (method: string, params: object) =>
      new Promise<unknown>((ok, no) => {
        waiting.set(++id, { ok, no });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const run = async <T,>(expression: string): Promise<T> => {
      const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value as T;
    };
    // A headless tab's window never has the system's focus, and without it the browser fires no focus events: as one in front.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Page.navigate', { url });
    const end = Date.now() + 20_000;
    while (!(await run<boolean>('document.readyState === "complete" && !!window.kitTest').catch(() => false))) {
      if (Date.now() > end) throw new Error(`timed out loading ${url}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    return {
      run,
      close: async () => {
        ws.close();
        gone();
      },
    };
  } catch (e) {
    gone();
    throw e;
  }
}
