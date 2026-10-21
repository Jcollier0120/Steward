import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, dataDir } from '../app.ts';
import { sharesConsole } from './console.ts';
import { LockTimeout, withLock } from './lock.ts';
import { manorHome } from './manor.ts';
import { parseProbe, ProgressParser, type MediaInfo, type Progress } from './media-probe.ts';
import { expandEnv } from './settings-kit.ts';
import { candidatesIn, chooseEncoder, parseEncoders, threadArgs, videoArgs, type Candidate, type Choice, type EncoderWords, type Preset, type Trial } from './video-encoders.ts';

/**
 * FFmpeg (kit 2.88.0): where it is, what it can encode here, running it, and fetching the manor's own build when this
 * PC has none. The Miller and the Chronicler each carried a copy (their ffmpeg.ts and getffmpeg.ts), pinned to
 * different builds; this is the Miller's, the newer of the two, with the Chronicler's build and its extra folder.
 *
 * One already on this PC comes first: the FFmpeg setting, PATH, the one the agent used last. When there's none, the
 * agent fetches the lean LGPL build made for the manor (dav1d and zlib, with Media Foundation, which reaches the PC's
 * own video encoder, and DirectShow, which reads capture cards), pinned by version and SHA-256. About 12 MB, once.
 *
 * Fetched once for every agent on the PC (getFfmpeg): into Manor's folder, %USERPROFILE%\.manor\ffmpeg\<version>, which
 * every agent's findTools looks in. Before kit 2.88.0 each agent fetched its own into its data folder; one fetched there
 * is still found, and an agent that can't write Manor's folder fetches into its own as before.
 */

// ------------------------------------------------------------------------------------------------
// The manor's build

export interface Build {
  version: string;
  url: string;
  sha256: string;
  /** The folder the zip holds, with bin\ffmpeg.exe and bin\ffprobe.exe (shared: their DLLs beside them). */
  folder: string;
}

/** The manor's public releases repository, where every release of the staff is too: FFmpeg by its tag, ffmpeg-v<version>. */
const RELEASE = 'https://github.com/Jcollier0120/Manor-releases/releases/download/ffmpeg-v8.1.3-6';

/**
 * Pinned builds by processor (Node's process.arch). The source and the build's configuration are in its release.
 * n8.1.3-5 (the Chronicler's pin since 2026-10-12) is n8.1.3-4 (the Miller's) with DirectShow, which reads capture cards.
 * n8.1.3-6 (kit 2.93.2) is n8.1.3-5 with every program and library in it signed by the manor: Smart App Control blocks
 * an unsigned program no one else runs, as the manor's build was.
 */
export const BUILDS: Record<string, Build> = {
  arm64: {
    version: 'n8.1.3-6',
    url: `${RELEASE}/ffmpeg-8.1.3-lean-lgpl-shared-win-arm64.zip`,
    sha256: '28a4b3aaf6d2fa99815d079d6d1619e57e235f5b98333aae7ff2e9de9b85eebf',
    folder: 'ffmpeg-8.1.3-lean-lgpl-shared-win-arm64',
  },
  x64: {
    version: 'n8.1.3-6',
    url: `${RELEASE}/ffmpeg-8.1.3-lean-lgpl-shared-win-x64.zip`,
    sha256: 'e26b6ec56ee89b39acb94792916bcb8346df1094f62432b5c18f56b286b1b12b',
    folder: 'ffmpeg-8.1.3-lean-lgpl-shared-win-x64',
  },
};

/**
 * Where the manor's build for this processor lives under `base` once fetched: <base>\ffmpeg\<version>\<folder>\bin.
 * The shared one's base is Manor's folder (manorHome()); an agent's own, its data folder.
 */
export function ownBin(base: string, arch: string = process.arch): string | null {
  const b = BUILDS[arch];
  return b ? path.join(base, 'ffmpeg', b.version, b.folder, 'bin') : null;
}

