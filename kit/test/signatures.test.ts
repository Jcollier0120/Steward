import assert from 'node:assert/strict';
import { test } from 'node:test';

// Who signed the programs the staff's local models run (signatures.ts, kit 2.108.0): config.json's servers, their
// folders' program files, and the signatures read for them, never this PC's own (a test gives its files and readings).
const { inventoryCount, inventorySay, parseSignatures, peFilesIn, serverPrograms, signatureInventory, signerName, tooWide } = await import('./fixture/src/kit/signatures.ts');

const ENV = { USERPROFILE: 'C:\\Users\\Arnold', LOCALAPPDATA: 'C:\\Users\\Arnold\\AppData\\Local', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
const GENIEX = 'C:\\Users\\Arnold\\AppData\\Local\\GenieX CLI';
const HEXAGON = 'C:\\Users\\Arnold\\.manor\\accelerators\\servers\\llama.cpp\\b11645-hexagon';

// As the X2 Elite's config.json has them (2026-10-23): GenieX for chat and pictures, llama.cpp on the Hexagon for
// embeddings, and the card's own llama-server.
const RAW = {
  accelerators: [
    {
      id: 'npu',
      kind: 'npu',
      chat: { baseUrl: 'http://127.0.0.1:18181', model: 'q', startCommand: ['%LOCALAPPDATA%\\GenieX CLI\\geniex.exe', 'serve'] },
      vision: { model: 'q' },
      embed: { baseUrl: 'http://127.0.0.1:18182', model: 'e', startCommand: ['%USERPROFILE%\\.manor\\accelerators\\servers\\llama.cpp\\b11645-hexagon\\llama-server.exe', '--port', '18182'] },
    },
    { id: 'gpu-adreno', kind: 'gpu', embed: { baseUrl: 'http://127.0.0.1:18191', model: 'e', startCommand: ['%USERPROFILE%\\.manor\\accelerators\\servers\\llama.cpp\\b11734-opencl-adreno-arm64\\llama-server.exe'] } },
    { id: 'cpu', kind: 'cpu', chat: { baseUrl: 'http://127.0.0.1:18200', model: 'q' } },
  ],
};

const sig = (file: string, status = 'NotSigned', signer: string | null = null, type = status === 'Valid' ? 'Authenticode' : 'None') => ({ file, size: 1000, status, type, signer, version: null });

test("config.json's servers: each program its endpoints start, expanded, with the endpoints that start it; an endpoint with no command starts none", () => {
  const p = serverPrograms(RAW, ENV);
  assert.deepEqual(
    p.map((x: any) => [x.program, x.who]),
    [
      [`${GENIEX}\\geniex.exe`, ['npu chat']],
      [`${HEXAGON}\\llama-server.exe`, ['npu embed']],
      ['C:\\Users\\Arnold\\.manor\\accelerators\\servers\\llama.cpp\\b11734-opencl-adreno-arm64\\llama-server.exe', ['gpu-adreno embed']],
    ],
  );
  const twice = { accelerators: [{ id: 'gpu', kind: 'gpu', chat: { startCommand: ['C:\\s\\llama-server.exe'] }, embed: { startCommand: ['c:\\S\\LLAMA-SERVER.EXE'] } }] };
  assert.deepEqual(serverPrograms(twice, ENV).map((x: any) => x.who), [['gpu chat', 'gpu embed']], 'one program, whatever its case, once');
  assert.deepEqual(serverPrograms({}, ENV), []);
  assert.deepEqual(serverPrograms({ accelerators: [null, { id: 'x', chat: { startCommand: [] } }] }, ENV), []);
});

test("a signer's name is its certificate's CN, quoted or not", () => {
  assert.equal(signerName('CN=Jeremy Collier, O=Jeremy Collier, L=Fredericksburg, S=Virginia, C=US'), 'Jeremy Collier');
  assert.equal(signerName('CN="QUALCOMM, INCORPORATED", O=Qualcomm'), 'QUALCOMM, INCORPORATED');
  assert.equal(signerName('O=Someone, CN=Someone Else'), 'Someone Else');
  assert.equal(signerName('O=No Name'), 'O=No Name');
  assert.equal(signerName(''), null);
  assert.equal(signerName(null), null);
});

test("Get-AuthenticodeSignature's JSON: one object or a list, its signer's CN, an unreadable status as UnknownError", () => {
  const one = parseSignatures(JSON.stringify({ file: 'C:\\a.dll', size: 12, status: 'Valid', type: 'Catalog', signer: 'CN=Microsoft Windows, O=Microsoft Corporation', version: '10.0.1 ' }));
  assert.deepEqual(one, [{ file: 'C:\\a.dll', size: 12, status: 'Valid', type: 'Catalog', signer: 'Microsoft Windows', version: '10.0.1' }]);
  const two = parseSignatures(JSON.stringify([{ file: 'C:\\b.exe', size: 3, status: 'NotSigned', type: 'None', signer: '', version: '' }, { file: 'C:\\c.dll', size: 4, status: '', type: '', signer: null, version: null }]));
  assert.deepEqual(two.map((s: any) => [s.status, s.type, s.signer, s.version]), [['NotSigned', 'None', null, null], ['UnknownError', 'None', null, null]]);
  assert.deepEqual(parseSignatures(''), []);
});

test("a server's program files: .exe, .dll, .pyd and .node below its folder, sorted; a folder that can't be read has none", () => {
  const list = () => [`${GENIEX}\\geniex.exe`, `${GENIEX}\\unins001.dat`, `${GENIEX}\\qairt\\geniex_core.dll`, `${GENIEX}\\llama_cpp\\geniex_plugin.dll.stock`, `${GENIEX}\\py\\_ext.pyd`, `${GENIEX}\\n\\addon.node`, `${GENIEX}\\notes.txt`];
  assert.deepEqual(peFilesIn(GENIEX, list), [`${GENIEX}\\geniex.exe`, `${GENIEX}\\n\\addon.node`, `${GENIEX}\\py\\_ext.pyd`, `${GENIEX}\\qairt\\geniex_core.dll`]);
  assert.deepEqual(
    peFilesIn(GENIEX, () => {
      throw new Error('EACCES');
    }),
    [],
  );
});

test("a folder too wide for one server's files: a drive, Windows, Program Files, a profile or AppData as a whole", () => {
  for (const f of ['C:\\', 'D:', 'C:\\Windows', 'c:\\windows\\', 'C:\\Program Files', 'C:\\Users\\Arnold', 'C:\\Users\\Arnold\\AppData\\Local']) assert.equal(tooWide(f, ENV), true, f);
  for (const f of [GENIEX, HEXAGON, 'C:\\Program Files\\FastFlowLM', 'C:\\Windows\\System32']) assert.equal(tooWide(f, ENV), false, f);
});

test('the inventory: each server folder read once, its files signed or not, by whom; one not there says so; a wide folder gives its program alone', async () => {
  const programs = [...serverPrograms(RAW, ENV), { who: ['npu vision'], program: `${GENIEX}\\geniex.exe` }, { who: ['cpu chat'], program: 'C:\\Program Files\\server.exe' }];
  const lists: string[] = [];
  const read = async (files: string[]) => {
    lists.push(...files);
    return files.map((f) =>
      /geniex\.exe$|llama\.dll$|llama-server\.exe$/i.test(f) ? sig(f) : /QnnHtp/.test(f) ? sig(f, 'Valid', 'QUALCOMM INCORPORATED') : /server\.exe$/.test(f) ? sig(f, 'Valid', 'Someone') : sig(f, 'Valid', 'Jeremy Collier', 'Catalog'),
    );
  };
  const inv = await signatureInventory(programs, {
    env: ENV,
    sac: 'on',
    read,
    exists: (p: string) => !/b11734/.test(p),
    list: (dir: string) => (dir === GENIEX ? [`${GENIEX}\\geniex.exe`, `${GENIEX}\\qairt\\htp-files\\QnnHtp.dll`] : dir === HEXAGON ? [`${HEXAGON}\\llama-server.exe`, `${HEXAGON}\\llama.dll`, `${HEXAGON}\\ggml.dll`] : ['C:\\Program Files\\x.dll']),
  });
  assert.equal(inv.smartAppControl, 'on');
  assert.deepEqual(inv.servers.map((s: any) => [s.folder, s.who, s.files.length, s.problem ?? null]), [
    [GENIEX, ['npu chat', 'npu vision'], 2, null],
    [HEXAGON, ['npu embed'], 3, null],
    ['C:\\Users\\Arnold\\.manor\\accelerators\\servers\\llama.cpp\\b11734-opencl-adreno-arm64', ['gpu-adreno embed'], 0, 'C:\\Users\\Arnold\\.manor\\accelerators\\servers\\llama.cpp\\b11734-opencl-adreno-arm64\\llama-server.exe isn\'t there'],
    ['C:\\Program Files', ['cpu chat'], 1, null],
  ]);
  assert.deepEqual(lists.filter((f) => f.startsWith('C:\\Program Files')), ['C:\\Program Files\\server.exe'], "Program Files isn't read whole: only the program");
  assert.deepEqual(inventoryCount(inv), { files: 6, unsigned: 3 });
  const lines = inventorySay(inv);
  assert.match(lines[0], /^Smart App Control: on \(it blocks unsigned files it doesn't know\)$/);
  assert.ok(lines.includes(`${GENIEX} (npu chat, npu vision)`));
  assert.ok(lines.includes('  2 program files: 1 unsigned; signed: 1 QUALCOMM INCORPORATED'));
  assert.ok(lines.includes('  3 program files: 2 unsigned; signed: 1 Jeremy Collier (by catalog)'));
  assert.ok(lines.some((l: string) => /^ {2}NotSigned geniex\.exe {2}1,000 bytes$/.test(l)));
  assert.ok(!lines.some((l: string) => /QnnHtp/.test(l)), 'signed files only with --all');
  assert.ok(inventorySay(inv, { all: true }).some((l: string) => /^ {2}Valid {5}qairt\\htp-files\\QnnHtp\.dll {2}1,000 bytes, QUALCOMM INCORPORATED$/.test(l)));
  assert.deepEqual(inventorySay({ at: '', smartAppControl: null, servers: [] }), ['Smart App Control: unknown', 'No model server is set up (config.json starts none).']);
});

test("signatures that can't be read leave the server's problem, and the rest are read", async () => {
  const inv = await signatureInventory([{ who: ['npu chat'], program: `${GENIEX}\\geniex.exe` }, { who: ['npu embed'], program: `${HEXAGON}\\llama-server.exe` }], {
    env: ENV,
    sac: null,
    exists: () => true,
    list: (dir: string) => [`${dir}\\x.dll`],
    read: async (files: string[]) => {
      if (files[0].startsWith(GENIEX)) throw new Error("couldn't read the files' signatures: PowerShell is gone");
      return files.map((f) => sig(f));
    },
  });
  assert.equal(inv.servers[0].problem, "couldn't read the files' signatures: PowerShell is gone");
  assert.equal(inv.servers[1].files.length, 1);
});
