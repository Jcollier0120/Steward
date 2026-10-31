import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Connecting an agent's MCP server to the AI assistants (node/assistants.ts, kit 2.146.0), each in a home of its own
// under the temp folder: nothing here reads or writes this PC's own assistants, and ~/.claude.json is never written.
const { ASSISTANTS, CLAUDE_MSIX, addServer, assistantOfClient, assistantsFound, claudeAddArgs, pasteFor, removeServer, serverProblem, serverStatus } = await import('./fixture/src/kit/assistants.ts');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'kit-assistants-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let homes = 0;
/** A home of its own, with these folders (relative to it) made. */
function homeWith(...folders: string[]): string {
  const home = path.join(tmp, `home-${++homes}`);
  mkdirSync(home, { recursive: true });
  for (const f of folders) mkdirSync(path.join(home, f), { recursive: true });
  return home;
}
/** Every file under a folder, relative to it. */
const filesIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replace(/\\/g, '/')).sort() : []);

const SERVER = { name: 'castellan', command: 'node', args: ['C:\\Castellan\\mcp.js'], env: { CASTELLAN_HOME: 'C:\\Castellan' } };
const NEWER = { ...SERVER, args: ['C:\\Castellan\\mcp.js', '--quiet'] };

interface Case {
  id: string;
  /** Its folder, made to say it's installed (relative to the home, on Windows). */
  folder: string;
  /** Its settings file. */
  file: string;
  /** A settings file the person has: another server, and what else of theirs must stay (`keep`, a comment where its format has them). */
  others: string;
  keep: (string | RegExp)[];
  /** One that doesn't parse. */
  broken: string;
  /** Plain JSON, read back with JSON.parse; and the key its servers are under. */
  json?: string;
}

const R = 'AppData/Roaming';
const CASES: Case[] = [
  {
    id: 'claude-desktop',
    folder: `${R}/Claude`,
    file: `${R}/Claude/claude_desktop_config.json`,
    others: '{\n  "mcpServers": {\n    "other": { "command": "node", "args": ["other.js"] }\n  },\n  "globalShortcut": "Ctrl+Space"\n}\n',
    keep: ['"other": { "command": "node", "args": ["other.js"] }', '"globalShortcut": "Ctrl+Space"'],
    broken: '{\n  "mcpServers": {\n    "other": { "command": "node"\n',
    json: 'mcpServers',
  },
  {
    id: 'cursor',
    folder: '.cursor',
    file: '.cursor/mcp.json',
    others: '{\n    "mcpServers": {\n        "other": {\n            "command": "npx",\n            "args": ["-y", "other"]\n        }\n    }\n}\n',
    keep: ['        "other": {\n            "command": "npx",\n            "args": ["-y", "other"]\n        }'],
    broken: '{ "mcpServers": { "other": { "command": "npx", } } }',
    json: 'mcpServers',
  },
  {
    id: 'vscode',
    folder: `${R}/Code/User`,
    file: `${R}/Code/User/mcp.json`,
    others: '{\n  // The person\'s own servers\n  "servers": {\n    "other": { "type": "stdio", "command": "node", "args": ["other.js"] }, // theirs\n  },\n  "inputs": [],\n}\n',
    keep: ["// The person's own servers", '"other": { "type": "stdio", "command": "node", "args": ["other.js"] }, // theirs', '"inputs": [],'],
    broken: '{\n  // half a file\n  "servers": {\n',
  },
  {
    id: 'windsurf',
    folder: '.codeium/windsurf',
    file: '.codeium/windsurf/mcp_config.json',
    others: '{"mcpServers":{"other":{"command":"uvx","args":["other"]}}}',
    keep: ['"other":{"command":"uvx","args":["other"]}'],
    broken: 'not json at all',
    json: 'mcpServers',
  },
  {
    id: 'gemini',
    folder: '.gemini',
    file: '.gemini/settings.json',
    others: '{\n  /* Gemini CLI */\n  "theme": "Default",\n  "mcpServers": {\n    "other": { "command": "node", "args": ["other.js"] }\n  }\n}\n',
    keep: ['/* Gemini CLI */', '"theme": "Default"', '"other": { "command": "node", "args": ["other.js"] }'],
    broken: '{\n  "theme": "Default"\n  "mcpServers": {}\n}\n',
  },
  {
    id: 'codex',
    folder: '.codex',
    file: '.codex/config.toml',
    others: '# Codex\nmodel = "o4-mini"\n\n[mcp_servers.other]\ncommand = "node"\nargs = ["other.js"] # theirs\n\n[profiles.fast]\nmodel = "o4-mini"\n',
    keep: ['# Codex', 'model = "o4-mini"', '[mcp_servers.other]\ncommand = "node"\nargs = ["other.js"] # theirs', '[profiles.fast]'],
    broken: 'model = "o4-mini\n[mcp_servers.other\n',
  },
  {
    id: 'copilot-cli',
    folder: '.copilot',
    file: '.copilot/mcp-config.json',
    // As `copilot mcp add other -- node other.js` writes it (Copilot CLI 1.0.105).
    others: '{\n  "mcpServers": {\n    "other": {\n      "tools": [\n        "*"\n      ],\n      "type": "local",\n      "command": "node",\n      "args": [\n        "other.js"\n      ]\n    }\n  }\n}\n',
    keep: ['    "other": {\n      "tools": [\n        "*"\n      ],\n      "type": "local",\n      "command": "node",\n      "args": [\n        "other.js"\n      ]\n    }'],
    broken: '{\n  "mcpServers": {\n    "other": { "type": "local", "command": "node" }\n',
    json: 'mcpServers',
  },
  {
    id: 'cline',
    folder: `${R}/Code/User/globalStorage/saoudrizwan.claude-dev`,
    file: `${R}/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`,
    others: '{\n  "mcpServers": {\n    "other": { "command": "node", "args": ["other.js"], "disabled": false, "autoApprove": [] }\n  }\n}\n',
    keep: ['"other": { "command": "node", "args": ["other.js"], "disabled": false, "autoApprove": [] }'],
    broken: '{\n  "mcpServers": [\n',
    json: 'mcpServers',
  },
  {
    id: 'continue',
    folder: '.continue',
    file: '.continue/config.yaml',
    others: '# Continue\nname: Mine\nversion: 1.0.0\nschema: v1\nmodels: []\nmcpServers:\n  - name: other\n    command: node # theirs\n    args:\n      - other.js\nrules:\n  - Be brief\n',
    keep: ['# Continue', 'name: Mine', '  - name: other\n    command: node # theirs\n    args:\n      - other.js', 'rules:\n  - Be brief'],
    broken: 'name: "Mine\nmcpServers:\n',
  },
  {
    id: 'zed',
    folder: `${R}/Zed`,
    file: `${R}/Zed/settings.json`,
    others: '// Zed settings\n{\n  "theme": "One Dark",\n  "context_servers": {\n    "other": { "source": "custom", "command": "node", "args": ["other.js"] } // theirs\n  }\n}\n',
    keep: ['// Zed settings', '"theme": "One Dark"', /"other": \{ "source": "custom", "command": "node", "args": \["other\.js"\] \},? \/\/ theirs\n/],
    broken: '{\n  "theme": "One Dark",\n  "context_servers": { "other": }\n}\n',
  },
];

