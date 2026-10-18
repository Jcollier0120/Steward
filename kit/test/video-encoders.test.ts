import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Which video encoder, and with what options (node/video-encoders.ts): the Miller's and the Chronicler's tests of their
// encoders.ts, with their fixtures (`ffmpeg -encoders` of the manor's lean build and of a full one). No FFmpeg is run.
const E = await import('./fixture/src/kit/video-encoders.ts');
const { audioArgs, candidatesIn, chooseEncoder, coreLimit, grindCores, parseEncoders, PRESETS, RANKED, targetBitRate, threadArgs, videoArgs } = E;
type Preset = import('./fixture/src/kit/video-encoders.ts').Preset;

const fixture = (name: string) => readFileSync(new URL(`./ffmpeg/${name}`, import.meta.url), 'utf8');
const enc = (name: string) => RANKED.find((c) => c.name === name)!;
const hd = { width: 1920, height: 1080, fps: 30, bitRate: null };

test("the lean build lists only D3D12 hardware encoders, and when this PC's driver refuses them there is no encoder", () => {
  const listed = candidatesIn(parseEncoders(fixture('encoders-lean-8.1.3.txt')));
  assert.deepEqual(listed.map((c) => c.name), ['hevc_d3d12va', 'av1_d3d12va', 'h264_d3d12va']);
  const refused = 'Driver does not support any RC mode compatible with selected options.';
  const c = chooseEncoder(listed, listed.map((l) => ({ name: l.name, ok: false, error: refused })));
  assert.equal(c.chosen, null);
  assert.equal(
    c.why,
    "No encoder available. This FFmpeg lists hevc_d3d12va, av1_d3d12va, h264_d3d12va, and each failed a test encode for the same reason: the graphics driver doesn't offer Direct3D 12 video encoding at a set bit rate (neither VBR nor CBR).",
  );
  // FFmpeg's own words stay with each trial, for the details.
  assert.equal(c.trials[0].error, refused);

  const mixed = chooseEncoder(listed, [
    { name: 'hevc_d3d12va', ok: false, error: 'Driver does not support VBR RC mode.' },
    { name: 'av1_d3d12va', ok: false, error: 'Driver does not support VBR RC mode.' },
    { name: 'h264_d3d12va', ok: false, error: 'Failed to create the encoder heap.' },
  ]);
  assert.match(mixed.why, /test encode: hevc_d3d12va, av1_d3d12va: the graphics driver doesn't offer VBR rate control through Direct3D 12; h264_d3d12va: Failed to create the encoder heap\.$/);
  assert.ok(!/\.[;.]/.test(mixed.why), "FFmpeg's own full stops are not doubled");
});

test('with no encoder, the need names the agent (its own name, unless given) and says what waits, in its words', () => {
  const listed = candidatesIn(parseEncoders(fixture('encoders-lean-8.1.3.txt')));
  const trials = listed.map((l) => ({ name: l.name, ok: false, error: 'no' }));
  const head = "This PC's video encoder refused every way in. If the FFmpeg setting names an FFmpeg of your own, clear it to let the";
  assert.equal(chooseEncoder(listed, trials).need, `${head} Fixture use its own; an up-to-date graphics driver often helps too.`);
  // The Miller's and the Chronicler's own words, as their copies had them.
  assert.equal(
    chooseEncoder(listed, trials, { agent: 'Miller', meanwhile: 'Videos wait in the hopper meanwhile.' }).need,
    `${head} Miller use its own; an up-to-date graphics driver often helps too. Videos wait in the hopper meanwhile.`,
  );
  assert.equal(
    chooseEncoder(listed, trials, { agent: 'Chronicler', meanwhile: 'Clips wait their turn meanwhile.' }).need,
    `${head} Chronicler use its own; an up-to-date graphics driver often helps too. Clips wait their turn meanwhile.`,
  );
});

test('Media Foundation is preferred, and a refused encoder is passed over with its reason', () => {
  const available = parseEncoders(fixture('encoders-full-mf.txt'));
  assert.ok(available.has('libx264') && available.has('hevc_mf') && !available.has('aac') && !available.has('='));
  const listed = candidatesIn(available);
  assert.deepEqual(listed.map((c) => c.name), ['hevc_mf', 'h264_mf', 'hevc_d3d12va', 'h264_d3d12va', 'libx265', 'libx264']);
  const first = chooseEncoder(listed, [{ name: 'hevc_mf', ok: true }]);
  assert.equal(first.chosen?.name, 'hevc_mf');
  assert.equal(first.need, null);
  assert.match(first.why, /Media Foundation, which reaches this PC's own video encoder/);
  const second = chooseEncoder(listed, [
    { name: 'hevc_mf', ok: false, error: 'could not find any MFT for the given media type' },
    { name: 'h264_mf', ok: true },
  ]);
  assert.equal(second.chosen?.name, 'h264_mf');
  assert.match(second.why, /Tried first and refused: hevc_mf \(could not find any MFT/);
  assert.match(chooseEncoder(listed, [{ name: 'libx265', ok: true }]).why, /software, so slower and harder on the battery/);
  assert.equal(chooseEncoder([], []).chosen, null);
  assert.match(chooseEncoder([], []).why, /decode-only/);
});

test('a preset maps to each encoder family its own way', () => {
  assert.deepEqual(PRESETS, ['smaller', 'balanced', 'better']);
  assert.deepEqual(
    PRESETS.map((p: Preset) => targetBitRate('hevc', p, hd)),
    [2_177_000, 3_421_000, 4_977_000],
  );
  assert.equal(targetBitRate('h264', 'balanced', hd), 5_132_000);
  // Never above 85% of what the original spends.
  assert.equal(targetBitRate('hevc', 'better', { ...hd, bitRate: 2_000_000 }), 1_700_000);
  assert.equal(targetBitRate('hevc', 'smaller', { width: 160, height: 90, fps: 10, bitRate: null }), 200_000);

  const mf = videoArgs(enc('hevc_mf'), 'balanced', hd);
  assert.deepEqual(mf.video, ['-c:v', 'hevc_mf', '-hw_encoding', '1', '-rate_control', 'u_vbr', '-b:v', '3421k', '-tag:v', 'hvc1']);
  assert.deepEqual(mf.filters, ['format=nv12']);
  const d3d = videoArgs(enc('h264_d3d12va'), 'smaller', hd);
  assert.deepEqual(d3d.global, ['-init_hw_device', 'd3d12va=mill', '-filter_hw_device', 'mill']);
  assert.deepEqual(d3d.filters, ['format=nv12', 'hwupload']);
  // No -rc_mode, so FFmpeg falls back from VBR to CBR on a driver without VBR.
  assert.deepEqual(d3d.video, ['-c:v', 'h264_d3d12va', '-b:v', '3266k', '-maxrate', '4899k', '-bufsize', '6532k']);
  assert.deepEqual(videoArgs(enc('libx265'), 'better', hd).video, ['-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'medium', '-tag:v', 'hvc1']);
  assert.deepEqual(videoArgs(enc('libx264'), 'smaller', hd).video.slice(4, 6), ['-crf', '27']);
  assert.deepEqual(videoArgs(enc('libsvtav1'), 'balanced', hd).video.slice(4, 6), ['-crf', '36']);
  assert.deepEqual(videoArgs(enc('libaom-av1'), 'balanced', hd).video, ['-c:v', 'libaom-av1', '-pix_fmt', 'yuv420p', '-crf', '36', '-b:v', '0', '-cpu-used', '6', '-row-mt', '1']);
  assert.deepEqual(videoArgs(enc('hevc_nvenc'), 'balanced', hd), { global: [], filters: ['format=nv12'], video: ['-c:v', 'hevc_nvenc', '-b:v', '3421k', '-maxrate', '5132k', '-bufsize', '6842k', '-tag:v', 'hvc1'] });
});

test('audio MP4 can hold is copied; anything else becomes AAC at the preset rate', () => {
  assert.deepEqual(audioArgs([{ codec: 'aac', channels: 2 }, { codec: 'opus', channels: 2 }, { codec: 'pcm_s16le', channels: 6 }], 'balanced'), [
    '-c:a:0', 'copy',
    '-c:a:1', 'aac', '-b:a:1', '128k',
    '-c:a:2', 'aac', '-b:a:2', '256k',
  ]);
  assert.deepEqual(audioArgs([], 'better'), []);
});

test('the core limit is what the gentle cap allows: a quarter of the processors, two at the most, one at the least', () => {
  assert.equal(coreLimit(18), 2);
  assert.equal(coreLimit(64), 2);
  assert.equal(coreLimit(8), 2);
  assert.equal(coreLimit(6), 1);
  assert.equal(coreLimit(4), 1);
  assert.equal(coreLimit(1), 1);
  assert.equal(coreLimit(0), 1);
  assert.ok(coreLimit() >= 1 && coreLimit() <= 2, "this PC's own");
});

test('only a scheduled software encode at a gentle pace is held to the core limit', () => {
  assert.equal(grindCores(enc('libx265'), 'gentle', false, 18), 2);
  assert.equal(grindCores(enc('libsvtav1'), 'gentle', false, 4), 1);
  assert.equal(grindCores(enc('libx265'), 'gentle', true, 18), null, 'someone asked: as many as it likes');
  assert.equal(grindCores(enc('libx265'), 'full', false, 18), null, 'a full pace: as before');
  assert.equal(grindCores(enc('hevc_mf'), 'gentle', false, 18), null, 'a hardware encode hardly uses the processor');
  assert.equal(grindCores(enc('hevc_nvenc'), 'gentle', false, 18), null);
});

test("an encode held to n threads says so to the decoder and the filters, and to each encoder's own pool", () => {
  assert.deepEqual(threadArgs(enc('libx265'), 2), { input: ['-threads', '2', '-filter_threads', '2'], video: ['-threads', '2', '-x265-params', 'pools=2:frame-threads=1'] });
  assert.deepEqual(threadArgs(enc('libsvtav1'), 1).video, ['-threads', '1', '-svtav1-params', 'lp=1']);
  assert.deepEqual(threadArgs(enc('libx264'), 2).video, ['-threads', '2']);
  assert.deepEqual(threadArgs(enc('hevc_mf'), null), { input: [], video: [] });
});
