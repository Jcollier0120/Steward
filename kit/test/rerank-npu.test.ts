import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { freePort } from './free-port.ts';

// AMD's NPU's reranker (kit 2.137.0, rerank-npu.ts): where it's set up, the keeper's look at it (fake program, fetch,
// compile and test, so no model is needed), what the keeper and setup keep of it, where reranks go once it's there, the
// card's "setting up" while it compiles, and the program's protocol (a stand-in program). The real program on a real
// NPU, its check against the processor and its accuracy, is spec/NPU-VENDORS.md's measuring, not a test here.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-rerank-npu-'));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.FIXTURE_PORT = String(await freePort()); // never the fixture's own 17979, which every checkout's tests share
process.env.KIT_GENTLE = '0'; // priority alone: no PowerShell worker
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'npu-agent', 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'no-manor');
process.env.SMITH_HOME = path.join(home, 'no-smith');
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });
after(() => rmSync(home, { recursive: true, force: true }));

const R = await import('./fixture/src/kit/rerank-npu.ts');
const { SPLIT_PATTERN, tokenizerFiles } = await import('./fixture/src/kit/rerank-npu-export.ts');
const { keepingNpuRerank } = await import('./fixture/src/kit/setup.ts');
const { reapedServers, servesBase } = await import('./fixture/src/kit/keeper.ts');
const { kitSettingUp, resetWorkTasks, setSettingUp, workTasks } = await import('./fixture/src/kit/work-tasks.ts');
const { LockTimeout } = await import('./fixture/src/kit/lock.ts');
const { NPU_CATALOG, workOrderFor } = await import('./fixture/src/kit/npu-vendors.ts');
const { configuredAccelerators, serves: servesKind } = await import('./fixture/src/kit/accelerator-config.ts');
const core = await import('../core/index.js');

type Deps = import('./fixture/src/kit/rerank-npu.ts').RerankLookDeps;
type Endpoint = import('./fixture/src/kit/accelerator-config.ts').Endpoint;

const MIN = 60_000;
const HOUR = 60 * MIN;
const TOOLS = path.join(home, 'tools');
const FILE = path.join(home, 'accelerators', 'config.json');
const ENV = { ...process.env, KIT_RERANK_HOME: path.join(home, 'rerank') };
const PLACE = R.rerankPlace(ENV);
const EXE = path.join(home, 'kit', 'rerank-npu-0123456789ab.exe');
const OLD_EXE = path.join(home, 'kit', 'rerank-npu-ba9876543210.exe');

const ep = (port: number, model: string, startCommand?: string[]) => ({ baseUrl: `http://127.0.0.1:${port}`, model, ...(startCommand ? { startCommand } : {}) });
/** AMD's NPU as setup writes it: FastFlowLM's chat (the AMD route's server), and the NPU's reranker when given. */
const amdNpu = (over: Record<string, unknown> = {}) => ({ id: 'npu', kind: 'npu', name: 'AMD Ryzen AI NPU', chat: ep(18184, 'qwen3.5:2b', [path.join(TOOLS, 'servers', 'fastflowlm-1.0.10', 'flm.exe'), 'serve', 'qwen3.5:2b', '--port', '18184']), ...over });
const radeon = (over: Record<string, unknown> = {}) => ({ id: 'gpu-amd-radeon-860m-graphics', kind: 'gpu', name: 'AMD Radeon 860M Graphics', vision: ep(18192, 'qwen-vl', ['llama-server.exe', '--port', '18192']), embed: ep(18193, 'embed', ['llama-server.exe', '--port', '18193']), rerank: ep(18194, R.RERANK_ALIAS, ['llama-server.exe', '--port', '18194', '--reranking']), ...over });
const cpu = (over: Record<string, unknown> = {}) => ({ id: 'cpu', kind: 'cpu', name: 'CPU', rerank: ep(18195, R.RERANK_ALIAS, ['llama-server.exe', '--port', '18195', '--reranking']), ...over });
const kitRerank = (exe = EXE) => R.rerankEndpoint(PLACE, exe);

const writeConfig = (accelerators: object[]) => {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify({ accelerators }));
};
const npuInConfig = () => JSON.parse(readFileSync(FILE, 'utf8')).accelerators.find((a: any) => a.id === 'npu');
const modelReady = (ready: boolean) => {
  rmSync(PLACE.model, { recursive: true, force: true });
  if (ready) {
    mkdirSync(PLACE.model, { recursive: true });
    writeFileSync(path.join(PLACE.model, 'ready'), 'now\n');
  }
};

