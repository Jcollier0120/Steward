import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

test('a scratch REEVE_HOME keeps one config.json, as before; REEVE_CONFIG names another', () => {
  assert.equal(C.acceleratorConfigFile(), path.join(home, 'config.json'));
  assert.equal(C.acceleratorConfigFile({ REEVE_CONFIG: 'X:\\c.json' }), 'X:\\c.json');
  assert.equal(C.toolsHome(), home);
  assert.equal(C.legacyConfigFile(), null, 'a scratch home is one file: nothing to move or mirror');
});

test("the accelerators' own folder (kit 2.31.0): Manor's, not Reeve's; a PC set up before keeps its servers in .reeve", () => {
  const profile = mkdtempSync(path.join(home, 'profile-'));
  assert.equal(C.acceleratorsHome({}), path.join(homedir(), '.manor', 'accelerators'));
  assert.equal(C.acceleratorConfigFile({ MANOR_HOME: 'D:\\m' }), path.join('D:\\m', 'accelerators', 'config.json'));
  assert.equal(C.acceleratorConfigFile({ ACCELERATORS_HOME: 'D:\\a' }), path.join('D:\\a', 'config.json'));
  assert.equal(C.acceleratorConfigFile({ ACCELERATORS_CONFIG: 'D:\\x.json', REEVE_HOME: 'D:\\r' }), 'D:\\x.json');
  assert.equal(C.toolsHome({}, profile), path.join(homedir(), '.manor', 'accelerators'), "a new PC: the accelerators' folder");
  mkdirSync(path.join(profile, '.reeve', 'models'), { recursive: true });
  assert.equal(C.toolsHome({}, profile), path.join(profile, '.reeve'), 'a PC set up before: its builds and models stay where they are');
});

test("moving the accelerators out of Reeve's config.json: a copy of their keys, Reeve's file untouched, later saves mirrored back", () => {
  const profile = mkdtempSync(path.join(home, 'move-'));
  const env = { MANOR_HOME: path.join(profile, '.manor') };
  const reeveFile = path.join(profile, '.reeve', 'config.json');
  mkdirSync(path.dirname(reeveFile), { recursive: true });
  // The owner's file as it is on the laptop: the NPU, its idle time, and Reeve's own keys beside them.
  const owner = { accelerators: [{ ...NPU, chat: { ...NPU.chat, startCommand: ['geniex.exe', 'serve', '--keepalive', '86400'] } }], npuIdleStopMinutes: 240, repos: { roots: ['C:\\Projects'] }, jobs: { toast: false } };
  const text = JSON.stringify(owner, null, 2);
  writeFileSync(reeveFile, text);
  const own = C.acceleratorConfigFile(env);
  assert.equal(own, path.join(profile, '.manor', 'accelerators', 'config.json'));
  assert.equal(C.legacyConfigFile(env, profile), reeveFile);
  assert.equal(C.readableConfigFile(env, profile), reeveFile, "not moved yet: agents read Reeve's");

  const moved = C.migrateAcceleratorConfig(env, profile, new Date('2026-10-07T00:00:00Z'));
  assert.deepEqual(moved, { file: own, from: reeveFile, keys: ['accelerators', 'npuIdleStopMinutes'] });
  const copy = JSON.parse(readFileSync(own, 'utf8'));
  assert.deepEqual(copy.accelerators[0].chat.startCommand, ['geniex.exe', 'serve', '--keepalive', '86400'], "the owner's working NPU entry, word for word");
  assert.equal(copy.npuIdleStopMinutes, 240);
  assert.equal(copy.accelerators[0].name, undefined, 'no name kept (kit 2.27.0)');
  assert.equal(copy.repos, undefined, "Reeve's own keys stay his");
  assert.equal(copy.movedFrom, reeveFile);
  assert.equal(readFileSync(reeveFile, 'utf8'), text, "Reeve's file untouched");
  assert.equal(C.readableConfigFile(env, profile), own, "moved: agents read the accelerators' own");
  assert.equal(C.migrateAcceleratorConfig(env, profile), null, 'once');
  assert.deepEqual([...C.validateKeeperConfig(copy), ...C.validateAccelerators(copy)], []);

  // A later change through the keeper is mirrored into Reeve's file for older agents: only the keeper's keys.
  const next = { ...copy, npuIdleStopMinutes: 30, gpuIdleStopMinutes: 5 };
  assert.equal(C.mirrorToLegacy(next, env, profile), true);
  const mirrored = JSON.parse(readFileSync(reeveFile, 'utf8'));
  assert.deepEqual([mirrored.npuIdleStopMinutes, mirrored.gpuIdleStopMinutes, mirrored.repos, mirrored.jobs], [30, 5, { roots: ['C:\\Projects'] }, { toast: false }]);
  assert.equal(mirrored.movedFrom, undefined, "only the keeper's keys go back");
  assert.equal(C.mirrorToLegacy(next, env, profile), false, 'nothing changed: not written');

  // Nothing to move: no Reeve file, or one without accelerators.
  const bare = mkdtempSync(path.join(home, 'bare-'));
  assert.equal(C.migrateAcceleratorConfig({ MANOR_HOME: path.join(bare, '.manor') }, bare), null);
  mkdirSync(path.join(bare, '.reeve'), { recursive: true });
  writeFileSync(path.join(bare, '.reeve', 'config.json'), JSON.stringify({ repos: {} }));
  assert.equal(C.migrateAcceleratorConfig({ MANOR_HOME: path.join(bare, '.manor') }, bare), null, 'Reeve without accelerators: not moved');
  assert.equal(existsSync(path.join(bare, '.manor', 'accelerators', 'config.json')), false);
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
