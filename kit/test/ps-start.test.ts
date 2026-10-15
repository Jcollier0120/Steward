import assert from 'node:assert/strict';
import { test } from 'node:test';
import { psStart } from '../node/ps.ts';

// kit 2.74.4: powershell.exe shares the page's windowless console, as git and gh do (console.ts), instead of each one
// getting a console host of its own.
test('psStart: powershell.exe shares the console when there is one, and starts hidden only when there is none', () => {
  assert.deepEqual(psStart(true), { windowsHide: false });
  assert.deepEqual(psStart(false), { windowsHide: true });
});
