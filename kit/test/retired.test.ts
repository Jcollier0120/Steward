import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The model files the NPU's routes no longer run (retired.ts, npu-vendors.json's `retired`, kit 2.101.0): removed once
// nothing names them for three days, never while config.json or a running server does. A fake PC throughout: its user
// folder (GenieX's cache) and tools home in a temporary one.
const root = mkdtempSync(path.join(tmpdir(), 'kit-retired-'));
process.env.REEVE_HOME = root;
after(() => rmSync(root, { recursive: true, force: true }));
const { NPU_CATALOG } = await import('./fixture/src/kit/npu-vendors.ts');
const { readRetiredRecord, removeRetiredModels, RETIRED_GRACE_MS, retiredModelsFile, retiredRoutes } = await import('./fixture/src/kit/retired.ts');
const { sharedAcceleratorsHome } = await import('./fixture/src/kit/everyone.ts');

const FOUR_B = 'qualcomm/Qwen3-VL-4B-Instruct:W4A16';
const TWO_B = 'unsloth/Qwen3-VL-2B-Instruct-GGUF:Q4_0';
const t0 = Date.parse('2026-10-23T12:00:00Z');

let n = 0;
/** A PC: its user folder, tools home and config.json, the NPU's entry chatting with `model` on GenieX (none: no NPU entry). */
function fakePc(o: { model?: string | null; cards?: Record<string, any>[] } = {}) {
  const dir = path.join(root, `pc-${++n}`);
  const user = path.join(dir, 'user');
  const tools = path.join(dir, 'tools');
  const env = { USERPROFILE: user, LOCALAPPDATA: path.join(user, 'AppData', 'Local') };
  const geniex = path.join(env.LOCALAPPDATA, 'GenieX CLI', 'geniex.exe');
  const models = path.join(user, '.cache', 'geniex', 'models');
  const fourB = path.join(models, 'qualcomm', 'Qwen3-VL-4B-Instruct');
  mkdirSync(fourB, { recursive: true });
  for (const f of ['geniex.json', 'part1_of_4.bin', 'vision_encoder.bin']) writeFileSync(path.join(fourB, f), 'x');
  mkdirSync(path.join(tools, 'models'), { recursive: true });
  const config = path.join(tools, 'config.json');
  const write = (model: string | null | undefined = o.model, cards = o.cards ?? []) =>
    writeFileSync(
      config,
      JSON.stringify({
        accelerators: [
          ...(model === null ? [] : [{ id: 'npu', kind: 'npu', chat: { baseUrl: 'http://127.0.0.1:18181', model: model ?? TWO_B, startCommand: ['%LOCALAPPDATA%\\GenieX CLI\\geniex.exe', 'serve', '--skip-update'] }, vision: { model: model ?? TWO_B } }]),
          ...cards,
        ],
      }),
    );
  write();
  const log: string[] = [];
  let running: string[] = [];
  let asked = 0;
  const look = (now: number, more: { exists?: (p: string) => boolean } = {}) =>
    removeRetiredModels({ configFile: config, home: tools, env, now: () => now, running: async () => (asked++, running), log: (l) => log.push(l), ...more });
  return { dir, user, tools, env, geniex, models, fourB, config, write, log, look, setRunning: (r: string[]) => (running = r), asked: () => asked };
}