test('the matrix covers every assistant the kit knows: eleven, by these names', () => {
  assert.deepEqual(ASSISTANTS.map((a) => a.id), ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'windsurf', 'gemini', 'codex', 'copilot-cli', 'cline', 'continue', 'zed']);
  assert.deepEqual([...CASES.map((c) => c.id), 'claude-code'].sort(), ASSISTANTS.map((a) => a.id).sort());
  for (const a of ASSISTANTS) {
    assert.ok(a.name && a.key && ['cli', 'json', 'jsonc', 'toml', 'yaml'].includes(a.format), a.id);
    for (const os of ['win32', 'darwin', 'linux'] as const) assert.ok(a.configPaths[os].length && a.installedPaths[os].length, `${a.id} on ${os}`);
    assert.ok(a.clients.length, `${a.id}: what it calls itself at connect`);
  }
});

test('each assistant by what it calls itself at connect (clientInfo.name), as agents have seen them', () => {
  const of = (client: string) => assistantOfClient(client)?.id ?? null;
  assert.deepEqual(
    ['claude-code', 'claude-ai', 'cursor-vscode', 'Visual Studio Code', 'Visual Studio Code - Insiders', 'windsurf-client', 'gemini-cli-mcp-client', 'mcp-test-client', 'codex-mcp-client', 'copilot-cli', 'Cline', 'continue-client', 'continue-cli-client', 'Zed'].map(of),
    ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'vscode', 'windsurf', 'gemini', 'gemini', 'codex', 'copilot-cli', 'cline', 'continue', 'continue', 'zed'],
  );
  assert.equal(of('notepad'), null);
  assert.equal(of('cline'), null, 'as it says it, case and all');
  const all = ASSISTANTS.flatMap((a) => a.clients);
  assert.equal(new Set(all).size, all.length, 'no name for two assistants');
});