/**
 * Whether a folder is an older build of the manor's than the one pinned (<base>\ffmpeg\<version>\<folder>\bin, the
 * manor's lean build under a version no longer pinned). Those before n8.1.3-6 weren't signed, and Smart App Control
 * blocks them, so they're passed over (toolDirs) and the pinned build is fetched in their place.
 */
export function olderBuild(dir: string): boolean {
  const m = /[\\/]ffmpeg[\\/]([^\\/]+)[\\/]ffmpeg-[^\\/]*-lean-lgpl-shared-win-[^\\/]+[\\/]bin[\\/]?$/i.exec(dir);
  return !!m && !Object.values(BUILDS).some((b) => b.version === m[1]);
}

/** Whether a folder holds both programs (whether they run, findTools checks). */
const hasBoth = (bin: string) => existsSync(path.join(bin, 'ffmpeg.exe')) && existsSync(path.join(bin, 'ffprobe.exe'));

export interface FetchDeps {
  download: (url: string) => Promise<Buffer>;
  /** Unpacks a zip into a folder (Windows' own tar.exe). Null, or why it couldn't. */
  unzip: (zip: string, into: string) => string | null;
}

/** The real download (named for the agent, as GitHub likes) and unzip. */
const realDeps = (userAgent: string): FetchDeps => ({
  async download(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000), headers: { 'User-Agent': userAgent } });
    if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  },
  unzip(zip, into) {
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const r = spawnSync(tar, ['-xf', zip, '-C', into], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    return r.status === 0 ? null : (r.stderr || r.error?.message || `tar.exe exit ${r.status}`).trim().slice(0, 300);
  },
});

/** No second try sooner than this after one failed, so an offline PC isn't asked every round. */
const RETRY_MS = 15 * 60_000;
let lastFailure = 0;

/**
 * How long a fetch waits for another agent's fetch of the same build to end (the download's 5 minutes and the unzip's 2,
 * with room), and when that agent's hold is taken for one that died.
 */
const FETCH_WAIT_MS = 8 * 60_000;
const FETCH_STALE_MS = 15 * 60_000;

export interface GetOptions {
  /** The agent's data folder, for its own FFmpeg: app.ts' dataDir when left out. */
  dataDir?: string;
  /**
   * False: fetched into the agent's data folder alone, as before kit 2.88.0. Otherwise (the default) into Manor's
   * folder, shared by every agent, or into the agent's own when Manor's folder can't be made.
   */
  shared?: boolean;
  /** Manor's folder: manorHome() when left out. */
  home?: string;
  arch?: string;
  deps?: FetchDeps;
  now?: number;
  log?: (line: string) => void;
  /** The agent's name, in the download's User-Agent and in the lines: its APP.name when left out. */
  agent?: string;
}

/**
 * The manor's FFmpeg folder: there already (shared, or the agent's own), or fetched now. `{ dir }` when ffmpeg.exe and
 * ffprobe.exe are in it (whether they run, findTools checks), else `{ error }` in a line for the page. A failed try
 * waits RETRY_MS. Two agents fetching at once take turns (a lock beside the builds): the second finds the first's.
 */
export async function getFfmpeg(o: GetOptions = {}): Promise<{ dir: string } | { error: string }> {
  const arch = o.arch ?? process.arch;
  const agent = o.agent ?? APP.name;
  const b = BUILDS[arch];
  if (!b) return { error: `there's no FFmpeg build of the ${agent}'s for a ${arch} processor` };
  const own = o.dataDir ?? dataDir;
  const bases = o.shared === false ? [own] : [o.home ?? manorHome(), own];
  const there = bases.map((base) => ownBin(base, arch)!).find(hasBoth);
  if (there) return { dir: there };
  const now = o.now ?? Date.now();
  if (now - lastFailure < RETRY_MS) return { error: `fetching FFmpeg failed a moment ago, and is tried again within ${Math.round(RETRY_MS / 60_000)} minutes` };
  // Manor's folder when it can be made; else the agent's own, as before.
  const base = bases.find((x, i) => i === bases.length - 1 || canMake(path.join(x, 'ffmpeg')))!;
  const root = path.join(base, 'ffmpeg');
  const bin = ownBin(base, arch)!;
  try {
    mkdirSync(root, { recursive: true });
    return await withLock(path.join(root, '.fetching'), () => fetchInto(root, bin, b, o.deps ?? realDeps(agent), o.log), { waitMs: FETCH_WAIT_MS, staleMs: FETCH_STALE_MS });
  } catch (e) {
    lastFailure = now;
    if (e instanceof LockTimeout) return { error: `another program has been fetching FFmpeg into ${root} for ${Math.round(FETCH_WAIT_MS / 60_000)} minutes; it's looked for again on a later round` };
    const msg = (e as Error).message;
    return { error: /fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|aborted|timeout/i.test(msg) ? `couldn't reach GitHub to fetch FFmpeg (${msg}); it tries again on a later round` : `fetching FFmpeg failed: ${msg}` };
  }
}

