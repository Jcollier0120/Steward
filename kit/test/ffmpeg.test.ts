import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// FFmpeg found, fetched and run (node/ffmpeg.ts): the Miller's and the Chronicler's tests of their getffmpeg.ts and
// ffmpeg.ts, and the fetch shared by every agent. No FFmpeg is run and nothing is downloaded: the download, the unzip
// and `-version` are stood in for. The agent's data folder, Manor's and %LOCALAPPDATA% are this test's own.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-ffmpeg-'));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.FIXTURE_HOME = path.join(home, 'agent');
process.env.MANOR_HOME = path.join(home, 'manor');
process.env.LOCALAPPDATA = path.join(home, 'local');

const F = await import('./fixture/src/kit/ffmpeg.ts');
const { BUILDS, findTools, getFfmpeg, grindArgs, HEIWARD_BIN, HEIWARD_SOURCE, lastError, olderBuild, ownBin, SHARED_SOURCE, tagArgs, toolDirs, _resetFfmpegFetch } = F;
const { RANKED } = await import('./fixture/src/kit/video-encoders.ts');
const { parseProbe } = await import('./fixture/src/kit/media-probe.ts');
const { dataDir } = await import('./fixture/src/app.ts');
type Run = typeof F.run;

/** A stand-in download: these bytes, pinned as the arm64 build for the test; and an unzip that lays out its folder. */
function fake(bytes: Buffer, o: { layout?: boolean; slowMs?: number } = {}) {
  const calls: string[] = [];
  const b = BUILDS.arm64;
  const pinned = b.sha256;
  b.sha256 = createHash('sha256').update(bytes).digest('hex');
  const deps = {
    download: async (url: string) => {
      calls.push(url);
      if (o.slowMs) await new Promise((r) => setTimeout(r, o.slowMs));
      return bytes;
    },
    unzip: (_zip: string, into: string) => {
      if (o.layout === false) return null;
      const bin = path.join(into, b.folder, 'bin');
      mkdirSync(bin, { recursive: true });
      for (const f of ['ffmpeg.exe', 'ffprobe.exe', 'avcodec-62.dll']) writeFileSync(path.join(bin, f), 'x');
      return null;
    },
  };
  return { deps, calls, restore: () => (b.sha256 = pinned) };
}

/** A fresh agent data folder and Manor folder for one test. */
function place(name: string) {
  const dir = mkdtempSync(path.join(home, `${name}-`));
  return { data: path.join(dir, 'agent'), manor: path.join(dir, 'manor') };
}

/** Puts both programs in a folder, as a fetch would. */
function lay(bin: string) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'ffmpeg.exe'), 'a');
  writeFileSync(path.join(bin, 'ffprobe.exe'), 'b');
}

