import os from 'node:os';
import { APP } from '../app.ts';
import type { Pace } from './pace.ts';

/**
 * Which video encoder to use, and with what options (kit 2.88.0, from the Miller's encoders.ts, which the Chronicler
 * carried). All of it is code: FFmpeg's own `-encoders` list says what is built in, a one-second test encode says what
 * actually opens on this PC (a listed hardware encoder can still be refused by the driver; ffmpeg.ts, pickEncoder),
 * and the preset maps to each encoder's options.
 */

/** How small a copy is made: the person's choice, in an agent's Settings. */
export type Preset = 'smaller' | 'balanced' | 'better';
export const PRESETS: Preset[] = ['smaller', 'balanced', 'better'];

export type Codec = 'hevc' | 'av1' | 'h264';

export interface Candidate {
  /** FFmpeg's encoder name. */
  name: string;
  codec: Codec;
  /** mf (Media Foundation), d3d12va, qsv, nvenc, amf, or a software library. */
  family: 'mf' | 'd3d12va' | 'qsv' | 'nvenc' | 'amf' | 'vaapi' | 'x265' | 'svtav1' | 'x264' | 'aom';
  hardware: boolean;
  /** One line for the page. */
  label: string;
}

/**
 * In order of preference. On a Snapdragon PC, Media Foundation reaches the chip's own video encoder
 * (hevc_mf, h264_mf with -hw_encoding 1). Then any other hardware encoder, then software: x265 and
 * SVT-AV1 compress best per bit, x264 plays everywhere; libaom is last because it is very slow.
 */
export const RANKED: Candidate[] = [
  { name: 'hevc_mf', codec: 'hevc', family: 'mf', hardware: true, label: 'HEVC on the PC\'s video encoder, through Media Foundation' },
  { name: 'h264_mf', codec: 'h264', family: 'mf', hardware: true, label: 'H.264 on the PC\'s video encoder, through Media Foundation' },
  { name: 'hevc_d3d12va', codec: 'hevc', family: 'd3d12va', hardware: true, label: 'HEVC on the GPU, through Direct3D 12 video encode' },
  { name: 'av1_d3d12va', codec: 'av1', family: 'd3d12va', hardware: true, label: 'AV1 on the GPU, through Direct3D 12 video encode' },
  { name: 'h264_d3d12va', codec: 'h264', family: 'd3d12va', hardware: true, label: 'H.264 on the GPU, through Direct3D 12 video encode' },
  { name: 'hevc_qsv', codec: 'hevc', family: 'qsv', hardware: true, label: 'HEVC on Intel Quick Sync' },
  { name: 'av1_qsv', codec: 'av1', family: 'qsv', hardware: true, label: 'AV1 on Intel Quick Sync' },
  { name: 'h264_qsv', codec: 'h264', family: 'qsv', hardware: true, label: 'H.264 on Intel Quick Sync' },
  { name: 'hevc_nvenc', codec: 'hevc', family: 'nvenc', hardware: true, label: 'HEVC on NVIDIA NVENC' },
  { name: 'av1_nvenc', codec: 'av1', family: 'nvenc', hardware: true, label: 'AV1 on NVIDIA NVENC' },
  { name: 'h264_nvenc', codec: 'h264', family: 'nvenc', hardware: true, label: 'H.264 on NVIDIA NVENC' },
  { name: 'hevc_amf', codec: 'hevc', family: 'amf', hardware: true, label: 'HEVC on AMD AMF' },
  { name: 'av1_amf', codec: 'av1', family: 'amf', hardware: true, label: 'AV1 on AMD AMF' },
  { name: 'h264_amf', codec: 'h264', family: 'amf', hardware: true, label: 'H.264 on AMD AMF' },
  { name: 'libx265', codec: 'hevc', family: 'x265', hardware: false, label: 'HEVC in software (x265)' },
  { name: 'libsvtav1', codec: 'av1', family: 'svtav1', hardware: false, label: 'AV1 in software (SVT-AV1)' },
  { name: 'libx264', codec: 'h264', family: 'x264', hardware: false, label: 'H.264 in software (x264)' },
  { name: 'libaom-av1', codec: 'av1', family: 'aom', hardware: false, label: 'AV1 in software (libaom, slow)' },
];

/** The video encoders in `ffmpeg -encoders` output (lines like " V....D hevc_mf   HEVC via MediaFoundation"). */
export function parseEncoders(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*V[A-Z.]{5}\s+(\S+)/.exec(line);
    if (m && m[1] !== '=') out.add(m[1]);
  }
  return out;
}

/** The ranked encoders this FFmpeg has. */
export const candidatesIn = (available: Set<string>) => RANKED.filter((c) => available.has(c.name));

export interface VideoShape {
  width: number;
  height: number;
  fps: number | null;
  /** The input's video bit rate (bits/s), when known. */
  bitRate: number | null;
}

/**
 * Bits per pixel per frame for a hardware encoder's target bit rate, for HEVC; AV1 needs a little
 * less, H.264 half as much again. 1080p30 HEVC "balanced" comes to about 3.4 Mb/s.
 */