/** Whether a folder is there or can be made. */
function canMake(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * One fetch, holding the folder's lock: the download, checked against the pinned SHA-256, unpacked beside the builds,
 * and only then moved into place. Nothing of a fetch that failed is kept. Another agent's, finished while this one
 * waited its turn, is taken as it is.
 */
async function fetchInto(root: string, bin: string, b: Build, deps: FetchDeps, log?: (line: string) => void): Promise<{ dir: string }> {
  if (hasBoth(bin)) return { dir: bin };
  const staging = path.join(root, `.${b.version}-${process.pid}`);
  const zip = `${staging}.zip`;
  try {
    log?.(`Fetching FFmpeg ${b.version} (LGPL) from ${new URL(b.url).host}`);
    const bytes = await deps.download(b.url);
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== b.sha256) throw new Error(`the download isn't the build it should be (SHA-256 ${got.slice(0, 12)}…, expected ${b.sha256.slice(0, 12)}…), so it wasn't used`);
    mkdirSync(staging, { recursive: true });
    writeFileSync(zip, bytes);
    const problem = deps.unzip(zip, staging);
    if (problem) throw new Error(`it couldn't be unpacked: ${problem}`);
    if (!existsSync(path.join(staging, b.folder, 'bin', 'ffmpeg.exe')) || !existsSync(path.join(staging, b.folder, 'bin', 'ffprobe.exe'))) {
      throw new Error("the download holds no ffmpeg.exe and ffprobe.exe where they should be");
    }
    const final = path.join(root, b.version);
    rmSync(final, { recursive: true, force: true });
    renameSync(staging, final);
    log?.(`FFmpeg ${b.version} is in ${bin}`);
    return { dir: bin };
  } finally {
    rmSync(zip, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Tests only: forget a failed try. */
export function _resetFfmpegFetch(): void {
  lastFailure = 0;
}

// ------------------------------------------------------------------------------------------------
// Finding it

/** Where Heiward keeps the FFmpeg it downloads (HEI.Agent/Installer.cs: <install>\bin). */
export const HEIWARD_BIN = '%LOCALAPPDATA%\\Programs\\Heiward\\bin';

/** Shared by every agent: the manor's build in Manor's folder (getFfmpeg). */
export const SHARED_SOURCE = "the staff's shared FFmpeg";

export interface ToolDir {
  dir: string;
  source: string;
}

/**
 * Folders to look for ffmpeg.exe + ffprobe.exe in, in order: the setting; PATH; the folder of the FFmpeg the agent
 * used last (`remembered`, from its state), so a build of your own it found once keeps being found; the manor's build
 * the staff share (`shared`, getFfmpeg); the agent's own (`own`, fetched into its data folder before kit 2.88.0, or
 * when Manor's folder couldn't be made); any `also` (the Chronicler looked at the Miller's); Heiward's. No folder of
 * anyone's PC is built in: a build elsewhere goes in the FFmpeg setting. An older build of the manor's (olderBuild) is
 * left out, but for the setting's: the pinned one is fetched in its place.
 */
export function toolDirs(o: {
  setting: string;
  pathDirs: string[];
  remembered?: string | null;
  shared?: string | null;
  own?: string | null;
  also?: ToolDir[];
  env?: NodeJS.ProcessEnv;
  /** The agent's name, as in "the Miller's own FFmpeg": its APP.name when left out. */
  agent?: string;
}): ToolDir[] {
  const out: ToolDir[] = [];
  const add = (dir: string, source: string, chosen = false) => {
    if (dir && (chosen || !olderBuild(dir)) && !out.some((d) => d.dir.toLowerCase() === dir.toLowerCase())) out.push({ dir, source });
  };
  if (o.setting.trim()) {
    const s = expandEnv(o.setting.trim(), o.env);
    add(/\.exe$/i.test(s) ? path.dirname(s) : s, 'the FFmpeg setting', true);
  }
  for (const d of o.pathDirs) if (d.trim()) add(d.trim(), 'PATH');
  if (o.remembered) add(o.remembered, 'the FFmpeg it used last');
  if (o.shared) add(o.shared, SHARED_SOURCE);
  if (o.own) add(o.own, `the ${o.agent ?? APP.name}'s own FFmpeg`);
  for (const d of o.also ?? []) add(d.dir, d.source);
  add(expandEnv(HEIWARD_BIN, o.env), "Heiward's FFmpeg");
  return out;
}

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
  dir: string;
  source: string;
  /** "n8.1.3-lean" */
  version: string;
  /** Identifies this exact build (path, size, time), so a changed FFmpeg is tested again. */
  stamp: string;
}

export interface ToolSearch {
  tools: Tools | null;
  /** Every folder looked at, and what was wrong with it. */
  looked: { dir: string; source: string; problem: string | null }[];
}

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a program to completion (or the timeout), collecting its output. It shares the page's windowless console when
 * there is one (console.ts), so it starts no console host (conhost.exe) of its own.
 */
export function run(cmd: string, args: string[], opts: { timeoutMs?: number; lowPriority?: boolean } = {}): Promise<Ran> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { windowsHide: !sharesConsole(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: (e as Error).message, timedOut: false });
      return;
    }
    if (opts.lowPriority) lower(child);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? 30_000);
    child.stdout!.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr!.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-20_000)));
    child.on('error', (e) => (stderr += e.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Below-normal priority, so an encode never slows what the person is doing. */
function lower(child: ChildProcess): void {
  try {
    if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // It may already have exited.
  }
}

/** FFmpeg's last meaningful stderr line, for the page. */
export function lastError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.replace(/^(\[[^\]]*\]\s*)+/, '').trim()).filter(Boolean);
  const telling = lines.filter((l) => !/^(Conversion failed|Error while opening encoder|Nothing was written|Task finished|Terminating thread|Could not open encoder before EOF|Error sending frames)/i.test(l));
  return (telling.at(-1) ?? lines.at(-1) ?? 'no message').slice(0, 300);
}

