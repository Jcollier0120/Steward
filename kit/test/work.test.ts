import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// "Where its work runs", on every kit agent's Settings page. Nothing here reads the real Reeve's config.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-work-test-'));
after(() => rmSync(home, { recursive: true, force: true }));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(home, 'agent');
process.env.REEVE_HOME = path.join(home, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'no-manor'); // the title bar's Back to Manor: never the real Manor's settings

const { WORK, thisPc, workSection } = await import('./fixture/src/kit/work.ts');
const { parseAccelerators, REEVE_NOT_SET_UP } = await import('./fixture/src/kit/accelerators.ts');
const { page } = await import('./fixture/src/kit/page.ts');

const legacyNpu = parseAccelerators({ chatEndpoint: { baseUrl: 'http://127.0.0.1:18181', model: 'qualcomm/Qwen3-4B-Instruct-2507:W4A16', device: 'Npu' }, visionModel: 'qualcomm/Qwen3-VL-4B-Instruct:W4A16' });

test('every kit agent has its lines, each with what, where and when', () => {
  for (const id of ['porter', 'auditor', 'clerk', 'herald', 'developer-herald', 'warrener', 'aletaster', 'miller', 'pinder', 'steward', 'surveyor', 'lamplighter', 'smith', 'thatcher', 'reckoner', 'weigher', 'shepherd']) {
    const w = WORK[id];
    assert.ok(w && w.lines.length, `${id} has lines`);
    for (const l of w.lines) for (const k of ['what', 'where', 'when'] as const) assert.ok(l[k].trim(), `${id}: "${l.what}" has its ${k}`);
  }
  assert.equal(WORK.steward.model, false, 'the Steward uses no model');
});

test('this PC: what Reeve lists, in order, and when that is the NPU alone', () => {
  assert.ok(!('error' in legacyNpu));
  const npu = thisPc(legacyNpu);
  assert.match(npu, /^On this PC, Reeve lists the NPU \(chat, vision\)\./);
  assert.match(npu, /NPU only, never on the processor or a graphics card/);
  const both = parseAccelerators({
    accelerators: [
      { id: 'npu', kind: 'npu', maxContextTokens: 2400, chat: { baseUrl: 'http://127.0.0.1:18181', model: 'q' } },
      { id: 'gpu-nvidia-geforce-rtx-4090', kind: 'gpu', memoryGb: 24, slots: 2, maxContextTokens: 8192, chat: { baseUrl: 'http://127.0.0.1:18191', model: 'q' } },
    ],
  }, { npu: true, npuName: 'Snapdragon X2 Elite NPU', cards: [{ name: 'NVIDIA GeForce RTX 4090', memoryGb: 24 }] });
  const text = thisPc(both);
  assert.match(text, /the Snapdragon X2 Elite \(chat\), then the NVIDIA GeForce RTX 4090 \(chat\)\./, 'auto order: the NPU first');
  assert.doesNotMatch(text, /NPU only/);
  assert.equal(thisPc({ error: REEVE_NOT_SET_UP }), `${REEVE_NOT_SET_UP}, so there is no model work here.`);
});