for (const c of CASES) {
  test(`${c.id}: add to a missing file, update its own entry, remove it`, async () => {
    const home = homeWith(c.folder);
    const o = { home, platform: 'win32' as const };
    const file = path.join(home, c.file);
    assert.deepEqual(serverStatus(c.id, 'castellan', o), { id: c.id, name: 'castellan', state: 'installed', file });
    // (Cline is inside VS Code's User folder, so VS Code is found with it.)
    assert.deepEqual(assistantsFound(home, { platform: 'win32' }).filter((a) => a.id === c.id).map((a) => [a.id, a.file, a.canWrite]), [[c.id, file, true]], 'found: installed, with its file, which it may write');
    const added = await addServer(c.id, SERVER, o);
    assert.equal(added.ok, true, added.words);
    assert.equal(added.changed, true);
    assert.equal(added.file, file);
    assert.equal(added.backup, undefined, 'no file before: no backup');
    assert.match(added.words, /has castellan now/);
    assert.deepEqual(serverStatus(c.id, 'castellan', o), { id: c.id, name: 'castellan', state: 'connected', file, entry: { command: 'node', args: ['C:\\Castellan\\mcp.js'] } });
    if (c.json) assert.deepEqual(JSON.parse(readFileSync(file, 'utf8'))[c.json].castellan, { ...(c.id === 'copilot-cli' ? { tools: ['*'], type: 'local' } : {}), command: 'node', args: ['C:\\Castellan\\mcp.js'], env: { CASTELLAN_HOME: 'C:\\Castellan' } });
    if (c.id === 'continue') assert.match(readFileSync(file, 'utf8'), /^name: Local Assistant\nversion: 1\.0\.0\nschema: v1\nmcpServers:\n {2}- name: "castellan"\n/, 'a new config.yaml has what Continue needs at its top');
    if (c.id === 'vscode') assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).servers.castellan.type, 'stdio');
    // The same again: nothing to write.
    const again = await addServer(c.id, SERVER, o);
    assert.deepEqual([again.ok, again.changed], [true, false], again.words);
    assert.match(again.words, /already has castellan, as it is/);
    // Its own entry, brought up to date.
    const written = readFileSync(file, 'utf8');
    const updated = await addServer(c.id, NEWER, o);
    assert.deepEqual([updated.ok, updated.changed], [true, true], updated.words);
    assert.ok(existsSync(`${file}.castellan.bak`), 'backed up before the first write to a file that was there');
    assert.equal(readFileSync(`${file}.castellan.bak`, 'utf8'), written);
    assert.deepEqual(serverStatus(c.id, 'castellan', o).entry, { command: 'node', args: ['C:\\Castellan\\mcp.js', '--quiet'] });
    // Removed, and once more: nothing to remove.
    const removed = await removeServer(c.id, 'castellan', o);
    assert.deepEqual([removed.ok, removed.changed], [true, true], removed.words);
    assert.match(removed.words, /no longer has castellan/);
    assert.equal(serverStatus(c.id, 'castellan', o).state, 'installed');
    if (c.json) assert.deepEqual(JSON.parse(readFileSync(file, 'utf8'))[c.json], {});
    if (c.id === 'continue') assert.match(readFileSync(file, 'utf8'), /^mcpServers: \[\]$/m, 'the last one gone: an empty list');
    const twice = await removeServer(c.id, 'castellan', o);
    assert.deepEqual([twice.ok, twice.changed], [true, false]);
    assert.equal(readFileSync(`${file}.castellan.bak`, 'utf8'), written, 'the backup is the file as it was before the first write, made once');
    assert.deepEqual(filesIn(home).filter((f) => /\.tmp$/.test(f)), [], 'no temp file left');
  });

  test(`${c.id}: add to a file with other servers, which are kept as they were`, async () => {
    const home = homeWith(c.folder);
    const o = { home, platform: 'win32' as const };
    const file = path.join(home, c.file);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, c.others);
    assert.equal(serverStatus(c.id, 'other', o).state, 'connected');
    const added = await addServer(c.id, SERVER, o);
    assert.deepEqual([added.ok, added.changed, added.backup], [true, true, `${file}.castellan.bak`], added.words);
    assert.equal(readFileSync(`${file}.castellan.bak`, 'utf8'), c.others);
    const text = readFileSync(file, 'utf8');
    const has = (t: string, k: string | RegExp) => (typeof k === 'string' ? t.includes(k) : k.test(t));
    for (const k of c.keep) assert.ok(has(text, k), `${c.id} kept ${String(k)} in:\n${text}`);
    assert.equal(serverStatus(c.id, 'castellan', o).state, 'connected');
    assert.equal(serverStatus(c.id, 'other', o).state, 'connected');
    if (c.json) assert.deepEqual(Object.keys(JSON.parse(text)[c.json]), ['other', 'castellan']);
    await addServer(c.id, NEWER, o);
    await removeServer(c.id, 'castellan', o);
    const back = readFileSync(file, 'utf8');
    for (const k of c.keep) assert.ok(has(back, k), `${c.id} still kept ${String(k)} after its own entry came and went:\n${back}`);
    if (c.id === 'zed') assert.equal(back, c.others, 'its entry gone, the file is as it was');
    assert.equal(serverStatus(c.id, 'other', o).state, 'connected');
    assert.equal(serverStatus(c.id, 'castellan', o).state, 'installed');
    // Removing another's server is the same call, for its own name only: never asked for, never done here.
    assert.equal(readFileSync(`${file}.castellan.bak`, 'utf8'), c.others);
  });

  test(`${c.id}: not installed, so nothing is written`, async () => {
    const home = homeWith();
    const o = { home, platform: 'win32' as const };
    assert.deepEqual(serverStatus(c.id, 'castellan', o), { id: c.id, name: 'castellan', state: 'not-installed', file: null });
    const added = await addServer(c.id, SERVER, o);
    assert.deepEqual([added.ok, added.changed], [false, false]);
    assert.match(added.words, /isn't installed on this PC: nothing was written\./);
    const removed = await removeServer(c.id, 'castellan', o);
    assert.deepEqual([removed.ok, removed.changed], [false, false]);
    assert.deepEqual(filesIn(home), []);
    assert.deepEqual(readdirSync(home), [], 'not even a folder');
    assert.deepEqual(assistantsFound(home, { platform: 'win32' }), []);
  });

  test(`${c.id}: a file that doesn't parse is refused in a sentence and left untouched`, async () => {
    const home = homeWith(c.folder);
    const o = { home, platform: 'win32' as const };
    const file = path.join(home, c.file);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, c.broken);
    const status = serverStatus(c.id, 'castellan', o);
    assert.equal(status.state, 'installed');
    assert.match(status.problem ?? '', /don't parse as (JSON|JSON with comments|TOML|YAML) \(.+, line \d+\)|aren't a JSON object|isn't an object of servers/);
    for (const run of [() => addServer(c.id, SERVER, o), () => removeServer(c.id, 'castellan', o)]) {
      const r = await run();
      assert.deepEqual([r.ok, r.changed], [false, false], r.words);
      assert.match(r.words, /so they were left as they are/);
      assert.equal(readFileSync(file, 'utf8'), c.broken);
      assert.ok(!existsSync(`${file}.castellan.bak`), 'no backup: nothing was written');
    }
    assert.match((await addServer(c.id, SERVER, o)).paste ?? '', /castellan/, 'the text to add it by hand');
  });
}

