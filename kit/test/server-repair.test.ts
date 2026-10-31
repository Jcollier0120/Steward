import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A model server whose program is gone from where config.json starts it, set up again by the keeper (server-repair.ts,
// kit 2.113.5): as on the X2 whose GenieX was in the Claude app's own AppData alone. A fake PC: its files a list, its
// clock a number, setup a stand-in that says what it was asked.
const home = mkdtempSync(path.join(tmpdir(), 'kit-server-repair-'));
process.env.REEVE_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const S = await import('./fixture/src/kit/server-repair.ts');
const V = await import('./fixture/src/kit/npu-vendors.ts');

const ENV = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', USERPROFILE: 'C:\\Users\\me' };
const tools = 'C:\\Users\\me\\.manor\\accelerators';
const MIN = 60_000;
const exe = (vendor: 'qualcomm' | 'intel' | 'amd') => V.serverExe(V.NPU_CATALOG.routes[vendor], tools, ENV);
const npu = (cmd: string, more: Record<string, any> = {}) => ({ id: 'npu', kind: 'npu', slots: 1, maxContextTokens: 4096, quirks: [], chat: { baseUrl: 'http://127.0.0.1:18181', model: 'm', startCommand: [cmd, 'serve'] }, ...more });
const card = (cmd: string) => ({ id: 'gpu-radeon', kind: 'gpu', memoryGb: 8, slots: 1, maxContextTokens: 8192, quirks: [], chat: { baseUrl: 'http://127.0.0.1:18191', model: 'q', startCommand: [cmd, '-m', 'q.gguf'] }, embed: { baseUrl: 'http://127.0.0.1:18192', model: 'e', startCommand: [cmd, '-m', 'e.gguf', '--embedding'] } });

let n = 0;
/** A PC with these accelerators in config.json and these files on disk; setup answers `code` and, when 0, puts the program back. */
function fakePc(accelerators: Record<string, any>[], files: string[] = [], o: { code?: number; stopped?: boolean } = {}) {
  const on = new Set(files.map((f) => f.toLowerCase()));
  const asked: any[] = [];
  const log: string[] = [];
  let now = Date.parse('2026-10-24T09:00:00Z');
  const file = path.join(home, `repair-${++n}.json`);
  const deps = {
    raw: () => ({ accelerators }),
    file,
    tools,
    env: ENV,
    exists: (p: string) => on.has(p.toLowerCase()),
    now: () => now,
    stopped: () => (o.stopped ? '2026-10-24T08:00:00Z' : null),
    setup: async (x: any) => {
      asked.push(x);
      if (!(o.code ?? 0)) for (const a of accelerators) for (const k of ['chat', 'vision', 'embed', 'rerank']) if (a[k]?.startCommand) on.add(String(a[k].startCommand[0]).replace(/%LOCALAPPDATA%/i, ENV.LOCALAPPDATA).toLowerCase());
      return { code: o.code ?? 0 };
    },
    log: (l: string) => log.push(l),
  };
  return { deps, asked, log, file, later: (ms: number) => (now += ms), record: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null), add: (f: string) => on.add(f.toLowerCase()), drop: (f: string) => on.delete(f.toLowerCase()) };
}

test("each maker's NPU server whose program is gone is set up again, once it has been missing 5 minutes: GenieX in AppData, OpenVINO Model Server and FastFlowLM in the tools home", async () => {
  for (const [vendor, cmd] of [
    ['qualcomm', '%LOCALAPPDATA%\\GenieX CLI\\geniex.exe'],
    ['intel', exe('intel')],
    ['amd', exe('amd')],
  ] as const) {
    const program = cmd.replace('%LOCALAPPDATA%', ENV.LOCALAPPDATA);
    assert.equal(program, exe(vendor), `${vendor}: where its route installs it`);
    const pc = fakePc([npu(cmd)]);
    assert.deepEqual(S.missingServers({ accelerators: [npu(cmd)] }, { tools, env: ENV, exists: pc.deps.exists }), [{ id: 'npu', kind: 'npu', program, kinds: ['chat'] }], vendor);
    assert.deepEqual(await S.repairMissing(pc.deps), { did: 'waiting', ids: ['npu'] }, vendor);
    assert.deepEqual(pc.log, [`npu's server program isn't installed where the staff look for it (${program}): it's set up again if it's still missing in 5 minutes`], vendor);
    pc.later(4 * MIN);
    assert.deepEqual(await S.repairMissing(pc.deps), { did: 'waiting', ids: ['npu'] }, `${vendor}: not yet`);
    assert.equal(pc.log.length, 1, `${vendor}: said once`);
    pc.later(MIN);
    assert.deepEqual(await S.repairMissing(pc.deps), { did: 'set-up', id: 'npu', code: 0 }, vendor);
    assert.deepEqual(pc.asked, [{ ids: ['npu'], yes: true }], `${vendor}: the NPU's setup, as local-ai runs it`);
    assert.deepEqual(pc.log.slice(1), [`setting up npu again: its server program isn't installed where the staff look for it (${program})`, 'npu is set up again'], vendor);
    assert.deepEqual(await S.repairMissing(pc.deps), { did: 'none' }, `${vendor}: back`);
    assert.equal(pc.log.at(-1), `npu's server program is back (${program})`);
    assert.deepEqual(pc.record(), {}, `${vendor}: forgotten`);
  }
});

