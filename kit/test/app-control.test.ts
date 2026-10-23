import assert from 'node:assert/strict';
import { test } from 'node:test';

// Windows' application control (app-control.ts, kit 2.88.4): the Code Integrity log's blocks, read from its XML as
// wevtutil gives it, never the real log (a test run doesn't ask it).
const { blockedIn, blockedSay, blocksIn, bySmartAppControl, parseBlocks, parseSacState, smartAppControlState } = await import('./fixture/src/kit/app-control.ts');

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

test("Smart App Control's state from reg query (kit 2.93.1): 1 on, 2 evaluation, 0 off; anything else, or no Windows, unknown", () => {
  const reg = (v: string) => `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n    VerifiedAndReputablePolicyState    REG_DWORD    ${v}\r\n\r\n`;
  assert.equal(parseSacState(reg('0x1')), 'on');
  assert.equal(parseSacState(reg('0x2')), 'evaluation');
  assert.equal(parseSacState(reg('0x0')), 'off');
  assert.equal(parseSacState(reg('0x3')), null);
  assert.equal(parseSacState('ERROR: The system was unable to find the specified registry key or value.'), null);
  assert.equal(smartAppControlState(() => reg('0x1'), 'win32'), 'on');
  assert.equal(smartAppControlState(() => null, 'win32'), null, "a Windows without it, or a registry it can't read");
  assert.equal(smartAppControlState(() => reg('0x1'), 'linux'), null);
  assert.equal(bySmartAppControl([{ file: 'a.exe', policy: null }, { file: 'a.exe', policy: 'VerifiedAndReputableDesktop' }]), true);
  assert.equal(bySmartAppControl([{ file: 'a.exe', policy: 'Contoso' }, { file: 'b.exe', policy: null }]), false);
});

test('blockedSay names the files and Smart App Control in plain words; an unnamed policy is said with care, an organization\'s by its name', () => {
  const sac = blocksIn(parseBlocks(DESKTOP), FOLDER);
  assert.equal(blockedSay(sac, 'llama.cpp'), "Windows' Smart App Control blocked ggml-cpu-ivybridge.dll, part of llama.cpp: its maker doesn't sign it, and Smart App Control blocks unsigned files it doesn't know");
  const two = [{ file: 'C:\\s\\ggml-cuda.dll', policy: null }, { file: 'C:\\s\\llama.dll', policy: null }, { file: 'C:\\s\\ggml.dll', policy: null }];
  assert.equal(blockedSay(two, 'llama.cpp'), "Windows blocked ggml-cuda.dll, llama.dll and ggml.dll, part of llama.cpp, because its maker doesn't sign it (Smart App Control, or a policy like it)");
  assert.equal(blockedSay([{ file: 'C:\\s\\geniex.exe', policy: 'Contoso Allow List' }], 'geniex.exe'), "Windows' application control (the policy Contoso Allow List) blocked geniex.exe, part of geniex.exe");
  assert.equal(blockedSay([], 'llama.cpp'), null);
});