test('the shipped catalog: the Snapdragon route retires the 4B, the old GenieX chat model and the graphics\' Q4_K_M; each entry says when and why', () => {
  const q = NPU_CATALOG.routes.qualcomm;
  assert.deepEqual(
    q.retired!.map((r) => [r.path, r.match ?? null, r.model ?? null, r.since]),
    [
      ['{tools}\\models', '^(Qwen_)?Qwen3-?VL-2B-Instruct-Q4_K_M\\.gguf$', null, '2.100.0'],
      ['%USERPROFILE%\\.cache\\geniex\\models\\qualcomm\\Qwen3-VL-4B-Instruct', null, FOUR_B, '2.101.0'],
      ['%USERPROFILE%\\.cache\\geniex\\models\\qualcomm\\Qwen3-4B-Instruct-2507', null, 'qualcomm/Qwen3-4B-Instruct-2507:W4A16', '2.101.0'],
    ],
  );
  for (const [id, r] of Object.entries(NPU_CATALOG.routes)) {
    for (const x of r.retired ?? []) {
      assert.ok(x.why.length > 20, `${id}: ${x.path} says why`);
      assert.match(x.since, /^\d+\.\d+\.\d+$/, `${id}: ${x.path}`);
      assert.match(x.path, /^(\{tools\}|%USERPROFILE%|%LOCALAPPDATA%)\\/, `${id}: ${x.path} is under a folder setup fills in`);
      if (x.match) new RegExp(x.match, 'i');
      // A retired model is never one the route still runs, for any generation.
      const running = [...r.models, ...Object.values(r.generations).flatMap((g) => g.models ?? [])].map((m) => m.id);
      if (x.model && x.model !== FOUR_B) assert.ok(!running.includes(x.model), `${id}: ${x.model} is still run`);
    }
  }
  // The 4B is the X Elite's fallback, so a PC that fell back to it names it in config.json, and keeps it.
  assert.deepEqual(q.generations['snapdragon-x'].fallback!.models, [FOUR_B]);
  assert.equal(new RegExp(q.retired![0].match!, 'i').test('Qwen3VL-2B-Instruct-Q4_K_M.gguf'), true);
  assert.equal(new RegExp(q.retired![0].match!, 'i').test('Qwen_Qwen3-VL-2B-Instruct-Q4_K_M.gguf'), true);
  assert.equal(new RegExp(q.retired![0].match!, 'i').test('Qwen3-VL-2B-Instruct-Q4_0.gguf'), false, "GenieX's own copy, which the cards read");
  assert.equal(new RegExp(q.retired![0].match!, 'i').test('mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf'), false, "setup's projector, which they read beside it");
});

test('a PC that moved to the 2B: the 4B goes once nothing has named it for three days, never while a server names it', async () => {
  const pc = fakePc();
  assert.deepEqual(await pc.look(t0), { removed: [] });
  assert.deepEqual(pc.log, ['Qwen3-VL-4B-Instruct is no longer used (GenieX retired it in kit 2.101.0): removed in 3 days unless something names it']);
  assert.deepEqual(readRetiredRecord(pc.config), { unnamed: { [pc.fourB]: new Date(t0).toISOString() } });
  // Looks before its time: nothing removed, Windows' process list not asked, the first time kept.
  assert.deepEqual(await pc.look(t0 + RETIRED_GRACE_MS - 1), { removed: [] });
  assert.equal(pc.asked(), 0);
  assert.equal(pc.log.length, 1);
  // Its time come, a running server names it (by its model's id): kept.
  pc.setRunning([`"${pc.geniex}" serve --model ${FOUR_B}`]);
  assert.deepEqual(await pc.look(t0 + RETIRED_GRACE_MS), { removed: [] });
  assert.ok(existsSync(pc.fourB));
  // Nothing names it: removed whole, nothing left beside it, and said so.
  pc.setRunning([`"${pc.geniex}" serve --skip-update --host 127.0.0.1:18181`]);
  assert.deepEqual(await pc.look(t0 + RETIRED_GRACE_MS + 60_000), { removed: [pc.fourB] });
  assert.ok(!existsSync(pc.fourB));
  assert.deepEqual(readdirSync(path.dirname(pc.fourB)), []);
  assert.equal(pc.log.at(-1), 'removed Qwen3-VL-4B-Instruct (0.00 GB): nothing has used it for 3 days (GenieX retired it in kit 2.101.0)');
  assert.deepEqual(readRetiredRecord(pc.config), { unnamed: {} });
  assert.deepEqual(await pc.look(t0 + 2 * RETIRED_GRACE_MS), { removed: [] });
});

test('a PC that never moved off the 4B, or fell back to it, keeps it: its entry names it', async () => {
  const pc = fakePc({ model: FOUR_B });
  assert.deepEqual(await pc.look(t0), { removed: [] });
  assert.deepEqual(await pc.look(t0 + 10 * RETIRED_GRACE_MS), { removed: [] });
  assert.ok(existsSync(pc.fourB));
  assert.deepEqual(pc.log, []);
  assert.equal(existsSync(retiredModelsFile(pc.config)), false, 'nothing to remember');
});