test("a card's llama.cpp gone: its setup for what it served; one server a look; a setup that fails is tried again 6 hours on", async () => {
  const llama = `${tools}\\servers\\llama.cpp\\b11800-vulkan\\llama-server.exe`;
  const pc = fakePc([card(llama)], [], { code: 1 });
  await S.repairMissing(pc.deps);
  pc.later(5 * MIN);
  assert.deepEqual(await S.repairMissing(pc.deps), { did: 'set-up', id: 'gpu-radeon', code: 1 });
  assert.deepEqual(pc.asked, [{ ids: ['gpu-radeon'], kinds: ['chat', 'embed'], yes: true }]);
  assert.equal(pc.log.at(-1), "gpu-radeon couldn't be set up again (setup's code 1): tried again in 6 hours");
  assert.equal(pc.record()['gpu-radeon'].code, 1);
  pc.later(6 * 3600_000 - MIN);
  assert.deepEqual(await S.repairMissing(pc.deps), { did: 'waiting', ids: ['gpu-radeon'] });
  pc.later(MIN);
  assert.deepEqual(await S.repairMissing(pc.deps), { did: 'set-up', id: 'gpu-radeon', code: 1 });
  assert.equal(pc.asked.length, 2);

  // Two gone at once: one set up a look, the other at the next.
  const two = fakePc([card(llama), npu(exe('intel'))], [], { code: 1 });
  await S.repairMissing(two.deps);
  two.later(5 * MIN);
  const first = await S.repairMissing(two.deps);
  const second = await S.repairMissing(two.deps);
  assert.deepEqual([first.did, second.did], ['set-up', 'set-up']);
  assert.deepEqual(two.asked.map((x) => x.ids[0]).sort(), ['gpu-radeon', 'npu']);
  // A setup that throws counts as a failure, and its look ends.
  const throws = fakePc([npu(exe('amd'))]);
  throws.deps.setup = async () => Promise.reject(new Error('the download failed\nat line 2'));
  await S.repairMissing(throws.deps);
  throws.later(5 * MIN);
  assert.deepEqual(await S.repairMissing(throws.deps), { did: 'set-up', id: 'npu', code: 1 });
  assert.ok(throws.log.includes('setting up npu again stopped: the download failed'), throws.log.join('\n'));
});

test("nothing set up while the manor is stopped, nor a program setup doesn't put there; a program moved by an update waits its 5 minutes again", async () => {
  const stopped = fakePc([npu(exe('qualcomm'))], [], { stopped: true });
  await S.repairMissing(stopped.deps);
  stopped.later(10 * MIN);
  assert.deepEqual(await S.repairMissing(stopped.deps), { did: 'stopped' });
  assert.deepEqual(stopped.asked, []);
  assert.equal(stopped.record().npu.triedAt, undefined, 'set up at once when the manor starts again');

  // The person's own: a script, a program elsewhere, one on PATH; one switched off; one that's there.
  const own = [npu('C:\\scripts\\my-npu.cmd'), card('llama-server'), { ...card(`${tools}\\servers\\llama.cpp\\b1\\llama-server.exe`), id: 'gpu-off', enabled: false }, { ...card(`${tools}\\servers\\llama.cpp\\b2\\llama-server.exe`), id: 'gpu-here' }, { ...card('D:\\models\\llama-server.exe'), id: 'gpu-mine' }];
  const pc = fakePc(own, [`${tools}\\servers\\llama.cpp\\b2\\llama-server.exe`]);
  assert.deepEqual(S.missingServers({ accelerators: own }, { tools, env: ENV, exists: pc.deps.exists }), []);
  assert.deepEqual(await S.repairMissing(pc.deps), { did: 'none' });
  assert.equal(pc.record(), null, 'nothing written');

  // FastFlowLM moved to a new version's folder before the old one's 5 minutes were up: its own 5 minutes from then.
  const old = `${tools}\\servers\\fastflowlm-1.0.7\\flm.exe`;
  const accs = [npu(old)];
  const moved = fakePc(accs);
  await S.repairMissing(moved.deps);
  moved.later(4 * MIN);
  accs[0] = npu(exe('amd'));
  assert.deepEqual(await S.repairMissing(moved.deps), { did: 'waiting', ids: ['npu'] });
  moved.later(4 * MIN);
  assert.deepEqual(await S.repairMissing(moved.deps), { did: 'waiting', ids: ['npu'] });
  moved.later(MIN);
  assert.equal((await S.repairMissing(moved.deps)).did, 'set-up');
  assert.deepEqual(S.setupFolders(tools, ENV).map((f) => f.toLowerCase()), [tools.toLowerCase(), `${ENV.LOCALAPPDATA}\\GenieX CLI`.toLowerCase()], "the tools home, and GenieX's own folder");
});

test("server-repair.json's rename is tried again while Windows refuses it for a moment (an antivirus, the indexer), where it failed the look with EPERM", async () => {
  const pc = fakePc([npu(exe('intel'))]);
  const waits: number[] = [];
  let refused = 0;
  const rename: typeof renameSync = (from, to) => {
    if (refused++ < 2) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM' });
    renameSync(from, to);
  };
  const deps = { ...pc.deps, rename, sleep: (ms: number) => void waits.push(ms) };
  assert.deepEqual(await S.repairMissing(deps), { did: 'waiting', ids: ['npu'] });
  assert.deepEqual(waits, [25, 25]);
  assert.equal(pc.record().npu.program, exe('intel'));
  assert.deepEqual(readdirSync(home).filter((f) => f.startsWith(path.basename(pc.file)) && f.endsWith('.tmp')), [], 'no temporary file left');
});