test("the processor variant a running llama-server loaded, from tasklist, where the build doesn't say it (kit 2.90.0)", async () => {
  const { cpuVariants, loadedCpuVariant, parseLoadedVariant } = await import('./fixture/src/kit/app-control.ts');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  // As `tasklist /m ggml-cpu-* /fi "PID eq 8124" /fo csv /nh` says it on the gaming desktop, and for a process with none.
  assert.equal(parseLoadedVariant('"llama-server.exe","8124","ggml-cpu-alderlake.dll"\r\n'), 'ggml-cpu-alderlake.dll');
  assert.equal(parseLoadedVariant('INFO: No tasks are running which match the specified criteria.\r\n'), null);
  assert.equal(parseLoadedVariant('"llama-server.exe","8124","N/A"\r\n'), null);
  if (process.platform === 'win32') assert.equal(await loadedCpuVariant(process.pid), null, 'node loads no ggml');
  const dir = mkdtempSync(path.join(tmpdir(), 'cpu-variants-'));
  try {
    assert.equal(cpuVariants(dir), 0);
    for (const f of ['ggml-cpu-alderlake.dll', 'ggml-cpu-haswell.dll', 'ggml-cuda.dll']) writeFileSync(path.join(dir, f), 'x');
    assert.equal(cpuVariants(dir), 2);
    assert.equal(cpuVariants(path.join(dir, 'gone')), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a block by its exit (kit 2.104.0): 0xC0E90002 however Node or Windows gives it, said in hexadecimal; nothing else is one', async () => {
  const { BLOCKED_EXIT, blockedExit, blockedExitSay, exitCodeSay, saysBlockedExit, smartAppControlOutsideTests } = await import('./fixture/src/kit/app-control.ts');
  assert.equal(BLOCKED_EXIT, 3236495362);
  assert.equal(blockedExit(3236495362), true, "Node's exit code for it");
  assert.equal(blockedExit(-1058471934), true, 'a signed 32-bit reading');
  for (const code of [0, 1, 0xc0000005, null, undefined]) assert.equal(blockedExit(code), false, String(code));
  assert.equal(exitCodeSay(3236495362), '0xC0E90002');
  assert.equal(exitCodeSay(-1073741819), '0xC0000005');
  assert.equal(exitCodeSay(1), '1');
  assert.equal(exitCodeSay(null), 'no exit code');
  for (const said of ['flm.exe exited (code 3236495362) while starting', 'exit 0xC0E90002', 'exited -1058471934']) assert.equal(saysBlockedExit(said), true, said);
  for (const said of ['exited (code 32364953620)', 'exit 0xc0e900021', 'exited 1']) assert.equal(saysBlockedExit(said), false, said);
  assert.equal(blockedExitSay('flm.exe', 'on'), "Windows' Smart App Control blocked flm.exe as it started (exit 0xC0E90002): its maker doesn't sign it, and Smart App Control blocks unsigned files it doesn't know");
  for (const sac of ['off', 'evaluation', null] as const) assert.equal(blockedExitSay('flm.exe', sac), "Windows blocked flm.exe as it started (exit 0xC0E90002), because its maker doesn't sign it (Smart App Control, or a policy like it)", String(sac));
  assert.equal(smartAppControlOutsideTests(), null, "a test run never asks this PC's setting");
});

test("the blocks that stop a llama.cpp build (kit 2.104.0): any file but a processor variant; and a block's path as Node gives it", async () => {
  const { localPath, stoppingBlocks } = await import('./fixture/src/kit/app-control.ts');
  const b = (file: string) => ({ file: `${FOLDER}\\${file}`, policy: null });
  assert.deepEqual(stoppingBlocks([b('ggml-cpu-ivybridge.dll'), b('GGML-CPU-haswell.dll')]), [], 'ggml keeps another variant');
  assert.deepEqual(stoppingBlocks([b('ggml-cpu-ivybridge.dll'), b('llama-server.exe'), b('ggml-vulkan.dll'), b('ggml-cpu.dll')]).map((x: any) => x.file.split('\\').pop()), ['llama-server.exe', 'ggml-vulkan.dll', 'ggml-cpu.dll']);
  assert.equal(localPath('\\Device\\HarddiskVolume3\\Users\\Arnold\\.manor\\x.dll', FOLDER), 'C:\\Users\\Arnold\\.manor\\x.dll');
  assert.equal(localPath('\\Device\\HarddiskVolume7\\tools\\x.dll', 'D:\\tools'), 'D:\\tools\\x.dll', "the drive the folder's on");
  assert.equal(localPath('\\??\\C:\\Users\\x.dll', FOLDER), 'C:\\Users\\x.dll');
  assert.equal(localPath('C:/Users/x.dll', FOLDER), 'C:\\Users\\x.dll');
});
