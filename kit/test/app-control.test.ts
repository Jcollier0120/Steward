import assert from 'node:assert/strict';
import { test } from 'node:test';

// Windows' application control (app-control.ts, kit 2.88.4): the Code Integrity log's blocks, read from its XML as
// wevtutil gives it, never the real log (a test run doesn't ask it).
const { blockedIn, blockedSay, blocksIn, parseBlocks } = await import('./fixture/src/kit/app-control.ts');

const FOLDER = 'C:\\Users\\Arnold\\.manor\\accelerators\\servers\\llama.cpp\\b11734-cuda-12.4-x64';
const event = (id: number, data: Record<string, string>) =>
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-CodeIntegrity'/><EventID>${id}</EventID><TimeCreated SystemTime='2026-10-19T14:30:14.1Z'/></System><EventData>${Object.entries(data)
    .map(([k, v]) => `<Data Name='${k}'>${v}</Data>`)
    .join('')}</EventData></Event>`;
// As the gaming desktop logged it on 2026-10-19: 3033 and 3077 for one file, a 3089 (its signature) beside them, and
// another program's 3033 the same day.
const DESKTOP = [
  event(3033, { FileNameLength: '96', FileNameBuffer: '\\Device\\HarddiskVolume3\\Users\\Arnold\\.manor\\accelerators\\servers\\llama.cpp\\b11734-cuda-12.4-x64\\ggml-cpu-ivybridge.dll', ProcessNameBuffer: '\\Device\\HarddiskVolume3\\Users\\Arnold\\.manor\\accelerators\\servers\\llama.cpp\\b11734-cuda-12.4-x64\\llama-server.exe' }),
  event(3077, { 'File Name': '\\Device\\HarddiskVolume3\\Users\\Arnold\\.manor\\accelerators\\servers\\llama.cpp\\b11734-cuda-12.4-x64\\ggml-cpu-ivybridge.dll', 'Process Name': '\\Device\\HarddiskVolume3\\Users\\Arnold\\.manor\\accelerators\\servers\\llama.cpp\\b11734-cuda-12.4-x64\\llama-server.exe', PolicyName: 'VerifiedAndReputableDesktop' }),
  event(3089, { PublisherName: 'Microsoft Windows' }),
  event(3033, { FileNameBuffer: '\\Device\\HarddiskVolume3\\Windows\\System32\\nvspcap64.dll', ProcessNameBuffer: '\\Device\\HarddiskVolume3\\Windows\\System32\\WaaSMedicAgent.exe' }),
].join('');

test("the log's blocks: each 3033 and 3077 event's file, and the policy a 3077 names; a 3089 is no block", () => {
  const blocks = parseBlocks(DESKTOP);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b: any) => [b.file.split('\\').pop(), b.policy]), [['ggml-cpu-ivybridge.dll', null], ['ggml-cpu-ivybridge.dll', 'VerifiedAndReputableDesktop'], ['nvspcap64.dll', null]]);
  assert.equal(parseBlocks(event(3033, { FileNameBuffer: 'C:\\a &amp; b\\x.dll' }))[0].file, 'C:\\a & b\\x.dll', 'its XML unescaped');
  assert.deepEqual(parseBlocks(''), []);
});

test("a server's folder's blocks: by its path without the volume, one per file with its policy kept; another folder's aren't", () => {
  const mine = blocksIn(parseBlocks(DESKTOP), FOLDER);
  assert.equal(mine.length, 1, '3033 and 3077 for one file are one block');
  assert.equal(mine[0].policy, 'VerifiedAndReputableDesktop');
  assert.deepEqual(blocksIn(parseBlocks(DESKTOP), `${FOLDER}\\`), mine, 'a folder with its trailing backslash');
  assert.deepEqual(blocksIn(parseBlocks(DESKTOP), FOLDER.replace('Arnold', 'arnold').replace('b11734', 'B11734')), mine, 'in any case');
  assert.deepEqual(blocksIn(parseBlocks(DESKTOP), 'C:\\Users\\Arnold\\.manor\\accelerators\\servers\\llama.cpp\\b11734-cuda'), [], "a folder whose name begins another's isn't it");
  assert.deepEqual(blocksIn(parseBlocks(DESKTOP), 'C:\\Users\\Jeremy\\.manor\\accelerators'), []);
});

test('blockedIn asks the log for 3033 and 3077 since then; a log that can\'t be read says nothing, and a test run never asks the real one', async () => {
  const asked: string[] = [];
  const blocks = await blockedIn(FOLDER, 90_000, async (q: string) => (asked.push(q), DESKTOP));
  assert.equal(blocks.length, 1);
  assert.match(asked[0], /EventID=3033 or EventID=3077/);
  assert.match(asked[0], /timediff\(@SystemTime\) <= 90000\]/);
  assert.deepEqual(await blockedIn(FOLDER, 90_000, async () => null), []);
  assert.deepEqual(await blockedIn(FOLDER, 90_000, async () => Promise.reject(new Error('wevtutil: access denied'))), []);
  assert.deepEqual(await blockedIn(FOLDER, 90_000), [], 'no reader: the real log is left alone under node --test');
});

test('blockedSay names the files and Smart App Control in plain words; an unnamed policy is said with care, an organization\'s by its name', () => {
  const sac = blocksIn(parseBlocks(DESKTOP), FOLDER);
  assert.equal(blockedSay(sac, 'llama.cpp'), "Windows' Smart App Control blocked ggml-cpu-ivybridge.dll, part of llama.cpp: its maker doesn't sign it, and Smart App Control blocks unsigned files it doesn't know");
  const two = [{ file: 'C:\\s\\ggml-cuda.dll', policy: null }, { file: 'C:\\s\\llama.dll', policy: null }, { file: 'C:\\s\\ggml.dll', policy: null }];
  assert.equal(blockedSay(two, 'llama.cpp'), "Windows blocked ggml-cuda.dll, llama.dll and ggml.dll, part of llama.cpp, because its maker doesn't sign it (Smart App Control, or a policy like it)");
  assert.equal(blockedSay([{ file: 'C:\\s\\geniex.exe', policy: 'Contoso Allow List' }], 'geniex.exe'), "Windows' application control (the policy Contoso Allow List) blocked geniex.exe, part of geniex.exe");
  assert.equal(blockedSay([], 'llama.cpp'), null);
});
