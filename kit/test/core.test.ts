import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as core from '../core/index.js';
import { coreDir, coreModules, makeCoreTypes } from './core-types.ts';

// The kit's core itself: no I/O, no clock and no randomness of its own; its .d.ts are its JSDoc's; its
// rules are spec/rules.json's. Its behaviour is the spec's vectors (vectors.test.ts).
const source = (f: string) => readFileSync(path.join(coreDir, f), 'utf8');
/** The code without its comments and strings, so they may name what the code mustn't use. */
const code = (f: string) =>
  source(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");

test('the core does no I/O and has no clock or randomness of its own: plain ES2022, any engine runs it', () => {
  const banned: [RegExp, string][] = [
    [/\bDate\.now\b/, 'Date.now'],
    [/new Date\(\s*\)/, 'new Date()'],
    [/\bMath\.random\b/, 'Math.random'],
    [/\bperformance\b/, 'performance'],
    [/\bprocess\b/, 'process'],
    [/\brequire\s*\(/, 'require'],
    [/\bimport\s*\(/, 'a dynamic import'],
    [/\b(setTimeout|setInterval|queueMicrotask|fetch|console|globalThis|structuredClone|crypto)\b/, 'a host API'],
    [/\b(async|await)\b/, 'async'],
  ];
  for (const f of coreModules()) {
    for (const [re, what] of banned) assert.doesNotMatch(code(f), re, `${f} uses ${what}`);
    const imports = [...source(f).matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const from of imports) assert.match(from, /^\.\/[a-z]+\.js$/, `${f} imports only the core's own modules`);
  }
});

test("the core's .d.ts are what its JSDoc gives (npm run core-types writes them), and it type-checks", () => {
  const made = makeCoreTypes();
  for (const [f, text] of Object.entries(made)) assert.equal(source(f).replace(/\r\n/g, '\n'), text, `kit/core/${f} is out of date: run npm run core-types`);
  assert.deepEqual(Object.keys(made).sort(), coreModules().map((f) => f.replace(/\.js$/, '.d.ts')).sort());
});

test("rules.json is checked: every timing and limit, a whole number; anything else is named", () => {
  const raw = JSON.parse(readFileSync(new URL('../spec/rules.json', import.meta.url), 'utf8'));
  const rules = core.checkRules(raw);
  assert.equal(rules.queue.deadMs, 15_000);
  assert.equal(rules.lock.staleMs, 600_000);
  assert.ok(Object.isFrozen(rules) && Object.isFrozen(rules.queue));
  assert.throws(() => core.checkRules({ ...raw, queue: { ...raw.queue, lateMs: '5000' } }), /queue\.lateMs must be a whole number/);
  assert.throws(() => core.checkRules({ ...raw, tokens: undefined }), /no "tokens"/);
  assert.throws(() => core.checkRules(null), /no object/);
});

test("a request's timeout: a background chat's scales with its answer, under the config's ceiling; a model loading adds its allowance", () => {
  const rules = core.checkRules(JSON.parse(readFileSync(new URL('../spec/rules.json', import.meta.url), 'utf8')));
  const t = (r: Partial<Parameters<typeof core.requestTimeoutMs>[1]>) => core.requestTimeoutMs(rules, { lane: 'background', work: 'chat', maxTokens: 100, ceilingMs: 180_000, ...r });
  assert.equal(t({}), 45_000, '15 s, and 0.3 s for each of 100 tokens');
  assert.equal(t({ work: 'vision', maxTokens: 64 }), 34_200);
  assert.equal(t({ maxTokens: 1000 }), 180_000, 'never past the ceiling');
  assert.equal(t({ ceilingMs: 5000 }), 5000, "a config's shorter ceiling holds");
  assert.equal(t({ lane: 'interactive' }), 180_000, 'a person waiting: the config');
  assert.equal(t({ work: 'embed' }), 180_000, 'embeddings: the config');
  assert.equal(t({ coldLoad: true }), 135_000, 'a model that may be loading: 90 s more');
});

test('the turn never hands a driver a state it changed, and never ends twice', () => {
  const rules = core.checkRules(JSON.parse(readFileSync(new URL('../spec/rules.json', import.meta.url), 'utf8')));
  const first = core.startTurn(rules, { slots: ['npu'], pid: 1, nowMs: 0, nowUs: 0, nonce: 'aaaaaaaa', who: 't' });
  const before = JSON.stringify(first.state);
  core.step(first.state, { nowMs: 1, results: [null, null] });
  assert.equal(JSON.stringify(first.state), before);
  const ended = core.abort(first.state);
  assert.deepEqual(ended.actions, [{ op: 'remove', path: ['npu.queue', '1-00000000000000000-1-aaaaaaaa.ticket'] }]);
  assert.throws(() => core.step(ended.state, { nowMs: 2, results: [] }), /has ended/);
  assert.throws(() => core.release(first.state, 2), /isn't held/);
});

test('times are read as ISO 8601 with a zone, the same in every engine', () => {
  assert.equal(core.parseIsoMs('2026-10-02T12:00:00.000Z'), Date.UTC(2026, 9, 2, 12));
  assert.equal(core.parseIsoMs('2026-10-02T14:00:00+02:00'), Date.UTC(2026, 9, 2, 12));
  assert.equal(core.parseIsoMs('2026-10-02T12:00:00.5Z'), Date.UTC(2026, 9, 2, 12, 0, 0, 500));
  for (const bad of ['2026-10-02', '2026-10-02T12:00:00', 'Fri, 02 Oct 2026 12:00:00 GMT', '2026-13-01T00:00:00Z', 12, null]) assert.ok(Number.isNaN(core.parseIsoMs(bad)), String(bad));
  assert.equal(core.isoTime(Date.UTC(2026, 9, 2, 12)), '2026-10-02T12:00:00.000Z');
});