let clock = Date.parse('2026-10-25T06:00:00Z');
beforeEach(() => {
  R.resetRerankLook();
  resetWorkTasks();
  clock = Date.parse('2026-10-25T06:00:00Z');
  modelReady(false);
});

/** The look's deps, all fake: a program that's ready, a fetch and compile that pass, a server that answers its test. */
function lookDeps(over: Partial<Deps> = {}) {
  const seen = { log: [] as string[], settingUp: [] as (string | null)[], exe: 0, status: 0, fetched: 0, prepared: 0, tested: [] as Endpoint[] };
  const deps: Deps = {
    configFile: FILE,
    tools: TOOLS,
    place: PLACE,
    exe: async () => (seen.exe++, EXE),
    status: async () => (seen.status++, { ready: 1 }),
    fetch: async () => void seen.fetched++,
    prepare: async () => (seen.prepared++, { prepared: 1, compiled: 1, ms: 37 * MIN, compile: { ms: 36 * MIN }, check: [[3.1, 3.05], [-4.2, -4.1], [-9, -8.9]] }),
    test: async (e) => (seen.tested.push(e), []),
    log: (l) => seen.log.push(l),
    answers: async () => false,
    settingUp: (t) => seen.settingUp.push(t),
    now: () => clock,
    ...over,
  };
  return { deps, seen };
}

// ---------------------------------------------------------------- where it's wanted

test("set up only on AMD's NPU and only where a reranker is ticked; kept while one is, taken out once none is; the person's own NPU reranker stands", () => {
  const wanted = (accelerators: object[]) => R.rerankNpuWanted({ accelerators }, TOOLS);
  assert.equal(wanted([radeon()]), 'none', 'no NPU');
  assert.equal(wanted([amdNpu(), radeon({ rerank: undefined })]), 'none', 'no reranker ticked');
  assert.equal(wanted([amdNpu({ chat: ep(18181, 'q', ['geniex.exe', 'serve']) }), radeon()]), 'none', "another vendor's NPU");
  assert.equal(wanted([amdNpu({ enabled: false }), radeon()]), 'none', 'the NPU turned off');
  assert.equal(wanted([amdNpu(), radeon({ enabled: false })]), 'none', "the reranker's card turned off");
  assert.equal(wanted([amdNpu(), radeon()]), 'prepare', "the card's reranker ticked");
  assert.equal(wanted([amdNpu(), radeon({ rerank: undefined }), cpu()]), 'prepare', "the processor's");
  assert.equal(wanted([amdNpu({ rerank: kitRerank() }), radeon()]), 'keep');
  assert.equal(wanted([amdNpu({ rerank: kitRerank() }), radeon({ rerank: undefined })]), 'drop', 'the NPU\'s alone: the ticked one is gone');
  assert.equal(wanted([amdNpu({ rerank: ep(18190, 'r', ['llama-server.exe', '--reranking']) }), radeon()]), 'none', "a reranker of the person's own on the NPU");
  assert.equal(wanted([]), 'none');
  assert.equal(R.rerankNpuWanted({}, TOOLS), 'none', 'no list at all');

  // withNpuRerank: the NPU's entry alone changes.
  const raw = { acceleratorOrder: 'auto', accelerators: [amdNpu(), radeon()] };
  const set = R.withNpuRerank(raw, kitRerank(), TOOLS)!;
  assert.deepEqual(set.accelerators[0], { ...amdNpu(), rerank: kitRerank() });
  assert.equal(set.accelerators[1], raw.accelerators[1]);
  assert.equal(set.acceleratorOrder, 'auto');
  assert.deepEqual(R.withNpuRerank(set, null, TOOLS)!.accelerators[0], amdNpu());
  assert.equal(R.withNpuRerank({ accelerators: [radeon()] }, kitRerank(), TOOLS), null, 'no AMD NPU: nothing to write');
});

