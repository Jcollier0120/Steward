import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dotnetWithSdk, startOptions } from '../src/run.ts';

// A .NET employee's commands need a dotnet with an SDK: Task Scheduler's PATH finds Program Files' runtime first.
test('dotnetWithSdk: the first folder with dotnet.exe and an SDK, never a runtime alone', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'steward-dotnet-'));
  const runtime = path.join(root, 'runtime');
  const sdk = path.join(root, 'sdk10');
  for (const d of [runtime, sdk]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'dotnet.exe'), '');
  }
  mkdirSync(path.join(sdk, 'sdk', '10.0.100'), { recursive: true });
  assert.equal(dotnetWithSdk([undefined, runtime, sdk]), sdk);
  assert.equal(dotnetWithSdk([runtime, path.join(root, 'missing')]), null);
  rmSync(root, { recursive: true, force: true });
});

// Steward 0.36.11: a hidden git gets a console host of its own, a second process for every git; sharing the page's
// windowless console (kit/console.ts) it gets none.
test('startOptions: git and gh share a console the Steward has; without one, detached in the background; the rest hidden', () => {
  for (const cmd of ['git', 'gh']) {
    assert.deepEqual(startOptions(cmd, { shares: true, background: true }), { windowsHide: false, detached: false });
    assert.deepEqual(startOptions(cmd, { shares: true, background: false }), { windowsHide: false, detached: false });
    assert.deepEqual(startOptions(cmd, { shares: false, background: true }), { windowsHide: true, detached: true });
    assert.deepEqual(startOptions(cmd, { shares: false, background: false }), { windowsHide: true, detached: false });
  }
  for (const cmd of ['npm', 'node', 'dotnet', 'powershell'])
    for (const shares of [true, false]) assert.deepEqual(startOptions(cmd, { shares, background: true }), { windowsHide: true, detached: false }, cmd);
});
