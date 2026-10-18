import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The token tally (token-tally.ts): counts of what agents send their models, by day and agent, for the NPU
// benchmark's mix. Written to a scratch folder; nothing else is touched.
const home = mkdtempSync(path.join(tmpdir(), 'kit-token-tally-'));
process.env.REEVE_HOME = home;
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
after(() => rmSync(home, { recursive: true, force: true }));

const T = await import('./fixture/src/kit/token-tally.ts');
const { parseBenchArgs } = await import('./fixture/src/kit/npu-bench.ts');

const req = (promptTokens: number, answerTokens: number, o: { lane?: string; kind?: string; work?: string } = {}) => ({ work: o.work ?? 'chat', lane: o.lane ?? 'background', kind: o.kind ?? 'npu', promptTokens, answerTokens, ms: 100 });
const DAY = new Date('2026-10-12T15:00:00Z');
const daysAgo = (n: number) => new Date(DAY.getTime() - n * 86_400_000);

test('a request goes in the bucket its size reaches: 64 is in 0-64, 65 in 65-128, past the last edge in the last', () => {
  let f = { day: '2026-10-12', agent: 'a', rows: [] as any[] };
  for (const [p, a] of [[64, 16], [65, 17], [5000, 600], [0, 0]]) f = T.addToTally(f, req(p, a));
  const [r] = f.rows;
  assert.equal(r.requests, 4);
  assert.equal(r.promptTokens, 64 + 65 + 5000);
  assert.deepEqual(r.prompts, [2, 1, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(r.answers, [2, 1, 0, 0, 0, 0, 1]);
  assert.equal(T.addToTally(f, req(10, 1, { lane: 'interactive' })).rows.length, 2, 'another lane is another row');
  assert.equal(f.rows[0].requests, 4, 'the counts it was given are left as they were');
});

test('counts are written by day and agent, read back across agents within the days asked, and days past 60 go', () => {
  const dir = path.join(home, 'by-day');
  T.tallyRequest('ledger', req(300, 40), { dir, now: daysAgo(70) });
  T.tallyRequest('ledger', req(300, 40), { dir, now: daysAgo(2) });
  T.tallyRequest('ledger', req(900, 20), { dir, now: DAY });
  T.tallyRequest('ledger', req(900, 20), { dir, now: DAY });
  T.tallyRequest('keeper', req(100, 200, { lane: 'interactive', kind: 'gpu' }), { dir, now: DAY });
  const usage = T.usageDir(dir);
  assert.deepEqual(readdirSync(usage).sort(), ['2026-10-10', '2026-10-12'], "today's first count cleared the day 70 days ago");
  assert.deepEqual(readdirSync(path.join(usage, '2026-10-12')).sort(), ['keeper.json', 'ledger.json'], 'one file an agent, no leftovers');
  const file = JSON.parse(readFileSync(path.join(usage, '2026-10-12', 'ledger.json'), 'utf8'));
  assert.equal(file.rows[0].requests, 2);
  assert.ok(!JSON.stringify(file).match(/prompt"|text|content/i), 'counts only, nothing asked or answered');

  const today = T.readTally(1, { dir, now: DAY });
  assert.deepEqual(today.agents, ['keeper', 'ledger']);
  assert.equal(today.rows.find((r) => r.kind === 'npu')!.requests, 2);
  const week = T.readTally(7, { dir, now: DAY });
  const npu = week.rows.find((r) => r.kind === 'npu')!;
  assert.equal(npu.requests, 3, 'ledger over two days, added together');
  assert.equal(npu.promptTokens, 2100);
  assert.deepEqual(npu.prompts, [0, 0, 0, 1, 2, 0, 0, 0]);
  assert.equal(week.from, '2026-10-06');
});

test("a count that can't be written is lost, never thrown, and a broken day file starts again", () => {
  const dir = path.join(home, 'broken');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'usage'), 'a file where the folder should be');
  assert.doesNotThrow(() => T.tallyRequest('ledger', req(10, 1), { dir, now: DAY }));
  const dir2 = path.join(home, 'broken2');
  mkdirSync(path.join(T.usageDir(dir2), '2026-10-12'), { recursive: true });
  writeFileSync(path.join(T.usageDir(dir2), '2026-10-12', 'ledger.json'), '{ not json');
  T.tallyRequest('ledger', req(10, 1), { dir: dir2, now: DAY });
  assert.equal(T.readTally(1, { dir: dir2, now: DAY }).rows[0].requests, 1);
  assert.equal(T.readTally(1, { dir: path.join(home, 'never'), now: DAY }).rows.length, 0, 'no folder reads as nothing counted');
  assert.ok(!existsSync(path.join(home, 'never')));
});

test('the summary names each work, lane and kind with its averages and spread; nothing counted says so', () => {
  const lines = T.mixSummary({ from: '2026-10-06', to: '2026-10-12', agents: ['ledger'], rows: [T.addToTally(T.addToTally({ day: '', agent: '', rows: [] }, req(900, 20)), req(100, 40)).rows[0]] });
  assert.match(lines[0], /2 requests from ledger/);
  assert.ok(lines.includes('chat, background, on the npu: 2 requests, prompts 500 tokens and answers 30 on average, 100 ms each'));
  assert.ok(lines.includes('  prompts: 65-128 50%, 513-1024 50%'));
  assert.ok(lines.includes('  answers: 17-32 50%, 33-64 50%'));
  assert.match(T.mixSummary({ from: 'a', to: 'b', agents: [], rows: [] }).join('\n'), /Nothing counted yet/);
});

test('the benchmark prints the mix with --mix, over 30 days unless a number follows', () => {
  assert.deepEqual(parseBenchArgs(['--mix']), { mix: 30 });
  assert.deepEqual(parseBenchArgs(['--mix', '7']), { mix: 7 });
  assert.deepEqual(parseBenchArgs(['--mix', '--yes']), { mix: 30, yes: true });
});

test("each accelerator's day: every agent's requests on it added together, by its id, embeddings too; the mix keeps to chat and vision", () => {
  const dir = path.join(home, 'busy');
  T.tallyRequest('porter', { ...req(300, 40), acc: 'npu', ms: 900 }, { dir, now: DAY });
  T.tallyRequest('porter', { ...req(300, 40), acc: 'npu', ms: 800 }, { dir, now: DAY });
  T.tallyRequest('reeve', { work: 'embed', lane: 'background', kind: 'npu', acc: 'npu', promptTokens: 1200, answerTokens: 0, ms: 300 }, { dir, now: DAY });
  T.tallyRequest('clerk', { ...req(500, 20, { work: 'vision', kind: 'gpu' }), acc: 'gpu-adreno', ms: 2000 }, { dir, now: DAY });
  T.tallyRequest('porter', { ...req(300, 40), acc: 'npu', ms: 5000 }, { dir, now: daysAgo(1) });
  const day = T.busyToday({ dir, now: DAY });
  assert.equal(day.day, T.tallyDay(DAY));
  assert.deepEqual(day.accelerators, [
    { id: 'gpu-adreno', kind: 'gpu', busyMs: 2000, requests: 1, promptTokens: 500, answerTokens: 20, agents: ['clerk'] },
    { id: 'npu', kind: 'npu', busyMs: 2000, requests: 3, promptTokens: 1800, answerTokens: 80, agents: ['porter', 'reeve'] },
  ]);
  const file = JSON.parse(readFileSync(path.join(T.usageDir(dir), T.tallyDay(DAY), 'porter.json'), 'utf8'));
  assert.equal(file.rows[0].acc, 'npu', 'the row names its accelerator');
  const mix = T.readTally(1, { dir, now: DAY });
  assert.deepEqual(mix.rows.map((r) => r.work).sort(), ['chat', 'vision'], 'embeddings are not in the mix');
  assert.ok(mix.rows.every((r) => !('acc' in r)), 'the mix adds accelerators of a kind together');
  // A row from before kit 2.85.0 names no accelerator: it counts as its kind's.
  const old = path.join(T.usageDir(dir), T.tallyDay(daysAgo(3)));
  mkdirSync(old, { recursive: true });
  writeFileSync(path.join(old, 'herald.json'), JSON.stringify({ day: 'x', agent: 'herald', rows: [{ ...T.addToTally({ day: '', agent: '', rows: [] }, req(10, 1)).rows[0] }] }));
  assert.deepEqual(T.busyToday({ dir, now: daysAgo(3) }).accelerators.map((a) => [a.id, a.requests]), [['npu', 1]]);
  assert.deepEqual(T.busyToday({ dir: path.join(home, 'nothing'), now: DAY }).accelerators, [], 'nothing counted: nothing');
});

test("a day is the PC's own date, not UTC's", () => {
  const d = new Date(2026, 9, 18, 23, 30);
  assert.equal(T.tallyDay(d), '2026-10-18');
  assert.equal(T.tallyDay(new Date(2026, 0, 2, 0, 5)), '2026-01-02');
});
