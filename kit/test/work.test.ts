import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// "Where its work runs", on every kit agent's Settings page. Nothing here reads the real Reeve's config.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-work-test-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(home, 'agent');
process.env.REEVE_HOME = path.join(home, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');

const { WORK, thisPc, workSection } = await import('./fixture/src/kit/work.ts');
const { parseAccelerators, REEVE_NOT_SET_UP } = await import('./fixture/src/kit/accelerators.ts');
const { page } = await import('./fixture/src/kit/page.ts');

const legacyNpu = parseAccelerators({ chatEndpoint: { baseUrl: 'http://127.0.0.1:18181', model: 'qualcomm/Qwen3-4B-Instruct-2507:W4A16', device: 'Npu' }, visionModel: 'qualcomm/Qwen3-VL-4B-Instruct:W4A16' });

test('every kit agent has its lines, each with what, where and when', () => {
  for (const id of ['porter', 'auditor', 'clerk', 'herald', 'warrener', 'aletaster', 'miller', 'pinder', 'steward', 'surveyor']) {
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
      { id: 'npu', kind: 'npu', name: 'Snapdragon X2 Elite NPU', maxContextTokens: 2400, chat: { baseUrl: 'http://127.0.0.1:18181', model: 'q' } },
      { id: 'gpu-rtx', kind: 'gpu', name: 'NVIDIA GeForce RTX 4090', memoryGb: 24, slots: 2, maxContextTokens: 8192, chat: { baseUrl: 'http://127.0.0.1:18191', model: 'q' } },
    ],
  });
  const text = thisPc(both);
  assert.match(text, /the NVIDIA GeForce RTX 4090 \(chat\), then the Snapdragon X2 Elite NPU \(chat\)\./, 'auto order: the big card first');
  assert.doesNotMatch(text, /NPU only/);
  assert.equal(thisPc({ error: REEVE_NOT_SET_UP }), `${REEVE_NOT_SET_UP}, so there is no model work here.`);
});

test('the section: the agent\'s table and notes, then its model work on this PC; the Steward has none', () => {
  const clerk = workSection({ id: 'clerk', name: 'Clerk', config: legacyNpu });
  assert.match(clerk, /<section class="work-runs" data-settings-extra>\s*<h2>Where its work runs<\/h2>/);
  assert.match(clerk, /What Clerk does on this PC/);
  assert.match(clerk, /Windows&#39; own OCR/);
  assert.match(clerk, /only to packaged apps/);
  assert.match(clerk, /Its model work/);
  assert.match(clerk, /NPU only/);
  const steward = workSection({ id: 'steward', name: 'Steward', config: legacyNpu });
  assert.match(steward, /Steward uses no model\./);
  assert.doesNotMatch(steward, /Its model work/);
  const stranger = workSection({ id: 'someone-new', name: 'Someone', config: legacyNpu });
  assert.doesNotMatch(stranger, /<table/, 'an agent not listed: the shared part only');
  assert.match(stranger, /Its model work/);
});

test('the page carries the section, which the script moves into Settings after the agent\'s own', () => {
  const html = page({ token: 'tok', body: '<h2>Settings</h2><div data-settings-panel></div><p>Version 1</p>' });
  assert.match(html, /<section class="work-runs" data-settings-extra>/);
  assert.ok(html.includes("el.hasAttribute('data-settings-extra') || (passed && el.tagName === 'H2')"), 'the Settings section stops at it');
  assert.ok(html.includes("main.querySelectorAll(':scope > [data-settings-extra]')"), 'and it follows the agent\'s Settings');
});
