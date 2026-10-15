import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import nodeHttp, { type IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { chatBody, expandEnv, listsWhenLoaded, serverEnv, visionBody } from './accelerators.ts';
import type { Accelerator, AcceleratorEntry } from './accelerator-config.ts';
import { runPowerShell } from './detect.ts';
import { type NpuPlan, runProgram } from './npu-vendors.ts';
import { download, type NpuIo, setUpNpu, unpack } from './setup.ts';

/**
 * What the NPU check (npu-check.ts) and the NPU benchmark (npu-bench.ts) share: setting a route up as setup does
 * (without writing config.json), starting its server as the keeper would, asking it (plainly or streamed), and
 * stopping it with everything it started. Neither tool goes through the keeper or the NPU's turn: each needs the
 * server to itself, so each refuses to run beside one that already answers.
 */

/** A server a tool started itself: its process, and how to stop it (its whole tree). */
export interface RunningServer {
  pid: number | undefined;
  stop: () => Promise<void>;
}

const taskkill = (pid: number) =>
  new Promise<void>((resolve) => {
    const k = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('exit', () => resolve());
    k.on('error', () => resolve());
  });

/**
 * Starts a server from its entry, detached, its output appended to `logFile`; stopped with its whole tree. Its
 * command's %VARIABLES% are expanded as the keeper does (setup writes %USERPROFILE%\... paths): before kit 2.65.0
 * they weren't, so a tools home under the user's folder started nothing, and said nothing for 20 minutes.
 */
export async function startServer(entry: AcceleratorEntry, logFile: string): Promise<RunningServer> {
  const ep = entry.chat!;
  const [cmd, ...args] = ep.startCommand!.map((a) => expandEnv(a));
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, cwd: os.homedir(), env: serverEnv({ env: ep.env }) });
  closeSync(fd);
  child.on('error', (e) => appendFileSync(logFile, `couldn't start ${cmd}: ${e.message}\n`));
  child.unref();
  return { pid: child.pid, stop: () => (child.pid ? taskkill(child.pid) : Promise.resolve()) };
}

/**
 * Stops the server at `base` that the kit started (its started record names it), and waits up to 30 s for it to stop
 * answering, so nothing is left running. `answers` says whether something answers there within the time given.
 */
export async function stopStartedAt(base: string, answers: (timeoutMs: number) => Promise<boolean>, now: () => number): Promise<void> {
  if (!(await answers(1_000))) return;
  const { readStarted } = await import('./accelerators.ts');
  for (const s of readStarted().filter((x) => x.base === base)) await taskkill(s.pid);
  const t = now();
  while (now() - t < 30_000 && (await answers(1_000))) await new Promise((res) => setTimeout(res, 250));
}

/** A process's working set and private bytes, from Windows. */
export async function processMemory(pid: number): Promise<{ workingSetBytes: number; privateBytes: number } | null> {
  try {
    const out = await runPowerShell(`$p = Get-Process -Id ${pid} -ErrorAction Stop; "$($p.WorkingSet64)|$($p.PrivateMemorySize64)"`, 20_000);
    const [ws, priv] = out.trim().split('|').map(Number);
    return Number.isFinite(ws) ? { workingSetBytes: ws, privateBytes: priv } : null;
  } catch {
    return null;
  }
}

/** One plain request's answer: a failure (a timeout, a refused connection) is an answer too, `ok` false. */
export interface Asked {
  status: number;
  ok: boolean;
  ms: number;
  raw: string;
  /** The answer with any think block taken off. */
  answer: string;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  error: string | null;
}

/** A streamed request's answer: when its first token came, and each token after. */
export interface Streamed extends Asked {
  /** The server streamed (server-sent events); false when it answered all at once, so the times below are estimates. */
  streamed: boolean;
  /** From sending the request to the first token of the answer (reading the prompt). */
  firstTokenMs: number | null;
  /** Tokens a second between the first token and the last, from the server's own count where it gave one. */
  tokensPerSecond: number | null;
}

export const withoutThink = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();

/**
 * fetch for a local model server, limited only by the request's own signal. Node's fetch gives up on a server that
 * sends no headers for 300 s (undici's headersTimeout), whatever the signal allows: a slow NPU reading a long prompt
 * answers all at once, after that, and the check's steps allow 10 minutes. This is node:http, which waits as long as
 * the signal lets it; an https URL goes to fetch. A timed-out request fails as fetch's does (a TimeoutError).
 */
