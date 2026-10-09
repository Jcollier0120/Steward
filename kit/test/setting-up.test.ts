import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingUpFromPing } from './fixture/src/kit/server.ts';

// An agent getting settled in says so in its ping (`settingUp`); Manor reads it with settingUpFromPing.

test("a ping's settingUp: read when it says what, with its count, its estimate and its accelerator; anything odd is left out, never an error", () => {
  assert.equal(settingUpFromPing(null), null);
  assert.equal(settingUpFromPing({ running: true }), null, 'an agent that predates it');
  assert.equal(settingUpFromPing({ settingUp: { text: '  ' } }), null);
  assert.equal(settingUpFromPing({ settingUp: 'yes' }), null);
  assert.deepEqual(settingUpFromPing({ settingUp: { text: 'Reeve is getting to know your projects', done: 12, total: 31, unit: 'projects', until: '2026-10-08T22:00:00Z', accelerator: 'gpu-adreno' } }), {
    text: 'Reeve is getting to know your projects',
    done: 12,
    total: 31,
    unit: 'projects',
    until: '2026-10-08T22:00:00Z',
    accelerator: 'gpu-adreno',
  });
  assert.deepEqual(settingUpFromPing({ settingUp: { text: 'x', done: 40, total: 31, unit: 'projects' } }), { text: 'x', done: 31, total: 31, unit: 'projects' }, 'done never past total');
  assert.deepEqual(settingUpFromPing({ settingUp: { text: 'x', done: -1, total: 0, until: 'soon', accelerator: 7 } }), { text: 'x' }, 'no count, no estimate, no accelerator');
});
