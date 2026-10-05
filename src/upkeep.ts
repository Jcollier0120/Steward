import { appendFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, KIT_VERSION } from './kitfiles.ts';

/**
 * The Steward's housekeeping: stages.log kept small, the kit releases no one pins any more let go, and the pages that
 * want to know told when a release is out.
 */

/** Appends a line to a log that is rotated past `max` bytes: log → log.1 → log.2, and the oldest goes. */
export function appendRotating(file: string, line: string, o: { max?: number; keep?: number } = {}): void {
  const max = o.max ?? 1_000_000;
  const keep = o.keep ?? 2;
  try {
    if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > max) {
      const old = (n: number) => file.replace(/(\.[^.\\/]+)?$/, (ext) => `.${n}${ext}`);
      rmSync(old(keep), { force: true });
      for (let n = keep - 1; n >= 1; n--) if (existsSync(old(n))) renameSync(old(n), old(n + 1));
      renameSync(file, old(1));
    }
  } catch {
    // A log that can't be rotated (another process has it open) is appended to; the next line tries again.
  }
  appendFileSync(file, line);
}

/** Where tools/kit.ts keeps the kit releases it downloaded, for every agent on this PC. */
export const kitsDir = (env: NodeJS.ProcessEnv = process.env) => env.STEWARD_KITS ?? path.join(os.homedir(), '.steward', 'kits');

/**
 * Lets go of the kit versions in the kits folder that no one pins: not an employee's branch, not the Steward's own
 * kit.json, and not among the newest `keep`. One touched in the last day stays too (a fill may be reading it). A version
 * let go is fetched again by tools/kit.ts if anything asks for it. What it removed.
 */
export function pruneKits(dir: string, pinned: (string | null | undefined)[], o: { keep?: number; now?: number } = {}): string[] {
  if (!existsSync(dir)) return [];
  const keep = o.keep ?? 3;
  const now = o.now ?? Date.now();
  const versions = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && KIT_VERSION.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => compareVersions(b, a));
  const kept = new Set([...versions.slice(0, keep), ...pinned.filter((v): v is string => !!v)]);
  const removed: string[] = [];
  for (const v of versions) {
    if (kept.has(v)) continue;
    const at = path.join(dir, v);
    try {
      if (now - statSync(at).mtimeMs < 24 * 3600_000) continue;
      rmSync(at, { recursive: true, force: true });
      removed.push(v);
    } catch {
      // In use: the next time.
    }
  }
  return removed;
}

/** A local address only: the Steward tells pages on this PC, never anything further. */
export const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost|[a-z0-9-]+\.localhost)(:\d+)?\/[A-Za-z0-9/_.-]*$/;

export type HttpAnswer = { status: number; body: string } | { error: string };
export type HttpRequest = (url: URL, o: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs: number }) => Promise<HttpAnswer>;

/** One HTTP request, with a deadline: its status and body, or the reason it got none. */
export const request: HttpRequest = (url, o) => {
  return new Promise((resolve) => {
    const req = http.request(url, { method: o.method, headers: o.headers, timeout: o.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size < 2_000_000) chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer in ${o.timeoutMs / 1000} s`)));
    req.on('error', (e) => resolve({ error: e.message }));
    req.end(o.body);
  });
};

/**
 * A page's token, read as its own script would: GET its origin's `/`, and the `<meta name="page-token">` in it (Manor's
 * page and every kit page carry one). `{ error }` when the page gives no answer at all; `{ status }` alone when it
 * answers without a token.
 */
export async function pageToken(origin: URL, o: { timeoutMs: number; http?: HttpRequest }): Promise<{ token: string } | { status: number } | { error: string }> {
  const page = await (o.http ?? request)(new URL('/', origin), { method: 'GET', timeoutMs: o.timeoutMs });
  if ('error' in page) return page;
  const token = /<meta name="page-token" content="([0-9A-Za-z_-]{16,200})">/.exec(page.body)?.[1];
  return token ? { token } : { status: page.status };
}

/** The headers a POST to a manor page carries: its token (as Manor's guard and the kit's read it), and no Origin. */
export const tokenHeaders = (token: string) => ({ 'content-type': 'application/json', 'x-token': token, 'x-manor-token': token });

/**
 * POSTs a page's action as its own page would: the page at its origin read for its token (`<meta name="page-token">`,
 * which Manor's page and every kit page carry), then the POST with it, and no Origin, as a script that read the page
 * (Manor's and the kit's guard allow that). What it said, in a few words, or why it couldn't.
 */
export async function pokePage(target: string, o: { timeoutMs?: number } = {}): Promise<{ ok: boolean; said: string }> {
  if (!LOCAL_URL.test(target)) return { ok: false, said: 'not a local address' };
  const timeoutMs = o.timeoutMs ?? 5000;
  const url = new URL(target);
  const t = await pageToken(url, { timeoutMs });
  if ('error' in t) return { ok: false, said: t.error };
  if (!('token' in t)) return { ok: false, said: `its page (HTTP ${t.status}) carries no token` };
  const r = await request(url, { method: 'POST', headers: tokenHeaders(t.token), body: '{}', timeoutMs });
  if ('error' in r) return { ok: false, said: r.error };
  return { ok: r.status >= 200 && r.status < 300, said: `HTTP ${r.status}` };
}

export type Poke = typeof pokePage;

/**
 * After a stage released something: each page in Settings' "Told after a release" is POSTed (Manor's update check,
 * so it installs the release within minutes rather than at its next look, hours away; the Aletaster's Run now, so it
 * tastes it). A page that doesn't answer is only logged: none of this holds anything up. Never under node --test,
 * unless a test gives its own `poke`.
 */
export async function tellAfterRelease(urls: string[], log: (line: string) => void, poke?: Poke): Promise<void> {
  if (!poke && process.env.NODE_TEST_CONTEXT) return;
  const p = poke ?? pokePage;
  await Promise.all(
    urls.map(async (u) => {
      const r = await p(u).catch((e: Error) => ({ ok: false, said: e.message }));
      log(r.ok ? `told ${u} of the release (${r.said})` : `couldn't tell ${u} of the release: ${r.said}`);
    }),
  );
}