test("its endpoint: the kit's program on port 18187 (the NPU's own are 18181 to 18186, setup's from 18191), its paths portable, the card's model name", () => {
  const e = kitRerank();
  assert.equal(e.baseUrl, 'http://127.0.0.1:18187');
  assert.equal(e.model, R.RERANK_ALIAS);
  const cmd = e.startCommand!;
  assert.deepEqual(cmd.slice(cmd.indexOf('--serve')), ['--serve', '--host', '127.0.0.1', '--port', '18187', '--alias', R.RERANK_ALIAS]);
  for (const flag of ['--dir', '--ort', '--vitisai', '--cache']) assert.ok(cmd.includes(flag), flag);
  if (home.toLowerCase().startsWith(os.homedir().toLowerCase())) {
    assert.ok(cmd[0].startsWith('%USERPROFILE%\\'), cmd[0]);
    assert.ok(cmd[cmd.indexOf('--dir') + 1].startsWith('%USERPROFILE%\\'));
  }
  assert.equal(R.isNpuRerank(e), true);
  assert.equal(R.isNpuRerank({ ...e, startCommand: ['C:\\k\\rerank-npu-0123456789ab.signed.exe'] }), true, "the kit's signed copy");
  assert.equal(R.isNpuRerank(radeon().rerank), false);
  assert.equal(R.isNpuRerank(undefined), false);
  assert.equal(R.isNpuRerank({ ...e, startCommand: ['C:\\k\\rerank-npu.exe'] }), false, 'not named by its source');
  assert.ok(R.NPU_RERANK_PORT > 18186 && R.NPU_RERANK_PORT < 18191);
  // The model: pinned to a commit, each file to its size and hash.
  assert.match(R.RERANK_COMMIT, /^[0-9a-f]{40}$/);
  for (const f of Object.values(R.RERANK_FILES)) {
    assert.ok(f.url.includes(`/resolve/${R.RERANK_COMMIT}/`), f.url);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(PLACE.model.endsWith(`model-${R.RERANK_COMMIT.slice(0, 12)}-640`), PLACE.model);
});

// ---------------------------------------------------------------- the look

test("the look sets it up: the card says it's setting up meanwhile, the model is fetched and compiled, its server tested, and it's written as the NPU's reranker", async () => {
  writeConfig([amdNpu(), radeon()]);
  const { deps, seen } = lookDeps();
  assert.deepEqual(await R.lookRerankNpu(deps), { did: 'prepared' });
  assert.deepEqual(npuInConfig().rerank, kitRerank());
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8')).accelerators[1].rerank.baseUrl, 'http://127.0.0.1:18194', "the person's reranker stays, behind it");
  assert.deepEqual([seen.fetched, seen.prepared, seen.tested.length], [1, 1, 1]);
  assert.deepEqual(seen.tested[0], kitRerank(), 'the endpoint written is the one tested');
  assert.equal(seen.settingUp.length, 2);
  assert.match(seen.settingUp[0]!, /^Setting up the NPU's reranker: .* Until then, search reranks as it did\.$/);
  assert.equal(seen.settingUp[1], null, 'and no longer once done');
  assert.ok(seen.log.some((l) => /passed its check against the processor .* compiled in 36 min/.test(l)), seen.log.join('\n'));
  assert.ok(seen.log.some((l) => l.includes('set up: search reranks on the NPU from now (port 18187)')));
});

test('a compile under way elsewhere, or its lock held: busy, nothing written, the card no longer says setting up', async () => {
  writeConfig([amdNpu(), radeon()]);
  const busy = lookDeps({ prepare: async () => ({ prepared: 0, busy: 1 }) });
  assert.deepEqual(await R.lookRerankNpu(busy.deps), { did: 'busy' });
  assert.equal(npuInConfig().rerank, undefined);
  assert.deepEqual(busy.seen.settingUp.at(-1), null);
  assert.equal(busy.seen.tested.length, 0);
  const locked = lookDeps({
    prepare: async () => {
      throw new LockTimeout('held');
    },
  });
  assert.deepEqual(await R.lookRerankNpu(locked.deps), { did: 'busy' });
  // A busy look isn't a failure: the next tries at once.
  const next = lookDeps();
  assert.deepEqual(await R.lookRerankNpu(next.deps), { did: 'prepared' });
});

test("a set-up that fails keeps config.json as it was (search reranks where it did), says why in the log alone, and is tried again only after 6 hours; a program that gave up waits for AMD's driver or plugin to change", async () => {
  writeConfig([amdNpu(), radeon()]);
  const before = readFileSync(FILE, 'utf8');
  const bad = lookDeps({ prepare: async () => ({ prepared: 0, error: "AMD's compiler ended (exit 3)\nmore lines" }) });
  assert.deepEqual(await R.lookRerankNpu(bad.deps), { did: 'failed', why: "AMD's compiler ended (exit 3)" });
  assert.equal(readFileSync(FILE, 'utf8'), before);
  assert.equal(bad.seen.settingUp.at(-1), null, 'the card says nothing more of it: no error');
  assert.ok(bad.seen.log.some((l) => l.includes("couldn't be set up (AMD's compiler ended (exit 3)): search reranks where it did; a look in 6 hours tries again")), bad.seen.log.join('\n'));

  clock += R.RERANK_RETRY_MS - MIN;
  const soon = lookDeps();
  assert.deepEqual(await R.lookRerankNpu(soon.deps), { did: 'waiting' });
  assert.deepEqual([soon.seen.fetched, soon.seen.prepared, soon.seen.settingUp.length], [0, 0, 0]);
  clock += MIN;
  const later = lookDeps();
  assert.deepEqual(await R.lookRerankNpu(later.deps), { did: 'prepared' });

  // Its server not answering its test: not written.
  R.resetRerankLook();
  writeConfig([amdNpu(), radeon()]);
  const deaf = lookDeps({ test: async () => ['it ranked the passage that answers 3rd'] });
  assert.deepEqual(await R.lookRerankNpu(deaf.deps), { did: 'failed', why: "its server didn't answer its test: it ranked the passage that answers 3rd" });
  assert.equal(npuInConfig().rerank, undefined);

  // A fetch that fails (no network): the same.
  R.resetRerankLook();
  const offline = lookDeps({
    fetch: async () => {
      throw new Error('fetch failed');
    },
  });
  assert.deepEqual(await R.lookRerankNpu(offline.deps), { did: 'failed', why: 'fetch failed' });
  assert.equal(offline.seen.prepared, 0);

  // The program gave up (two compiles failed on this driver and plugin): no try, no card.
  R.resetRerankLook();
  const gaveUp = lookDeps({ status: async () => ({ ready: 0, failed: 2, giveUp: 1 }) });
  assert.deepEqual(await R.lookRerankNpu(gaveUp.deps), { did: 'waiting' });
  assert.deepEqual([gaveUp.seen.fetched, gaveUp.seen.settingUp.length], [0, 0]);
});

test("once it's the NPU's: kept as it is, its compile asked after now and then; a driver that wants a compile of its own, or a model gone, takes it out and sets it up again", async () => {
  writeConfig([amdNpu({ rerank: kitRerank() }), radeon()]);
  modelReady(true);
  const first = lookDeps();
  assert.deepEqual(await R.lookRerankNpu(first.deps), { did: 'current' });
  assert.equal(first.seen.status, 1, 'asked at the first look');
  clock += R.RERANK_STATUS_MS - MIN;
  const again = lookDeps();
  assert.deepEqual(await R.lookRerankNpu(again.deps), { did: 'current' });
  assert.equal(again.seen.status, 0, 'not again within 6 hours');

  // AMD's driver updated: the compile isn't this NPU's. Taken out first, so search reranks where it did meanwhile.
  clock += 2 * MIN;
  let during: unknown = 'unread';
  const driver = lookDeps({
    status: async () => ({ ready: 0, plugin: '2.4.91' }),
    prepare: async () => ((during = npuInConfig().rerank), { prepared: 1, compiled: 1, ms: 40 * MIN }),
  });
  assert.deepEqual(await R.lookRerankNpu(driver.deps), { did: 'prepared' });
  assert.equal(during, undefined, 'out of config.json while it compiled');
  assert.deepEqual(npuInConfig().rerank, kitRerank(), 'and back once it passed');
  assert.ok(driver.seen.log.some((l) => l.includes("taken out of config.json, as it isn't compiled for this NPU's driver as it is now (plugin 2.4.91)")), driver.seen.log.join('\n'));

  // Its model gone (another kit's pin): the same, and a compile that fails leaves it out.
  modelReady(false);
  const gone = lookDeps({ prepare: async () => ({ prepared: 0, error: 'no NPU' }) });
  assert.deepEqual(await R.lookRerankNpu(gone.deps), { did: 'failed', why: 'no NPU' });
  assert.equal(npuInConfig().rerank, undefined, 'search reranks where it did');
  assert.ok(gone.seen.log.some((l) => l.includes("as its model isn't this kit's")));
});

test("another kit's program: switched once its old server has stopped (the keeper's idle stop) and the new one has answered its test", async () => {
  writeConfig([amdNpu({ rerank: kitRerank(OLD_EXE) }), radeon()]);
  modelReady(true);
  const running = lookDeps({ answers: async () => true });
  assert.deepEqual(await R.lookRerankNpu(running.deps), { did: 'busy' });
  assert.deepEqual(npuInConfig().rerank, kitRerank(OLD_EXE));
  assert.equal(running.seen.tested.length, 0, 'never two servers on its port');

  const failing = lookDeps({ test: async () => ['it answered 500'] });
  assert.deepEqual(await R.lookRerankNpu(failing.deps), { did: 'failed', why: 'it answered 500' });
  assert.deepEqual(npuInConfig().rerank, kitRerank(OLD_EXE), 'the old program kept');

  const stopped = lookDeps();
  assert.deepEqual(await R.lookRerankNpu(stopped.deps), { did: 'refreshed' });
  assert.deepEqual(npuInConfig().rerank, kitRerank());
  assert.equal(stopped.seen.prepared, 0, 'no compile: the program changed, not the graph');
});

test('nothing to do, or the ticked reranker gone: the program is never looked for; the NPU\'s is taken out, its files kept', async () => {
  writeConfig([amdNpu(), radeon({ rerank: undefined })]);
  const none = lookDeps();
  assert.deepEqual(await R.lookRerankNpu(none.deps), { did: 'none' });
  assert.equal(none.seen.exe, 0);

  writeConfig([amdNpu({ rerank: kitRerank() }), radeon({ rerank: undefined })]);
  modelReady(true);
  const drop = lookDeps();
  assert.deepEqual(await R.lookRerankNpu(drop.deps), { did: 'taken-out' });
  assert.equal(npuInConfig().rerank, undefined);
  assert.equal(drop.seen.exe, 0);
  assert.ok(readFileSync(path.join(PLACE.model, 'ready'), 'utf8'), 'its model stays, for when one is ticked again');
});

test('only on Windows on x64, never in a test run, and not with KIT_RERANK_NPU=off', () => {
  assert.equal(R.rerankNpuAllowed({}, 'win32', 'x64'), true);
  assert.equal(R.rerankNpuAllowed({ NODE_TEST_CONTEXT: 'child-v8' }, 'win32', 'x64'), false);
  assert.equal(R.rerankNpuAllowed({ KIT_RERANK_NPU: 'off' }, 'win32', 'x64'), false);
  assert.equal(R.rerankNpuAllowed({}, 'win32', 'arm64'), false, "a Snapdragon's NPU reranks its own way");
  assert.equal(R.rerankNpuAllowed({}, 'linux', 'x64'), false);
  assert.equal(R.rerankNpuAllowed(), false, 'this run');
});

// ---------------------------------------------------------------- the card's "setting up"

test("while it compiles, the agent's ping says so (its job named on the Work page), unless the agent says a setting-up of its own", async () => {
  const deps = R.pcRerankDeps({ log: () => {}, env: ENV });
  deps.settingUp('Setting up the NPU\'s reranker: …');
  assert.deepEqual(kitSettingUp(), { text: "Setting up the NPU's reranker: …", accelerator: 'npu' });
  assert.deepEqual(workTasks().map((t) => [t.kind, t.what, t.runningSince !== null]), [['setup', "Setting up the NPU's reranker: compiling it for this NPU, once", true]]);

  const { port } = await import('./fixture/src/app.ts');
  const { serve } = await import('./fixture/src/kit/server.ts');
  let own: Record<string, unknown> = {};
  const { close } = await serve({ port, icon: '<svg/>', ping: () => own });
  const ping = () =>
    new Promise<any>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/ping', headers: { host: `127.0.0.1:${port}` } }, async (res) => {
          let body = '';
          for await (const c of res) body += c;
          resolve(JSON.parse(body));
        })
        .on('error', reject);
    });
  try {
    assert.deepEqual((await ping()).settingUp, { text: "Setting up the NPU's reranker: …", accelerator: 'npu' });
    own = { settingUp: { text: 'Reeve is getting to know your projects', done: 3, total: 9, unit: 'projects' } };
    assert.deepEqual((await ping()).settingUp, own.settingUp, "the agent's own first");
    own = {};
    deps.settingUp(null);
    assert.equal(kitSettingUp(), null);
    assert.deepEqual(workTasks(), []);
    assert.equal('settingUp' in (await ping()), false, 'done: nothing said');
  } finally {
    await close();
  }
  // The first begun is said; each is its own.
  setSettingUp('a', { text: 'first' });
  setSettingUp('b', { text: 'second' });
  assert.equal(kitSettingUp()!.text, 'first');
  setSettingUp('a', null);
  assert.equal(kitSettingUp()!.text, 'second');
});

