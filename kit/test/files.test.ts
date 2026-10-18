import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A copy's times and the Recycle Bin (node/files.ts), through the agent's PowerShell worker. Nothing is sent to the
// Recycle Bin: only its refusals, which come before anything is touched, are tried.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-files-'));
after(() => rmSync(home, { recursive: true, force: true }));

const { recycle, setFileTimes } = await import('./fixture/src/kit/files.ts');
const onWindows = { skip: process.platform !== 'win32' && 'Windows PowerShell' };

test("a copy is given its original's created and modified times", onWindows, async () => {
  const file = path.join(home, "copy's name.mp4");
  writeFileSync(file, 'x');
  const created = new Date('2024-03-01T08:15:30.000Z');
  const modified = new Date('2024-03-02T19:45:10.000Z');
  await setFileTimes(file, created, modified);
  const st = statSync(file);
  assert.equal(st.birthtime.toISOString(), created.toISOString());
  assert.equal(st.mtime.toISOString(), modified.toISOString());
});

test("a file on a share has no Recycle Bin, so it isn't recycled: it stays, and the reason is given", onWindows, async () => {
  await assert.rejects(recycle('\\\\server\\share\\clip.mp4'), /it isn't on a lettered local drive, so it has no Recycle Bin/);
});