export const longFetch: typeof fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'http:') return fetch(input, init);
  const signal = init.signal ?? undefined;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let got: IncomingMessage | undefined;
    const abort = () => {
      got?.destroy(signal!.reason);
      req.destroy(signal!.reason);
    };
    const done = () => signal?.removeEventListener('abort', abort);
    // A connection of its own each time: a kept-alive one may be to a server stopped and started again since.
    const req = nodeHttp.request(url, { method: init.method ?? 'GET', headers, agent: false }, (res) => {
      got = res;
      res.on('close', done);
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
      const status = res.statusCode ?? 0;
      const empty = [101, 204, 205, 304].includes(status) || init.method === 'HEAD';
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? '', headers: h }));
    });
    signal?.addEventListener('abort', abort, { once: true });
    req.on('error', (e) => {
      done();
      reject(signal?.aborted ? signal.reason : e);
    });
    if (init.body !== undefined && init.body !== null) req.end(typeof init.body === 'string' ? init.body : Buffer.from(init.body as ArrayBuffer));
    else req.end();
  });
};

/** Talking to one server: asking it, plainly or streamed, and whether it answers. Its requests are longFetch's unless `http` is given. */
export function serverClient(acc: Accelerator, o: { http?: typeof fetch; now?: () => number } = {}) {
  const http = o.http ?? longFetch;
  const now = o.now ?? (() => performance.now());
  const ep = { ...acc.chat!, baseUrl: acc.chat!.baseUrl! };
  const kitAcc = acc as unknown as Parameters<typeof chatBody>[0];
  const failed = (t0: number, e: any, timeoutMs: number) => ({ status: 0, ok: false, ms: Math.round(now() - t0), raw: '', answer: '', usage: null, error: e?.name === 'TimeoutError' ? `no answer in ${Math.round(timeoutMs / 1000)} s` : String(e?.cause?.code ?? e?.message ?? e) });
  const bodyFor = (q: Question) => (q.image ? visionBody(kitAcc, { ...ep, model: acc.vision?.model ?? ep.model } as any, q.image, q.prompt, q.maxTokens) : chatBody(kitAcc, ep as any, [{ role: 'user', content: q.prompt }], q.maxTokens));

  /** One chat request, answered all at once; never throws. */
  const ask = async (prompt: string, maxTokens: number, timeoutMs: number): Promise<Asked> => {
    const t0 = now();
    let res: Response;
    let text: string;
    try {
      res = await http(`${ep.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyFor({ prompt, maxTokens })), signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
    } catch (e: any) {
      return failed(t0, e, timeoutMs);
    }
    const ms = Math.round(now() - t0);
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const raw = String(json?.choices?.[0]?.message?.content ?? '');
    return { status: res.status, ok: res.ok && typeof json?.choices?.[0]?.message?.content === 'string', ms, raw, answer: withoutThink(raw), usage: json?.usage ?? null, error: res.ok ? null : text.slice(0, 300) };
  };

  /**
   * One chat request, streamed with the server's usage in its last chunk, so reading (to the first token) and writing
   * (between tokens) are timed apart; never throws. A server that answers all at once instead is read that way, and
   * says so (`streamed` false).
   */
  const askStream = async (q: Question, timeoutMs: number): Promise<Streamed> => {
    const t0 = now();
    let res: Response;
    try {
      res = await http(`${ep.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...bodyFor(q), stream: true, stream_options: { include_usage: true } }), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) {
      return { ...failed(t0, e, timeoutMs), streamed: false, firstTokenMs: null, tokensPerSecond: null };
    }
    const sse = /text\/event-stream/i.test(res.headers.get('content-type') ?? '');
    if (!res.ok || !sse) {
      let text = '';
      try {
        text = await res.text();
      } catch (e: any) {
        return { ...failed(t0, e, timeoutMs), streamed: false, firstTokenMs: null, tokensPerSecond: null };
      }
      const ms = Math.round(now() - t0);
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {}
      const raw = String(json?.choices?.[0]?.message?.content ?? '');
      const ok = res.ok && typeof json?.choices?.[0]?.message?.content === 'string';
      return { status: res.status, ok, ms, raw, answer: withoutThink(raw), usage: json?.usage ?? null, error: res.ok ? (ok ? null : 'no answer in the reply') : text.slice(0, 300), streamed: false, firstTokenMs: null, tokensPerSecond: null };
    }
    const times: number[] = [];
    let raw = '';
    let usage: Streamed['usage'] = null;
    let buf = '';
    try {
      const decoder = new TextDecoder();
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(part, { stream: true }).replace(/\r\n/g, '\n');
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = event
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          if (!data || data === '[DONE]') continue;
          let j: any;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          const piece = j.choices?.[0]?.delta?.content;
          if (typeof piece === 'string' && piece) {
            times.push(now() - t0);
            raw += piece;
          }
          if (j.usage) usage = j.usage;
        }
      }
    } catch (e: any) {
      return { ...failed(t0, e, timeoutMs), raw, answer: withoutThink(raw), streamed: true, firstTokenMs: times.length ? Math.round(times[0]) : null, tokensPerSecond: null };
    }
    const ms = Math.round(now() - t0);
    const written = Number(usage?.completion_tokens) || times.length;
    const span = times.length > 1 ? (times[times.length - 1] - times[0]) / 1000 : 0;
    return {
      status: res.status,
      ok: times.length > 0,
      ms,
      raw,
      answer: withoutThink(raw),
      usage,
      error: times.length ? null : 'the stream carried no answer',
      streamed: true,
      firstTokenMs: times.length ? Math.round(times[0]) : null,
      tokensPerSecond: span > 0 && written > 1 ? Number(((written - 1) / span).toFixed(2)) : null,
    };
  };

  // Answering, and for a server that lists its model only once it's loaded (OpenVINO), listing it.
  const lists = listsWhenLoaded(ep.startCommand);
  const answers = async (timeoutMs = 5_000) => {
    try {
      const res = await http(`${ep.baseUrl}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok || !lists) return res.ok;
      const j: any = await res.json().catch(() => null);
      return !(Array.isArray(j?.data) && j.data.length === 0);
    } catch {
      return false;
    }
  };
  // Taking connections at all: what a server stopped no longer does.
  const listening = async (timeoutMs = 1_000) => {
    try {
      await (await http(`${ep.baseUrl}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })).text();
      return true;
    } catch {
      return false;
    }
  };
  /** How long until it answers (with its model loaded), or null past the deadline. */
  const untilAnswers = async (deadlineMs: number) => {
    const t0 = now();
    while (now() - t0 < deadlineMs) {
      if (await answers(2_000)) return Math.round(now() - t0);
      await new Promise((res) => setTimeout(res, 500));
    }
    return null;
  };
  /** Until it no longer takes connections, or 30 seconds: whether it's gone. */
  const untilGone = async () => {
    const t = now();
    while (now() - t < 30_000) {
      if (!(await listening(1_000))) return true;
      await new Promise((res) => setTimeout(res, 250));
    }
    return false;
  };
  /** Stops the server the kit's own test request started (its started record names it), so nothing is left running. */
  const stopKitStarted = () => stopStartedAt(ep.baseUrl, listening, now);
  return { ep, lists, ask, askStream, answers, listening, untilAnswers, untilGone, stopKitStarted };
}