// ---------------------------------------------------------------- the keeper, setup and the order

test("the keeper looks after its server as the NPU's: the NPU's lock, its idle time, its log; and knows its process by --host and --port", () => {
  const accs = [amdNpu({ rerank: kitRerank() }), radeon()];
  const list = reapedServers(accs as any, 'C:\\logs', { npuMs: 7 * MIN, otherMs: 5 * MIN }, 'C:\\locks\\npu');
  const rerank = list.find((s) => s.base === 'http://127.0.0.1:18187')!;
  assert.ok(rerank, list.map((s) => s.base).join(', '));
  assert.deepEqual([rerank.acc.id, rerank.lockDirs, rerank.idleMs, rerank.spec.logFile], ['npu', ['C:\\locks\\npu'], 7 * MIN, 'C:\\logs\\npu.rerank.log']);
  assert.equal(rerank.program, path.join(home, 'kit', 'rerank-npu-0123456789ab.exe'), 'its program, %USERPROFILE% expanded');
  // A reranker of another program on the NPU's entry isn't the keeper's to stop.
  const other = reapedServers([amdNpu({ rerank: ep(18187, 'r', ['C:\\x\\rerank.exe', '--port', '18187']) })] as any, 'C:\\logs', { npuMs: 7 * MIN }, 'C:\\locks\\npu');
  assert.equal(other.some((s) => s.base === 'http://127.0.0.1:18187'), false);
  const line = (exe: string, port: number) => `"${exe}" --dir C:\\m --ort C:\\o --vitisai C:\\w --cache C:\\c --serve --host 127.0.0.1 --port ${port} --alias ${R.RERANK_ALIAS}`;
  assert.equal(servesBase(line('C:\\k\\rerank-npu-0123456789ab.exe', 18187), 'http://127.0.0.1:18187'), true);
  assert.equal(servesBase(line('C:\\k\\rerank-npu-0123456789ab.signed.exe', 18187), 'http://127.0.0.1:18187'), true);
  assert.equal(servesBase(line('C:\\k\\rerank-npu-0123456789ab.exe', 18188), 'http://127.0.0.1:18187'), false);
});