test('a settings file with no servers yet gets its key, and keeps the rest', async () => {
  const cases: [string, string, string, string, RegExp][] = [
    ['gemini', '.gemini', '.gemini/settings.json', '{\n  // mine\n  "theme": "Default"\n}\n', /\/\/ mine\n {2}"theme": "Default",\n {2}"mcpServers": \{\n {4}"castellan": \{/],
    ['zed', `${R}/Zed`, `${R}/Zed/settings.json`, '{\n\t"vim_mode": true,\n}\n', /\t"vim_mode": true,\n\t"context_servers": \{\n\t\t"castellan": \{/],
    ['vscode', `${R}/Code/User`, `${R}/Code/User/mcp.json`, '{}', /"servers": \{/],
    ['cursor', '.cursor', '.cursor/mcp.json', '', /^\{\n {2}"mcpServers": \{\n {4}"castellan": \{/],
    ['codex', '.codex', '.codex/config.toml', 'model = "o4-mini"\n', /^model = "o4-mini"\n\n\[mcp_servers\.castellan\]\ncommand = "node"\nargs = \["C:\\\\Castellan\\\\mcp\.js"\]\nenv = \{ CASTELLAN_HOME = "C:\\\\Castellan" \}\n$/],
    ['continue', '.continue', '.continue/config.yaml', 'name: Mine\nversion: 1.0.0\nschema: v1\nmcpServers: []\n', /^name: Mine\nversion: 1\.0\.0\nschema: v1\nmcpServers:\n {2}- name: "castellan"\n {4}command: "node"\n {4}args:\n {6}- "C:\\\\Castellan\\\\mcp\.js"\n {4}env:\n {6}CASTELLAN_HOME: "C:\\\\Castellan"\n$/],
  ];
  for (const [id, folder, rel, before, after] of cases) {
    const home = homeWith(folder);
    const file = path.join(home, rel);
    writeFileSync(file, before);
    const r = await addServer(id, SERVER, { home, platform: 'win32' });
    assert.deepEqual([r.ok, r.changed], [true, true], `${id}: ${r.words}`);
    assert.match(readFileSync(file, 'utf8'), after, id);
    assert.equal(serverStatus(id, 'castellan', { home, platform: 'win32' }).state, 'connected', id);
  }
});

test("a file's line endings are kept: CRLF stays CRLF", async () => {
  for (const [id, folder, rel, before] of [
    ['gemini', '.gemini', '.gemini/settings.json', '{\r\n  "theme": "Default"\r\n}\r\n'],
    ['codex', '.codex', '.codex/config.toml', 'model = "o4-mini"\r\n'],
    ['continue', '.continue', '.continue/config.yaml', 'name: Mine\r\nmcpServers:\r\n  - name: other\r\n    command: node\r\n'],
  ]) {
    const home = homeWith(folder);
    writeFileSync(path.join(home, rel), before);
    await addServer(id, SERVER, { home, platform: 'win32' });
    const text = readFileSync(path.join(home, rel), 'utf8');
    assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, `${id}: every line ends in CRLF:\n${JSON.stringify(text)}`);
  }
});

test('a server written by hand where only a person should change it is refused, and left', async () => {
  const cases: [string, string, string, string][] = [
    ['codex', '.codex', '.codex/config.toml', '[mcp_servers]\ncastellan = { command = "node" }\n'],
    ['codex', '.codex', '.codex/config.toml', 'mcp_servers.castellan.command = "node"\n'],
    ['continue', '.continue', '.continue/config.yaml', 'mcpServers: [{ name: castellan, command: node }]\n'],
    ['cursor', '.cursor', '.cursor/mcp.json', '{ "mcpServers": [] }'],
    ['cursor', '.cursor', '.cursor/mcp.json', '[]'],
  ];
  for (const [id, folder, rel, text] of cases) {
    const home = homeWith(folder);
    writeFileSync(path.join(home, rel), text);
    const r = await addServer(id, SERVER, { home, platform: 'win32' });
    assert.deepEqual([r.ok, r.changed], [false, false], `${id}: ${text}`);
    assert.match(r.words, /left as they are\. Put them right, or add castellan by hand\./);
    assert.equal(readFileSync(path.join(home, rel), 'utf8'), text);
  }
});

test('an unknown assistant is said, and nothing is done', async () => {
  const home = homeWith('.cursor');
  for (const id of ['notepad', '', 'Cursor', '../cursor']) {
    const s = serverStatus(id, 'castellan', { home });
    assert.equal(s.state, 'not-installed');
    assert.match(s.problem ?? '', /isn't an AI assistant the kit knows: claude-code, claude-desktop, cursor, vscode, windsurf, gemini, codex, copilot-cli, cline, continue, zed\./);
    for (const r of [await addServer(id, SERVER, { home }), await removeServer(id, 'castellan', { home })]) {
      assert.deepEqual([r.ok, r.changed], [false, false]);
      assert.match(r.words, /isn't an AI assistant the kit knows/);
    }
    assert.equal(pasteFor(id, SERVER), '');
  }
  assert.deepEqual(filesIn(home), []);
});

test('no secret goes in an assistant\'s settings, and a server needs a name and a command', async () => {
  const refused: [object, RegExp][] = [
    [{ ...SERVER, env: { GITHUB_TOKEN: 'abc' } }, /env GITHUB_TOKEN looks like a secret/],
    [{ ...SERVER, env: { API_KEY: 'abc' } }, /looks like a secret/],
    [{ ...SERVER, env: { DB_PASSWORD: 'abc' } }, /looks like a secret/],
    [{ ...SERVER, env: { client_secret: 'abc' } }, /looks like a secret/],
    [{ ...SERVER, env: { AWS_ACCESS_KEY_ID: 'abc' } }, /looks like a secret/],
    [{ ...SERVER, env: { CREDENTIALS: 'abc' } }, /looks like a secret/],
    [{ ...SERVER, env: { WHERE: `ghp_${'a'.repeat(36)}` } }, /env WHERE looks like a secret/],
    [{ ...SERVER, env: { WHERE: `glpat-${'a'.repeat(20)}` } }, /looks like a secret/],
    [{ ...SERVER, env: { WHERE: `sk-${'a'.repeat(32)}` } }, /looks like a secret/],
    [{ ...SERVER, env: { WHERE: 'AKIAABCDEFGHIJKLMNOP' } }, /looks like a secret/],
    [{ ...SERVER, args: ['--token=abc'] }, /arguments looks like a secret/],
    [{ ...SERVER, args: ['--api-key=abc'] }, /arguments looks like a secret/],
    [{ ...SERVER, args: [`github_pat_${'a'.repeat(30)}`] }, /arguments looks like a secret/],
    [{ ...SERVER, args: ['eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f'] }, /arguments looks like a secret/],
    [{ ...SERVER, name: 'two words' }, /name should be 1 to 64 letters/],
    [{ ...SERVER, name: '' }, /name should be/],
    [{ ...SERVER, name: '-dash' }, /name should be/],
    [{ ...SERVER, name: 'x'.repeat(65) }, /name should be/],
    [{ ...SERVER, command: ' ' }, /has no command to start it/],
    [{ ...SERVER, args: 'mcp.js' }, /arguments should be a list of words/],
    [{ ...SERVER, env: { N: 7 } }, /env N should be text/],
  ];
  const home = homeWith('.cursor', '.codex');
  for (const [s, said] of refused) {
    assert.match(serverProblem(s as never) ?? '', said, JSON.stringify(s));
    for (const id of ['cursor', 'codex']) {
      const r = await addServer(id, s as never, { home, platform: 'win32' });
      assert.deepEqual([r.ok, r.changed], [false, false], JSON.stringify(s));
      assert.match(r.words, /Nothing was written\.$/);
    }
  }
  assert.deepEqual(filesIn(home), [], 'nothing was written');
  // What only looks like one of those words is fine.
  for (const env of [{ AUTHOR: 'me' }, { PASSAGE: 'x' }, { TOKENIZER: 'bpe' }, { CASTELLAN_HOME: 'C:\\x' }, { WHERE: 'ghp_short' }] as Record<string, string>[]) assert.equal(serverProblem({ ...SERVER, env }), null, JSON.stringify(env));
  assert.equal(serverProblem(SERVER), null);
  assert.match((await removeServer('cursor', 'two words', { home, platform: 'win32' })).words, /name should be/);
});

test('Claude Code: its claude command adds and removes, for every project; ~/.claude.json is only read, never written', async () => {
  const home = homeWith('.claude', 'bin');
  const json = path.join(home, '.claude.json');
  const theirs = `${JSON.stringify({ numStartups: 3, mcpServers: { other: { type: 'stdio', command: 'node', args: ['other.js'] } }, projects: {} }, null, 2)}\n`;
  writeFileSync(json, theirs);
  const claude = path.join(home, 'bin', 'claude.cmd');
  writeFileSync(claude, '@echo off\r\n');
  const calls: [string, string[]][] = [];
  let code = 0;
  const o = { home, platform: 'win32' as const, env: { PATH: path.join(home, 'bin') }, run: async (cmd: string, args: string[]) => (calls.push([cmd, args]), { code, out: '', err: code ? 'Error: MCP server castellan already exists in user config\n' : '' }) };
  assert.deepEqual(assistantsFound(home, { platform: 'win32', env: o.env }).map((a) => [a.id, a.file, a.canWrite]), [['claude-code', json, true]]);
  assert.equal(serverStatus('claude-code', 'other', o).state, 'connected');
  assert.deepEqual(serverStatus('claude-code', 'castellan', o), { id: 'claude-code', name: 'castellan', state: 'installed', file: json });
  // Added: claude mcp add, user scope, its name before -e (which takes every word up to --).
  const added = await addServer('claude-code', SERVER, o);
  assert.deepEqual([added.ok, added.changed], [true, true], added.words);
  assert.match(added.words, /for every project: new sessions see it/);
  assert.deepEqual(calls, [[claude, ['mcp', 'add', '--scope', 'user', 'castellan', '-e', 'CASTELLAN_HOME=C:\\Castellan', '--', 'node', 'C:\\Castellan\\mcp.js']]]);
  assert.equal(readFileSync(json, 'utf8'), theirs, 'never written by the kit');
  // As claude itself would have it: the same is nothing to do; a newer one is removed and added again.
  writeFileSync(json, `${JSON.stringify({ ...JSON.parse(theirs), mcpServers: { ...JSON.parse(theirs).mcpServers, castellan: { type: 'stdio', command: 'node', args: ['C:\\Castellan\\mcp.js'], env: {} } } }, null, 2)}\n`);
  const claudeHas = readFileSync(json, 'utf8');
  calls.length = 0;
  assert.deepEqual([(await addServer('claude-code', SERVER, o)).changed, calls], [false, []]);
  await addServer('claude-code', NEWER, o);
  assert.deepEqual(calls.map((c) => c[1].slice(0, 2).concat(c[1].includes('--quiet') ? ['--quiet'] : [])), [['mcp', 'remove'], ['mcp', 'add', '--quiet']]);
  assert.deepEqual(calls[0][1], ['mcp', 'remove', 'castellan', '--scope', 'user']);
  calls.length = 0;
  assert.deepEqual([(await removeServer('claude-code', 'castellan', o)).changed, calls], [true, [[claude, ['mcp', 'remove', 'castellan', '--scope', 'user']]]]);
  // The command failing: said, with the line to run.
  code = 1;
  const failed = await addServer('claude-code', NEWER, o);
  assert.deepEqual([failed.ok, failed.changed], [false, false]);
  assert.match(failed.words, /claude mcp add didn't work \(Error: MCP server castellan already exists in user config\): run this yourself\./);
  assert.match(failed.paste ?? '', /^claude mcp add --scope user castellan -e /);
  assert.equal(readFileSync(json, 'utf8'), claudeHas, 'never written by the kit');
  // Not connected: nothing to remove, and claude isn't run.
  calls.length = 0;
  writeFileSync(json, theirs);
  assert.deepEqual([(await removeServer('claude-code', 'castellan', o)).changed, calls], [false, []]);
});

test("Claude Code: claude runs in the home and env the kit was given, never this process's own (found live)", { skip: process.platform !== 'win32' && 'a .cmd stands in for claude' }, async () => {
  const home = homeWith('.claude', 'bin');
  const seen = path.join(home, 'seen.txt');
  // A claude that notes where it would write: its CLAUDE_CONFIG_DIR and home, as cmd.exe sees them.
  writeFileSync(path.join(home, 'bin', 'claude.cmd'), `@echo off\r\n>>"${seen}" echo config=%CLAUDE_CONFIG_DIR% home=%USERPROFILE%\r\n`);
  const config = path.join(home, 'config');
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'this-process');
  try {
    const r = await addServer('claude-code', SERVER, { home, platform: 'win32', env: { PATH: path.join(home, 'bin'), CLAUDE_CONFIG_DIR: config } });
    assert.deepEqual([r.ok, r.changed], [true, true], r.words);
    assert.equal(readFileSync(seen, 'utf8').trim(), `config=${config} home=${home}`);
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = was;
  }
  // A test's run is handed the same.
  const envs: unknown[] = [];
  await addServer('claude-code', SERVER, { home, platform: 'win32', env: { PATH: path.join(home, 'bin'), CLAUDE_CONFIG_DIR: config }, run: async (_c, _a, env) => (envs.push(env), { code: 0, out: '', err: '' }) });
  assert.deepEqual(envs, [{ PATH: path.join(home, 'bin'), CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home }]);
});

test('CODEX_HOME, COPILOT_HOME and GEMINI_CLI_HOME move those assistants as their CLIs read them (found live)', async () => {
  const home = homeWith();
  const codex = path.join(homeWith('codex-elsewhere'), 'codex-elsewhere');
  const copilot = path.join(homeWith('copilot-elsewhere'), 'copilot-elsewhere');
  const gemini = homeWith('.gemini');
  const env = { CODEX_HOME: codex, COPILOT_HOME: copilot, GEMINI_CLI_HOME: gemini };
  assert.deepEqual(assistantsFound(home, { platform: 'win32', env }).map((a) => [a.id, a.file]), [
    ['gemini', path.join(gemini, '.gemini', 'settings.json')],
    ['codex', path.join(codex, 'config.toml')],
    ['copilot-cli', path.join(copilot, 'mcp-config.json')],
  ]);
  assert.deepEqual(serverStatus('copilot-cli', 'castellan', { home, platform: 'win32' }).state, 'not-installed', 'without it: the home has none');
  for (const id of ['codex', 'copilot-cli', 'gemini']) {
    const r = await addServer(id, SERVER, { home, platform: 'win32', env });
    assert.deepEqual([r.ok, r.changed], [true, true], r.words);
    assert.equal(serverStatus(id, 'castellan', { home, platform: 'win32', env }).state, 'connected');
  }
  assert.match(readFileSync(path.join(codex, 'config.toml'), 'utf8'), /^\[mcp_servers\.castellan\]$/m);
  assert.equal(JSON.parse(readFileSync(path.join(copilot, 'mcp-config.json'), 'utf8')).mcpServers.castellan.type, 'local');
  assert.ok(JSON.parse(readFileSync(path.join(gemini, '.gemini', 'settings.json'), 'utf8')).mcpServers.castellan);
  assert.deepEqual(filesIn(home), [], 'nothing in the home: each went where its variable says');
  // Without them: the home's own.
  assert.deepEqual(serverStatus('codex', 'castellan', { home, platform: 'win32' }).state, 'not-installed');
});

test("Claude Code without its claude command: the line to paste, and nothing written", async () => {
  const home = homeWith('.claude');
  const o = { home, platform: 'win32' as const };
  assert.deepEqual(assistantsFound(home, { platform: 'win32' }).map((a) => [a.id, a.file, a.canWrite]), [['claude-code', null, false]]);
  const r = await addServer('claude-code', SERVER, o);
  assert.deepEqual([r.ok, r.changed], [false, false]);
  assert.match(r.words, /claude command isn't on this PC's PATH, so add it yourself: run this once in a terminal\./);
  assert.equal(r.paste, "claude mcp add --scope user castellan -e 'CASTELLAN_HOME=C:\\Castellan' -- node 'C:\\Castellan\\mcp.js'");
  assert.equal((await removeServer('claude-code', 'castellan', o)).paste, 'claude mcp remove castellan --scope user');
  assert.ok(!existsSync(path.join(home, '.claude.json')), '~/.claude.json is never made');
  assert.deepEqual(filesIn(home), []);
  // CLAUDE_CONFIG_DIR: its .claude.json there.
  const dir = path.join(homeWith(), 'claude-config');
  mkdirSync(dir);
  writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { castellan: { command: 'node', args: ['x.js'] } } }));
  assert.deepEqual(serverStatus('claude-code', 'castellan', { home, platform: 'win32', env: { CLAUDE_CONFIG_DIR: dir } }), { id: 'claude-code', name: 'castellan', state: 'connected', file: path.join(dir, '.claude.json'), entry: { command: 'node', args: ['x.js'] } });
  assert.deepEqual(serverStatus('claude-code', 'castellan', { home: homeWith(), platform: 'win32' }).state, 'not-installed');
  assert.deepEqual(claudeAddArgs({ name: 'n', command: 'c' }), ['mcp', 'add', '--scope', 'user', 'n', '--', 'c']);
});

test('the text to paste, in each assistant\'s own form', () => {
  const s = { name: 'castellan', command: 'node', args: ['mcp.js'] };
  assert.equal(pasteFor('cursor', s), JSON.stringify({ mcpServers: { castellan: { command: 'node', args: ['mcp.js'] } } }, null, 2));
  assert.equal(pasteFor('vscode', s), JSON.stringify({ servers: { castellan: { type: 'stdio', command: 'node', args: ['mcp.js'] } } }, null, 2));
  assert.equal(pasteFor('zed', s), JSON.stringify({ context_servers: { castellan: { command: 'node', args: ['mcp.js'] } } }, null, 2));
  assert.equal(pasteFor('codex', s), '[mcp_servers.castellan]\ncommand = "node"\nargs = ["mcp.js"]');
  assert.equal(pasteFor('copilot-cli', s), JSON.stringify({ mcpServers: { castellan: { tools: ['*'], type: 'local', command: 'node', args: ['mcp.js'] } } }, null, 2));
  assert.equal(pasteFor('continue', s), 'mcpServers:\n  - name: "castellan"\n    command: "node"\n    args:\n      - "mcp.js"');
  assert.equal(pasteFor('claude-code', s), 'claude mcp add --scope user castellan -- node mcp.js');
});

test('Continue with its older config.json: nothing written, said, and the text to paste', async () => {
  const home = homeWith('.continue');
  writeFileSync(path.join(home, '.continue', 'config.json'), '{ "models": [] }');
  assert.deepEqual(assistantsFound(home, { platform: 'win32' }).map((a) => [a.id, a.canWrite]), [['continue', false]]);
  const r = await addServer('continue', SERVER, { home, platform: 'win32' });
  assert.deepEqual([r.ok, r.changed], [false, false]);
  assert.match(r.words, /Continue keeps its settings in config\.json here, not config\.yaml/);
  assert.match(r.paste ?? '', /^mcpServers:\n {2}- name: "castellan"/);
  assert.deepEqual(filesIn(home), ['.continue/config.json']);
});

test('Claude Desktop from the Store: its package\'s own copy of the settings, else the one in AppData', async () => {
  const pkg = `AppData/Local/Packages/${CLAUDE_MSIX}`;
  const cache = `${pkg}/LocalCache/Roaming/Claude/claude_desktop_config.json`;
  const roaming = `${R}/Claude/claude_desktop_config.json`;
  const at = (home: string) => assistantsFound(home, { platform: 'win32' }).find((a) => a.id === 'claude-desktop')?.file?.slice(home.length + 1).replace(/\\/g, '/');
  // Only the package: its LocalCache, made on the first write.
  const store = homeWith(pkg);
  assert.equal(at(store), cache);
  const r = await addServer('claude-desktop', SERVER, { home: store, platform: 'win32' });
  assert.deepEqual([r.ok, r.changed], [true, true], r.words);
  assert.match(r.words, /Restart Claude Desktop to use it\./);
  assert.deepEqual(filesIn(store), [cache]);
  // Both files: the package's.
  const both = homeWith(pkg, `${R}/Claude`, path.dirname(cache));
  writeFileSync(path.join(both, roaming), '{}');
  writeFileSync(path.join(both, cache), '{}');
  assert.equal(at(both), cache);
  // The package and only AppData's file: AppData's, which is the one it reads then.
  const old = homeWith(pkg, `${R}/Claude`);
  writeFileSync(path.join(old, roaming), '{}');
  assert.equal(at(old), roaming);
  // Installed from its own installer: AppData's.
  assert.equal(at(homeWith(`${R}/Claude`)), roaming);
  // As the Store's keeps it now (found live): its data in Claude-Data, the old folders left with a marker. Only that
  // file is read, there yet or not, even beside an old one.
  const data = `AppData/Local/Claude-Data/${CLAUDE_MSIX}`;
  const moved = homeWith(pkg, data, path.dirname(cache), `${R}/Claude`);
  writeFileSync(path.join(moved, cache), '{}');
  writeFileSync(path.join(moved, roaming), '{}');
  writeFileSync(path.join(moved, path.dirname(cache), `.user-data-left.${CLAUDE_MSIX.toLowerCase()}`), '');
  assert.equal(at(moved), `${data}/claude_desktop_config.json`);
  const first = await addServer('claude-desktop', SERVER, { home: moved, platform: 'win32' });
  assert.deepEqual([first.ok, first.changed, first.backup], [true, true, undefined], first.words);
  assert.equal(serverStatus('claude-desktop', 'castellan', { home: moved, platform: 'win32' }).state, 'connected');
  assert.equal(readFileSync(path.join(moved, cache), 'utf8'), '{}', 'the old copy left as it was');
  assert.deepEqual(JSON.parse(readFileSync(path.join(moved, data, 'claude_desktop_config.json'), 'utf8')).mcpServers.castellan.command, 'node');
  // APPDATA and LOCALAPPDATA when given.
  const env = homeWith('elsewhere/Roaming/Claude');
  assert.equal(assistantsFound(env, { platform: 'win32', env: { APPDATA: path.join(env, 'elsewhere', 'Roaming') } })[0]?.file, path.join(env, 'elsewhere', 'Roaming', 'Claude', 'claude_desktop_config.json'));
});

test("Cline 4: ~/.cline/data's settings once that folder is there, even beside VS Code's old copy (found live)", async () => {
  const legacyFolder = `${R}/Code/User/globalStorage/saoudrizwan.claude-dev`;
  const legacy = `${legacyFolder}/settings/cline_mcp_settings.json`;
  const fresh = '.cline/data/settings/cline_mcp_settings.json';
  const at = (home: string) => assistantsFound(home, { platform: 'win32' }).find((a) => a.id === 'cline')?.file?.slice(home.length + 1).replace(/\\/g, '/');
  // As Cline 4 makes it on its first start, beside the copy an older Cline left.
  const home = homeWith('.cline/data/settings', path.dirname(legacy));
  writeFileSync(path.join(home, fresh), '{\n  "mcpServers": {}\n}');
  const old = '{"mcpServers":{"old":{"command":"node"}}}';
  writeFileSync(path.join(home, legacy), old);
  assert.equal(at(home), fresh);
  const r = await addServer('cline', SERVER, { home, platform: 'win32' });
  assert.deepEqual([r.ok, r.changed], [true, true], r.words);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(home, fresh), 'utf8')).mcpServers), ['castellan']);
  assert.equal(readFileSync(path.join(home, legacy), 'utf8'), old, 'the old copy left as it was');
  assert.equal(serverStatus('cline', 'old', { home, platform: 'win32' }).state, 'installed', "the old copy's servers aren't Cline's now");
  // Its data folder alone, before the file: there.
  assert.equal(at(homeWith('.cline/data')), fresh);
  // A .cline with no data in it (as Cline 4 leaves one while it still reads VS Code's old copy): the old copy.
  assert.equal(at(homeWith('.cline', legacyFolder)), legacy);
});

test('on macOS and Linux: each assistant in its own place', () => {
  const sup = 'Library/Application Support';
  const mac = homeWith(`${sup}/Claude`, `${sup}/Code/User`, '.config/zed', '.cursor', '.codex', '.copilot');
  assert.deepEqual(
    assistantsFound(mac, { platform: 'darwin' }).map((a) => [a.id, a.file!.slice(mac.length + 1).replace(/\\/g, '/')]),
    [['claude-desktop', `${sup}/Claude/claude_desktop_config.json`], ['cursor', '.cursor/mcp.json'], ['vscode', `${sup}/Code/User/mcp.json`], ['codex', '.codex/config.toml'], ['copilot-cli', '.copilot/mcp-config.json'], ['zed', '.config/zed/settings.json']],
  );
  const linux = homeWith('.config/Claude', '.config/Code/User/globalStorage/saoudrizwan.claude-dev', '.config/zed', '.gemini');
  assert.deepEqual(
    assistantsFound(linux, { platform: 'linux' }).map((a) => [a.id, a.file!.slice(linux.length + 1).replace(/\\/g, '/')]),
    [['claude-desktop', '.config/Claude/claude_desktop_config.json'], ['vscode', '.config/Code/User/mcp.json'], ['gemini', '.gemini/settings.json'], ['cline', '.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'], ['zed', '.config/zed/settings.json']],
  );
  // XDG_CONFIG_HOME, where it's set.
  const xdg = homeWith('xdg/zed');
  assert.deepEqual(assistantsFound(xdg, { platform: 'linux', env: { XDG_CONFIG_HOME: path.join(xdg, 'xdg') } }).map((a) => [a.id, a.file]), [['zed', path.join(xdg, 'xdg', 'zed', 'settings.json')]]);
  // Claude Code on PATH, by its own name there. Its folder is given relative to the current one: a Linux PATH can't hold
  // a Windows folder, whose drive's colon it splits at, and this runs on Windows too.
  const bin = homeWith('bin');
  writeFileSync(path.join(bin, 'bin', 'claude'), '#!/bin/sh\n');
  const cwd = process.cwd();
  process.chdir(bin);
  try {
    assert.deepEqual(assistantsFound(bin, { platform: 'linux', env: { PATH: '/nowhere:bin' } }).map((a) => [a.id, a.canWrite]), [['claude-code', true]]);
  } finally {
    process.chdir(cwd);
  }
});

test('every assistant found at once, in their order, and none that aren\'t there', () => {
  const home = homeWith(...CASES.map((c) => c.folder), '.claude');
  assert.deepEqual(assistantsFound(home, { platform: 'win32' }).map((a) => a.id), ASSISTANTS.map((a) => a.id));
  assert.deepEqual(assistantsFound(homeWith('.cursor', '.vscode', 'AppData/Roaming/Code'), { platform: 'win32' }).map((a) => a.id), ['cursor'], "VS Code's own folder without its User folder isn't an install; .vscode is a project's");
});