const BPP: Record<Preset, number> = { smaller: 0.035, balanced: 0.055, better: 0.08 };
const CODEC_FACTOR: Record<Codec, number> = { hevc: 1, av1: 0.85, h264: 1.5 };

/** A hardware encoder's target bit rate (bits/s): never above 85% of the input's own, never below 200 kb/s. */
export function targetBitRate(codec: Codec, preset: Preset, v: VideoShape): number {
  const fps = Math.min(120, Math.max(1, v.fps ?? 30));
  let rate = BPP[preset] * CODEC_FACTOR[codec] * v.width * v.height * fps;
  if (v.bitRate && v.bitRate > 0) rate = Math.min(rate, v.bitRate * 0.85);
  return Math.max(200_000, Math.round(rate / 1000) * 1000);
}

/** Software encoders take a constant-quality level instead of a bit rate. */
const CRF: Record<Candidate['family'], Record<Preset, number> | undefined> = {
  x265: { smaller: 30, balanced: 27, better: 23 },
  x264: { smaller: 27, balanced: 24, better: 20 },
  svtav1: { smaller: 42, balanced: 36, better: 30 },
  aom: { smaller: 42, balanced: 36, better: 30 },
  mf: undefined, d3d12va: undefined, qsv: undefined, nvenc: undefined, amf: undefined, vaapi: undefined,
};

const kb = (bits: number) => `${Math.round(bits / 1000)}k`;

export interface EncodeArgs {
  /** Before -i (a hardware device to upload frames to). */
  global: string[];
  /** The tail of the -vf chain this encoder needs (pixel format, upload). */
  filters: string[];
  /** -c:v and its options. */
  video: string[];
}

/** The preset, mapped to this encoder's own options. */
export function videoArgs(c: Candidate, preset: Preset, v: VideoShape): EncodeArgs {
  const crf = CRF[c.family];
  if (crf) {
    const q = crf[preset];
    const video = ['-c:v', c.name, '-pix_fmt', 'yuv420p'];
    if (c.family === 'x265') video.push('-crf', String(q), '-preset', 'medium', '-tag:v', 'hvc1');
    if (c.family === 'x264') video.push('-crf', String(q), '-preset', 'medium');
    if (c.family === 'svtav1') video.push('-crf', String(q), '-preset', '8');
    if (c.family === 'aom') video.push('-crf', String(q), '-b:v', '0', '-cpu-used', '6', '-row-mt', '1');
    return { global: [], filters: [], video };
  }
  const rate = targetBitRate(c.codec, preset, v);
  const rateArgs = ['-b:v', kb(rate), '-maxrate', kb(rate * 1.5), '-bufsize', kb(rate * 2)];
  const tag = c.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [];
  switch (c.family) {
    case 'mf':
      // -hw_encoding 1: FFmpeg otherwise only looks at software MFTs.
      return { global: [], filters: ['format=nv12'], video: ['-c:v', c.name, '-hw_encoding', '1', '-rate_control', 'u_vbr', '-b:v', kb(rate), ...tag] };
    case 'd3d12va':
      // No -rc_mode: given a bit rate, FFmpeg tries VBR, then CBR, so a driver with only one still encodes. The
      // device's name ("mill") is only a label within the command.
      return {
        global: ['-init_hw_device', 'd3d12va=mill', '-filter_hw_device', 'mill'],
        filters: ['format=nv12', 'hwupload'],
        video: ['-c:v', c.name, ...rateArgs, ...tag],
      };
    default:
      return { global: [], filters: ['format=nv12'], video: ['-c:v', c.name, ...rateArgs, ...tag] };
  }
}

/**
 * The core limit at the manor's gentle pace: as many processors as the kit's background cap allows (gentle.ts'
 * gentleCap(): a quarter of the processor, two processors' worth at the most), and at least one. 18 processors: 2;
 * 8: 2; 4 or fewer: 1.
 */
export function coreLimit(processors = os.availableParallelism()): number {
  return Math.max(1, Math.floor(Math.min(Math.max(1, processors) / 4, 2)));
}

/**
 * How many threads an encode may use: the core limit for a software encode at a gentle pace that no one asked for (a
 * scheduled round), so it never fills every core while work waits; null, as many as the encoder likes, at a full pace,
 * when someone asked (Run now), or on a hardware encoder, which hardly uses the processor.
 */
export function grindCores(c: Candidate, p: Pace, asked: boolean, processors?: number): number | null {
  if (c.hardware || p !== 'gentle' || asked) return null;
  return coreLimit(processors);
}

/**
 * The options holding an encode to `n` threads (none when `n` is null): the decoder's and the filters' before -i, and
 * the encoder's own pool after -c:v (x265's thread pool and one frame at a time, SVT-AV1's level of parallelism).
 */
export function threadArgs(c: Candidate, n: number | null): { input: string[]; video: string[] } {
  if (!n) return { input: [], video: [] };
  const t = String(n);
  const input = ['-threads', t, '-filter_threads', t];
  switch (c.family) {
    case 'x265':
      return { input, video: ['-threads', t, '-x265-params', `pools=${t}:frame-threads=1`] };
    case 'svtav1':
      return { input, video: ['-threads', t, '-svtav1-params', `lp=${t}`] };
    default:
      return { input, video: ['-threads', t] };
  }
}