/** One request: a prompt, and a picture with it for a vision model (a path or a `data:` URL). */
export interface Question {
  prompt: string;
  maxTokens: number;
  image?: string;
}

/**
 * Sets a route up as setup does, its server and models, each step timed, without writing config.json: the entry setup
 * would write (or the problems), and the time each kind of step took.
 */
export async function setUpRoute(plan: NpuPlan, tools: string, io: Partial<NpuIo>, log: (l: string) => void, now: () => number) {
  const timed: Record<string, number> = {};
  const time = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    const t0 = now();
    try {
      return await fn();
    } finally {
      timed[name] = (timed[name] ?? 0) + Math.round(now() - t0);
    }
  };
  let entry: AcceleratorEntry | undefined;
  const r = await setUpNpu(plan, tools, {
    ...io,
    log: (l) => log(`  ${l}`),
    download: (dl, progress) => time('download', () => (io.download ?? download)(dl, progress)),
    unpack: (zip, into) => {
      const t0 = now();
      (io.unpack ?? unpack)(zip, into);
      timed.unpack = Math.round(now() - t0);
    },
    run: (exe, args, ro) => time(args.some((a) => /pull/i.test(a)) ? 'pull' : 'install', () => (io.run ?? ((e, a, o) => runProgram(e, a, o)))(exe, args, ro)),
    testNpu: async (e) => {
      entry = e;
      return [];
    },
    // Its embedding server is measured by the caller, in a step of its own; so is the server (setup's calibration).
    testEmbed: async () => [],
    measure: io.measure ?? (async () => null),
  });
  return { entry, problems: r.problems, timed };
}
