import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A slow start (boot-speed.ts, the core's bootSpeed): each program keeps the decode speeds its servers report, by boot,
// and this boot is slow when it decodes well under the earlier boots' usual. The numbers are WEASELDEV03's (an AMD
// Ryzen AI 7 350, qwen3.5:2b on FastFlowLM 1.0.7): 16-31-token answers at 20.5-20.8 tokens a second after a normal
// start, 15.8 after one that went into Modern Standby in its first two minutes. Everything in a scratch folder.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-boot-speed-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(home, 'agent');
process.env.REEVE_HOME = path.join(home, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'npu-agent', 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'manor');
after(() => rmSync(home, { recursive: true, force: true }));

const core = await import('../core/index.js');
const S = await import('./fixture/src/kit/boot-speed.ts');
const A = await import('./fixture/src/kit/accelerators.ts');
const { Npu } = await import('./fixture/src/kit/npu.ts');
const { acceleratorsDir } = await import('./fixture/src/kit/lock.ts');
const { APP } = await import('./fixture/src/app.ts');

const RULES = core.checkRules(JSON.parse(readFileSync(new URL('../spec/rules.json', import.meta.url), 'utf8')));
type Speeds = import('../core/index.js').Speeds;

const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);
const FAST_1 = at('2026-10-16T17:32:00Z');
const FAST_2 = at('2026-10-17T03:14:00Z');
const SLOW = at('2026-10-17T04:15:00Z');
const NOW = at('2026-10-17T16:17:00Z');

/** One program's speeds: `n` answers of `tokens` at each speed given, on each boot. */
function speeds(agent: string, boots: [number, number[]][], o: { acc?: string; model?: string; tokens?: number } = {}): Speeds {
  let f: Speeds | null = null;
  for (const [boot, tps] of boots) for (const t of tps) f = core.addSpeed(RULES, f, agent, boot, { acc: o.acc ?? 'npu', model: o.model ?? 'qwen3.5:2b', answerTokens: o.tokens ?? 20, tokensPerSecond: t });
  return f ?? { agent, boots: [] };
}
const times = (n: number, x: number) => Array.from({ length: n }, (_, i) => x + (i % 3) * 0.1);

test("an answer's size: under 16 tokens isn't kept; 16-31, 32-63 and 64 and up are each their own", () => {
  assert.deepEqual([0, 15, 16, 31, 32, 63, 64, 900].map(core.speedSize), [null, null, 16, 16, 32, 32, 64, 64]);
  assert.equal(RULES.speed.slowPercent, 85);
});