test('named again in config.json: kept, and its three days start over once nothing names it', async () => {
  const pc = fakePc();
  await pc.look(t0);
  pc.write(FOUR_B);
  await pc.look(t0 + RETIRED_GRACE_MS);
  assert.equal(pc.log.at(-1), 'Qwen3-VL-4B-Instruct is named in config.json again: kept');
  assert.deepEqual(readRetiredRecord(pc.config), { unnamed: {} });
  pc.write(TWO_B);
  const t1 = t0 + 2 * RETIRED_GRACE_MS;
  assert.deepEqual(await pc.look(t1), { removed: [] });
  assert.deepEqual(await pc.look(t1 + RETIRED_GRACE_MS - 1), { removed: [] });
  assert.deepEqual(await pc.look(t1 + RETIRED_GRACE_MS), { removed: [pc.fourB] });
});

test("the graphics' Q4_K_M, under any repository's name: the one a card still reads is kept, the other goes", async () => {
  const pc = fakePc();
  // The processor's entry reads one of them.
  const read = path.join(pc.tools, 'models', 'Qwen3VL-2B-Instruct-Q4_K_M.gguf');
  pc.write(TWO_B, [{ id: 'cpu', kind: 'cpu', chat: { baseUrl: 'http://127.0.0.1:18193', model: 'qwen3-vl-2b-instruct', startCommand: ['C:\\l\\llama-server.exe', '-m', read] } }]);
  const other = path.join(pc.tools, 'models', 'Qwen_Qwen3-VL-2B-Instruct-Q4_K_M.gguf');
  const projector = path.join(pc.tools, 'models', 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf');
  for (const f of [read, other, projector]) writeFileSync(f, 'x');
  rmSync(pc.fourB, { recursive: true });
  await pc.look(t0);
  assert.deepEqual(await pc.look(t0 + RETIRED_GRACE_MS), { removed: [other] });
  assert.ok(existsSync(read) && existsSync(projector));
  assert.ok(!existsSync(other));
});

test('nothing is looked at where the route has nothing to do with the PC, config.json can\'t be read, or the files are the shared folder\'s', async () => {
  // No NPU entry and no GenieX: the Snapdragon's list doesn't apply.
  const none = fakePc({ model: null });
  assert.deepEqual(retiredRoutes({ accelerators: [] }, { tools: none.tools, env: none.env, exists: () => false }), []);
  assert.deepEqual(await none.look(t0, { exists: () => false }), { removed: [] });
  assert.deepEqual(await none.look(t0 + RETIRED_GRACE_MS, { exists: () => false }), { removed: [] });
  assert.ok(existsSync(none.fourB));
  // GenieX installed, its entry gone: the list applies (its models are named by nothing).
  assert.deepEqual(retiredRoutes({ accelerators: [] }, { tools: none.tools, env: none.env, exists: (p) => p === none.geniex }).map((r) => r.server), ['GenieX']);
  // config.json unreadable: nothing, the next look tries.
  const broken = fakePc();
  writeFileSync(broken.config, '{ not json');
  assert.deepEqual(await broken.look(t0), { removed: [] });
  assert.equal(existsSync(retiredModelsFile(broken.config)), false);
  // The PC's shared folder (an Everyone install): its Q4_K_M is other accounts' too; GenieX's cache is this user's own.
  const shared = path.join(root, 'castellan');
  mkdirSync(shared, { recursive: true });
  writeFileSync(path.join(shared, 'everyone.json'), '{}');
  const pc = fakePc();
  const env = { ...pc.env, CASTELLAN_SHARED: shared };
  const tools = sharedAcceleratorsHome(env);
  mkdirSync(path.join(tools, 'models'), { recursive: true });
  const q4km = path.join(tools, 'models', 'Qwen3VL-2B-Instruct-Q4_K_M.gguf');
  writeFileSync(q4km, 'x');
  const look = (now: number) => removeRetiredModels({ configFile: pc.config, home: tools, env, now: () => now, running: async () => [], log: () => {} });
  await look(t0);
  assert.deepEqual(await look(t0 + RETIRED_GRACE_MS), { removed: [pc.fourB] });
  assert.ok(existsSync(q4km));
});

test('a folder whose removal was cut short goes at the next look', async () => {
  const pc = fakePc();
  const aside = `${pc.fourB}.removing`;
  mkdirSync(aside, { recursive: true });
  writeFileSync(path.join(aside, 'part2_of_4.bin'), 'x');
  await pc.look(t0);
  assert.ok(!existsSync(aside));
  assert.ok(existsSync(pc.fourB), 'the folder itself waits its three days');
});
