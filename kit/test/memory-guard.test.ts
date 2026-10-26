import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The memory guard (memory-guard.ts, kit 2.138.0): a model server starts only with room for its model, the manor's other
// servers, unused, stopped for it first. A fake PC throughout.
const home = mkdtempSync(path.join(tmpdir(), 'kit-guard-'));
process.env.REEVE_HOME = home;
process.env.MANOR_HOME = path.join(home, 'no-manor');
process.env.SMITH_HOME = path.join(home, 'no-smith');
after(() => rmSync(home, { recursive: true, force: true }));

const { bytesAt, GUARD_LOOK_MS, HEADROOM_BYTES, headroomBytes, modelBytes, needOf, roomFor, UNKNOWN_MODEL_BYTES } = await import('./fixture/src/kit/memory-guard.ts');
const { ensureServer, NoRoomToLoad } = await import('./fixture/src/kit/accelerators.ts');
type Deps = Parameters<typeof roomFor>[2];

const GB = 1024 ** 3;

/** A fake PC: `free` available, and the others' stops, each freeing its `gb` when it stops (or saying why not). */
function pc(free: number, others: { base: string; gb: number; says: ('stopped' | 'not-running' | 'kept')[] }[]) {
  let mem = free;
  let now = 0;
  const lines: string[] = [];
  const asked: string[] = [];
  const d: Deps = {
    freeBytes: () => mem,
    others: () =>
      others.map((o) => ({
        base: o.base,
        stop: async () => {
          asked.push(o.base);
          const r = o.says.length > 1 ? o.says.shift()! : o.says[0];
          if (r === 'stopped') {
            mem += o.gb * GB;
            o.says = ['not-running'];
          }
          return r;
        },
      })),
    log: (l) => lines.push(l),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  return { d, lines, asked, at: () => now };
}

test("a model file and its projector, or an OpenVINO model folder, are what a server needs, with the manor's ceiling's share left; a card with its own memory is left alone", () => {
  assert.equal(headroomBytes(8 * GB), HEADROOM_BYTES, 'at least 1.5 GB');
  assert.equal(headroomBytes(32 * GB), Math.round(0.15 * 32 * GB), "what the 85% ceiling leaves of 32 GB");
  const dir = path.join(home, 'models');
  mkdirSync(path.join(dir, 'repo', 'Org', 'Model'), { recursive: true });
  writeFileSync(path.join(dir, 'm.gguf'), Buffer.alloc(3000));
  writeFileSync(path.join(dir, 'mmproj.gguf'), Buffer.alloc(1000));
  writeFileSync(path.join(dir, 'repo', 'Org', 'Model', 'a.bin'), Buffer.alloc(500));
  writeFileSync(path.join(dir, 'repo', 'Org', 'Model', 'b.xml'), Buffer.alloc(20));
  assert.equal(bytesAt(path.join(dir, 'repo')), 520);
  assert.equal(bytesAt(path.join(dir, 'none')), 0);
  assert.equal(modelBytes(['llama-server.exe', '-m', path.join(dir, 'm.gguf'), '--mmproj', path.join(dir, 'mmproj.gguf'), '--port', '1']), 4000);
  assert.equal(modelBytes(['ovms.exe', '--source_model', 'Org/Model', '--model_repository_path', '%MODELS%'], bytesAt, { MODELS: path.join(dir, 'repo') }), 520);
  assert.equal(modelBytes(['geniex.exe', '--port', '18181']), null);
  assert.equal(modelBytes(['llama-server.exe', '-m', path.join(dir, 'gone.gguf')]), null);

  const raw = {
    accelerators: [
      { id: 'npu', kind: 'npu', slots: 1, maxContextTokens: 4096, quirks: [], chat: { baseUrl: 'http://127.0.0.1:18181', model: 'm', startCommand: ['geniex.exe'] } },
      { id: 'gpu-big', kind: 'gpu', memoryGb: 8, slots: 2, maxContextTokens: 4096, quirks: [], chat: { baseUrl: 'http://127.0.0.1:18300', model: 'm', startCommand: ['llama-server.exe'] } },
      { id: 'gpu-igpu', kind: 'gpu', memoryGb: 0.5, slots: 2, maxContextTokens: 4096, quirks: [], chat: { baseUrl: 'http://127.0.0.1:18301', model: 'm', startCommand: ['llama-server.exe'] } },
    ],
  };
  const small = { totalBytes: 8 * GB };
  assert.deepEqual(needOf({ baseUrl: 'http://127.0.0.1:18181', startCommand: ['geniex.exe'] }, raw, small), { needBytes: UNKNOWN_MODEL_BYTES + HEADROOM_BYTES, accId: 'npu' });
  assert.equal(needOf({ baseUrl: 'http://127.0.0.1:18300', startCommand: ['llama-server.exe'] }, raw), null);
  assert.deepEqual(needOf({ baseUrl: 'http://127.0.0.1:18301', startCommand: ['llama-server.exe', '-m', 'x'] }, raw, { size: () => 2 * GB, totalBytes: 32 * GB }), { needBytes: 2 * GB + Math.round(0.15 * 32 * GB), accId: 'gpu-igpu' });
  assert.deepEqual(needOf({ baseUrl: 'http://127.0.0.1:18199', startCommand: [] }, raw, small), { needBytes: UNKNOWN_MODEL_BYTES + HEADROOM_BYTES, accId: null });
});

test('with room, nothing is stopped and nothing waits', async () => {
  const p = pc(8 * GB, [{ base: 'a', gb: 2, says: ['stopped'] }]);
  const r = await roomFor('x', 4 * GB, p.d);
  assert.equal(r.did, 'room');
  assert.deepEqual(r.stopped, []);
  assert.deepEqual(p.asked, []);
  assert.deepEqual(p.lines, []);
});

test('short of room, the unused others stop, the longest unused first, only until there is room', async () => {
  const p = pc(2 * GB, [
    { base: 'old', gb: 1, says: ['stopped'] },
    { base: 'older', gb: 2, says: ['stopped'] },
    { base: 'newest', gb: 2, says: ['stopped'] },
  ]);
  const r = await roomFor('x', 4.5 * GB, p.d);
  assert.equal(r.did, 'room');
  assert.deepEqual(r.stopped, ['old', 'older']);
  assert.deepEqual(p.asked, ['old', 'older']);
  assert.equal(p.at(), 0);
  assert.match(p.lines.join('\n'), /stopped old, older, unused, for room to start x/);
});

test('one in use is waited on, looked at again until its work is done, and then stopped', async () => {
  const p = pc(1 * GB, [{ base: 'busy', gb: 4, says: ['kept', 'kept', 'stopped'] }]);
  const r = await roomFor('x', 4 * GB, p.d);
  assert.equal(r.did, 'room');
  assert.deepEqual(r.stopped, ['busy']);
  assert.equal(r.waitedMs, 2 * GUARD_LOOK_MS);
});

test("still short, a person's starts anyway (at once when nothing can stop, after the wait when one stays in use), and background work is left for later", async () => {
  const none = pc(1 * GB, [{ base: 'gone', gb: 4, says: ['not-running'] }]);
  const r1 = await roomFor('x', 4 * GB, none.d);
  assert.equal(r1.did, 'short');
  assert.equal(r1.waitedMs, 0);
  assert.match(none.lines.join('\n'), /started x anyway: 1\.0 GB of memory available, where its model needs about 4\.0 GB to stay under the manor's 85%; none of the manor's other servers could be stopped for it/);

  const busy = pc(1 * GB, [{ base: 'busy', gb: 4, says: ['kept'] }]);
  const r2 = await roomFor('x', 4 * GB, busy.d, { waitMs: 30_000 });
  assert.equal(r2.did, 'short');
  assert.equal(r2.waitedMs, 30_000);
  assert.match(busy.lines.join('\n'), /still in use after 30 s/);

  const later = pc(1 * GB, [{ base: 'busy', gb: 4, says: ['kept'] }]);
  assert.equal((await roomFor('x', 4 * GB, later.d, { waitMs: 30_000, then: 'defer' })).did, 'short');
  assert.match(later.lines.join('\n'), /left x for later: 1\.0 GB of memory available/);

  const broken = pc(1 * GB, []);
  broken.d.others = () => {
    throw new Error('no config');
  };
  assert.equal((await roomFor('x', 4 * GB, broken.d)).did, 'room', 'a look that fails never holds a start back');
  assert.match(broken.lines.join('\n'), /without looking for room: no config/);
});

test("with no room, background work's server isn't started: NoRoomToLoad, which npu.ts defers; a person's starts anyway", async () => {
  const asked: string[] = [];
  const short = async (_ep: unknown, o: { then: string }) => (asked.push(o.then), { did: 'short' as const, freeBytes: 1 * GB, needBytes: 4 * GB });
  // Nothing answers at this address, and its program isn't there: only a start that went ahead would say so.
  const ep = { baseUrl: 'http://127.0.0.1:9', model: 'm', startCommand: [path.join(home, 'no-such-server.exe')] };
  await assert.rejects(ensureServer(ep, { whenShort: 'defer', room: short }), (e: any) => e instanceof NoRoomToLoad && /wasn't started: 1\.0 GB of memory available, where its model needs about 4\.0 GB/.test(e.message));
  await assert.rejects(ensureServer(ep, { room: short }), (e: any) => !(e instanceof NoRoomToLoad) && /isn't installed/.test(e.message), 'started anyway: its program is looked for');
  assert.deepEqual(asked, ['defer', 'start']);
});