test('speeds are kept by boot, accelerator, model and size: the latest 30 a row and the latest 10 boots; nothing else changes them', () => {
  let f = speeds('reeve', [[FAST_1, times(40, 20.5)]]);
  assert.equal(f.boots.length, 1);
  assert.equal(f.boots[0].boot, '2026-10-16T17:32:00.000Z');
  assert.equal(f.boots[0].rows[0].tps.length, RULES.speed.keptPerBoot, 'the latest 30');
  // The same boot read a minute later (the clock set after the uptime started) is the same boot.
  f = core.addSpeed(RULES, f, 'reeve', FAST_1 + MIN, { acc: 'npu', model: 'qwen3.5:2b', answerTokens: 100, tokensPerSecond: 22.94 });
  assert.equal(f.boots.length, 1);
  assert.deepEqual(f.boots[0].rows.map((r) => [r.size, r.tps.length]), [[16, 30], [64, 1]]);
  assert.equal(f.boots[0].rows[1].tps[0], 22.94);
  // Too short, no speed, or a speed that isn't one: left as it was, and the file given isn't changed.
  const before = JSON.stringify(f);
  for (const s of [{ answerTokens: 15, tokensPerSecond: 20 }, { answerTokens: 20, tokensPerSecond: 0 }, { answerTokens: 20, tokensPerSecond: NaN }]) {
    assert.equal(JSON.stringify(core.addSpeed(RULES, f, 'reeve', FAST_1, { acc: 'npu', model: 'm', ...s })), before);
  }
  core.addSpeed(RULES, f, 'reeve', SLOW, { acc: 'npu', model: 'qwen3.5:2b', answerTokens: 20, tokensPerSecond: 15.8 });
  assert.equal(JSON.stringify(f), before, 'addSpeed returns a new file');
  // Twelve boots: the latest ten, oldest first, whatever order they came in.
  let many: Speeds | null = null;
  for (const i of [11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) many = core.addSpeed(RULES, many, 'reeve', FAST_1 + i * 60 * MIN, { acc: 'npu', model: 'm', answerTokens: 20, tokensPerSecond: 20 });
  assert.deepEqual(many!.boots.map((b) => (Date.parse(b.boot) - FAST_1) / (60 * MIN)), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("a speeds file is read leniently: what can't be read is left out, and a file that isn't one is none", () => {
  assert.equal(core.speedsOf(null), null);
  assert.equal(core.speedsOf('{not json'), null);
  assert.equal(core.speedsOf('{"boots":[]}'), null, 'no agent');
  const f = core.speedsOf(`﻿${JSON.stringify({ agent: 'smith', boots: [{ boot: 'yesterday', rows: [] }, { boot: '2026-10-17T04:15:00.000Z', rows: [{ acc: 'npu', model: 'm', size: 16, tps: [15.8, 'x', -1, 16] }, { acc: 'npu', model: 'm', size: 17, tps: [1] }, null] }] })}`);
  assert.deepEqual(f, { agent: 'smith', boots: [{ boot: '2026-10-17T04:15:00.000Z', rows: [{ acc: 'npu', model: 'm', size: 16, tps: [15.8, 16] }] }] });
});

test("this PC's slow boot is slow: about 15.9 against the usual 20.9 is 76%, and the restart after it, at 20.5, is 98%", () => {
  const files = [speeds('reeve', [[FAST_1, times(12, 20.5)], [FAST_2, times(12, 20.8)], [SLOW, times(12, 15.8)]])];
  const slow = core.bootSpeed(RULES, files, SLOW, 'npu');
  assert.deepEqual(slow, { acc: 'npu', model: 'qwen3.5:2b', size: 16, since: '2026-10-17T04:15:00.000Z', now: 15.9, samples: 12, usual: 20.9, boots: 2, percent: 76, slow: true });
  assert.equal(core.say.slowBoot(slow!.now, slow!.usual), 'about 16 tokens a second since this PC started, against 21 after earlier starts; restarting the PC usually brings it back');
  // The next boot, back to speed: the slow one before it doesn't lower the usual (the fastest earlier boot's).
  const next = core.bootSpeed(RULES, [speeds('reeve', [[FAST_1, times(12, 20.5)], [FAST_2, times(12, 20.8)], [SLOW, times(12, 15.8)], [NOW, times(12, 20.4)]])], NOW, 'npu');
  assert.equal(next?.usual, 20.9);
  assert.equal(next?.boots, 3);
  assert.equal(next?.percent, 98);
  assert.equal(next?.slow, false);
  // Right at 85% is slow; just over isn't.
  const edge = (x: number) => core.bootSpeed(RULES, [speeds('r', [[FAST_1, Array(9).fill(20)], [NOW, Array(9).fill(x)]])], NOW, 'npu')!;
  assert.equal(edge(17).slow, true);
  assert.equal(edge(17.2).slow, false);
});

test('nothing is said until there is enough: 8 answers this boot, and an earlier boot with 8', () => {
  assert.equal(core.bootSpeed(RULES, [], NOW, 'npu'), null);
  assert.equal(core.bootSpeed(RULES, [null, speeds('r', [[FAST_1, times(12, 20.8)], [NOW, times(7, 15)]])], NOW, 'npu'), null, '7 this boot');
  assert.equal(core.bootSpeed(RULES, [speeds('r', [[FAST_1, times(7, 20.8)], [NOW, times(12, 15)]])], NOW, 'npu'), null, '7 earlier');
  assert.equal(core.bootSpeed(RULES, [speeds('r', [[NOW, times(30, 15)]])], NOW, 'npu'), null, 'a first boot has nothing to compare with');
  // Another accelerator's, another size's or a later boot's (a clock set back) answers don't count.
  assert.equal(core.bootSpeed(RULES, [speeds('r', [[FAST_1, times(12, 20.8)], [NOW, times(12, 15)]], { acc: 'gpu-amd-radeon-860m-graphics' })], NOW, 'npu'), null);
  assert.equal(core.bootSpeed(RULES, [speeds('r', [[FAST_1, times(12, 22.9)]], { tokens: 100 }), speeds('s', [[NOW, times(12, 15)]])], NOW, 'npu'), null);
  assert.equal(core.bootSpeed(RULES, [speeds('r', [[NOW + 600 * MIN, times(12, 20.8)], [NOW, times(12, 15)]])], NOW, 'npu'), null);
});

test("every program's answers count together, a boot's time a minute apart is the same boot, and the size with the most answers is the one compared", () => {
  const reeve = speeds('reeve', [[FAST_1, times(5, 20.8)], [NOW, times(4, 15.8)]]);
  const smith = speeds('smith', [[FAST_1 + MIN, times(5, 20.6)], [NOW - MIN, times(4, 15.8)]]);
  const short = core.bootSpeed(RULES, [reeve, smith], NOW, 'npu');
  assert.equal(short?.size, 16);
  assert.equal(short?.samples, 8, "the two programs' 4 each");
  assert.equal(short?.boots, 1, 'their boots a minute apart are one boot');
  assert.equal(short?.usual, 20.8);
  assert.equal(short?.slow, true);
  const scribe = speeds('scribe', [[FAST_1, times(10, 22.9)], [NOW, times(20, 17.4)]], { tokens: 120 });
  const long = core.bootSpeed(RULES, [reeve, smith, scribe], NOW, 'npu');
  assert.equal(long?.size, 64, '20 long answers this boot against 8 short ones');
  assert.equal(long?.samples, 20);
  assert.equal(long?.percent, 76);
});

test('the node part: speeds written per program in the accelerators folder, read back together; never a throw', () => {
  const dir = path.join(home, 'node-part');
  for (const t of times(10, 20.8)) S.noteSpeed('reeve', { acc: 'npu', model: 'qwen3.5:2b', answerTokens: 20, tokensPerSecond: t }, { dir, bootMs: FAST_1 });
  for (const t of times(10, 15.8)) S.noteSpeed('smith', { acc: 'npu', model: 'qwen3.5:2b', answerTokens: 20, tokensPerSecond: t }, { dir, bootMs: NOW });
  S.noteSpeed('smith', { acc: 'npu', model: 'qwen3.5:2b', answerTokens: 3, tokensPerSecond: 9 }, { dir, bootMs: NOW });
  const smith = JSON.parse(readFileSync(path.join(S.speedDir(dir), 'smith.json'), 'utf8'));
  assert.equal(smith.boots[0].rows[0].tps.length, 10, 'a 3-token answer is not kept');
  writeFileSync(path.join(S.speedDir(dir), 'broken.json'), '{nope');
  assert.equal(S.readSpeeds({ dir }).length, 2);
  assert.equal(S.bootSpeedOf('npu', { dir, bootMs: NOW })?.percent, 76);
  assert.equal(S.bootSpeedOf('npu', { dir: path.join(home, 'nothing-here'), bootMs: NOW }), null);
  // A folder that can't be made: the speed is lost, the request isn't.
  writeFileSync(path.join(home, 'a-file'), '');
  assert.doesNotThrow(() => S.noteSpeed('reeve', { acc: 'npu', model: 'm', answerTokens: 20, tokensPerSecond: 20 }, { dir: path.join(home, 'a-file') }));
  // This boot, by the uptime: within a second of the clock less it.
  assert.ok(Math.abs(S.bootMs() - (Date.now() - os.uptime() * 1000)) < 1000);
});

test("a chat's decode speed, as FastFlowLM reports it, is kept for this boot under the agent's name; a server that reports none, and vision, keep nothing", async () => {
  let tps: number | undefined = 21.37;
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    if (req.method === 'GET') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'one, two, three' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 24, ...(tps ? { decoding_speed_tps: tps } : {}) } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cfg = A.parseAccelerators({ accelerators: [{ id: 'npu', kind: 'npu', name: 'NPU', chat: { baseUrl, model: 'qwen3.5:2b' } }] }, null);
    if ('error' in cfg) throw new Error(cfg.error);
    const model = new Npu(cfg);
    const a = await model.chat([{ role: 'user', content: 'Count to three' }], { maxTokens: 40 });
    assert.equal(a.tokensPerSecond, 21.37);
    const mine = JSON.parse(readFileSync(path.join(S.speedDir(acceleratorsDir), `${APP.id}.json`), 'utf8'));
    assert.equal(mine.agent, APP.id);
    assert.equal(Math.abs(Date.parse(mine.boots[0].boot) - S.bootMs()) < RULES.speed.bootSlackMs, true, 'this boot');
    assert.deepEqual(mine.boots[0].rows, [{ acc: 'npu', model: 'qwen3.5:2b', size: 16, tps: [21.37] }]);
    tps = undefined;
    const b = await model.chat([{ role: 'user', content: 'Count to three' }], { maxTokens: 40 });
    assert.equal('tokensPerSecond' in b, false);
    assert.deepEqual(JSON.parse(readFileSync(path.join(S.speedDir(acceleratorsDir), `${APP.id}.json`), 'utf8')).boots[0].rows[0].tps, [21.37]);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