/** Why a passed-over FFmpeg isn't used, in `looked`. */
export const PASSED_OVER = "none of its encoders worked here, so it's passed over for another";

/**
 * Builds whose ffmpeg and ffprobe both ran `-version`, by the two files' stamps, with the version FFmpeg gave: the same
 * files run the same way, so later rounds don't start them just to ask again. A build that changes is asked again.
 */
const ran = new Map<string, string>();

export interface FindOptions {
  /** Runs `-version` (run; a test stands in). */
  start?: typeof run;
  /** The agent's data folder, for its own FFmpeg: app.ts' dataDir when left out. */
  dataDir?: string;
  /** False: the shared FFmpeg in Manor's folder isn't looked at (getFfmpeg's `shared: false`). */
  shared?: boolean;
  /** Manor's folder: manorHome() when left out. */
  home?: string;
  /** More folders, after the agent's own and before Heiward's. */
  also?: ToolDir[];
  /** The agent's name, in its own folder's source: its APP.name when left out. */
  agent?: string;
}

/**
 * The first folder with a working ffmpeg.exe and ffprobe.exe (`-version` must run: some builds crash on load), leaving
 * out the builds in `passOver`: stamps of ones none of whose encoders worked here (video-shrink.ts, decideEncoder). A
 * build that changes has a new stamp, so it's tried again.
 */
