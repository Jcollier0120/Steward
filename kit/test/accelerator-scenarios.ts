#!/usr/bin/env node
/**
 * Writes kit/spec/accelerator-vectors.json: the accelerators' rules (spec/ACCELERATORS.md) as cases any
 * implementation runs. The inputs are here; the expected answers are the core's, recorded, so review the
 * file's diff when the core changes: it is the core's behaviour, written out. kit/test/vectors.test.ts runs
 * them against the core and the node part, the dotnet tests against the core in Jint.
 *
 *   npm run accelerator-vectors       (node kit/test/accelerator-scenarios.ts --write)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../core/index.js';

const RULES = core.checkRules(JSON.parse(readFileSync(new URL('../spec/rules.json', import.meta.url), 'utf8')));
const NOW = 1_790_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const config = (raw: unknown) => {
  const c = core.parseAccelerators(RULES, raw);
  if ('error' in c) throw new Error(c.error);
  return c.accelerators;
};

const names = [
  'NVIDIA GeForce RTX 4090',
  'NVIDIA GeForce RTX 4090 #2',
  'Qualcomm(R) Adreno(TM) X2-90 GPU',
  'AMD Radeon(TM) Graphics (TM)',
  'AMD Radeon(TM) 890M Graphics',
  '  Intel(R) Arc(TM) A770  ',
  '',
  '(™)',
];

const ids = ['npu', 'cpu', 'gpu-nvidia-geforce-rtx-4090-2', 'gpu-', 'gpu-Upper', 'gpu-a--b', '..\\npu', 'npu.2', 'tpu-1', 'GPU 1'];

const adapters = [
  { index: 0, name: 'NVIDIA GeForce RTX 4090', luid: '0x00000000_0x0000d1a5', dedicatedMemory: 24e9, vendorId: 0x10de, software: false },
  { index: 1, name: 'Microsoft Basic Render Driver', luid: '0x00000000_0x00000001', dedicatedMemory: 0, vendorId: 0x1414, software: true },
  { index: 2, name: 'NVIDIA GeForce RTX 4090 ', luid: '0x00000000_0x0000d1f1', dedicatedMemory: 24e9, vendorId: 0x10de, software: false },
  { index: 3, name: '', luid: '0x00000000_0x0000e2b6', dedicatedMemory: 8e9, vendorId: 0x1002, software: false },
  { index: 4, name: 'nvidia geforce rtx 4090', luid: '0x00000000_0x0000f3c7', dedicatedMemory: 24e9, vendorId: 0x10de, software: false },
];

const configs: { case: string; raw: unknown; hw?: core.Hardware }[] = [
  {
    case: "Reeve's config lists the accelerators: auto order by memory, a vision model without an address on the chat server, a bad id and a second npu named as problems",
    raw: {
      accelerators: [
        {
          id: 'npu', kind: 'npu', name: 'Snapdragon X2 Elite NPU', slots: 1, maxContextTokens: 2400,
          chat: { baseUrl: 'http://127.0.0.1:18181', model: 'qualcomm/Qwen3-4B-Instruct-2507:W4A16', startCommand: ['%LOCALAPPDATA%\\GenieX CLI\\geniex.exe', 'serve'] },
          vision: { model: 'Qwen3-VL-4B-Instruct:W4A16' }, quirks: ['prefix-leak', 'image-path', 'unknown'],
        },
        {
          id: 'gpu-nvidia-geforce-rtx-4090', kind: 'gpu', name: 'NVIDIA GeForce RTX 4090', memoryGb: 24, slots: 2, maxContextTokens: 16384,
          chat: { baseUrl: 'http://127.0.0.1:18191/v1/', model: 'qwen3-4b-instruct-2507', startCommand: ['llama-server.exe', '--port', '18191'] },
          vision: { model: 'qwen3-vl-4b-instruct' }, embed: { baseUrl: 'http://127.0.0.1:18192', model: 'qwen3-embedding-0.6b' }, quirks: [],
        },
        { id: 'gpu-off', kind: 'gpu', name: 'Off', memoryGb: 48, chat: { baseUrl: 'http://127.0.0.1:2', model: 'm' }, enabled: false },
        { id: 'GPU 1', kind: 'gpu' },
        { id: 'npu', kind: 'npu', chat: { baseUrl: 'http://127.0.0.1:1', model: 'm' } },
      ],
      acceleratorOrder: 'auto',
    },
  },
  {
    case: "a card has at most 16 slots, the NPU always 1; without hardware.json each is its kind's name, whatever the entry says; no cap is 2400",
    raw: { accelerators: [{ id: 'gpu-big', slots: 40, memoryGb: 24, chat: { baseUrl: 'http://x:1', model: 'm' } }, { id: 'npu', slots: 3, chat: { baseUrl: 'http://x:2', model: 'm' } }, { id: 'cpu', name: '  ', embed: { baseUrl: 'http://x:3', model: 'e' } }], requestTimeoutMs: 5000 },
  },
  {
    case: 'acceleratorOrder: the ids it lists first, in its order, then the rest in auto order',
    raw: {
      accelerators: [
        { id: 'cpu', name: 'Oryon', chat: { baseUrl: 'http://x:1', model: 'm' } },
        { id: 'gpu-igpu', memoryGb: 0.5, chat: { baseUrl: 'http://x:2', model: 'm' } },
        { id: 'npu', chat: { baseUrl: 'http://x:3', model: 'm' } },
        { id: 'gpu-small', memoryGb: 8, chat: { baseUrl: 'http://x:4', model: 'm' } },
        { id: 'gpu-big', memoryGb: 24, chat: { baseUrl: 'http://x:5', model: 'm' } },
        { id: 'gpu-unknown', chat: { baseUrl: 'http://x:6', model: 'm' } },
      ],
      acceleratorOrder: ['cpu', 'npu', 'nope', 3],
    },
  },
  {
    case: 'auto: cards with 2 GB or more by memory, then the NPU, then shared graphics, then the CPU',
    raw: {
      accelerators: [
        { id: 'cpu', name: 'Oryon', chat: { baseUrl: 'http://x:1', model: 'm' } },
        { id: 'gpu-igpu', memoryGb: 0.5, chat: { baseUrl: 'http://x:2', model: 'm' } },
        { id: 'npu', chat: { baseUrl: 'http://x:3', model: 'm' } },
        { id: 'gpu-small', memoryGb: 8, chat: { baseUrl: 'http://x:4', model: 'm' } },
        { id: 'gpu-big', memoryGb: 24, chat: { baseUrl: 'http://x:5', model: 'm' } },
        { id: 'gpu-unknown', chat: { baseUrl: 'http://x:6', model: 'm' } },
      ],
    },
  },
  {
    case: 'an older config with only chatEndpoint: one accelerator, the NPU, with GenieX\'s quirks; its embed endpoint never started',
    raw: {
      chatEndpoint: { baseUrl: 'http://127.0.0.1:18181/v1', model: 'qualcomm/Qwen3-4B-Instruct-2507:W4A16', device: 'Npu', startCommand: ['geniex.exe', 'serve'] },
      visionModel: 'Qwen3-VL-4B-Instruct:W4A16',
      npuMaxContextTokens: 2000,
      requestTimeoutMs: 5000,
      embedEndpoint: { baseUrl: 'http://127.0.0.1:18282', model: 'nomic-embed-text-v1.5', device: 'Npu' },
    },
  },
  { case: 'an older config on a graphics card', raw: { chatEndpoint: { baseUrl: 'http://x:1', model: 'm', device: 'Gpu' } } },
  { case: 'an older config: an embed endpoint on another device is an accelerator of its own; start false never starts it', raw: { chatEndpoint: { baseUrl: 'http://x:1', model: 'm' }, embedEndpoint: { baseUrl: 'http://x:2', model: 'e', device: 'Cpu', start: false } } },
  { case: 'an empty list is Reeve not set up, not an older config', raw: { accelerators: [] } },
  { case: 'nothing at all is Reeve not set up', raw: {} },
  { case: 'a list where nothing serves anything is Reeve not set up', raw: { accelerators: [{ id: 'npu', chat: { baseUrl: 'http://x:1', model: 'm' }, enabled: false }, { id: 'cpu', name: 'Oryon' }] } },
  { case: 'an older config with no endpoint is Reeve not set up', raw: { npuMaxContextTokens: 2400 } },
  { case: "entries that can't be read are named, not taken for Reeve not set up", raw: { accelerators: [{ name: 'no id' }, { id: 'tpu-1', chat: { baseUrl: 'http://x:1', model: 'm' } }] } },
  {
    case: "names come from this PC (hardware.json), never from the config: the NPU's as Windows lists it, a card's as DXGI does, found by its id (made from DXGI's name), shown without (R) and (TM); the processor's; a card it doesn't list is the kind's",
    raw: {
      accelerators: [
        { id: 'npu', name: 'My NPU', chat: { baseUrl: 'http://x:1', model: 'm' } },
        { id: 'gpu-nvidia-geforce-rtx-4090-2', name: 'The second one', memoryGb: 24, chat: { baseUrl: 'http://x:2', model: 'm' } },
        { id: 'gpu-gone', name: 'A card taken out', memoryGb: 8, chat: { baseUrl: 'http://x:3', model: 'm' } },
        { id: 'gpu-intel-r-uhd-graphics-770', memoryGb: 0.1, chat: { baseUrl: 'http://x:5', model: 'm' } },
        { id: 'cpu', name: 'Mine', chat: { baseUrl: 'http://x:4', model: 'm' } },
      ],
    },
    hw: {
      npu: true,
      cards: [{ name: 'NVIDIA GeForce RTX 4090', memoryGb: 24 }, { name: 'NVIDIA GeForce RTX 4090 #2', memoryGb: 24 }, { name: 'Intel(R)  UHD Graphics 770', memoryGb: 0.1 }],
      npuName: 'Snapdragon X2 Elite Extreme - X2E94100 - Qualcomm Hexagon NPU',
      cpuName: 'Snapdragon X2 Elite Extreme - X2E94100 - Qualcomm Oryon CPU',
    },
  },
  {
    case: "an older config's NPU is named from this PC too",
    raw: { chatEndpoint: { baseUrl: 'http://x:1', model: 'm', device: 'Npu' } },
    hw: { npu: true, cards: [], npuName: 'Snapdragon X2 Elite - X2E88100 - Qualcomm Hexagon NPU' },
  },
  {
    case: "on a PC with no NPU, an entry listed as the NPU runs on its one card, by the card's name and id, whatever name the entry carries",
    raw: { accelerators: [{ id: 'npu', name: 'Snapdragon X2 Elite NPU', chat: { baseUrl: 'http://x:1', model: 'm' } }], acceleratorOrder: ['npu'] },
    hw: { npu: false, cards: [{ name: 'NVIDIA(R) GeForce RTX 4080 SUPER', memoryGb: 16 }], npuName: 'left from before', cpuName: 'AMD Ryzen 9 7950X 16-Core Processor' },
  },
  {
    case: "on a PC with no NPU and no card, an older config's NPU runs on the processor, by its name",
    raw: { chatEndpoint: { baseUrl: 'http://x:1', model: 'm', device: 'Npu' } },
    hw: { npu: false, cards: [], cpuName: 'AMD Ryzen 9 7950X 16-Core Processor' },
  },
];

const files: { case: string; file: string; text: string | null }[] = [
  { case: 'no config.json: Reeve not set up', file: 'C:\\Users\\me\\.reeve\\config.json', text: null },
  { case: 'a config.json that is not JSON names the file', file: 'C:\\Users\\me\\.reeve\\config.json', text: '{ not json' },
  { case: 'a config.json whose entries cannot be read names the file', file: 'C:\\Users\\me\\.reeve\\config.json', text: '{"accelerators":[{"name":"no id"}]}' },
  { case: 'Reeve not set up never names the file', file: 'C:\\Users\\me\\.reeve\\config.json', text: '{"accelerators":[]}' },
  { case: 'a byte order mark is skipped', file: 'C:\\Users\\me\\.reeve\\config.json', text: '\uFEFF{"chatEndpoint":{"baseUrl":"http://127.0.0.1:18181/v1","model":"q"}}' },
];

const marker = (since: unknown, reason: unknown = 'refused', by?: unknown) => JSON.stringify({ since, reason, ...(by === undefined ? {} : { by }) });
const failures: { case: string; text: string | null }[] = [
  { case: 'a marker 9 minutes old counts', text: marker(iso(NOW - 9 * 60_000), 'chat: refused the connection', 'clerk') },
  { case: 'a marker exactly 10 minutes old has expired', text: marker(iso(NOW - 10 * 60_000)) },
  { case: 'a marker with no by reads as by nobody', text: marker(iso(NOW - 60_000)) },
  { case: 'a time with an offset', text: marker('2026-09-21T16:12:20.000+02:00') },
  { case: 'a time without milliseconds', text: marker('2026-09-21T14:12:20Z') },
  { case: 'a time with seven decimals, as .NET writes them', text: marker('2026-09-21T14:12:20.1234567Z') },
  { case: 'a marker from a clock ahead still counts', text: marker(iso(NOW + 60_000)) },
  { case: 'no marker', text: null },
  { case: 'not JSON', text: '{ half a fi' },
  { case: 'a since that is no ISO time', text: marker('yesterday-ish') },
  { case: 'a since that is a number', text: '{ "since": 12345, "reason": "x" }' },
  { case: 'no since', text: '{ "reason": "no since" }' },
  { case: 'no reason', text: marker(iso(NOW - 60_000), 5) },
  { case: 'not an object', text: '[]' },
  { case: 'a day that does not exist', text: marker('2026-02-30T12:00:00Z') },
  { case: 'a byte order mark is skipped', text: `\uFEFF${marker(iso(NOW - 60_000))}` },
];

const reasons = [
  'its server said 503:\n  overloaded',
  '  DirectML could not open the model: 0x887A0005\r\n   at Microsoft.ML.OnnxRuntime...',
  'one line   ',
  '',
  '   \n second',
  'x'.repeat(301),
  'a\rb',
];

const games = {
  adapters: adapters.slice(0, 2).concat([{ index: 2, name: 'AMD Radeon RX 7600', luid: '0x00000000_0x0000e2b6', dedicatedMemory: 8e9, vendorId: 0x1002, software: false }]),
  counters: [
    'pid_9876_luid_0x00000000_0x0000D1A5_phys_0_eng_0_engtype_3D\t87.5',
    'pid_9876_luid_0x00000000_0x0000D1A5_phys_0_eng_1_engtype_3D\t3',
    'pid_1200_luid_0x00000000_0x0000E2B6_phys_0_eng_0_engtype_3D\t95',
    'pid_4242_luid_0x00000000_0x0000E2B6_phys_0_eng_0_engtype_3D\t80',
    'pid_5555_luid_0x00000000_0x0000E2B6_phys_0_eng_0_engtype_3D\t12',
    'pid_777_luid_0x00000000_0x0000E2B6_phys_0_eng_0_engtype_3D\t99',
    'pid_0_luid_0x00000000_0x0000D1A5_phys_0_eng_0_engtype_3D\t50',
    'pid_31_luid_0x00000000_0x0000D1A5_phys_0_eng_0_engtype_VideoDecode\t90',
    '_Total\t99',
  ].join('\r\n'),
  processes: { '9876': 'Cyberpunk2077', '1200': 'dwm', '4242': 'llama-server', '5555': 'msedge.exe' },
  compositor: 1200,
};
const gameConfig = {
  accelerators: [
    { id: 'gpu-nvidia-geforce-rtx-4090', name: 'NVIDIA GeForce RTX 4090', memoryGb: 24, chat: { baseUrl: 'http://x:1', model: 'm', startCommand: ['C:\\servers\\llama-server.exe'] } },
    { id: 'gpu-amd-radeon-rx-7600', name: 'AMD Radeon RX 7600', memoryGb: 8, chat: { baseUrl: 'http://x:2', model: 'm', startCommand: ['%USERPROFILE%\\bin\\My-Server.EXE', '--port', '1'] } },
    { id: 'gpu-elsewhere', name: 'A card DXGI does not list', memoryGb: 8, chat: { baseUrl: 'http://x:3', model: 'm' } },
    { id: 'npu', chat: { baseUrl: 'http://x:4', model: 'm' } },
  ],
};

const choosing = {
  accelerators: [
    { id: 'gpu-a', name: 'Card A', memoryGb: 24, maxContextTokens: 16384, chat: { baseUrl: 'http://x:1', model: 'm' } },
    { id: 'gpu-b', name: 'Card B', memoryGb: 12, maxContextTokens: 16384, chat: { baseUrl: 'http://x:2', model: 'm' }, vision: { model: 'v' } },
    { id: 'npu', name: 'NPU', maxContextTokens: 2400, chat: { baseUrl: 'http://x:3', model: 'm' } },
    { id: 'cpu', name: 'Processor', maxContextTokens: 4000, embed: { baseUrl: 'http://x:4', model: 'e' } },
  ],
};
const failed = (minutesAgo: number) => ({ since: iso(NOW - minutesAgo * 60_000), reason: 'refused', by: 'x' });
const gameOnB = { checkedAt: iso(NOW - 5000), cards: { 'gpu-b': { busy: true, percent: 87, by: ['game.exe'] } } };
const bg = (work: core.Work, tokens: number) => ({ work, tokens, lane: 'background' as const });

const candidateCases: { case: string; need: core.Need; failures?: Record<string, core.Failure | null>; games?: core.Games; deferredMs?: Record<string, number> }[] = [
  { case: 'chat: those that serve it, in order', need: bg('chat', 500) },
  { case: 'vision: only the card with a vision model', need: bg('vision', 500) },
  { case: 'embed: only the processor', need: bg('embed', 500) },
  { case: "a request over the NPU's cap goes to the cards", need: bg('chat', 3000) },
  { case: 'a failed card and a card a game is using are skipped, and say why', need: bg('chat', 500), failures: { 'gpu-a': failed(2) }, games: gameOnB },
  { case: 'a person waiting may use the card a game is using', need: { work: 'chat', tokens: 500, lane: 'interactive' as const }, failures: { 'gpu-a': failed(2) }, games: gameOnB },
  { case: 'one the agent leaves alone after a line too long is skipped until it resumes', need: bg('chat', 500), deferredMs: { npu: 60_000, 'gpu-a': 0 } },
  { case: 'the last resort: every one that would do has failed, so they are all tried again', need: bg('chat', 500), failures: { 'gpu-a': failed(1), 'gpu-b': failed(2), npu: failed(3) } },
  { case: 'the last resort still keeps background work off a card a game is using', need: bg('chat', 500), failures: { 'gpu-a': failed(1), 'gpu-b': failed(2), npu: failed(3) }, games: gameOnB },
  { case: 'one working is enough: the failed stay skipped', need: bg('chat', 500), failures: { 'gpu-a': failed(1), 'gpu-b': failed(9.5) } },
  { case: 'nothing fits: no candidates and nothing skipped', need: bg('chat', 20_000) },
];

const looks = (m: Record<string, [boolean, number]>) => Object.fromEntries(Object.entries(m).map(([id, [freeSlot, waiting]]) => [id, { freeSlot, waiting }]));
const pickCases = [
  { case: 'the first in order with a free slot and nobody waiting', lane: 'background', looks: looks({ 'gpu-a': [true, 0], npu: [true, 0] }) },
  { case: 'the free one', lane: 'background', looks: looks({ 'gpu-a': [false, 0], npu: [true, 0] }) },
  { case: 'else the shortest line', lane: 'background', looks: looks({ 'gpu-a': [true, 1], npu: [false, 2] }) },
  { case: 'ties by order', lane: 'background', looks: looks({ 'gpu-a': [false, 2], npu: [false, 2] }) },
  { case: 'background work waits when every line has 4 or more', lane: 'background', looks: looks({ 'gpu-a': [false, 4], npu: [false, 5] }) },
  { case: 'one line under 4 takes it', lane: 'background', looks: looks({ 'gpu-a': [false, 4], npu: [false, 3] }) },
  { case: 'a person waiting always joins', lane: 'interactive', looks: looks({ 'gpu-a': [false, 6], npu: [false, 5] }) },
  { case: 'one candidate, its line full', lane: 'background', only: ['npu'], looks: looks({ npu: [false, 4] }) },
];

const whyCases = [
  { case: 'one failed first and none could take it after', skipped: [{ id: 'npu', why: 'game', detail: 'the NPU is in use by game.exe' }], first: { acc: { id: 'gpu-a', name: 'Card A' }, reason: 'chat: 503' } },
  { case: 'busy while any is only resting or held by a game', skipped: [{ id: 'gpu-a', why: 'failed', detail: 'a' }, { id: 'npu', why: 'deferred', detail: 'b' }], first: null },
  { case: 'an error when they all failed', skipped: [{ id: 'gpu-a', why: 'failed', detail: 'the Card A failed (x); it is tried again in 3 min' }], first: null },
  { case: 'nothing at all', skipped: [], first: null },
];

export function makeAcceleratorVectors() {
  const choose = config(choosing);
  const byId = (list: core.Accelerator[]) => list.map((a) => a.id);
  return {
    about:
      "Shared test data for the accelerators (ACCELERATORS.md, beside this file): the ids, a card's name, reading Reeve's config, the order, the failure markers, the game check, the candidates for a request and the pick, as the kit's core answers them, with the timings of rules.json. Every implementation of these rules runs them: the kit's core directly, its node part, its dotnet part (the core in Jint). nowMs is the clock unless a case gives its own; accelerators are given as a config's raw entries, read by parseAccelerators first; a config's hw, when it has one, is what the PC has (hardware.json), and none is null. Made by kit/test/accelerator-scenarios.ts; take this file from a kit release, unchanged.",
    nowMs: NOW,
    ids: names.map((name) => ({ name, id: core.acceleratorId('gpu', name) })),
    isId: ids.map((id) => ({ id, valid: core.isId(id), kind: core.kindOfId(id) })),
    lockFolders: [
      { case: 'the NPU has one slot, whatever its entry says', id: 'npu', slots: 4 },
      { case: 'a card has a folder a slot', id: 'gpu-x', slots: 3 },
      { case: 'no slots given is one', id: 'cpu' },
    ].map((c) => ({ ...c, folders: core.lockFoldersOf(c) })),
    cards: [
      { case: "software adapters left out; a second card of a name, in any case, is #2; no name is 'Graphics card <n>'", adapters, software: false, keys: core.keyedCards(adapters).map((c) => c.key) },
      { case: 'software adapters listed when asked', adapters, software: true, keys: core.keyedCards(adapters, { software: true }).map((c) => c.key) },
    ],
    configs: configs.map((c) => ({ ...c, expect: core.parseAccelerators(RULES, c.raw, c.hw ?? null) })),
    files: files.map((f) => ({ ...f, expect: core.readConfig(RULES, f.file, f.text) })),
    failures: failures.map((f) => ({ ...f, expect: core.failureOf(RULES, f.text, NOW) })),
    reasons: reasons.map((text) => ({ text, expect: core.oneLine(RULES, text) })),
    records: [
      { reason: 'chat: /v1/chat/completions on http://127.0.0.1:18181 failed (503): busy\nmore', by: 'clerk', nowMs: NOW, expect: core.sharedText(core.failureRecord(RULES, 'chat: /v1/chat/completions on http://127.0.0.1:18181 failed (503): busy\nmore', 'clerk', NOW)) },
    ],
    games: [
      { case: 'a card is busy while another program keeps a 3D engine over 25%: by LUID, not the desktop, not the checker, not a model server', load: games, config: gameConfig, self: 777, expect: core.gameCards(RULES, games, config(gameConfig), { self: 777 }) },
      { case: 'a card DXGI does not list is not busy', load: { ...games, adapters: [] }, config: gameConfig, self: 777, expect: core.gameCards(RULES, { ...games, adapters: [] }, config(gameConfig), { self: 777 }) },
    ],
    serverNames: [{ config: gameConfig, expect: core.serverNames(config(gameConfig)) }],
    gamesStale: [
      { case: 'none', games: null, stale: true },
      { case: '10 s old', games: { checkedAt: iso(NOW - 10_000), cards: {} }, stale: false },
      { case: 'exactly 15 s old', games: { checkedAt: iso(NOW - 15_000), cards: {} }, stale: false },
      { case: 'over 15 s old', games: { checkedAt: iso(NOW - 15_001), cards: {} }, stale: true },
      { case: 'from a clock 16 s ahead', games: { checkedAt: iso(NOW + 16_000), cards: {} }, stale: true },
      { case: 'an unreadable time', games: { checkedAt: 'soon', cards: {} }, stale: true },
    ].map((g) => ({ ...g, stale: core.gamesStale(RULES, g.games, NOW) })),
    candidates: candidateCases.map((c) => {
      const r = core.candidates(RULES, choose, c.need as core.Need, { failures: c.failures, games: c.games, deferredMs: c.deferredMs, nowMs: NOW });
      return { ...c, config: choosing, expect: { list: byId(r.list), skipped: r.skipped.map((s) => ({ id: s.acc.id, why: s.why, detail: s.detail })) } };
    }),
    pick: pickCases.map((c) => {
      const list = choose.filter((a) => (c.only ?? ['gpu-a', 'npu']).includes(a.id));
      const r = core.pick(RULES, list, c.lane as core.Lane, c.looks);
      return { case: c.case, config: choosing, candidates: byId(list), lane: c.lane, looks: c.looks, expect: 'acc' in r ? { acc: r.acc.id } : r };
    }),
    whyNone: whyCases.map((c) => ({ ...c, expect: core.whyNone(c.skipped.map((s) => ({ ...s, acc: { id: s.id, name: s.id } })) as unknown as core.Skipped[], c.first) })),
    messages: [
      { case: "the NPU's own name", ref: { id: 'npu', name: 'Snapdragon X2 Elite NPU' } },
      { case: 'an older config\'s card', ref: { id: 'gpu-graphics-card', name: 'Graphics card' } },
      { case: 'the processor', ref: { id: 'cpu', name: 'Processor' } },
      { case: 'a name that says "the"', ref: { id: 'cpu', name: 'The Oryon CPU' } },
      { case: 'none: a note that says nothing of where (from before the accelerators) is from a local model, never guessed to be the NPU', ref: null },
    ].map((m) => ({ ...m, theAccelerator: core.theAccelerator(m.ref), noteLabel: core.noteLabel(m.ref) })),
    tokens: [
      { text: 'x'.repeat(9000), estimate: core.estimateTokens(RULES, 'x'.repeat(9000)) },
      { text: 'Hi', estimate: core.estimateTokens(RULES, 'Hi') },
      { chat: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }], estimate: core.chatTokens(RULES, [{ content: 'Be brief.' }, { content: 'Hi' }]) },
      { vision: 'What is the title?', estimate: core.visionTokens(RULES, 'What is the title?') },
    ],
    pieces: [{ text: Array.from({ length: 12 }, (_, i) => `line ${i} `.repeat(9)).join('\n'), budget: 50 }].map((p) => ({ ...p, expect: core.pieces(RULES, p.text, p.budget) })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = `${JSON.stringify(makeAcceleratorVectors(), null, 1)}\n`;
  if (process.argv.includes('--write')) {
    writeFileSync(new URL('../spec/accelerator-vectors.json', import.meta.url), text);
    console.log('kit/spec/accelerator-vectors.json written');
  } else process.stdout.write(text);
}
