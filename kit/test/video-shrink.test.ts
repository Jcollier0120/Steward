import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Making a video smaller (node/video-shrink.ts): what to re-encode and whether a copy is kept (the Miller's and the
// Chronicler's tests of their checks.ts), choosing the encoder (of mill.ts' decideEncoder and shrink.ts' encoderFor),
// and one video end to end (their grindVideo and shrinkOne), with ffprobe and FFmpeg stood in for. No FFmpeg is run.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-video-shrink-'));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.FIXTURE_HOME = path.join(home, 'agent');
process.env.MANOR_HOME = path.join(home, 'manor');

const S = await import('./fixture/src/kit/video-shrink.ts');
const { checkVideo, decideEncoder, MB, planVideo, shrinkVideo, verdict } = S;
const { parseProbe } = await import('./fixture/src/kit/media-probe.ts');
const { PASSED_OVER } = await import('./fixture/src/kit/ffmpeg.ts');
const { RANKED } = await import('./fixture/src/kit/video-encoders.ts');
type MediaInfo = import('./fixture/src/kit/media-probe.ts').MediaInfo;
type Progress = import('./fixture/src/kit/media-probe.ts').Progress;
type Tools = import('./fixture/src/kit/ffmpeg.ts').Tools;
type Running = import('./fixture/src/kit/ffmpeg.ts').Running;
type EncoderDeps = import('./fixture/src/kit/video-shrink.ts').EncoderDeps;
type ShrinkDeps = import('./fixture/src/kit/video-shrink.ts').ShrinkDeps;
type ShrinkJob = import('./fixture/src/kit/video-shrink.ts').ShrinkJob;

const fixture = (name: string) => readFileSync(new URL(`./ffmpeg/${name}`, import.meta.url), 'utf8');
const phone = parseProbe(JSON.parse(fixture('probe-phone.json')));
const SETTINGS = { ffmpeg: '', preset: 'balanced' as const, videoMinMB: 10 };

/** A probe result shaped like a screen recording, adjusted per test. */
function media(o: Omit<Partial<MediaInfo>, 'audio' | 'video'> & { video?: Partial<NonNullable<MediaInfo['video']>> | null; w?: number; h?: number; rotation?: number; audio?: number } = {}): MediaInfo {
  const w = o.w ?? 1920;
  const h = o.h ?? 1080;
  const quarter = o.rotation === 90 || o.rotation === 270;
  return {
    duration: o.duration === undefined ? 63.5 : o.duration,
    bitRate: 20_000_000,
    video:
      o.video === null
        ? null
        : { codec: 'h264', width: w, height: h, rotation: o.rotation ?? 0, displayWidth: quarter ? h : w, displayHeight: quarter ? w : h, fps: 60, pixFmt: 'yuv420p', transfer: null, bitRate: 19_000_000, ...o.video },
    audio: Array.from({ length: o.audio ?? 1 }, () => ({ codec: 'aac', channels: 2 })),
    tags: o.tags ?? {},
  };
}

// ---------------------------------------------------------------- keep or refuse

test('a video copy is kept only when it is smaller, as long, as loud and the same size', () => {
  const input = media();
  const plan = planVideo(input, 900 * MB, SETTINGS);
  assert.equal(plan.action, 'grind');
  if (plan.action !== 'grind') return;
  const ok = checkVideo(900 * MB, plan.expected, 300 * MB, media({ duration: 63.4 }));
  assert.deepEqual(verdict(ok), { keep: true, reason: null });

  const cases: [string, number, MediaInfo, RegExp][] = [
    ['not smaller enough', 850 * MB, media(), /smaller: .*94% of the original/],
    ['exactly 90% is refused', 810 * MB, media(), /smaller/],
    ['too short', 300 * MB, media({ duration: 62.9 }), /duration: 62\.90 s against 63\.50 s/],
    ['an audio stream lost', 300 * MB, media({ audio: 0 }), /audio: 0 audio streams, the original has 1/],
    ['an extra audio stream', 300 * MB, media({ audio: 2 }), /audio: 2 audio streams/],
    ['wrong size', 300 * MB, media({ w: 1280, h: 720 }), /dimensions: 1280×720, expected 1920×1080/],
    ['no picture', 300 * MB, media({ video: null }), /video: the copy has no video stream/],
    ['length unreadable', 300 * MB, media({ duration: null }), /duration: the copy's length can't be read/],
  ];
  for (const [what, outBytes, out, why] of cases) {
    const v = verdict(checkVideo(900 * MB, plan.expected, outBytes, out));
    assert.equal(v.keep, false, what);
    assert.match(v.reason ?? '', why, what);
  }
  // Half a second either way is allowed.
  assert.equal(verdict(checkVideo(900 * MB, plan.expected, 300 * MB, media({ duration: 64.0 }))).keep, true);
});

test('a rotated phone clip is expected upright, and odd window sizes are cropped to even', () => {
  const p = planVideo(phone, 400 * MB, SETTINGS);
  assert.equal(p.action, 'grind');
  if (p.action === 'grind') assert.deepEqual([p.expected.width, p.expected.height, p.expected.cropToEven], [1080, 1920, false]);
  const odd = planVideo(media({ w: 1283, h: 721 }), 50 * MB, SETTINGS);
  assert.ok(odd.action === 'grind' && odd.expected.width === 1282 && odd.expected.height === 720 && odd.expected.cropToEven);
});

test('videos that are small, HDR or unreadable are left as they are', () => {
  const small = planVideo(media(), 4 * MB, SETTINGS);
  assert.ok(small.action === 'skip' && /already small: 4\.0 MB, under the 10 MB minimum/.test(small.reason));
  const hdr = planVideo(media({ video: { transfer: 'arib-std-b67' } }), 500 * MB, SETTINGS);
  assert.ok(hdr.action === 'skip' && /HDR/.test(hdr.reason));
  assert.equal(planVideo(media({ video: null }), 500 * MB, SETTINGS).action, 'skip');
  assert.equal(planVideo(media({ duration: null }), 500 * MB, SETTINGS).action, 'skip');
  assert.equal(S.fmtBytes(3 * 1024 * MB), '3.00 GB');
  assert.equal(S.fmtBytes(512), '1 KB');
});

// ---------------------------------------------------------------- choosing the encoder

/**
 * A made-up PC's FFmpegs, in the order findTools would look: the setting's, the agent's own once fetched, then the
 * rest. Each keeps its stamp whether the agent's own is there or not. `o.own` may change between rounds.
 */
function ffmpegs(o: { builds: { source: string; encodes: boolean }[]; own?: 'fetches' | 'fails' | 'there'; ownSource?: string }) {
  const tools = (b: { source: string }, i: number): Tools => ({ ffmpeg: `C:\\f${i}\\ffmpeg.exe`, ffprobe: `C:\\f${i}\\ffprobe.exe`, dir: `C:\\f${i}`, source: b.source, version: 'n8.1.3-lean', stamp: `f${i}|1|1` });
  const own = { source: o.ownSource ?? "the Miller's own FFmpeg", encodes: true };
  let ownThere = o.own === 'there';
  const picked: string[] = [];
  const passOvers: string[][] = [];
  let fetches = 0;
  const deps: EncoderDeps = {
    find: async (_setting, _remembered, passOver = []) => {
      passOvers.push([...passOver]);
      const found = o.builds.map((b, i) => tools(b, i));
      const setting = found.filter((t) => t.source === 'the FFmpeg setting');
      const all = [...setting, ...(ownThere ? [tools(own, o.builds.length)] : []), ...found.filter((t) => !setting.includes(t))];
      const looked: { dir: string; source: string; problem: string | null }[] = [];
      for (const t of all) {
        if (passOver.includes(t.stamp)) looked.push({ dir: t.dir, source: t.source, problem: PASSED_OVER });
        else return { tools: t, looked: [...looked, { dir: t.dir, source: t.source, problem: null }] };
      }
      return { tools: null, looked };
    },
    fetchOwn: async () => {
      fetches++;
      if (o.own === 'fails') return { error: "couldn't reach GitHub" };
      ownThere = true;
      return { dir: 'C:\\own' };
    },
    pick: async (t) => {
      picked.push(t.source);
      const b = t.source === own.source ? own : o.builds.find((x) => x.source === t.source)!;
      return b.encodes
        ? { chosen: RANKED[0], why: 'hevc_mf works.', need: null, trials: [], listed: ['hevc_mf'] }
        : { chosen: null, why: 'No encoder available. hevc_d3d12va: Driver does not support VBR RC mode.', need: 'An FFmpeg with Media Foundation.', trials: [], listed: ['hevc_d3d12va'] };
    },
  };
  return { deps, picked, passOvers, fetches: () => fetches };
}

const MILLER = { agent: 'Miller' };

test("an FFmpeg on the PC that can't encode here is passed over for the agent's own, until that build changes", async () => {
  const pc = ffmpegs({ builds: [{ source: 'PATH', encodes: false }], own: 'fetches' });
  const r = await decideEncoder(SETTINGS, null, { deps: pc.deps, words: MILLER });
  assert.equal(r.t?.source, "the Miller's own FFmpeg");
  assert.equal(r.encoder?.chosen?.name, 'hevc_mf');
  assert.deepEqual(r.encoder?.passedOver, ['f0|1|1']);
  assert.deepEqual(r.encoder?.looked.map((l) => l.problem), [null], 'its own, found first once fetched');
  assert.deepEqual(pc.picked, ['PATH', "the Miller's own FFmpeg"]);
  // Next round, PATH's isn't tested again: the decision stands.
  const again = await decideEncoder(SETTINGS, r.encoder!, { deps: pc.deps, words: MILLER });
  assert.equal(again.t?.source, "the Miller's own FFmpeg");
  assert.equal(again.encoder, undefined);
  assert.equal(pc.picked.length, 2);
  assert.deepEqual(pc.passOvers.at(-1), ['f0|1|1']);
  // Asked to (the Miller's force), it's decided again at once.
  const forced = await decideEncoder(SETTINGS, r.encoder!, { deps: pc.deps, words: MILLER, force: true });
  assert.equal(forced.encoder?.chosen?.name, 'hevc_mf');
  assert.equal(pc.picked.length, 3);
  // A day later the encoder is checked again, but PATH's same build stays passed over.
  const dayOld = { ...r.encoder!, checkedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() };
  await decideEncoder(SETTINGS, dayOld, { deps: pc.deps, words: MILLER });
  assert.deepEqual(pc.picked.slice(3), ["the Miller's own FFmpeg"]);
  // Another preset, or an encoder the kit no longer ranks, is decided again too.
  await decideEncoder({ ...SETTINGS, preset: 'better' }, r.encoder!, { deps: pc.deps, words: MILLER });
  await decideEncoder(SETTINGS, { ...r.encoder!, chosen: { ...RANKED[0], name: 'gone_encoder' } }, { deps: pc.deps, words: MILLER });
  assert.equal(pc.picked.length, 6);
});

test("the FFmpeg the setting names is never passed over, even when it can't encode here", async () => {
  const pc = ffmpegs({ builds: [{ source: 'the FFmpeg setting', encodes: false }], own: 'there' });
  const r = await decideEncoder({ ...SETTINGS, ffmpeg: 'C:\\f0' }, null, { deps: pc.deps, words: MILLER });
  assert.equal(r.t?.source, 'the FFmpeg setting');
  assert.equal(r.encoder?.chosen, null);
  assert.deepEqual(r.encoder?.passedOver, []);
});

test("when its own can't be fetched, the one found stays, says why, and the fetch is tried again next round", async () => {
  const pc = ffmpegs({ builds: [{ source: "Heiward's FFmpeg", encodes: false }], own: 'fails' });
  const r = await decideEncoder(SETTINGS, null, { deps: pc.deps, words: MILLER });
  assert.equal(r.t?.source, "Heiward's FFmpeg");
  assert.equal(r.encoder?.chosen, null);
  assert.deepEqual(r.encoder?.passedOver, [], 'not passed over: there was nothing else');
  assert.equal(r.encoder?.why, "No encoder available. hevc_d3d12va: Driver does not support VBR RC mode. The Miller's own FFmpeg, to try instead, couldn't be fetched: couldn't reach GitHub.");
  assert.equal(r.encoder?.need, 'Nothing, once this PC can reach GitHub: the Miller fetches its own FFmpeg (about 12 MB, LGPL) and starts.');
  assert.equal(r.encoder?.ownFailed, "couldn't reach GitHub");
  await decideEncoder(SETTINGS, r.encoder!, { deps: pc.deps, words: MILLER });
  assert.equal(pc.picked.length, 2, 'tried again, not held for a day');
});

test("Heiward's FFmpeg, though it encodes, is borrowed only while the agent's own can't be fetched (kit 2.136.6)", async () => {
  const opts: Parameters<typeof ffmpegs>[0] = { builds: [{ source: "Heiward's FFmpeg", encodes: true }], own: 'fetches' };
  const fetched = ffmpegs(opts);
  const r = await decideEncoder(SETTINGS, null, { deps: fetched.deps, words: MILLER });
  assert.equal(r.t?.source, "the Miller's own FFmpeg");
  assert.deepEqual(fetched.picked, ["the Miller's own FFmpeg"], "Heiward's isn't even tried");
  assert.equal(fetched.fetches(), 1);

  opts.own = 'fails';
  const offline = ffmpegs(opts);
  const b = await decideEncoder(SETTINGS, null, { deps: offline.deps, words: MILLER });
  assert.equal(b.t?.source, "Heiward's FFmpeg");
  assert.equal(b.encoder?.chosen?.name, 'hevc_mf');
  assert.equal(b.encoder?.why, "hevc_mf works. It's Heiward's FFmpeg, borrowed until the Miller's own can be fetched: couldn't reach GitHub.");
  assert.equal(b.encoder?.ownFailed, null, 'not a failure: its encoder works');
  // Next round its own is asked for again (getFfmpeg waits between tries), but Heiward's isn't tested again.
  const again = await decideEncoder(SETTINGS, b.encoder!, { deps: offline.deps, words: MILLER });
  assert.equal(again.encoder, undefined);
  assert.equal(offline.picked.length, 1);
  assert.equal(offline.fetches(), 2);
  // Once it can be fetched, its own takes over.
  opts.own = 'fetches';
  const back = await decideEncoder(SETTINGS, b.encoder!, { deps: offline.deps, words: MILLER });
  assert.equal(back.t?.source, "the Miller's own FFmpeg");
  assert.equal(back.encoder?.why, 'hevc_mf works.');
  assert.deepEqual(offline.picked, ["Heiward's FFmpeg", "the Miller's own FFmpeg"]);
});

test('an FFmpeg that encodes is kept, and nothing is passed over', async () => {
  const pc = ffmpegs({ builds: [{ source: 'PATH', encodes: true }, { source: "Heiward's FFmpeg", encodes: false }] });
  const r = await decideEncoder(SETTINGS, null, { deps: pc.deps });
  assert.equal(r.t?.source, 'PATH');
  assert.deepEqual(r.encoder?.passedOver, []);
  assert.equal(r.encoder?.ownFailed, null);
  assert.deepEqual(pc.picked, ['PATH']);
});

test("with no FFmpeg at all, the lines name the agent, in the Miller's or the Chronicler's own words", async () => {
  const none = () => ffmpegs({ builds: [], own: 'fails' });
  // The agent's APP.name when no words are given.
  const plain = await decideEncoder(SETTINGS, null, { deps: none().deps });
  assert.equal(plain.t, null);
  assert.equal(plain.encoder?.why, "No FFmpeg yet: none on this PC, and couldn't reach GitHub.");
  assert.equal(plain.encoder?.need, 'Nothing, once this PC can reach GitHub: the Fixture fetches its own FFmpeg (about 12 MB, LGPL) and starts.');
  const named = await decideEncoder({ ...SETTINGS, ffmpeg: 'D:\\mine\\ffmpeg.exe' }, null, { deps: none().deps, words: MILLER });
  assert.equal(named.encoder?.why, "No FFmpeg found: the one the FFmpeg setting names doesn't run here.");
  assert.equal(named.encoder?.need, 'Clear the FFmpeg setting to let the Miller use its own, or point it at an ffmpeg.exe that runs.');
  // A fetch that says nothing: the agent's own couldn't be fetched.
  const silent: EncoderDeps = { ...none().deps, fetchOwn: async () => ({ dir: 'C:\\own' }) };
  assert.equal((await decideEncoder(SETTINGS, null, { deps: silent, words: { agent: 'Chronicler' } })).encoder?.why, "No FFmpeg yet: none on this PC, and the Chronicler's own couldn't be fetched.");
  // Each agent's own need, as its copy had it.
  const miller = await decideEncoder(SETTINGS, null, {
    deps: none().deps,
    words: { agent: 'Miller', ownNeed: 'Nothing, once this PC can reach GitHub: the Miller fetches its own FFmpeg (about 12 MB, LGPL) and starts. Videos wait in the hopper until then.' },
  });
  assert.match(miller.encoder!.need!, /Videos wait in the hopper until then\.$/);
  const chronicler = await decideEncoder(SETTINGS, null, {
    deps: none().deps,
    words: { agent: 'Chronicler', ownNeed: 'Nothing, once this PC can reach GitHub: the Chronicler fetches its own FFmpeg (about 12 MB) and starts.' },
  });
  assert.equal(chronicler.encoder?.need, 'Nothing, once this PC can reach GitHub: the Chronicler fetches its own FFmpeg (about 12 MB) and starts.');
});

// ---------------------------------------------------------------- one video

const TOOLS: Tools = { ffmpeg: 'C:\\ff\\ffmpeg.exe', ffprobe: 'C:\\ff\\ffprobe.exe', dir: 'C:\\ff', source: 'test', version: 'n8.1.3-5', stamp: 's' };
const enc = (name: string) => RANKED.find((c) => c.name === name)!;
const block = (outTime: number, totalSize: number): Progress => ({ outTime, totalSize, speed: 2, done: false });

/**
 * A video on disk and FFmpeg stood in for: ffprobe answers `input` for the original and `copy` for anything else (or
 * fails with `probeError` / `copyError`); FFmpeg feeds `blocks`, then writes `outBytes` to its output and exits
 * (`exit`, or killed when a block's answer stops it).
 */
function rig(name: string, o: { input?: MediaInfo; copy?: MediaInfo; probeError?: string; copyError?: string; blocks?: Progress[]; outBytes?: number; exit?: number; failTimes?: boolean } = {}) {
  const dir = mkdtempSync(path.join(home, `${name}-`));
  const file = path.join(dir, 'original.mkv');
  writeFileSync(file, 'original');
  const seen = { args: [] as string[], times: [] as [string, Date, Date][], running: [] as (Running | null)[], phases: [] as string[], progress: [] as number[], temps: 0, finals: 0, kills: [] as string[] };
  const deps: ShrinkDeps = {
    probe: async (_t, f) => {
      if (f === file) return o.probeError ? { error: o.probeError } : { info: o.input ?? media() };
      return o.copyError ? { error: o.copyError } : { info: o.copy ?? media({ duration: 63.4 }) };
    },
    encode: (_t, job) => {
      seen.args = job.args;
      let stopped: string | null = null;
      const kill = (why: string) => void (stopped ??= why, seen.kills.push(why));
      const done = (async () => {
        await Promise.resolve();
        for (const b of o.blocks ?? [block(30, 100 * MB), block(63.5, 300 * MB)]) {
          const why = job.onProgress(b);
          if (why) {
            kill(why);
            break;
          }
        }
        if (stopped) return { ok: false, stopped, error: 'killed' };
        const exit = o.exit ?? 0;
        if (exit === 0) writeFileSync(job.args.at(-1)!, Buffer.alloc(o.outBytes ?? 3000));
        else writeFileSync(job.args.at(-1)!, 'half');
        return { ok: exit === 0, stopped: null, error: exit === 0 ? null : 'Invalid data found when processing input' };
      })();
      return { done, kill };
    },
    setFileTimes: async (f, created, modified) => {
      if (o.failTimes) throw new Error('PowerShell is busy');
      seen.times.push([f, created, modified]);
    },
  };
  const job = (more: Partial<ShrinkJob> = {}): ShrinkJob => ({
    t: TOOLS,
    encoder: enc('hevc_mf'),
    preset: 'balanced',
    inBytes: 900 * MB,
    videoMinMB: 10,
    temp: () => (seen.temps++, path.join(dir, '.agent-1.part.mp4')),
    final: () => (seen.finals++, path.join(dir, 'original.mp4')),
    onPhase: (p) => void seen.phases.push(p),
    onProgress: (p) => void seen.progress.push(Math.round(p.percent)),
    onRunning: (r) => void seen.running.push(r),
    deps,
    ...more,
  });
  return { dir, file, seen, job, files: () => readdirSync(dir).sort() };
}

test('a copy that passes its checks is kept: moved to its final name, with the original\'s times', async () => {
  const r = rig('kept');
  const out = await shrinkVideo(r.file, r.job());
  assert.equal(out?.status, 'kept');
  assert.equal(out?.reason, null);
  assert.equal(out?.outPath, path.join(r.dir, 'original.mp4'));
  assert.equal(out?.outBytes, 3000);
  assert.equal(out?.how, 'hevc_mf, balanced');
  assert.deepEqual(out?.checks.map((c) => [c.name, c.ok]), [['smaller', true], ['dimensions', true], ['duration', true], ['audio', true]]);
  assert.equal(out?.info?.duration, 63.5, "the original's view, for the agent's own record (its length, its tags)");
  assert.deepEqual(r.files(), ['original.mkv', 'original.mp4'], 'no temporary copy left');
  assert.deepEqual(r.seen.phases, ['reading', 'encoding', 'checking']);
  assert.deepEqual(r.seen.progress, [47, 100]);
  assert.equal(r.seen.running.length, 2);
  assert.equal(r.seen.running[1], null, 'the encode is handed over while it runs, and taken back after');
  assert.deepEqual([r.seen.temps, r.seen.finals], [1, 1]);
  const [timed, created, modified] = r.seen.times[0];
  assert.equal(timed, out?.outPath);
  assert.ok(created instanceof Date && modified instanceof Date);
  // The command: the plan's shape, the original's audio, MP4 and every core when nothing says otherwise.
  assert.equal(r.seen.args[r.seen.args.indexOf('-i') + 1], r.file);
  assert.equal(r.seen.args.at(-1), path.join(r.dir, '.agent-1.part.mp4'));
  assert.equal(r.seen.args[r.seen.args.indexOf('-f') + 1], 'mp4');
  assert.ok(!r.seen.args.includes('-threads'));
});

test("the Miller's cores and a MOV container reach the command; times that can't be set don't undo a kept copy", async () => {
  const r = rig('cores', { failTimes: true });
  const out = await shrinkVideo(r.file, r.job({ encoder: enc('libx265'), cores: 2, format: 'mov', final: () => path.join(r.dir, 'original.mov') }));
  assert.equal(out?.status, 'kept');
  assert.equal(out?.how, 'libx265, balanced');
  assert.equal(r.seen.args[r.seen.args.indexOf('-x265-params') + 1], 'pools=2:frame-threads=1');
  assert.equal(r.seen.args[r.seen.args.indexOf('-f') + 1], 'mov');
  assert.deepEqual(r.files(), ['original.mkv', 'original.mov']);
});

test('a video left as it is asks for no copy at all', async () => {
  const r = rig('small');
  const out = await shrinkVideo(r.file, r.job({ inBytes: 4 * MB }));
  assert.deepEqual(out && { ...out, info: !!out.info }, { status: 'skipped', reason: 'already small: 4.0 MB, under the 10 MB minimum', checks: [], outPath: null, outBytes: null, how: null, info: true });
  assert.deepEqual([r.seen.temps, r.seen.finals, r.seen.args.length], [0, 0, 0]);
  assert.deepEqual(r.files(), ['original.mkv']);
});

test("one ffprobe can't read is refused, in the Miller's words or the Chronicler's", async () => {
  const r = rig('unreadable', { probeError: 'Invalid data found when processing input' });
  assert.deepEqual(await shrinkVideo(r.file, r.job()), { status: 'refused', reason: "ffprobe couldn't read it: Invalid data found when processing input", checks: [], outPath: null, outBytes: null, how: null, info: null });
  const chronicler = await shrinkVideo(r.file, r.job({ words: { unreadable: "it couldn't be read" } }));
  assert.equal(chronicler?.reason, "it couldn't be read: Invalid data found when processing input");
  assert.equal(r.seen.temps, 0);
});

test('a copy past 90% of the original is stopped there, since it can only be refused, and removed', async () => {
  const r = rig('big', { blocks: [block(10, 100 * MB), block(31.75, 810 * MB), block(63.5, 900 * MB)] });
  const out = await shrinkVideo(r.file, r.job());
  assert.equal(out?.status, 'refused');
  assert.equal(out?.reason, "the copy passed 90% of the original's size (810.0 MB) 50% of the way through, so it can't come out smaller");
  assert.deepEqual([out?.how, out?.outBytes, out?.outPath, out?.checks], ['hevc_mf, balanced', null, null, []]);
  assert.equal(r.seen.kills.length, 1);
  assert.deepEqual(r.files(), ['original.mkv']);
  assert.equal(r.seen.finals, 0);
  // The Chronicler's words: the clip's size.
  const clip = await shrinkVideo(r.file, r.job({ words: { original: "the clip's" } }));
  assert.match(clip?.reason ?? '', /^the copy passed 90% of the clip's size \(810\.0 MB\) 50% of the way through/);
});

test("FFmpeg failing is a refusal with its words; stopped by the agent, it's no refusal at all", async () => {
  const failed = rig('failed', { exit: 1 });
  const out = await shrinkVideo(failed.file, failed.job());
  assert.deepEqual(out && { ...out, info: !!out.info }, { status: 'refused', reason: 'FFmpeg failed: Invalid data found when processing input', checks: [], outPath: null, outBytes: null, how: 'hevc_mf, balanced', info: true });
  assert.deepEqual(failed.files(), ['original.mkv'], 'the half-made copy is removed');

  const stopped = rig('stopped', { exit: 1 });
  assert.equal(await shrinkVideo(stopped.file, stopped.job({ stopping: () => true })), null);
  assert.deepEqual(stopped.files(), ['original.mkv']);
});

test('a copy that fails its checks, or that ffprobe cannot read, is refused with them and removed', async () => {
  const loud = rig('loud', { copy: media({ audio: 2 }) });
  const out = await shrinkVideo(loud.file, loud.job());
  assert.equal(out?.status, 'refused');
  assert.equal(out?.reason, 'audio: 2 audio streams, the original has 1');
  assert.equal(out?.outBytes, 3000);
  assert.equal(out?.checks.length, 4);
  assert.deepEqual(loud.files(), ['original.mkv']);
  assert.equal(loud.seen.finals, 0);
  assert.equal(loud.seen.times.length, 0);

  const broken = rig('broken', { copyError: 'moov atom not found' });
  const b = await shrinkVideo(broken.file, broken.job());
  assert.deepEqual(b?.checks, [{ name: 'video', ok: false, detail: "the copy can't be read: moov atom not found" }]);
  assert.equal(b?.reason, "video: the copy can't be read: moov atom not found");
  assert.equal(existsSync(path.join(broken.dir, '.agent-1.part.mp4')), false);
});