/** A test encode's outcome. */
export interface Trial {
  name: string;
  ok: boolean;
  /** FFmpeg's own last words when it refused. */
  error?: string;
}

export interface Choice {
  chosen: Candidate | null;
  /** Why this one (or why none), in a sentence or two. */
  why: string;
  /** What would make one available, when none is. */
  need: string | null;
  trials: Trial[];
}

/**
 * How an agent's encoder lines speak of it, and of what waits: the only words that differ between the Miller and the
 * Chronicler. Each is optional.
 */
export interface EncoderWords {
  /** The agent's name, as in "the Miller's own FFmpeg": its APP.name when left out. */
  agent?: string;
  /** A sentence ending the need when no encoder works: "Videos wait in the hopper meanwhile." None when left out. */
  meanwhile?: string;
  /**
   * The need while the agent's own FFmpeg can't be fetched (video-shrink.ts, decideEncoder). Left out: "Nothing, once
   * this PC can reach GitHub: the <agent> fetches its own FFmpeg (about 12 MB, LGPL) and starts."
   */
  ownNeed?: string;
}

/** The agent's name in its encoder lines. */
export const agentOf = (w: EncoderWords = {}) => w.agent ?? APP.name;

/**
 * Why an encoder refused, in plain words where FFmpeg's are cryptic. A D3D12 encoder asks the driver
 * for each rate-control mode, and a driver without D3D12 video encode says no to every one of them.
 */
function said(t: Trial): string {
  const error = (t.error ?? 'failed').replace(/[.\s]+$/, '');
  if (t.name.endsWith('_d3d12va')) {
    if (/Driver does not support any RC mode/i.test(error)) return "the graphics driver doesn't offer Direct3D 12 video encoding at a set bit rate (neither VBR nor CBR)";
    const mode = /Driver does not support (\w+) RC mode/i.exec(error)?.[1];
    if (mode) return `the graphics driver doesn't offer ${mode} rate control through Direct3D 12`;
  }
  return error;
}

/**
 * The first ranked encoder whose test encode worked. `trials` must be in ranked order; an encoder not
 * yet tried (because an earlier one worked) is simply absent. `words` name the agent in the need.
 */
export function chooseEncoder(listed: Candidate[], trials: Trial[], words: EncoderWords = {}): Choice {
  const ok = trials.find((t) => t.ok);
  const chosen = ok ? listed.find((c) => c.name === ok.name) ?? null : null;
  if (chosen) {
    const before = trials.filter((t) => !t.ok).map((t) => `${t.name} (${said(t)})`);
    const pref = chosen.family === 'mf' ? "Windows' Media Foundation, which reaches this PC's own video encoder" : chosen.hardware ? 'hardware, so light on power' : 'software, so slower and harder on the battery';
    return {
      chosen,
      why: `${chosen.name}: ${chosen.label}; ${pref}. Its test encode worked.${before.length ? ` Tried first and refused: ${before.join('; ')}.` : ''}`,
      need: null,
      trials,
    };
  }
  // Encoders refused for the same reason share one sentence.
  const reasons = new Map<string, string[]>();
  for (const t of trials) reasons.set(said(t), [...(reasons.get(said(t)) ?? []), t.name]);
  const failures =
    reasons.size === 1 && trials.length > 1
      ? ` for the same reason: ${[...reasons.keys()][0]}`
      : `: ${[...reasons].map(([reason, names]) => `${names.join(', ')}: ${reason}`).join('; ')}`;
  const why = listed.length
    ? `No encoder available. This FFmpeg lists ${listed.map((c) => c.name).join(', ')}, and each failed a test encode${failures}.`
    : 'No encoder available. This FFmpeg has no HEVC, AV1 or H.264 encoder at all (a decode-only build).';
  return {
    chosen: null,
    why,
    need:
      `This PC's video encoder refused every way in. If the FFmpeg setting names an FFmpeg of your own, clear it to let the ${agentOf(words)} use its own; ` +
      `an up-to-date graphics driver often helps too.${words.meanwhile ? ` ${words.meanwhile}` : ''}`,
    trials,
  };
}

/** Audio that MP4 holds as it is; anything else becomes AAC. */
const MP4_AUDIO = new Set(['aac', 'mp3', 'alac', 'ac3', 'eac3']);
const AAC_KBPS: Record<Preset, number> = { smaller: 96, balanced: 128, better: 192 };

/** Per audio stream: copied when MP4 can hold it, else AAC at the preset's rate (doubled above stereo). */
export function audioArgs(streams: { codec: string; channels: number }[], preset: Preset): string[] {
  const out: string[] = [];
  streams.forEach((s, i) => {
    if (MP4_AUDIO.has(s.codec)) out.push(`-c:a:${i}`, 'copy');
    else out.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, `${AAC_KBPS[preset] * (s.channels > 2 ? 2 : 1)}k`);
  });
  return out;
}
