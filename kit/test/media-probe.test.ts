import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// What ffprobe and ffmpeg say, parsed (node/media-probe.ts): the Miller's tests of its media.ts, with its fixture. No
// FFmpeg is run.
const { isHdr, parseProbe, ProgressParser, rate } = await import('./fixture/src/kit/media-probe.ts');

const fixture = (name: string) => readFileSync(new URL(`./ffmpeg/${name}`, import.meta.url), 'utf8');

test('ffprobe output: a phone clip stored landscape plays portrait', () => {
  const phone = parseProbe(JSON.parse(fixture('probe-phone.json')));
  assert.equal(phone.video?.width, 1920);
  assert.equal(phone.video?.height, 1080);
  assert.equal(phone.video?.rotation, 90);
  assert.equal(phone.video?.displayWidth, 1080);
  assert.equal(phone.video?.displayHeight, 1920);
  assert.equal(phone.duration, 2);
  assert.equal(phone.audio.length, 1);
  assert.equal(phone.tags['com.apple.quicktime.make'], 'Apple');
  assert.equal(rate('30000/1001')?.toFixed(2), '29.97');
  assert.equal(rate('0/0'), null);
});

test('cover art is not taken for the video stream', () => {
  const info = parseProbe({
    format: { duration: '10' },
    streams: [
      { codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } },
      { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '25/1' },
    ],
  });
  assert.equal(info.video?.width, 1280);
  assert.equal(info.video?.fps, 25);
});

test('a length only the streams give is the longest of them; nothing readable gives nulls, not a throw', () => {
  const info = parseProbe({ format: {}, streams: [{ codec_type: 'audio', codec_name: 'opus', duration: '3.5' }, { codec_type: 'video', width: 2, height: 2, duration: '4' }] });
  assert.equal(info.duration, 4);
  assert.deepEqual(info.audio, [{ codec: 'opus', channels: 2 }]);
  assert.deepEqual(parseProbe(null), { duration: null, bitRate: null, video: null, audio: [], tags: {} });
});

test('PQ and HLG are HDR; anything else is not', () => {
  const v = parseProbe({ streams: [{ codec_type: 'video', width: 2, height: 2 }] }).video!;
  assert.equal(isHdr({ ...v, transfer: 'smpte2084' }), true);
  assert.equal(isHdr({ ...v, transfer: 'arib-std-b67' }), true);
  assert.equal(isHdr({ ...v, transfer: 'bt709' }), false);
  assert.equal(isHdr(v), false);
});

test("ffmpeg's -progress blocks are read across chunk boundaries", () => {
  const p = new ProgressParser();
  assert.deepEqual(p.push('frame=10\nout_time_us=N/A\ntotal_size=48\nspeed=N/A\nprogr'), []);
  const [a, b] = p.push('ess=continue\nout_time_us=2500000\ntotal_size=1048576\nspeed=3.5x\nprogress=continue\n');
  assert.deepEqual(a, { outTime: 0, totalSize: 48, speed: null, done: false });
  assert.deepEqual(b, { outTime: 2.5, totalSize: 1_048_576, speed: 3.5, done: false });
  assert.deepEqual(p.push(''), []);
  const [c] = p.push('out_time_ms=5000000\ntotal_size=2000000\nspeed=4x\nprogress=end\n');
  assert.deepEqual(c, { outTime: 5, totalSize: 2_000_000, speed: 4, done: true });
});
