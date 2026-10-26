import { renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { encode, findTools, getFfmpeg, grindArgs, HEIWARD_SOURCE, pickEncoder, probe, tagArgs, type FindOptions, type GetOptions, type Running, type Tools, type ToolSearch } from './ffmpeg.ts';
import { setFileTimes } from './files.ts';
import { isHdr, type MediaInfo } from './media-probe.ts';
import { agentOf, audioArgs, RANKED, type Candidate, type Choice, type EncoderWords, type Preset } from './video-encoders.ts';

/**
 * Making a video smaller (kit 2.88.0): what to re-encode, choosing the encoder, the encode itself, and whether its copy
 * is kept, all code. A copy is kept only when every check passes: under 90% of the original's size, as long, the same
 * audio streams and the same picture size; otherwise it is discarded and the reason given. The Miller (mill.ts,
 * grindVideo and decideEncoder) and the Chronicler (shrink.ts, shrinkOne and encoderFor) each carried this; their
 * differences in words and in where a copy goes are the options here.
 */

export const MB = 1024 * 1024;

/** A copy must come in under this share of the original's size. */
export const MAX_RATIO = 0.9;
/** A video copy's length may differ by this much (seconds). */
export const DURATION_SLACK = 0.5;

export interface Check {
  /** `upright` is the Miller's photos' (its checks.ts): kept here so its photo checks share this type. */
  name: 'smaller' | 'duration' | 'audio' | 'dimensions' | 'video' | 'upright';
  ok: boolean;
  detail: string;
}

export type Plan<E> = { action: 'grind'; expected: E } | { action: 'skip'; reason: string };

export interface VideoExpected {
  width: number;
  height: number;
  duration: number;
  audioStreams: number;
  /** Crop to even dimensions first: 4:2:0 video needs them, and window recordings are often odd. */
  cropToEven: boolean;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(2)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

/** Whether to re-encode a video, and what the copy must look like. Videos under `videoMinMB` are left as they are. */
export function planVideo(info: MediaInfo, inBytes: number, s: { videoMinMB: number }): Plan<VideoExpected> {
  const v = info.video;
  if (!v || !v.width || !v.height) return { action: 'skip', reason: 'no video picture in it (audio only, or unreadable)' };
  if (!info.duration || info.duration <= 0) return { action: 'skip', reason: "its length can't be read, so the copy couldn't be checked against it" };
  if (isHdr(v)) return { action: 'skip', reason: `HDR video (${v.transfer}): a copy would lose the HDR look, so it is left as it is` };
  if (inBytes < s.videoMinMB * MB) return { action: 'skip', reason: `already small: ${fmtBytes(inBytes)}, under the ${s.videoMinMB} MB minimum` };
  const width = v.displayWidth - (v.displayWidth % 2);
  const height = v.displayHeight - (v.displayHeight % 2);
  return {
    action: 'grind',
    expected: { width, height, duration: info.duration, audioStreams: info.audio.length, cropToEven: width !== v.displayWidth || height !== v.displayHeight },
  };
}

/** The checks on a finished video copy. */
export function checkVideo(inBytes: number, expected: VideoExpected, outBytes: number, out: MediaInfo): Check[] {
  const checks: Check[] = [];
  checks.push({
    name: 'smaller',
    ok: outBytes > 0 && outBytes < inBytes * MAX_RATIO,
    detail: `${fmtBytes(inBytes)} → ${fmtBytes(outBytes)} (${pct(outBytes, inBytes)} of the original; must be under ${Math.round(MAX_RATIO * 100)}%)`,
  });
  if (!out.video) {
    checks.push({ name: 'video', ok: false, detail: 'the copy has no video stream' });
  } else {
    const ok = out.video.displayWidth === expected.width && out.video.displayHeight === expected.height;
    checks.push({ name: 'dimensions', ok, detail: `${out.video.displayWidth}×${out.video.displayHeight}${ok ? '' : `, expected ${expected.width}×${expected.height}`}` });
  }
  const d = out.duration;
  const diff = d === null ? Infinity : Math.abs(d - expected.duration);
  checks.push({
    name: 'duration',
    ok: diff <= DURATION_SLACK,
    detail: d === null ? "the copy's length can't be read" : `${d.toFixed(2)} s against ${expected.duration.toFixed(2)} s (${diff.toFixed(2)} s apart; at most ${DURATION_SLACK} s)`,
  });
  checks.push({
    name: 'audio',
    ok: out.audio.length === expected.audioStreams,
    detail: `${out.audio.length} audio stream${out.audio.length === 1 ? '' : 's'}${out.audio.length === expected.audioStreams ? '' : `, the original has ${expected.audioStreams}`}`,
  });
  return checks;
}

/** Kept only when every check passed; the refusal reason lists the ones that failed. */
export function verdict(checks: Check[]): { keep: boolean; reason: string | null } {
  const failed = checks.filter((c) => !c.ok);
  return failed.length ? { keep: false, reason: failed.map((c) => `${c.name}: ${c.detail}`).join('; ') } : { keep: true, reason: null };
}

// ------------------------------------------------------------------------------------------------
// Choosing the encoder

/** The encoder an agent chose and why, as it keeps it in its state (state.json's `encoder`) for its page. */
export interface EncoderState extends Choice {
  ffmpeg: { path: string; version: string; source: string } | null;
  /** Every folder looked at for FFmpeg, and what was wrong with it. */
  looked: { dir: string; source: string; problem: string | null }[];
  listed: string[];
  stamp: string | null;
  preset: string;
  checkedAt: string;
  /** Stamps of FFmpegs found here none of whose encoders worked: passed over for another until they change. */
  passedOver?: string[];
  /** Why the agent's own FFmpeg couldn't be fetched, when the one found can't encode: it's tried again next time. */
  ownFailed?: string | null;
}

/** What decideEncoder uses: FFmpeg's own in use (realEncoderDeps), stand-ins in tests. */
export interface EncoderDeps {
  find: (setting: string, remembered: string | null, passOver: string[]) => Promise<ToolSearch>;
  fetchOwn: () => Promise<{ dir: string } | { error: string }>;
  pick: (t: Tools, preset: Preset) => Promise<Choice & { listed: string[] }>;
}

/**
 * The real ones: findTools and getFfmpeg with `find` and `get`'s options (the agent's data folder, a shared FFmpeg or
 * not, more folders), getFfmpeg's lines in the agent's log, and pickEncoder with `words`.
 */
export function realEncoderDeps(o: { find?: FindOptions; get?: GetOptions; words?: EncoderWords } = {}): EncoderDeps {
  return {
    find: (setting, remembered, passOver) => findTools(setting, remembered, passOver, o.find),
    fetchOwn: () => getFfmpeg({ log: (line) => console.log(line), ...o.get }),
    pick: (t, preset) => pickEncoder(t, preset, o.words),
  };
}

const DAY = 24 * 3600_000;

/**
 * Finds FFmpeg and picks the encoder when there's no decision yet (`e`), the FFmpeg or preset changed, it's a day old,
 * or `force`: `encoder` is the new decision, or undefined when `e` stands (the agent saves it). None found and none
 * named in the FFmpeg setting, the agent fetches the manor's own (ffmpeg.ts, getFfmpeg); so too when only Heiward's
 * is found, which is borrowed only while the manor's can't be fetched (kit 2.136.6). One found on this PC none of
 * whose encoders works here (an older build without Media Foundation, say, on a Snapdragon) is passed over for the
 * next, in the end the manor's own, until that build changes. Never the one the FFmpeg setting names: that's the
 * person's choice. `words` name the agent in the lines it leaves for its page.
 */
export async function decideEncoder(
  s: { ffmpeg: string; preset: Preset },
  e: EncoderState | null,
  o: { force?: boolean; deps?: EncoderDeps; words?: EncoderWords } = {},
): Promise<{ t: Tools | null; encoder?: EncoderState }> {
  const d = o.deps ?? realEncoderDeps({ words: o.words });
  const agent = agentOf(o.words);
  const ownNeed = o.words?.ownNeed ?? `Nothing, once this PC can reach GitHub: the ${agent} fetches its own FFmpeg (about 12 MB, LGPL) and starts.`;
  // The FFmpeg it used last is looked at again, after the setting, the manor's build and PATH (ffmpeg.ts, toolDirs).
  const remembered = e?.ffmpeg?.path ? path.dirname(e.ffmpeg.path) : null;
  const passedOver = [...(e?.passedOver ?? [])];
  const look = async () => {
    let found = await d.find(s.ffmpeg, remembered, passedOver);
    // None on this PC, or only Heiward's, and none of the person's own named in Settings: the agent fetches the manor's
    // own. Heiward's is borrowed only while that can't be (kit 2.136.6), and isn't a failure to try again sooner for.
    let fetchError: string | null = null;
    let borrowed: string | null = null;
    if ((!found.tools || found.tools.source === HEIWARD_SOURCE) && !s.ffmpeg.trim()) {
      const got = await d.fetchOwn();
      if ('dir' in got) found = await d.find(s.ffmpeg, remembered, passedOver);
      else if (found.tools) borrowed = got.error;
      else fetchError = got.error;
    }
    return { found, fetchError, borrowed };
  };
  let { found, fetchError, borrowed } = await look();
  let t = found.tools;
  const fresh =
    e &&
    e.stamp === (t?.stamp ?? null) &&
    e.preset === s.preset &&
    Date.now() - Date.parse(e.checkedAt) < DAY &&
    (!e.chosen || RANKED.some((r) => r.name === e.chosen!.name));
  // A fetch that failed is tried again on a later round, not a day later.
  if (fresh && !o.force && !fetchError && !e.ownFailed) return { t };
  let choice = t ? await d.pick(t, s.preset) : null;
  let ownFailed: string | null = null;
  while (t && choice && !choice.chosen && t.source !== 'the FFmpeg setting') {
    passedOver.push(t.stamp);
    const next = await look();
    if (!next.found.tools) {
      // Nothing else to try: this one stays, its failed encoders saying why.
      passedOver.pop();
      ownFailed = next.fetchError;
      break;
    }
    found = next.found;
    borrowed = next.borrowed;
    t = next.found.tools;
    choice = await d.pick(t, s.preset);
  }
  const ffmpeg = t ? { path: t.ffmpeg, version: t.version, source: t.source } : null;
  const base = { ffmpeg, looked: found.looked, stamp: t?.stamp ?? null, preset: s.preset, checkedAt: new Date().toISOString(), passedOver, ownFailed };
  if (!t || !choice) {
    return {
      t,
      encoder: {
        ...base,
        chosen: null,
        listed: [],
        trials: [],
        why: s.ffmpeg.trim()
          ? "No FFmpeg found: the one the FFmpeg setting names doesn't run here."
          : `No FFmpeg yet: none on this PC, and ${fetchError ?? `the ${agent}'s own couldn't be fetched`}.`,
        need: s.ffmpeg.trim() ? `Clear the FFmpeg setting to let the ${agent} use its own, or point it at an ffmpeg.exe that runs.` : ownNeed,
      },
    };
  }
  if (ownFailed) return { t, encoder: { ...base, ...choice, why: `${choice.why} The ${agent}'s own FFmpeg, to try instead, couldn't be fetched: ${ownFailed}.`, need: ownNeed } };
  if (borrowed && t.source === HEIWARD_SOURCE) return { t, encoder: { ...base, ...choice, why: `${choice.why} It's Heiward's FFmpeg, borrowed until the ${agent}'s own can be fetched: ${borrowed}.` } };
  return { t, encoder: { ...base, ...choice } };
}

// ------------------------------------------------------------------------------------------------
// One video

/** Where an encode is: ffprobe reading the original, FFmpeg writing the copy, then the copy's checks. */
export type ShrinkPhase = 'reading' | 'encoding' | 'checking';

/** The words a refusal uses, where the Miller's and the Chronicler's differ. */
export interface ShrinkWords {
  /** Whose size an early stop says the copy passed: "the original's" when left out (the Chronicler: "the clip's"). */
  original?: string;
  /** A refusal's start when ffprobe can't read the file: "ffprobe couldn't read it" when left out (the Chronicler: "it couldn't be read"). */
  unreadable?: string;
}

export interface ShrinkJob {
  t: Tools;
  /** The encoder chosen (decideEncoder). */
  encoder: Candidate;
  preset: Preset;
  /** The original's size as the agent saw it, in bytes: the measure of "smaller". */
  inBytes: number;
  /** Videos under this many MB are left as they are (planVideo). */
  videoMinMB: number;
  /** Where the copy is written while it's made: asked once the plan says to make one, so a folder can be made then. */
  temp: () => string;
  /** Where a kept copy goes: asked once it passed its checks, so a name taken meanwhile gets one of its own. */
  final: () => string;
  /** At most this many threads (video-encoders.ts, grindCores); null or left out, as many as the encoder likes. */
  cores?: number | null;
  /** The container: MP4 when left out. */
  format?: 'mp4' | 'mov';
  /**
   * Whether the copy keeps every tag the original has, where it was filmed included (ffmpeg.ts, tagArgs): an agent's
   * setting, off by default, as the Miller's keepVideoTags. Left out (kit 2.137.2): only when it was recorded and each
   * track's language.
   */
  keepTags?: boolean;
  onPhase?: (phase: ShrinkPhase) => void;
  /** Each progress block: how far through (0 to 100), the copy's bytes so far, and FFmpeg's speed. */
  onProgress?: (p: { percent: number; outBytes: number; speed: number | null }) => void;
  /** The encode under way, so the agent can stop it; null once it's over. */
  onRunning?: (r: Running | null) => void;
  /** Whether the agent is stopping: an encode that ends then is no refusal, and shrinkVideo answers null. */
  stopping?: () => boolean;
  words?: ShrinkWords;
  /** ffprobe, FFmpeg and the copy's times (ffmpeg.ts, files.ts); stand-ins in tests. */
  deps?: ShrinkDeps;
}

export interface ShrinkDeps {
  probe: typeof probe;
  encode: typeof encode;
  setFileTimes: typeof setFileTimes;
}

const REAL_SHRINK_DEPS: ShrinkDeps = { probe, encode, setFileTimes };

/** What became of one video. */
export interface Shrunk {
  /** kept: a smaller copy passed its checks. refused: a copy was made and failed them, or couldn't be made. skipped: left as it is (planVideo). */
  status: 'kept' | 'refused' | 'skipped';
  reason: string | null;
  checks: Check[];
  outPath: string | null;
  outBytes: number | null;
  /** What made the copy ("hevc_mf, balanced"), once an encode ran. */
  how: string | null;
  /** ffprobe's view of the original, when it could read it (an agent keeps its length, tags or kind). */
  info: MediaInfo | null;
}

/**
 * Makes one video smaller: ffprobe reads it, planVideo says whether and what the copy must be, FFmpeg writes it to
 * `temp()` (stopped as soon as it passes MAX_RATIO of the original, since it can only be refused then), ffprobe reads
 * the copy, and the checks decide. A kept copy is moved to `final()` with the original's created and modified times,
 * so it sorts like the original; anything else is removed. Null when the agent stopped it (`stopping`).
 */
export async function shrinkVideo(file: string, j: ShrinkJob): Promise<Shrunk | null> {
  const w = { original: "the original's", unreadable: "ffprobe couldn't read it", ...j.words };
  const d = j.deps ?? REAL_SHRINK_DEPS;
  const none = { checks: [], outPath: null, outBytes: null, how: null };
  j.onPhase?.('reading');
  const p = await d.probe(j.t, file);
  if ('error' in p) return { status: 'refused', reason: `${w.unreadable}: ${p.error}`, ...none, info: null };
  const info = p.info;
  const plan = planVideo(info, j.inBytes, j);
  if (plan.action === 'skip') return { status: 'skipped', reason: plan.reason, ...none, info };

  const temp = j.temp();
  const args = grindArgs({
    input: file,
    output: temp,
    c: j.encoder,
    preset: j.preset,
    shape: { width: plan.expected.width, height: plan.expected.height, fps: info.video!.fps, bitRate: info.video!.bitRate ?? info.bitRate },
    audio: info.audio,
    audioArgs: audioArgs(info.audio, j.preset),
    cropToEven: plan.expected.cropToEven,
    format: j.format,
    cores: j.cores,
    tags: tagArgs(info, j.keepTags),
  });
  j.onPhase?.('encoding');
  const running = d.encode(j.t, {
    args,
    onProgress: (pr) => {
      const percent = Math.min(100, (pr.outTime / plan.expected.duration) * 100);
      j.onProgress?.({ percent, outBytes: pr.totalSize, speed: pr.speed });
      // Code decides early: a copy already past the size limit can only be refused.
      if (pr.totalSize >= j.inBytes * MAX_RATIO) return `the copy passed ${Math.round(MAX_RATIO * 100)}% of ${w.original} size (${fmtBytes(pr.totalSize)}) ${Math.round(percent)}% of the way through, so it can't come out smaller`;
      return null;
    },
  });
  j.onRunning?.(running);
  const r = await running.done;
  j.onRunning?.(null);
  const how = `${j.encoder.name}, ${j.preset}`;
  if (!r.ok) {
    rmSync(temp, { force: true });
    if (j.stopping?.()) return null;
    return { status: 'refused', reason: r.stopped ?? `FFmpeg failed: ${r.error}`, ...none, how, info };
  }

  j.onPhase?.('checking');
  const outBytes = statSync(temp).size;
  const op = await d.probe(j.t, temp);
  const checks: Check[] = 'error' in op ? [{ name: 'video', ok: false, detail: `the copy can't be read: ${op.error}` }] : checkVideo(j.inBytes, plan.expected, outBytes, op.info);
  const v = verdict(checks);
  if (!v.keep) {
    rmSync(temp, { force: true });
    return { status: 'refused', reason: v.reason, checks, outPath: null, outBytes, how, info };
  }
  const final = j.final();
  renameSync(temp, final);
  // The copy sorts like the original: the same created and modified times.
  try {
    const orig = statSync(file);
    await d.setFileTimes(final, orig.birthtime, orig.mtime);
  } catch {
    // Times are a courtesy; the copy is still good.
  }
  return { status: 'kept', reason: null, checks, outPath: final, outBytes, how, info };
}