export async function findTools(setting: string, remembered: string | null = null, passOver: string[] = [], o: FindOptions = {}): Promise<ToolSearch> {
  const start = o.start ?? run;
  const dirs = toolDirs({
    setting,
    pathDirs: (process.env.PATH ?? '').split(path.delimiter),
    remembered,
    shared: o.shared === false ? null : ownBin(o.home ?? manorHome()),
    own: ownBin(o.dataDir ?? dataDir),
    also: o.also,
    agent: o.agent,
  });
  const looked: ToolSearch['looked'] = [];
  for (const d of dirs) {
    const ffmpeg = path.join(d.dir, 'ffmpeg.exe');
    const ffprobe = path.join(d.dir, 'ffprobe.exe');
    if (!existsSync(ffmpeg) || !existsSync(ffprobe)) {
      // PATH folders without FFmpeg aren't worth listing.
      if (d.source !== 'PATH') looked.push({ ...d, problem: existsSync(d.dir) ? 'no ffmpeg.exe and ffprobe.exe here' : "folder doesn't exist" });
      continue;
    }
    const st = statSync(ffmpeg);
    const stamp = `${ffmpeg}|${st.size}|${Math.round(st.mtimeMs)}`;
    const pst = statSync(ffprobe);
    const both = `${stamp}|${pst.size}|${Math.round(pst.mtimeMs)}`;
    let version = ran.get(both);
    if (version === undefined) {
      const r = await start(ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 15_000 });
      const probe = await start(ffprobe, ['-hide_banner', '-version'], { timeoutMs: 15_000 });
      if (r.code !== 0 || probe.code !== 0) {
        looked.push({ ...d, problem: `doesn't run here (exit ${r.code ?? 'none'}${r.timedOut ? ', timed out' : ''}): ${lastError(r.stderr || probe.stderr)}` });
        continue;
      }
      version = /ffmpeg version (\S+)/.exec(r.stdout)?.[1] ?? 'unknown';
      ran.set(both, version);
    }
    if (passOver.includes(stamp)) {
      looked.push({ ...d, problem: PASSED_OVER });
      continue;
    }
    looked.push({ ...d, problem: null });
    return { tools: { ffmpeg, ffprobe, dir: d.dir, source: d.source, version, stamp }, looked };
  }
  return { tools: null, looked };
}

// ------------------------------------------------------------------------------------------------
// What it can encode here

/** A one-second test encode of FFmpeg's own test picture with exactly the options an encode would use. */
export async function testEncode(t: Tools, c: Candidate, preset: Preset): Promise<Trial> {
  const a = videoArgs(c, preset, { width: 640, height: 360, fps: 30, bitRate: null });
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error', ...a.global,
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=1',
    ...(a.filters.length ? ['-vf', a.filters.join(',')] : []),
    ...a.video, '-f', 'null', '-',
  ];
  const r = await run(t.ffmpeg, args, { timeoutMs: 60_000, lowPriority: true });
  return r.code === 0 ? { name: c.name, ok: true } : { name: c.name, ok: false, error: r.timedOut ? 'the test encode timed out' : lastError(r.stderr) };
}

/** The encoders this FFmpeg lists, tried in order of preference until one works. `words` name the agent in the need. */
export async function pickEncoder(t: Tools, preset: Preset, words: EncoderWords = {}): Promise<Choice & { listed: string[] }> {
  const r = await run(t.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 15_000 });
  const listed = candidatesIn(parseEncoders(r.stdout));
  const trials: Trial[] = [];
  for (const c of listed) {
    const trial = await testEncode(t, c, preset);
    trials.push(trial);
    if (trial.ok) break;
  }
  return { ...chooseEncoder(listed, trials, words), listed: listed.map((c) => c.name) };
}

// ------------------------------------------------------------------------------------------------
// Running it

/** ffprobe's view of a file, or why it couldn't say. */
export async function probe(t: Tools, file: string): Promise<{ info: MediaInfo } | { error: string }> {
  const r = await run(t.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60_000 });
  if (r.code !== 0) return { error: lastError(r.stderr) };
  try {
    return { info: parseProbe(JSON.parse(r.stdout)) };
  } catch (e) {
    return { error: `ffprobe's answer couldn't be read: ${(e as Error).message}` };
  }
}