test("setup run again keeps the NPU's reranker it didn't make (its compile is an hour's work), never another program's", () => {
  const made = amdNpu();
  assert.deepEqual(keepingNpuRerank(made as any, amdNpu({ rerank: kitRerank() }) as any), { ...made, rerank: kitRerank() });
  assert.equal(keepingNpuRerank(made as any, amdNpu({ rerank: ep(18190, 'r', ['llama-server.exe']) }) as any), made);
  assert.equal(keepingNpuRerank(made as any, undefined), made);
  const own = amdNpu({ rerank: ep(18190, 'r', ['llama-server.exe']) });
  assert.equal(keepingNpuRerank(own as any, amdNpu({ rerank: kitRerank() }) as any), own, 'one setup made stands');
});

test("once it's there, reranks go to the NPU first, the switch on or off; before, with the switch off, the card's reranker is kept out (the processor's, if ticked, reranks)", () => {
  const order = workOrderFor(NPU_CATALOG.routes.amd, 'xdna2') ?? undefined;
  assert.equal(order?.rerank, undefined, "AMD's work order says nothing of the reranker: the NPU's turn comes first by the auto order");
  // As an agent's router takes them (Reeve's serving('rerank')): config.json's accelerators in their order, the card
  // kept out beside the NPU while the switch is off, the first that reranks.
  const parse = (accelerators: object[]) => configuredAccelerators({ accelerators });
  const firstRerank = (l: readonly any[]) => l.find((a) => servesKind(a as never, 'rerank'))?.id ?? null;
  const ready = parse([amdNpu({ rerank: kitRerank() }), radeon(), cpu()]);
  assert.equal(firstRerank(ready), 'npu', 'switch on');
  assert.equal(firstRerank(core.withoutGpuBesideNpu(ready, false, order)), 'npu', 'switch off');
  const before = parse([amdNpu(), radeon(), cpu()]);
  assert.equal(firstRerank(before), 'gpu-amd-radeon-860m-graphics', 'switch on: the card, as today');
  assert.equal(firstRerank(core.withoutGpuBesideNpu(before, false, order)), 'cpu', 'switch off: the processor, the card kept out');
  assert.equal(firstRerank(core.withoutGpuBesideNpu(parse([amdNpu(), radeon()]), false, order)), null, 'switch off, the card alone ticked: none until the NPU\'s is ready');
});

