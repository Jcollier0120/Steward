import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// config.json as its owner reads and writes it (accelerator-config.ts: Reeve's src/accelerators.ts and settings.ts
// until kit 2.10.0): the keeper's keys, the etag, and the agents' reader agreeing with the owner's.
const home = mkdtempSync(path.join(tmpdir(), 'kit-accel-config-'));
process.env.REEVE_HOME = home;
delete process.env.REEVE_CONFIG;
after(() => rmSync(home, { recursive: true, force: true }));

const C = await import('./fixture/src/kit/accelerator-config.ts');
const kit = await import('./fixture/src/kit/accelerators.ts');

const NPU = { id: 'npu', kind: 'npu', name: 'Snapdragon X2 Elite NPU', chat: { baseUrl: 'http://127.0.0.1:18181', model: 'qwen', startCommand: ['geniex.exe', 'serve'] }, vision: { model: 'qwen-vl' }, quirks: ['prefix-leak', 'image-path'] };
const CARD = { id: 'gpu-nvidia-geforce-rtx-4090', kind: 'gpu', name: 'NVIDIA GeForce RTX 4090', memoryGb: 24, slots: 2, maxContextTokens: 16384, chat: { baseUrl: 'http://127.0.0.1:18191', model: 'q' } };

test("the file is Reeve's config.json, where every agent already reads it; REEVE_CONFIG names another", () => {
  assert.equal(C.acceleratorConfigFile(), path.join(home, 'config.json'));
  assert.equal(C.acceleratorConfigFile({ REEVE_CONFIG: 'X:\c.json' }), 'X:\c.json');
  assert.equal(C.toolsHome(), home);
});

test("the keeper's idle times: rules.json's defaults (10 and 10) unless config.json gives good ones", () => {
  assert.deepEqual(C.keeperSettings({}), { npuIdleStopMinutes: 10, gpuIdleStopMinutes: 10 });
  assert.deepEqual(C.keeperSettings({ npuIdleStopMinutes: 0, gpuIdleStopMinutes: 30 }), { npuIdleStopMinutes: 0, gpuIdleStopMinutes: 30 });
  assert.deepEqual(C.keeperSettings({ npuIdleStopMinutes: -1, gpuIdleStopMinutes: '5' }), { npuIdleStopMinutes: 10, gpuIdleStopMinutes: 10 });
  assert.match(C.validateKeeperConfig({ npuIdleStopMinutes: 2000 }).join('\n'), /npuIdleStopMinutes .* from 0 to 1440/);
});

test("a save: only the keeper's keys, everything else kept, refused when the file changed since it was read or doesn't validate", () => {
  const file = path.join(home, 'save.json');
  writeFileSync(file, JSON.stringify({ repos: { roots: ['C:\Projects'] }, jobs: { toast: false }, accelerators: [NPU] }));
  const etag = C.etagOf(file);
  assert.equal(C.saveConfig(file, { set: { repos: {} }, etag }, { only: C.KEEPER_KEYS }).ok, false, "Reeve's keys aren't the keeper's");
  const r = C.saveConfig(file, { set: { accelerators: [NPU, CARD], acceleratorOrder: ['npu'], gpuIdleStopMinutes: 5 }, etag }, { only: C.KEEPER_KEYS });
  assert.equal(r.ok, true, JSON.stringify(r));
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.repos, { roots: ['C:\Projects'] }, "Reeve's kept");
  assert.equal(saved.jobs.toast, false);
  assert.deepEqual(saved.acceleratorOrder, ['npu']);
  const stale = C.saveConfig(file, { set: { gpuIdleStopMinutes: 6 }, etag }, { only: C.KEEPER_KEYS });
  assert.deepEqual(stale.ok ? null : stale.status, 409);
  const bad = C.saveConfig(file, { set: { accelerators: [{ ...CARD, slots: 99 }] } }, { only: C.KEEPER_KEYS });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.problems.join('\n'), /slots must be a whole number from 1 to 16/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).accelerators.length, 2, 'nothing written');
});

test("the owner's reading and every agent's agree: the same accelerators, in the same order, with the same servers", () => {
  for (const raw of [{ accelerators: [NPU, CARD] }, { accelerators: [NPU, CARD], acceleratorOrder: ['npu'] }, { chatEndpoint: { baseUrl: 'http://127.0.0.1:18181', model: 'qwen', device: 'Npu' }, visionModel: 'vl' }]) {
    const owner = C.configuredAccelerators(raw).filter((a) => C.SERVE_KINDS.some((k) => C.serves(a, k)));
    const agents = kit.parseAccelerators(raw);
    assert.ok(!('error' in agents));
    if ('error' in agents) continue;
    assert.deepEqual(owner.map((a) => a.id), agents.accelerators.map((a) => a.id));
    for (const a of owner) {
      const b: any = agents.accelerators.find((x: { id: string }) => x.id === a.id)!;
      for (const k of C.SERVE_KINDS) {
        if (!C.serves(a, k)) continue;
        const ep = C.endpointFor(a, k);
        assert.deepEqual([ep.baseUrl, ep.model, ep.startCommand], [b[k]!.baseUrl, b[k]!.model, b[k]!.startCommand]);
      }
    }
  }
});