export interface EncodeJob {
  args: string[];
  /** Called with each progress block. Return a reason to stop early (the copy is then discarded). */
  onProgress: (p: Progress) => string | null | void;
}

export interface Running {
  done: Promise<{ ok: boolean; stopped: string | null; error: string | null }>;
  kill: (reason: string) => void;
}

/** No progress for this long means FFmpeg is stuck. */
const STALL_MS = 10 * 60_000;

/** Runs one encode at below-normal priority, reporting progress from `-progress pipe:1`. */
export function encode(t: Tools, job: EncodeJob): Running {
  const child = spawn(t.ffmpeg, job.args, { windowsHide: !sharesConsole(), stdio: ['ignore', 'pipe', 'pipe'] });
  lower(child);
  let stopped: string | null = null;
  let stderr = '';
  let last = Date.now();
  const parser = new ProgressParser();
  const kill = (reason: string) => {
    if (!stopped) stopped = reason;
    child.kill();
  };
  const stall = setInterval(() => Date.now() - last > STALL_MS && kill('FFmpeg made no progress for 10 minutes'), 30_000);
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    for (const p of parser.push(d)) {
      last = Date.now();
      const why = job.onProgress(p);
      if (why) kill(why);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-20_000)));
  const done = new Promise<{ ok: boolean; stopped: string | null; error: string | null }>((resolve) => {
    child.on('error', (e) => {
      clearInterval(stall);
      resolve({ ok: false, stopped, error: e.message });
    });
    child.on('close', (code) => {
      clearInterval(stall);
      resolve({ ok: code === 0 && !stopped, stopped, error: code === 0 ? null : lastError(stderr) });
    });
  });
  return { done, kill };
}

/**
 * The full argument list for re-encoding one video. `format` is the container written: MP4 when left out (a Miller
 * project's MOV stays MOV). `cores` holds the encode to that many threads (video-encoders.ts, grindCores: a software
 * encode at the manor's gentle pace); null or left out, as many as it likes.
 */
export function grindArgs(o: {
  input: string;
  output: string;
  c: Candidate;
  preset: Preset;
  shape: { width: number; height: number; fps: number | null; bitRate: number | null };
  audio: { codec: string; channels: number }[];
  audioArgs: string[];
  cropToEven: boolean;
  format?: 'mp4' | 'mov';
  cores?: number | null;
}): string[] {
  const a = videoArgs(o.c, o.preset, o.shape);
  const th = threadArgs(o.c, o.cores ?? null);
  const filters = [...(o.cropToEven ? ['crop=trunc(iw/2)*2:trunc(ih/2)*2'] : []), ...a.filters];
  return [
    '-hide_banner', '-nostdin', '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1',
    ...a.global,
    ...th.input,
    '-i', o.input,
    '-map', '0:v:0', ...(o.audio.length ? ['-map', '0:a'] : []),
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    ...a.video,
    ...th.video,
    ...o.audioArgs,
    // Keep the original's timing (screen recordings are often variable frame rate) and its tags
    // (creation time, camera make and place).
    '-fps_mode', 'passthrough', '-map_metadata', '0', '-movflags', '+faststart+use_metadata_tags',
    '-f', o.format ?? 'mp4', o.output,
  ];
}

/** One frame from a video, at `atSeconds`, as a PNG at most 1024 px wide, for the vision model. Null, or why not. */
export async function extractFrame(t: Tools, video: string, atSeconds: number, png: string): Promise<string | null> {
  const r = await run(
    t.ffmpeg,
    ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-ss', atSeconds.toFixed(2), '-i', video, '-frames:v', '1', '-vf', "scale='min(1024,iw)':-2", png],
    { timeoutMs: 60_000, lowPriority: true },
  );
  return r.code === 0 && existsSync(png) ? null : lastError(r.stderr) || 'no frame came out';
}