test('the section: the agent\'s table and notes, then its model work on this PC; the Steward has none', () => {
  const clerk = workSection({ id: 'clerk', name: 'Clerk', config: legacyNpu, developer: true });
  assert.match(clerk, /<section class="work-runs" data-settings-extra>\s*<h2>Where its work runs<\/h2>/);
  assert.match(clerk, /What Clerk does on this PC/);
  assert.match(clerk, /Windows&#39; own OCR/);
  assert.match(clerk, /only to packaged apps/);
  assert.match(clerk, /Its model work/);
  assert.match(clerk, /NPU only/);
  const steward = workSection({ id: 'steward', name: 'Steward', config: legacyNpu, developer: true });
  assert.match(steward, /Steward uses no model\./);
  assert.doesNotMatch(steward, /Its model work/);
  const stranger = workSection({ id: 'someone-new', name: 'Someone', config: legacyNpu, developer: true });
  assert.doesNotMatch(stranger, /<table/, 'an agent not listed: the shared part only');
  assert.match(stranger, /Its model work/);
  // Some agents test that their page never says "NPU:" or "NPU note" (from when the NPU was all there was): the section mustn't either.
  for (const id of Object.keys(WORK)) assert.doesNotMatch(workSection({ id, name: id, config: legacyNpu, developer: true }), /NPU note|NPU:/, `${id}'s section`);
});

test("the Lamplighter's model work: the NPU only, never a graphics card or the processor, and none on a PC without an NPU", () => {
  const both = parseAccelerators({
    accelerators: [
      { id: 'gpu-rtx', kind: 'gpu', name: 'NVIDIA GeForce RTX 4090', memoryGb: 24, slots: 2, maxContextTokens: 8192, chat: { baseUrl: 'http://127.0.0.1:18191', model: 'q' } },
      { id: 'npu', kind: 'npu', name: 'Snapdragon X2 Elite NPU', maxContextTokens: 2400, chat: { baseUrl: 'http://127.0.0.1:18181', model: 'q' } },
    ],
  });
  const gpuOnly = parseAccelerators({ accelerators: [{ id: 'gpu-rtx', kind: 'gpu', name: 'NVIDIA GeForce RTX 4090', memoryGb: 24, slots: 2, maxContextTokens: 8192, chat: { baseUrl: 'http://127.0.0.1:18191', model: 'q' } }] });
  assert.ok(!('error' in both) && !('error' in gpuOnly));
  assert.equal(WORK.lamplighter.npuOnly, true);
  const withNpu = workSection({ id: 'lamplighter', name: 'Lamplighter', config: both, developer: true });
  assert.match(withNpu, /goes to the NPU only/);
  assert.match(withNpu, /Never to a graphics card or the processor/);
  assert.match(withNpu, /This PC has one\./);
  assert.doesNotMatch(withNpu, /Each request goes to the first one in Reeve&#39;s order/, 'not the shared order');
  assert.match(workSection({ id: 'lamplighter', name: 'Lamplighter', config: gpuOnly, developer: true }), /This PC has none, so it asks no model/);
  assert.doesNotMatch(workSection({ id: 'surveyor', name: 'Surveyor', config: both, developer: true }), /NPU only/, 'only an agent that says so');
});

test('the page carries the section, which the script moves into Settings after the agent\'s own', () => {
  const html = page({ token: 'tok', body: '<h2>Settings</h2><div data-settings-panel></div><p>Version 1</p>' });
  assert.match(html, /<section class="work-runs" data-settings-extra>/);
  assert.ok(html.includes("el.hasAttribute('data-settings-extra') || (passed && el.tagName === 'H2')"), 'the Settings section stops at it');
  assert.ok(html.includes("main.querySelectorAll(':scope > [data-settings-extra]')"), 'and it follows the agent\'s Settings');
});

/** What the section never says with Developer options off (spec/DEVELOPER-OPTIONS.md): tools, commands, ports, model servers, code. */
const DEVELOPER_WORDS = [/Reeve/, /PowerShell/, /\bWMI\b/, /pnputil/, /GenieX/i, /llama/i, /SHA-256/, /winget/, /FFmpeg/, /x26[45]|SVT-AV1/, /\bgit\b|\bgh\b|GitHub/, /worktree|checkout|repositor|changelog|upstream|typecheck/i, /\bports?\b/i, /\bSYSTEM\b/, /model server/i, /Claude/, /\bOCR\b/, /\bcode\b/];

test('with Developer options off, the section is in plain words: the local AI, no tool, command or server by name, and no developer work', () => {
  const both = parseAccelerators({
    accelerators: [
      { id: 'npu', kind: 'npu', name: 'Snapdragon X2 Elite NPU', maxContextTokens: 2400, chat: { baseUrl: 'http://127.0.0.1:18181', model: 'q' } },
      { id: 'gpu-rtx', kind: 'gpu', name: 'NVIDIA GeForce RTX 4090', memoryGb: 24, slots: 2, maxContextTokens: 8192, chat: { baseUrl: 'http://127.0.0.1:18191', model: 'q' } },
    ],
  });
  const gpuOnly = parseAccelerators({ accelerators: [{ id: 'gpu-rtx', kind: 'gpu', name: 'NVIDIA GeForce RTX 4090', memoryGb: 24, slots: 2, maxContextTokens: 8192, chat: { baseUrl: 'http://127.0.0.1:18191', model: 'q' } }] });
  for (const config of [legacyNpu, both, gpuOnly, { error: REEVE_NOT_SET_UP }] as const) {
    for (const id of [...Object.keys(WORK), 'someone-new']) {
      const plain = workSection({ id, name: id, config, developer: false });
      for (const word of DEVELOPER_WORDS) assert.doesNotMatch(plain, word, `${id}'s plain section`);
    }
  }
  const clerk = workSection({ id: 'clerk', name: 'Clerk', config: legacyNpu, developer: false });
  assert.match(clerk, /Its AI work<\/strong> goes to the local AI/);
  assert.match(clerk, /On this PC, the local AI uses the NPU \(chat, vision\)\./);
  assert.match(clerk, /the local AI&#39;s vision model \(below\)/);
  // Developer work isn't shown at all: the Aletaster's and the Steward's rows are about repositories and builds.
  assert.doesNotMatch(workSection({ id: 'aletaster', name: 'Aletaster', config: legacyNpu, developer: false }), /<table/);
  const steward = workSection({ id: 'steward', name: 'Steward', config: legacyNpu, developer: false });
  assert.doesNotMatch(steward, /<table/);
  assert.match(steward, /Steward uses no AI\./);
  // The same agent with Developer options on says it all, as before.
  const smithDev = workSection({ id: 'smith', name: 'Smith', config: both, developer: true });
  assert.match(smithDev, /GenieX/);
  assert.match(smithDev, /the model servers Reeve runs|Smith uses no model/);
  assert.doesNotMatch(workSection({ id: 'smith', name: 'Smith', config: both, developer: false }), /GenieX|llama/);
  assert.equal(thisPc({ error: REEVE_NOT_SET_UP }, false), "The local AI isn't set up on this PC, so there is no AI work here.");
});

test('every plain line keeps what, where and when; a developer-only line has no plain words to show', () => {
  for (const [id, w] of Object.entries(WORK)) {
    for (const l of w.lines) {
      if (l.dev) assert.equal(l.plain, undefined, `${id}: "${l.what}" is a developer's only`);
      for (const k of ['what', 'where', 'when'] as const) if (l.plain?.[k] !== undefined) assert.ok(l.plain[k]!.trim(), `${id}: "${l.what}" has its plain ${k}`);
    }
    for (const n of w.plainNotes ?? []) assert.ok(n.trim(), `${id}'s plain notes`);
  }
});

test("by default the section follows the switch: off without Manor and without the agent's own", () => {
  const plain = workSection({ id: 'clerk', name: 'Clerk', config: legacyNpu });
  assert.doesNotMatch(plain, /Reeve/);
  assert.match(plain, /the local AI/);
  const html = page({ token: 'tok', body: '<p>Hello</p>' });
  assert.match(html, /<footer>[^<]+ · this PC only<\/footer>/, 'no data folder in the footer');
  assert.doesNotMatch(html, /its files are in/);
});
