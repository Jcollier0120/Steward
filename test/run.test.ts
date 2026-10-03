import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dotnetWithSdk } from '../src/run.ts';

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
});