test('the manor\'s build is n8.1.3-6 (DirectShow too, and signed), from its public releases, pinned by SHA-256 for each processor', () => {
  assert.deepEqual(Object.keys(BUILDS).sort(), ['arm64', 'x64']);
  for (const b of Object.values(BUILDS)) {
    assert.equal(b.version, 'n8.1.3-6');
    assert.match(b.url, /^https:\/\/github\.com\/Jcollier0120\/Manor-releases\/releases\/download\/ffmpeg-v8\.1\.3-6\//, "the public LGPL build, from the manor's releases, pinned");
    assert.ok(b.url.endsWith(`/${b.folder}.zip`));
  }
  // The signed build's pins: a change here is a new build, and its release says what's in it.
  assert.equal(BUILDS.arm64.sha256, '28a4b3aaf6d2fa99815d079d6d1619e57e235f5b98333aae7ff2e9de9b85eebf');
  assert.equal(BUILDS.x64.sha256, 'e26b6ec56ee89b39acb94792916bcb8346df1094f62432b5c18f56b286b1b12b');
  assert.equal(ownBin('C:\\Users\\me\\.manor', 'x64'), 'C:\\Users\\me\\.manor\\ffmpeg\\n8.1.3-6\\ffmpeg-8.1.3-lean-lgpl-shared-win-x64\\bin');
  assert.equal(ownBin('C:\\Users\\me\\.manor', 'ia32'), null);
});

test("fetched once into Manor's folder for every agent, when it's the pinned build, then found where it was put", async () => {
  _resetFfmpegFetch();
  const p = place('shared');
  const f = fake(Buffer.from('a zip'));
  const lines: string[] = [];
  try {
    const got = await getFfmpeg({ dataDir: p.data, home: p.manor, arch: 'arm64', deps: f.deps, log: (l) => lines.push(l) });
    assert.deepEqual(got, { dir: ownBin(p.manor, 'arm64') });
    assert.ok(existsSync(path.join(ownBin(p.manor, 'arm64')!, 'ffprobe.exe')));
    assert.deepEqual(f.calls, [BUILDS.arm64.url]);
    assert.deepEqual(readdirSync(path.join(p.manor, 'ffmpeg')), [BUILDS.arm64.version], 'no zip, half-unpacked folder or lock left beside it');
    assert.equal(existsSync(p.data), false, "the agent's own folder isn't touched");
    assert.deepEqual(lines, ['Fetching FFmpeg n8.1.3-6 (LGPL) from github.com', `FFmpeg n8.1.3-6 is in ${ownBin(p.manor, 'arm64')}`]);
    // Another agent (its own data folder) finds it there.
    const other = await getFfmpeg({ dataDir: path.join(p.data, '..', 'other'), home: p.manor, arch: 'arm64', deps: f.deps });
    assert.deepEqual(other, { dir: ownBin(p.manor, 'arm64') });
    assert.equal(f.calls.length, 1, 'there already: not fetched again');
  } finally {
    f.restore();
  }
});

test('two agents fetching at once take turns: one download, and both have it', async () => {
  _resetFfmpegFetch();
  const p = place('both');
  const f = fake(Buffer.from('a zip'), { slowMs: 300 });
  try {
    const [a, b] = await Promise.all([
      getFfmpeg({ dataDir: `${p.data}-a`, home: p.manor, arch: 'arm64', deps: f.deps }),
      getFfmpeg({ dataDir: `${p.data}-b`, home: p.manor, arch: 'arm64', deps: f.deps }),
    ]);
    assert.deepEqual([a, b], [{ dir: ownBin(p.manor, 'arm64') }, { dir: ownBin(p.manor, 'arm64') }]);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(readdirSync(path.join(p.manor, 'ffmpeg')), [BUILDS.arm64.version]);
  } finally {
    f.restore();
  }
});

test("an agent's own, fetched before kit 2.88.0, is still found; shared: false keeps to its own folder; Manor's folder unwritable, its own is used", async () => {
  _resetFfmpegFetch();
  const p = place('own');
  const f = fake(Buffer.from('a zip'));
  try {
    lay(ownBin(p.data, 'arm64')!);
    assert.deepEqual(await getFfmpeg({ dataDir: p.data, home: p.manor, arch: 'arm64', deps: f.deps }), { dir: ownBin(p.data, 'arm64') });
    assert.equal(f.calls.length, 0);

    const alone = place('alone');
    assert.deepEqual(await getFfmpeg({ dataDir: alone.data, home: alone.manor, shared: false, arch: 'arm64', deps: f.deps }), { dir: ownBin(alone.data, 'arm64') });
    assert.equal(existsSync(alone.manor), false, "shared: false never writes Manor's folder");
    assert.deepEqual(readdirSync(path.join(alone.data, 'ffmpeg')), [BUILDS.arm64.version]);

    // Manor's "folder" is a file, so nothing can be made in it.
    const blocked = place('blocked');
    mkdirSync(path.dirname(blocked.manor), { recursive: true });
    writeFileSync(blocked.manor, 'not a folder');
    assert.deepEqual(await getFfmpeg({ dataDir: blocked.data, home: blocked.manor, arch: 'arm64', deps: f.deps }), { dir: ownBin(blocked.data, 'arm64') });
    assert.equal(f.calls.length, 2);
  } finally {
    f.restore();
  }
});

test("a download that isn't the pinned build is never used, and a failed fetch waits 15 minutes, then tries again", async () => {
  _resetFfmpegFetch();
  const p = place('wrong');
  const f = fake(Buffer.from('the real one'));
  try {
    const wrong = { ...f.deps, download: async (url: string) => (f.calls.push(url), Buffer.from('something else')) };
    const got = await getFfmpeg({ dataDir: p.data, home: p.manor, arch: 'arm64', deps: wrong, now: 1_000_000 });
    assert.ok('error' in got && /isn't the build it should be \(SHA-256/.test(got.error), JSON.stringify(got));
    assert.equal(existsSync(ownBin(p.manor, 'arm64')!), false);
    assert.deepEqual(readdirSync(path.join(p.manor, 'ffmpeg')), [], 'nothing of it kept');

    const soon = await getFfmpeg({ dataDir: p.data, home: p.manor, arch: 'arm64', deps: f.deps, now: 1_000_000 + 60_000 });
    assert.ok('error' in soon && /tried again within 15 minutes/.test(soon.error));
    assert.equal(f.calls.length, 1, 'not asked again within the wait');

    const later = await getFfmpeg({ dataDir: p.data, home: p.manor, arch: 'arm64', deps: f.deps, now: 1_000_000 + 16 * 60_000 });
    assert.deepEqual(later, { dir: ownBin(p.manor, 'arm64') });
  } finally {
    f.restore();
  }
});

test("offline, it says it couldn't reach GitHub and tries again later; a zip without FFmpeg in it is refused; no build, no fetch", async () => {
  _resetFfmpegFetch();
  const p = place('offline');
  const offline = { download: async () => Promise.reject(new TypeError('fetch failed')), unzip: () => null };
  const got = await getFfmpeg({ dataDir: p.data, home: p.manor, arch: 'arm64', deps: offline, now: 5_000_000 });
  assert.ok('error' in got && /couldn't reach GitHub.*tries again on a later round/.test(got.error), JSON.stringify(got));

  _resetFfmpegFetch();
  const f = fake(Buffer.from('empty zip'), { layout: false });
  try {
    const empty = await getFfmpeg({ dataDir: p.data, home: p.manor, arch: 'arm64', deps: f.deps, now: 6_000_000 });
    assert.ok('error' in empty && /no ffmpeg\.exe and ffprobe\.exe/.test(empty.error));
  } finally {
    f.restore();
  }
  assert.deepEqual(await getFfmpeg({ dataDir: p.data, home: p.manor, arch: 'ia32' }), { error: "there's no FFmpeg build of the Fixture's for a ia32 processor" });
  assert.deepEqual(await getFfmpeg({ arch: 'ia32', agent: 'Miller' }), { error: "there's no FFmpeg build of the Miller's for a ia32 processor" });
});

test("FFmpeg is looked for in the setting, the staff's, the agent's own, PATH, where it was found last time, then Heiward's: no folder of anyone's PC built in", () => {
  const dirs = toolDirs({
    setting: 'D:\\tools\\ffmpeg\\bin\\ffmpeg.exe',
    pathDirs: ['C:\\Windows', 'D:\\tools\\ffmpeg\\bin'],
    remembered: 'E:\\builds\\ffmpeg-lean\\bin',
    env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
  });
  assert.deepEqual(
    dirs.map((d) => d.dir),
    ['D:\\tools\\ffmpeg\\bin', 'C:\\Windows', 'E:\\builds\\ffmpeg-lean\\bin', 'C:\\Users\\me\\AppData\\Local\\Programs\\Heiward\\bin'],
  );
  assert.equal(dirs[0].source, 'the FFmpeg setting');
  assert.equal(dirs[2].source, 'the FFmpeg it used last');
  assert.deepEqual(toolDirs({ setting: '', pathDirs: [], env: { LOCALAPPDATA: 'C:\\L' } }).map((d) => d.dir), ['C:\\L\\Programs\\Heiward\\bin'], "nothing found yet: only Heiward's");

  // The manor's signed build before one on PATH or the one used last (kit 2.136.6).
  const all = toolDirs({
    setting: '',
    pathDirs: ['D:\\tools\\bin'],
    remembered: 'E:\\mine\\bin',
    shared: 'C:\\Users\\me\\.manor\\ffmpeg\\n8.1.3-5\\x\\bin',
    own: 'C:\\Users\\me\\.miller\\ffmpeg\\n8.1.3-5\\x\\bin',
    also: [{ dir: 'C:\\Users\\me\\.chronicler\\ffmpeg\\n8.1.3-5\\x\\bin', source: "the Chronicler's FFmpeg" }],
    env: { LOCALAPPDATA: 'C:\\L' },
    agent: 'Miller',
  });
  assert.deepEqual(all.map((d) => d.source), [SHARED_SOURCE, "the Miller's own FFmpeg", 'PATH', 'the FFmpeg it used last', "the Chronicler's FFmpeg", HEIWARD_SOURCE]);
  // Heiward's is Heiward's however it's reached, on PATH or as the one used last, and listed once; but the setting's is the person's.
  const heiward = 'C:\\L\\Programs\\Heiward\\bin';
  const onPath = toolDirs({ setting: '', pathDirs: ['c:\\l\\programs\\heiward\\bin\\'], own: 'C:\\o', env: { LOCALAPPDATA: 'C:\\L' } });
  assert.deepEqual(onPath.map((d) => d.source), ["the Fixture's own FFmpeg", HEIWARD_SOURCE]);
  const usedLast = toolDirs({ setting: '', pathDirs: [], remembered: heiward, env: { LOCALAPPDATA: 'C:\\L' } });
  assert.deepEqual(usedLast, [{ dir: heiward, source: HEIWARD_SOURCE }]);
  assert.deepEqual(toolDirs({ setting: `${heiward}\\ffmpeg.exe`, pathDirs: [], env: { LOCALAPPDATA: 'C:\\L' } }), [{ dir: heiward, source: 'the FFmpeg setting' }]);
  // The Chronicler's, as its copy looked: its own, then the Miller's, then Heiward's.
  const chronicler = toolDirs({ setting: '', pathDirs: [], own: 'C:\\c', also: [{ dir: 'C:\\m', source: "the Miller's FFmpeg" }], env: { LOCALAPPDATA: 'C:\\L' }, agent: 'Chronicler' });
  assert.deepEqual(chronicler.map((d) => d.source), ["the Chronicler's own FFmpeg", "the Miller's FFmpeg", "Heiward's FFmpeg"]);
  assert.equal(toolDirs({ setting: '', pathDirs: [], own: 'C:\\o' })[0].source, "the Fixture's own FFmpeg", "the agent's APP.name when no name is given");
  assert.equal(HEIWARD_BIN, '%LOCALAPPDATA%\\Programs\\Heiward\\bin');
});

test("an older, unsigned build of the manor's isn't looked at, but for the setting's: the signed one is fetched in its place (kit 2.93.2)", () => {
  const older = (base: string, v: string, arch = 'x64') => `${base}\\ffmpeg\\${v}\\ffmpeg-8.1.3-lean-lgpl-shared-win-${arch}\\bin`;
  assert.equal(olderBuild(older('C:\\Users\\me\\.manor', 'n8.1.3-5')), true);
  assert.equal(olderBuild(older('C:\\Users\\me\\.miller', 'n8.1.3-4', 'arm64') + '\\'), true);
  assert.equal(olderBuild(ownBin('C:\\Users\\me\\.manor', 'x64')!), false, 'the pinned build');
  assert.equal(olderBuild('E:\\builds\\ffmpeg\\n7.1\\ffmpeg-7.1-full_build\\bin'), false, 'a build of your own');
  const dirs = toolDirs({
    setting: '',
    pathDirs: [older('C:\\Users\\me\\.chronicler', 'n8.1.3-5')],
    remembered: older('C:\\Users\\me\\.manor', 'n8.1.3-5'),
    shared: ownBin('C:\\Users\\me\\.manor', 'x64'),
    also: [{ dir: older('C:\\Users\\me\\.miller', 'n8.1.3-4'), source: "the Miller's FFmpeg" }],
    env: { LOCALAPPDATA: 'C:\\L' },
  });
  assert.deepEqual(dirs.map((d) => d.source), [SHARED_SOURCE, "Heiward's FFmpeg"]);
  const named = toolDirs({ setting: older('C:\\Users\\me\\.manor', 'n8.1.3-5') + '\\ffmpeg.exe', pathDirs: [], env: { LOCALAPPDATA: 'C:\\L' } });
  assert.equal(named[0].source, 'the FFmpeg setting', "the person's choice stands");
});

test("an FFmpeg that ran -version isn't started again just to ask, until it changes; one that didn't run is asked again", async (t) => {
  const dir = mkdtempSync(path.join(home, 'find-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'ffmpeg.exe'), 'a');
  writeFileSync(path.join(dir, 'ffprobe.exe'), 'b');
  let code = 1;
  const started: string[] = [];
  const start: Run = async (cmd) => {
    // Only this folder's: on a PC with FFmpeg on PATH, a search that passes this folder over goes on to those.
    if (path.dirname(cmd) === dir) started.push(path.basename(cmd));
    return { code, stdout: 'ffmpeg version n8.1.3-lean Copyright', stderr: code ? 'crashed on load' : '', timedOut: false };
  };

  const crashed = await findTools(dir, null, [], { start });
  assert.notEqual(crashed.tools?.dir, dir);
  assert.match(crashed.looked.find((l) => l.dir === dir)?.problem ?? '', /doesn't run here/);
  assert.deepEqual(started, ['ffmpeg.exe', 'ffprobe.exe']);

  code = 0;
  const first = await findTools(dir, null, [], { start });
  assert.equal(first.tools?.dir, dir);
  assert.equal(first.tools?.version, 'n8.1.3-lean');
  assert.equal(started.length, 4, 'one that crashed is asked again');

  const again = await findTools(dir, null, [], { start });
  assert.deepEqual(again.tools, first.tools);
  assert.equal(started.length, 4, 'the same build is not started again');

  writeFileSync(path.join(dir, 'ffprobe.exe'), 'bb');
  await findTools(dir, null, [], { start });
  assert.equal(started.length, 6, 'a changed build is asked again');
});

test("with nothing named and nothing on PATH, the staff's shared build is found first, then the agent's own; a build passed over is skipped", async (t) => {
  const path0 = process.env.PATH;
  process.env.PATH = '';
  t.after(() => void (process.env.PATH = path0));
  const p = place('found');
  const start: Run = async () => ({ code: 0, stdout: 'ffmpeg version n8.1.3-5-lean', stderr: '', timedOut: false });
  const none = await findTools('', null, [], { start, dataDir: p.data, home: p.manor });
  assert.equal(none.tools, null);
  assert.deepEqual(none.looked.map((l) => [l.source, l.problem]), [
    [SHARED_SOURCE, "folder doesn't exist"],
    ["the Fixture's own FFmpeg", "folder doesn't exist"],
    ["Heiward's FFmpeg", "folder doesn't exist"],
  ]);

  lay(ownBin(p.data)!);
  const own = await findTools('', null, [], { start, dataDir: p.data, home: p.manor });
  assert.equal(own.tools?.source, "the Fixture's own FFmpeg");
  assert.equal(own.tools?.version, 'n8.1.3-5-lean');

  lay(ownBin(p.manor)!);
  const shared = await findTools('', null, [], { start, dataDir: p.data, home: p.manor });
  assert.equal(shared.tools?.source, SHARED_SOURCE);
  assert.equal(shared.tools?.dir, ownBin(p.manor));
  // Passed over (none of its encoders worked here): the agent's own is next.
  const passed = await findTools('', null, [shared.tools!.stamp], { start, dataDir: p.data, home: p.manor });
  assert.equal(passed.tools?.source, "the Fixture's own FFmpeg");
  assert.equal(passed.looked[0].problem, F.PASSED_OVER);
  // shared: false, as an agent's own copy looked: Manor's folder isn't looked at.
  const alone = await findTools('', null, [], { start, dataDir: p.data, home: p.manor, shared: false });
  assert.equal(alone.tools?.source, "the Fixture's own FFmpeg");
  assert.ok(!alone.looked.some((l) => l.source === SHARED_SOURCE));
  // The agent's data folder is app.ts' when none is given.
  assert.ok(toolDirs({ setting: '', pathDirs: [], own: ownBin(dataDir) }).some((d) => d.dir.startsWith(process.env.FIXTURE_HOME!)));
});

test("FFmpeg's error lines are reduced to the one that says why", () => {
  const stderr = [
    '[hevc_d3d12va @ 0000008001832440] Driver does not support CQP RC mode.',
    '[vost#0:0/hevc_d3d12va @ 000000800183a7d0] [enc:hevc_d3d12va @ 00000080017fb190] Error while opening encoder - maybe incorrect parameters',
    'Conversion failed!',
  ].join('\r\n');
  assert.equal(lastError(stderr), 'Driver does not support CQP RC mode.');
  assert.equal(lastError(''), 'no message');
});

const enc = (name: string) => RANKED.find((c) => c.name === name)!;
const hd = { width: 1920, height: 1080, fps: 30, bitRate: null };

/** A phone video's probe: its place, its camera and its owner, beside when it was recorded and its tracks' languages. */
const PLACE = '+48.8584+002.2945/';
const filmed = parseProbe({
  streams: [
    { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, tags: { language: 'eng', handler_name: 'Core Media Video' } },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'fra' } },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'und' } },
  ],
  format: {
    duration: '2',
    tags: {
      creation_time: '2026-07-04T12:00:00.000000Z',
      location: PLACE,
      'com.apple.quicktime.location.ISO6709': PLACE,
      'com.apple.quicktime.make': 'Apple',
      'com.apple.quicktime.model': 'iPhone 15 Pro',
      author: 'Jane Doe',
    },
  },
});

test("a video copy keeps when it was recorded and each track's language, and leaves out its place, its camera and its owner", () => {
  assert.equal(filmed.video?.language, 'eng');
  assert.deepEqual(filmed.audio.map((a) => a.language), ['fra', undefined], '"und" names no language');
  const args = tagArgs(filmed);
  assert.deepEqual(args, [
    '-map_metadata', '-1',
    '-metadata', 'creation_time=2026-07-04T12:00:00.000000Z',
    '-metadata:s:v:0', 'language=eng',
    '-metadata:s:a:0', 'language=fra',
    '-movflags', '+faststart',
  ]);
  assert.doesNotMatch(args.join(' '), /48\.8584|Apple|iPhone|Jane/);
  // An agent's setting to keep them (off by default) keeps every one, as copies did before kit 2.137.2.
  assert.deepEqual(tagArgs(filmed, true), ['-map_metadata', '0', '-movflags', '+faststart+use_metadata_tags']);
  // A date that doesn't parse isn't passed on.
  assert.deepEqual(tagArgs({ tags: { creation_time: 'unset' }, video: null, audio: [] }), ['-map_metadata', '-1', '-movflags', '+faststart']);
});

test('the encoding command keeps every audio stream and the timing, and only the tags it is given', () => {
  const job = {
    input: 'C:\\Hopper\\a.mkv', output: 'C:\\Flour\\.miller-1.part.mp4', c: enc('hevc_mf'), preset: 'balanced' as const,
    shape: hd, audio: [{ codec: 'opus', channels: 2 }], audioArgs: ['-c:a:0', 'aac'], cropToEven: true,
  };
  const args = grindArgs(job);
  const at = (flag: string, a = args) => a[a.indexOf(flag) + 1];
  assert.equal(at('-i'), 'C:\\Hopper\\a.mkv');
  assert.equal(at('-vf'), 'crop=trunc(iw/2)*2:trunc(ih/2)*2,format=nv12');
  assert.equal(at('-progress'), 'pipe:1');
  assert.equal(at('-fps_mode'), 'passthrough');
  assert.equal(at('-map_metadata'), '-1', "no tags given: none of the original's");
  assert.equal(at('-movflags'), '+faststart');
  assert.ok(args.join(' ').includes('-map 0:v:0 -map 0:a'));
  assert.equal(at('-f'), 'mp4');
  assert.equal(args.at(-1), 'C:\\Flour\\.miller-1.part.mp4');
  // Without a format, cores or tags, the Chronicler's command, but for the tags.
  assert.deepEqual(args, [
    '-hide_banner', '-nostdin', '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1',
    '-i', 'C:\\Hopper\\a.mkv', '-map', '0:v:0', '-map', '0:a', '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2,format=nv12',
    '-c:v', 'hevc_mf', '-hw_encoding', '1', '-rate_control', 'u_vbr', '-b:v', '3421k', '-tag:v', 'hvc1',
    '-c:a:0', 'aac', '-fps_mode', 'passthrough', '-map_metadata', '-1', '-movflags', '+faststart', '-f', 'mp4', 'C:\\Flour\\.miller-1.part.mp4',
  ]);
  const tagged = grindArgs({ ...job, tags: tagArgs(filmed) });
  assert.equal(at('-metadata', tagged), 'creation_time=2026-07-04T12:00:00.000000Z');
  assert.doesNotMatch(tagged.join(' '), /48\.8584|Apple|iPhone|Jane/);
  assert.equal(tagged.at(-1), 'C:\\Flour\\.miller-1.part.mp4');
  const mov = grindArgs({ input: 'a.mov', output: 'b.mov', c: enc('hevc_mf'), preset: 'balanced', shape: hd, audio: [], audioArgs: [], cropToEven: false, format: 'mov' });
  assert.equal(mov[mov.indexOf('-f') + 1], 'mov', "a Miller project's MOV stays MOV");
  assert.equal(mov[mov.indexOf('-vf') + 1], 'format=nv12', 'nothing to crop');
  assert.ok(!mov.includes('0:a'), 'no audio, no audio map');
});

test('an encode held to the core limit says so to the decoder, the filters and the encoder', () => {
  const grind = (name: string, cores: number | null | undefined) =>
    grindArgs({ input: 'in.mkv', output: 'out.mp4', c: enc(name), preset: 'balanced', shape: hd, audio: [], audioArgs: [], cropToEven: false, cores });
  const x265 = grind('libx265', 2);
  const i = x265.indexOf('-i');
  // The decoder's and the filters' threads before the input; the encoder's after -c:v.
  assert.deepEqual(x265.slice(i - 4, i), ['-threads', '2', '-filter_threads', '2']);
  const cv = x265.indexOf('-c:v');
  assert.ok(x265.lastIndexOf('-threads') > cv);
  assert.equal(x265[x265.indexOf('-x265-params') + 1], 'pools=2:frame-threads=1');
  assert.equal(grind('libsvtav1', 1)[grind('libsvtav1', 1).indexOf('-svtav1-params') + 1], 'lp=1');
  const x264 = grind('libx264', 2);
  assert.equal(x264.filter((a) => a === '-threads').length, 2);
  assert.ok(!x264.includes('-x265-params'));
  // A full pace, someone asking, or a hardware encode: no cap at all, the arguments as before.
  for (const [name, cores] of [['libx265', null], ['hevc_mf', null], ['libx265', undefined]] as const) {
    const a = grind(name, cores);
    assert.ok(!a.includes('-threads') && !a.includes('-filter_threads') && !a.includes('-x265-params'), name);
  }
});