// ---------------------------------------------------------------- the program's protocol and the tokenizer

test("the program's lines: the last carrying its field is the answer, each seen as it comes, its stderr in the log; one that ends without it, or runs too long, is an error", async () => {
  const log = path.join(home, 'logs', 'prepare.log');
  const lines: any[] = [];
  const script = `console.log('not json'); console.log('{"compiling":4242}'); console.error('compile: pass 1'); console.log('{"prepared":0}'); console.log('{"prepared":1,"ms":5}');`;
  let started: number | undefined;
  const said = await R.runRerankProgram(process.execPath, ['-e', script], 'prepared', { log, timeoutMs: 30_000, onStart: (pid) => (started = pid), onLine: (m) => lines.push(m) });
  assert.deepEqual(said, { prepared: 1, ms: 5 });
  assert.deepEqual(lines, [{ compiling: 4242 }, { prepared: 0 }, { prepared: 1, ms: 5 }]);
  assert.equal(typeof started, 'number');
  assert.match(readFileSync(log, 'utf8'), /compile: pass 1/);
  await assert.rejects(R.runRerankProgram(process.execPath, ['-e', 'console.log(\'{"other":1}\'); process.exit(4)'], 'prepared', { timeoutMs: 30_000 }), /ended without saying \(exit 4\)/);
  await assert.rejects(R.runRerankProgram(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], 'prepared', { timeoutMs: 300 }), /ended without saying/);
});

