import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A video copy's tags through FFmpeg itself (kit 2.137.2, node/ffmpeg.ts tagArgs): the FFmpeg this PC has, if any (the
// staff's shared build, PATH or Heiward's), only looked at and run; with none, skipped. The agent's own folder is this
// test's, so nothing is fetched into it.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-video-tags-'));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.FIXTURE_HOME = path.join(home, 'agent');

const { findTools, probe, run, tagArgs } = await import('./fixture/src/kit/ffmpeg.ts');

const PLACE = '+48.8584+002.2945/';
const FILMED_TAGS = {
  creation_time: '2026-07-04T12:00:00.000000Z',
  location: PLACE,
  'location-eng': PLACE,
  'com.apple.quicktime.location.ISO6709': PLACE,
  'com.apple.quicktime.make': 'Apple',
  'com.apple.quicktime.model': 'iPhone 15 Pro',
  author: 'Jane Doe',
};

test('a video filmed with its place and camera tagged comes out without them, through FFmpeg itself', async (c) => {
  const t = (await findTools('')).tools;
  if (!t) return c.skip('no FFmpeg on this PC');
  const original = path.join(home, 'IMG_0001.MOV');
  const quiet = ['-hide_banner', '-nostdin', '-y', '-v', 'error'];
  const made = await run(t.ffmpeg, [
    ...quiet,
    '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=0.5',
    '-f', 'lavfi', '-i', 'sine=duration=0.5',
    '-c:v', 'mpeg4', '-c:a', 'aac',
    ...Object.entries(FILMED_TAGS).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]),
    '-metadata:s:a:0', 'language=fra',
    '-movflags', '+use_metadata_tags', '-f', 'mov', original,
  ], { timeoutMs: 60_000 });
  assert.equal(made.code, 0, made.stderr);
  const before = await probe(t, original);
  assert.ok('info' in before, JSON.stringify(before));
  assert.equal(before.info.tags['com.apple.quicktime.location.iso6709'], PLACE, 'the original carries its place');
  assert.equal(before.info.audio[0].language, 'fra');

  // The copy's tags as grindArgs writes them (the picture and sound copied as they are, so the test needs no encoder).
  const copy = path.join(home, 'copy.mp4');
  const r = await run(t.ffmpeg, [...quiet, '-i', original, '-map', '0:v:0', '-map', '0:a', '-c', 'copy', ...tagArgs(before.info), '-f', 'mp4', copy], { timeoutMs: 60_000 });
  assert.equal(r.code, 0, r.stderr);
  const after = await probe(t, copy);
  assert.ok('info' in after, JSON.stringify(after));
  // Only the container's own tags and the date are left.
  assert.deepEqual(Object.keys(after.info.tags).filter((k) => !['major_brand', 'minor_version', 'compatible_brands', 'encoder', 'creation_time'].includes(k)), [], JSON.stringify(after.info.tags));
  assert.equal(Date.parse(after.info.tags.creation_time), Date.parse('2026-07-04T12:00:00Z'));
  assert.equal(after.info.audio[0].language, 'fra');
  assert.doesNotMatch(JSON.stringify(after.info), /48\.8584|Apple|iPhone|Jane/);

  // An agent that keeps every tag (its setting, off by default) keeps the place too, as copies did before.
  const kept = path.join(home, 'kept.mp4');
  const k = await run(t.ffmpeg, [...quiet, '-i', original, '-map', '0:v:0', '-map', '0:a', '-c', 'copy', ...tagArgs(before.info, true), '-f', 'mp4', kept], { timeoutMs: 60_000 });
  assert.equal(k.code, 0, k.stderr);
  const all = await probe(t, kept);
  assert.ok('info' in all, JSON.stringify(all));
  assert.equal(all.info.tags['com.apple.quicktime.location.iso6709'], PLACE);
  assert.equal(all.info.tags['com.apple.quicktime.make'], 'Apple');
});
