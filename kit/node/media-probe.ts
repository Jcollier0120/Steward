/**
 * What ffprobe and ffmpeg say about a file, parsed (kit 2.88.0, from the Miller's media.ts, which the Chronicler carried
 * unchanged). Pure, so the checks are testable with fixtures: ffmpeg.ts runs the programs.
 */

export interface VideoStream {
  codec: string;
  /** Stored frame size. */
  width: number;
  height: number;
  /** Degrees from the display matrix (or the old "rotate" tag): what a player turns the picture by. */
  rotation: number;
  /** As a player shows it: width and height swapped for a quarter turn. */
  displayWidth: number;
  displayHeight: number;
  fps: number | null;
  pixFmt: string | null;
  /** Colour transfer: smpte2084 (PQ) and arib-std-b67 (HLG) are HDR. */
  transfer: string | null;
  bitRate: number | null;
}

export interface MediaInfo {
  /** Seconds. */
  duration: number | null;
  bitRate: number | null;
  video: VideoStream | null;
  audio: { codec: string; channels: number }[];
  /** Container tags, keys lower-cased (creation_time, com.apple.quicktime.make, ...). */
  tags: Record<string, string>;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** "30000/1001" → 29.97; "0/0" → null. */
export function rate(r: unknown): number | null {
  if (typeof r !== 'string') return null;
  const [a, b] = r.split('/').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !b || !a) return null;
  return a / b;
}

const lowerKeys = (o: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries((o as Record<string, unknown>) ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));

/** `ffprobe -print_format json -show_format -show_streams` output, parsed. */
export function parseProbe(json: any): MediaInfo {
  const streams: any[] = Array.isArray(json?.streams) ? json.streams : [];
  // Cover art in a .mov/.mp4 is a video stream too; it isn't the video.
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  let video: VideoStream | null = null;
  if (v) {
    const matrix = (v.side_data_list ?? []).find((d: any) => /display matrix/i.test(String(d.side_data_type)));
    let rotation = num(matrix?.rotation) ?? num(v.tags?.rotate) ?? 0;
    rotation = ((Math.round(rotation) % 360) + 360) % 360;
    const quarter = rotation === 90 || rotation === 270;
    const width = num(v.width) ?? 0;
    const height = num(v.height) ?? 0;
    video = {
      codec: String(v.codec_name ?? ''),
      width,
      height,
      rotation,
      displayWidth: quarter ? height : width,
      displayHeight: quarter ? width : height,
      fps: rate(v.avg_frame_rate) ?? rate(v.r_frame_rate),
      pixFmt: v.pix_fmt ?? null,
      transfer: v.color_transfer ?? null,
      bitRate: num(v.bit_rate),
    };
  }
  const durations = [num(json?.format?.duration), ...streams.map((s) => num(s.duration))].filter((d): d is number => d !== null && d > 0);
  return {
    duration: num(json?.format?.duration) ?? (durations.length ? Math.max(...durations) : null),
    bitRate: num(json?.format?.bit_rate),
    video,
    audio: streams.filter((s) => s.codec_type === 'audio').map((s) => ({ codec: String(s.codec_name ?? ''), channels: num(s.channels) ?? 2 })),
    tags: lowerKeys(json?.format?.tags),
  };
}

/** HDR video: PQ (smpte2084) or HLG (arib-std-b67). A copy would lose its look, so video-shrink.ts leaves it. */
export const isHdr = (v: VideoStream) => v.transfer === 'smpte2084' || v.transfer === 'arib-std-b67';

export interface Progress {
  /** Seconds of output written. */
  outTime: number;
  /** Bytes of output written. */
  totalSize: number;
  /** e.g. 2.4 (times real time). */
  speed: number | null;
  done: boolean;
}

/**
 * ffmpeg's `-progress` output: blocks of key=value lines, each ended by progress=continue|end.
 * Feed it chunks as they come; it returns the blocks completed so far.
 */
export class ProgressParser {
  private rest = '';
  private cur: Record<string, string> = {};

  push(chunk: string): Progress[] {
    const out: Progress[] = [];
    const lines = (this.rest + chunk).split(/\r?\n/);
    this.rest = lines.pop() ?? '';
    for (const line of lines) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      this.cur[k] = v;
      if (k === 'progress') {
        // out_time_us is microseconds; so, despite its name, is out_time_ms. "N/A" before the first frame.
        const us = num(this.cur.out_time_us) ?? num(this.cur.out_time_ms);
        out.push({
          outTime: us !== null && us > 0 ? us / 1e6 : 0,
          totalSize: num(this.cur.total_size) ?? 0,
          speed: num(String(this.cur.speed ?? '').replace(/x$/, '')),
          done: v === 'end',
        });
        this.cur = {};
      }
    }
    return out;
  }
}
