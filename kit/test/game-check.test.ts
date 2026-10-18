import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The kit's game check for agents that wait while a game is played (gameIn, gameWatchCards, gameNow: kit 2.87.0, the
// Scribe's, the Marshal's and the Chronicler's): the program using a card, from games.json or a check of the counters
// (stood in for here), on the config's cards or, with none in it, hardware.json's. Everything in a scratch folder.
const home = mkdtempSync(path.join(os.tmpdir(), 'game-check-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(home, 'agent');
process.env.REEVE_HOME = path.join(home, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'npu-agent', 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'manor');
after(() => rmSync(home, { recursive: true, force: true }));

const A = await import('./fixture/src/kit/accelerators.ts');
type Hardware = import('./fixture/src/kit/accelerators.ts').Hardware;
type Games = import('./fixture/src/kit/accelerators.ts').Games;

const LUID = '0x00000000_0x0000d1a5';
const adapters = [{ index: 0, name: 'NVIDIA GeForce RTX 4090', luid: LUID, dedicatedMemory: 24e9, vendorId: 0x10de, software: false }];
const engine = (pid: number, percent: number) => `pid_${pid}_luid_${LUID}_phys_0_eng_0_engtype_3D\t${percent}`;
const HW: Hardware = { npu: true, cards: [{ name: 'NVIDIA GeForce RTX 4090', memoryGb: 24 }] };
const T = Date.parse('2026-10-18T12:00:00Z');

/** A check of the counters: a game on the 4090 (or nothing), counted. */
function prober(percent = 70) {
  const p = {
    count: 0,
    probe: async () => {
      p.count++;
      return JSON.stringify({ adapters, counters: engine(9876, percent), processes: { '9876': 'EldenRing' }, compositor: null });
    },
  };
  return p;
}

/** Each test starts with no games.json, and its own config. */
function fresh(config: unknown | null): string {
  rmSync(path.dirname(A.gamesFile()), { recursive: true, force: true });
  const file = path.join(home, `config-${Math.random().toString(36).slice(2)}.json`);
  if (config !== null) writeFileSync(file, JSON.stringify(config));
  return file;
}

test("gameIn: the program using a card, 'a game' when the check didn't say which, null for none", () => {
  const g = (cards: Games['cards']): Games => ({ checkedAt: new Date(T).toISOString(), cards });
  assert.equal(A.gameIn(g({ a: { busy: false, percent: 10, by: [] }, b: { busy: true, percent: 80, by: ['Halo.exe', 'x.exe'] } })), 'Halo.exe');
  assert.equal(A.gameIn(g({ a: { busy: true, percent: 80, by: [] } })), 'a game');
  assert.equal(A.gameIn(g({ a: { busy: false, percent: 10, by: [] } })), null);
  assert.equal(A.gameIn(g({})), null);
  assert.equal(A.gameIn(null), null, 'no check');
});

test("gameWatchCards: the config's own while one is an enabled card; else hardware.json's cards beside them, for the check only", () => {
  const card = { id: 'gpu-mine', kind: 'gpu', name: 'NVIDIA GeForce RTX 4090', memoryGb: 24, slots: 1, maxContextTokens: 0, quirks: [] } as any;
  const npu = { id: 'npu', kind: 'npu', name: 'NPU', memoryGb: null, slots: 1, maxContextTokens: 0, quirks: [] } as any;
  assert.deepEqual(A.gameWatchCards([npu, card], HW), [npu, card], 'a card in the config: as before');
  const added = A.gameWatchCards([npu, { ...card, enabled: false }], HW);
  assert.equal(added.length, 3, 'a card turned off is no card to watch: hardware.json adds its own');
  assert.deepEqual(
    [added[2].id, added[2].kind, added[2].name],
    [A.acceleratorId('gpu', 'NVIDIA GeForce RTX 4090'), 'gpu', 'NVIDIA GeForce RTX 4090'],
  );
  assert.deepEqual(A.gameWatchCards([npu], null), [npu], 'no hardware.json: nothing added');
  assert.deepEqual(A.gameWatchCards([], { npu: false, cards: [] }), [], 'no cards here');
});

test("gameNow with a card in the config: the config's card, checked once in 15 s", async () => {
  const file = fresh({ accelerators: [{ id: 'gpu-nvidia-geforce-rtx-4090', kind: 'gpu', name: 'NVIDIA GeForce RTX 4090', chat: { baseUrl: 'http://127.0.0.1:1', model: 'm' } }] });
  const p = prober();
  assert.equal(await A.gameNow({ file, hw: HW, now: T, probe: p.probe }), 'EldenRing.exe');
  assert.equal(await A.gameNow({ file, hw: HW, now: T + 10_000, probe: p.probe }), 'EldenRing.exe');
  assert.equal(p.count, 1, 'games.json fresh: read, not checked again');
  const quiet = prober(5);
  assert.equal(await A.gameNow({ file, hw: HW, now: T + 16_000, probe: quiet.probe }), null, 'the game closed');
  assert.equal(quiet.count, 1);
});

test("gameNow with no local AI set up (no config) or none on a card: this PC's cards from hardware.json", async () => {
  const none = fresh(null);
  const p = prober();
  assert.equal(await A.gameNow({ file: none, hw: HW, now: T, probe: p.probe }), 'EldenRing.exe');
  assert.equal(p.count, 1);
  assert.match(readFileSync(A.gamesFile(), 'utf8'), /gpu-nvidia-geforce-rtx-4090/, 'written for everyone, by the id the name gives');

  const npuOnly = fresh({ accelerators: [{ id: 'npu', kind: 'npu', chat: { baseUrl: 'http://127.0.0.1:1', model: 'm' } }] });
  const q = prober();
  assert.equal(await A.gameNow({ file: npuOnly, hw: HW, now: T, probe: q.probe }), 'EldenRing.exe');
  assert.equal(q.count, 1);
});

test("gameNow without hardware.json and no card in the config: no check, null; a failed check: what games.json said", async () => {
  const none = fresh(null);
  const p = prober();
  assert.equal(await A.gameNow({ file: none, hw: null, now: T, probe: p.probe }), null);
  assert.equal(p.count, 0, 'nothing probed');

  const failing = async () => {
    throw new Error('PowerShell exited 1');
  };
  assert.equal(await A.gameNow({ file: none, hw: HW, now: T, probe: failing }), null, 'never throws');
});