test("the tokenizer's files: Qwen2's byte-level BPE alone, as the program reads it; anything else is said, never guessed at", () => {
  const good = {
    normalizer: { type: 'NFC' },
    pre_tokenizer: { type: 'Sequence', pretokenizers: [{ type: 'Split', pattern: { Regex: SPLIT_PATTERN }, behavior: 'Isolated', invert: false }, { type: 'ByteLevel', add_prefix_space: false, trim_offsets: false, use_regex: false }] },
    model: { type: 'BPE', dropout: null, unk_token: null, continuing_subword_prefix: '', end_of_word_suffix: '', fuse_unk: false, byte_fallback: false, ignore_merges: false, vocab: { a: 0, b: 1, ab: 2, 'Ġc': 3 }, merges: [['a', 'b'], 'Ġ c'] },
    added_tokens: [{ id: 4, content: '<|im_start|>', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true }],
  };
  assert.deepEqual(tokenizerFiles(JSON.stringify(good)), { 'vocab.txt': 'a\nb\nab\nĠc\n', 'merges.txt': 'a b\nĠ c\n', 'added.txt': '4\t<|im_start|>\n' });
  const bad = (change: (t: any) => void) => {
    const t = structuredClone(good);
    change(t);
    return () => tokenizerFiles(JSON.stringify(t));
  };
  assert.throws(bad((t) => (t.model.dropout = 0.1)), /isn't Qwen2's byte-level BPE/);
  assert.throws(bad((t) => (t.model.byte_fallback = true)), /isn't Qwen2's/);
  assert.throws(bad((t) => (t.normalizer = null)), /isn't Qwen2's/);
  assert.throws(bad((t) => (t.pre_tokenizer.pretokenizers[0].pattern.Regex = "'s|\\p{L}+")), /isn't Qwen2's/);
  assert.throws(bad((t) => (t.pre_tokenizer.pretokenizers[1].add_prefix_space = true)), /isn't Qwen2's/);
  assert.throws(bad((t) => (t.model.vocab = { a: 0, b: 2 })), /token 1 can't be a line/);
  assert.throws(bad((t) => (t.model.vocab = { 'a\nb': 0 })), /token 0 can't be a line/);
  assert.throws(bad((t) => (t.model.merges = ['a b c'])), /a merge that can't be a line/);
  assert.throws(bad((t) => (t.added_tokens[0].lstrip = true)), /isn't a plain added token/);
});
