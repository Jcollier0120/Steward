import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { APP, appRoot } from '../app.ts';
import { SETTINGS_SPEC } from '../settings.ts';
import { checkValues, schemaGaps, type Field } from './settings-kit.ts';

/**
 * The kit's checks of the agent it sits in: that the agent gives the kit what it needs (the agent
 * interface, in the Steward's README). Every agent runs them from one line, its test/agent.test.ts:
 *
 *   import '../src/kit/agent-checks.ts';
 *
 * They read files and call pure functions only: nothing is written, nothing listens.
 */

const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const read = (rel: string) => readFileSync(path.join(appRoot, rel), 'utf8').replace(/^﻿/, '');

test('the agent is the same agent in package.json and src/app.ts', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, APP.id, "package.json's name is the agent's id");
  assert.equal(pkg.version, APP.version, "package.json's version is src/app.ts's (the release checks it too)");
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/, 'an id is lowercase letters, digits and dashes');
  assert.ok(APP.name.trim() && APP.role.trim(), 'a name and a one-line role, for its page and Manor');
});

const pinFile = path.join(appRoot, 'kit.json');
test('src/kit holds the kit that kit.json pins', { skip: !existsSync(pinFile) && "no kit.json: the kit's own fixture" }, () => {
  const pin = JSON.parse(read('kit.json')).kit;
  assert.match(String(pin), /^\d+\.\d+\.\d+$/, 'kit.json pins one exact version: {"kit": "1.0.0"}');
  assert.equal(read(path.join('src', 'kit', 'VERSION')).trim(), pin, 'npm run kit fills src/kit at the pinned version');
});

test('its icon is art/icon.svg', () => {
  assert.match(read(path.join('art', 'icon.svg')), /<svg[\s>]/);
});

test('its settings: the schema and the defaults name the same settings', () => {
  assert.deepEqual(schemaGaps(SETTINGS_SPEC.schema, SETTINGS_SPEC.defaults), []);
});

test('its settings: the defaults pass the schema, and the agent reads them as they are', () => {
  assert.deepEqual(checkValues(SETTINGS_SPEC.schema, SETTINGS_SPEC.defaults).errors, {});
  const { settings, problems } = SETTINGS_SPEC.normalize(json(SETTINGS_SPEC.defaults));
  assert.deepEqual(problems, []);
  assert.deepEqual(json(settings), json(SETTINGS_SPEC.defaults));
});

test("its settings: each number's limits are the agent's own (normalize keeps both ends and nothing past them)", () => {
  const numbers: [string[], Field & { min: number; max: number }][] = [];
  for (const f of SETTINGS_SPEC.schema as Field[]) {
    if (f.kind === 'whole' || f.kind === 'number') numbers.push([[f.key], f]);
    if (f.kind === 'group') for (const g of f.fields) if (g.kind === 'whole' || g.kind === 'number') numbers.push([[f.key, g.key], g]);
  }
  const at = (p: string[], v: number) => {
    const raw = json(SETTINGS_SPEC.defaults);
    if (p.length === 1) raw[p[0]] = v;
    else raw[p[0]] = { ...raw[p[0]], [p[1]]: v };
    const s = SETTINGS_SPEC.normalize(raw).settings as any;
    return p.length === 1 ? s[p[0]] : s[p[0]][p[1]];
  };
  for (const [p, f] of numbers) {
    const step = f.kind === 'whole' ? 1 : (f.max - f.min) / 10;
    assert.equal(at(p, f.min), f.min, `${p.join('.')} keeps its least, ${f.min}`);
    assert.equal(at(p, f.max), f.max, `${p.join('.')} keeps its most, ${f.max}`);
    assert.notEqual(at(p, f.max + step), f.max + step, `${p.join('.')} doesn't keep ${f.max + step}`);
    assert.notEqual(at(p, f.min - step), f.min - step, `${p.join('.')} doesn't keep ${f.min - step}`);
  }
});
