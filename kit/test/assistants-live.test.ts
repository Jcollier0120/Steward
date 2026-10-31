import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The kit's AI assistants (node/assistants.ts) with the real assistants, as installed on this PC: opt-in
// (STEWARD_LIVE_ASSISTANTS=1), for they run the real CLIs. Both ways round: each assistant's own command adds a server
// and the kit reads it, and the kit adds one and the assistant's own command reads it back (and, where its command
// does, starts it). Each runs in a home or config folder of its own under the temp folder: nothing of yours is read or
// written but the paths assistantsFound looks at, and the last test checks that none of your settings has this run's
// servers. This process's own CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME and GEMINI_CLI_HOME are a decoy folder, so a command run
// in this process's environment by mistake writes there, never to yours. An assistant not installed here is skipped,
// and says so.
const LIVE = process.env.STEWARD_LIVE_ASSISTANTS === '1';
const skip = !LIVE && 'set STEWARD_LIVE_ASSISTANTS=1 to run the real assistants';

const { addServer, assistantsFound, removeServer, serverStatus } = await import('./fixture/src/kit/assistants.ts');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'kit-assistants-live-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const dir = (...parts: string[]) => {
  const d = path.join(tmp, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
};

const MOVED = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'GEMINI_CLI_HOME'];
const base: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !MOVED.includes(k)));
const decoy = dir('decoy');
for (const k of MOVED) process.env[k] = decoy;

/** A tiny MCP server (initialize, tools/list), in a folder with a space in its name; it notes each start in its log. */
const server = path.join(dir('mcp server'), 'tiny.mjs');
writeFileSync(
  server,
  `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = (s) => process.env.TINY_LOG && appendFileSync(process.env.TINY_LOG, s + '\\n');
log('started ' + process.argv.slice(2).join(' '));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tiny', version: '1.0.0' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'hello', description: 'Says hello', inputSchema: { type: 'object', properties: {} } }] } });
  else send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`,
);
const node = process.execPath;
/** This run's server names: in nobody's settings but these temp ones. */
const name = (what: string) => `steward-live-${process.pid}-${what}`;
const NAMES: string[] = [];
const tiny = (what: string, ...args: string[]) => {
  NAMES.push(name(what));
  return { name: name(what), command: node, args: [server, ...args], env: { TINY_LOG: path.join(tmp, `${name(what)}.log`) } };
};
const started = (s: { name: string }) => existsSync(path.join(tmp, `${s.name}.log`)) && /^started/m.test(readFileSync(path.join(tmp, `${s.name}.log`), 'utf8'));

/** Where `cli` is, as PowerShell finds it on PATH; null when it isn't installed. */
function whereIs(cli: string): string | null {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Command ${cli} -ErrorAction SilentlyContinue | Select-Object -First 1).Source`], { encoding: 'utf8', windowsHide: true });
  return r.stdout.trim() || null;
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** A command as a person types it in PowerShell, each word quoted. */
function ps(words: string[], env: NodeJS.ProcessEnv, cwd = tmp): { status: number | null; stdout: string; out: string } {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& ${words.map(q).join(' ')}; exit $LASTEXITCODE`], { encoding: 'utf8', env, cwd, windowsHide: true, timeout: 180_000 });
  return { status: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
}
const notInstalled = (cli: string) => (!LIVE ? skip : process.platform !== 'win32' ? 'these live tests run on Windows' : whereIs(cli) ? false : `${cli} isn't installed here`);

// ---------------------------------------------------------------------------------------------------------------
// Claude Code: claude mcp add and list, with CLAUDE_CONFIG_DIR a folder of its own.

const claudeHome = dir('claude-home');
const claudeConfig = dir('claude-home', 'config');
const claudeEnv = { ...base, CLAUDE_CONFIG_DIR: claudeConfig };
const claudeFrom = tiny('claude-own', 'from claude');

test('Claude Code: claude mcp add writes the server, and the kit reads it connected', { skip: notInstalled('claude'), timeout: 180_000 }, () => {
  const add = ps(['claude', 'mcp', 'add', '--scope', 'user', claudeFrom.name, '-e', `TINY_LOG=${claudeFrom.env.TINY_LOG}`, '--', node, ...claudeFrom.args], claudeEnv);
  assert.equal(add.status, 0, add.out);
  assert.deepEqual(serverStatus('claude-code', claudeFrom.name, { home: claudeHome, env: { CLAUDE_CONFIG_DIR: claudeConfig } }), {
    id: 'claude-code',
    name: claudeFrom.name,
    state: 'connected',
    file: path.join(claudeConfig, '.claude.json'),
    entry: { command: node, args: claudeFrom.args },
  });
});

test("Claude Code: the kit adds through claude, which lists it connected beside claude's own; brought up to date; removed", { skip: notInstalled('claude'), timeout: 300_000 }, async () => {
  const mine = tiny('claude-kit');
  const o = { home: claudeHome, env: claudeEnv };
  const added = await addServer('claude-code', mine, o);
  assert.deepEqual([added.ok, added.changed], [true, true], added.words);
  assert.equal(serverStatus('claude-code', mine.name, o).state, 'connected', 'in the config the kit was given, not this process\'s');
  const list = ps(['claude', 'mcp', 'list'], claudeEnv);
  // Through Windows PowerShell's console, Claude Code's ✓ comes out as √.
  assert.match(list.out, new RegExp(`${mine.name}: .*tiny\\.mjs - [✓√] Connected`), list.out);
  assert.match(list.out, new RegExp(`${claudeFrom.name}: .*tiny\\.mjs from claude - [✓√] Connected`), list.out);
  assert.ok(started(mine), 'claude started it, with the env the kit gave it');
  assert.deepEqual([(await addServer('claude-code', mine, o)).changed], [false], 'the same again: nothing to do');
  const newer = { ...mine, args: [...mine.args, '--newer'] };
  assert.equal((await addServer('claude-code', newer, o)).changed, true);
  assert.match(ps(['claude', 'mcp', 'get', mine.name], claudeEnv).out, /tiny\.mjs --newer/);
  const removed = await removeServer('claude-code', mine.name, o);
  assert.deepEqual([removed.ok, removed.changed], [true, true], removed.words);
  const after = ps(['claude', 'mcp', 'list'], claudeEnv).out;
  assert.doesNotMatch(after, new RegExp(mine.name));
  assert.match(after, new RegExp(`${claudeFrom.name}: .* - [✓√] Connected`), "claude's own is kept");
});

// ---------------------------------------------------------------------------------------------------------------
// Codex CLI: codex mcp add, get and list, with CODEX_HOME a folder of its own (the home's .codex).

const codexHome = dir('codex-home');
const codexDir = dir('codex-home', '.codex');
const codexEnv = { ...base, CODEX_HOME: codexDir };
const codexFrom = tiny('codex-own', 'from codex');
/** codex mcp get's JSON: Codex warns on stderr (it makes no PATH aliases under a temp folder), so stdout's. */
const codexGet = (n: string) => {
  const r = ps(['codex', 'mcp', 'get', n, '--json'], codexEnv);
  assert.equal(r.status, 0, r.out);
  return JSON.parse(r.stdout) as { name: string; enabled: boolean; transport: { command: string; args: string[]; env: Record<string, string> | null } };
};
const codexNames = () => {
  const r = ps(['codex', 'mcp', 'list', '--json'], codexEnv);
  assert.equal(r.status, 0, r.out);
  return (JSON.parse(r.stdout) as { name: string }[]).map((s) => s.name).sort();
};

test('Codex CLI: codex mcp add writes the server (its env a table of its own), and the kit reads it connected, by its home or by CODEX_HOME', { skip: notInstalled('codex'), timeout: 180_000 }, () => {
  const add = ps(['codex', 'mcp', 'add', codexFrom.name, '--env', `TINY_LOG=${codexFrom.env.TINY_LOG}`, '--', node, ...codexFrom.args], codexEnv);
  assert.equal(add.status, 0, add.out);
  assert.match(readFileSync(path.join(codexDir, 'config.toml'), 'utf8'), new RegExp(`\\[mcp_servers\\.${codexFrom.name}\\.env\\]`), 'its env as a table of its own');
  const want = { id: 'codex', name: codexFrom.name, state: 'connected', file: path.join(codexDir, 'config.toml'), entry: { command: node, args: codexFrom.args } };
  assert.deepEqual(serverStatus('codex', codexFrom.name, { home: codexHome }), want);
  // CODEX_HOME, as Codex reads it: wherever it is, with no ~/.codex at all.
  assert.deepEqual(serverStatus('codex', codexFrom.name, { home: dir('codex-elsewhere'), env: { CODEX_HOME: codexDir } }), want);
});

test("Codex CLI: the kit writes, and codex mcp get reads it the same; codex's own kept; the kit's own entry, and codex's, removed whole", { skip: notInstalled('codex'), timeout: 300_000 }, async () => {
  const mine = tiny('codex-kit');
  const o = { home: codexHome };
  const added = await addServer('codex', mine, o);
  assert.deepEqual([added.ok, added.changed], [true, true], added.words);
  const got = codexGet(mine.name);
  assert.deepEqual([got.enabled, got.transport.command, got.transport.args, got.transport.env], [true, node, mine.args, mine.env]);
  assert.deepEqual(codexNames(), [codexFrom.name, mine.name].sort(), "codex's own kept");
  assert.deepEqual(codexGet(codexFrom.name).transport.env, codexFrom.env, "codex's own env table kept");
  const newer = { ...mine, args: [...mine.args, '--newer'] };
  assert.equal((await addServer('codex', newer, o)).changed, true);
  assert.deepEqual(codexGet(mine.name).transport.args, newer.args);
  // Codex's own, with its [mcp_servers.<name>.env] table: the kit takes out the whole of it, and Codex still reads the file.
  const theirs = await removeServer('codex', codexFrom.name, o);
  assert.deepEqual([theirs.ok, theirs.changed], [true, true], theirs.words);
  assert.doesNotMatch(readFileSync(path.join(codexDir, 'config.toml'), 'utf8'), new RegExp(codexFrom.name), 'no table of it left behind');
  assert.deepEqual(codexNames(), [mine.name]);
  assert.deepEqual([(await removeServer('codex', mine.name, o)).changed, codexNames()], [true, []]);
});

// ---------------------------------------------------------------------------------------------------------------
// Gemini CLI: gemini mcp add and list, with GEMINI_CLI_HOME a home of its own; its list starts each server.

const geminiHome = dir('gemini-home');
const geminiEnv = { ...base, GEMINI_CLI_HOME: geminiHome };
const geminiWork = dir('gemini-work');
const geminiFrom = tiny('gemini-own', 'from gemini');
/** gemini mcp list, in a folder it is told to trust: it starts each server and says Connected. */
const geminiList = () => ps(['gemini', 'mcp', 'list'], { ...geminiEnv, GEMINI_CLI_TRUST_WORKSPACE: 'true' }, geminiWork).out;

test('Gemini CLI: gemini mcp add writes the server, and the kit reads it connected, by its home or by GEMINI_CLI_HOME', { skip: notInstalled('gemini'), timeout: 180_000 }, () => {
  const add = ps(['gemini', 'mcp', 'add', '--scope', 'user', '-e', `TINY_LOG=${geminiFrom.env.TINY_LOG}`, geminiFrom.name, node, ...geminiFrom.args], geminiEnv, geminiWork);
  assert.equal(add.status, 0, add.out);
  const want = { id: 'gemini', name: geminiFrom.name, state: 'connected', file: path.join(geminiHome, '.gemini', 'settings.json'), entry: { command: node, args: geminiFrom.args } };
  assert.deepEqual(serverStatus('gemini', geminiFrom.name, { home: geminiHome }), want);
  assert.deepEqual(serverStatus('gemini', geminiFrom.name, { home: dir('gemini-elsewhere'), env: { GEMINI_CLI_HOME: geminiHome } }), want);
});

test("Gemini CLI: the kit writes, and gemini mcp list starts it, Connected, beside gemini's own; removed", { skip: notInstalled('gemini'), timeout: 300_000 }, async () => {
  const mine = tiny('gemini-kit');
  const o = { home: geminiHome };
  const added = await addServer('gemini', mine, o);
  assert.deepEqual([added.ok, added.changed], [true, true], added.words);
  const list = geminiList();
  assert.match(list, new RegExp(`${mine.name}: .*tiny\\.mjs \\(stdio\\) - Connected`), list);
  assert.match(list, new RegExp(`${geminiFrom.name}: .*tiny\\.mjs from gemini \\(stdio\\) - Connected`), list);
  assert.ok(started(mine), 'gemini started it, with the env the kit gave it');
  const removed = await removeServer('gemini', mine.name, o);
  assert.deepEqual([removed.ok, removed.changed], [true, true], removed.words);
  const after = geminiList();
  assert.doesNotMatch(after, new RegExp(mine.name));
  assert.match(after, new RegExp(`${geminiFrom.name}: .* - Connected`), "gemini's own is kept");
});

// ---------------------------------------------------------------------------------------------------------------
// Copilot CLI: copilot mcp add, get and list (--json), with COPILOT_HOME a folder of its own (the home's .copilot). Its
// commands only read and write the file: it starts a server in a session, which needs a GitHub sign-in, never made here.

const copilotHome = dir('copilot-home');
const copilotDir = dir('copilot-home', '.copilot');
const copilotEnv = { ...base, COPILOT_HOME: copilotDir, COPILOT_AUTO_UPDATE: 'false' };
const copilotFrom = tiny('copilot-own', 'from copilot');
type CopilotServer = { type?: string; command: string; args: string[]; env?: Record<string, string>; tools: string[]; source: string; enabled: boolean };
const copilotGet = (n: string) => {
  const r = ps(['copilot', 'mcp', 'get', n, '--json'], copilotEnv);
  assert.equal(r.status, 0, r.out);
  return (JSON.parse(r.stdout) as Record<string, CopilotServer>)[n];
};
/** The servers in its user settings (not its built-in GitHub one). */
const copilotNames = () => {
  const r = ps(['copilot', 'mcp', 'list', '--json'], copilotEnv);
  assert.equal(r.status, 0, r.out);
  return Object.entries((JSON.parse(r.stdout) as { mcpServers: Record<string, CopilotServer> }).mcpServers).filter(([, s]) => s.source === 'user').map(([n]) => n).sort();
};

test('Copilot CLI: copilot mcp add writes the server, and the kit reads it connected, by its home or by COPILOT_HOME', { skip: notInstalled('copilot'), timeout: 180_000 }, async () => {
  const add = ps(['copilot', 'mcp', 'add', copilotFrom.name, '--env', `TINY_LOG=${copilotFrom.env.TINY_LOG}`, '--', node, ...copilotFrom.args], copilotEnv);
  assert.equal(add.status, 0, add.out);
  const want = { id: 'copilot-cli', name: copilotFrom.name, state: 'connected', file: path.join(copilotDir, 'mcp-config.json'), entry: { command: node, args: copilotFrom.args } };
  assert.deepEqual(serverStatus('copilot-cli', copilotFrom.name, { home: copilotHome }), want);
  assert.deepEqual(serverStatus('copilot-cli', copilotFrom.name, { home: dir('copilot-elsewhere'), env: { COPILOT_HOME: copilotDir } }), want);
  // The kit's own entry is the one copilot writes: the same server added through the kit is already there.
  const same = await addServer('copilot-cli', copilotFrom, { home: copilotHome });
  assert.deepEqual([same.ok, same.changed], [true, false], same.words);
});

test("Copilot CLI: the kit writes, and copilot mcp get reads it, enabled with all its tools; copilot's own kept; removed", { skip: notInstalled('copilot'), timeout: 300_000 }, async () => {
  const mine = tiny('copilot-kit');
  const o = { home: copilotHome };
  const added = await addServer('copilot-cli', mine, o);
  assert.deepEqual([added.ok, added.changed], [true, true], added.words);
  const got = copilotGet(mine.name);
  assert.deepEqual([got.type, got.command, got.args, got.env, got.tools, got.source, got.enabled], ['local', node, mine.args, mine.env, ['*'], 'user', true]);
  assert.deepEqual(copilotNames(), [copilotFrom.name, mine.name].sort(), "copilot's own kept");
  assert.deepEqual(copilotGet(copilotFrom.name).env, copilotFrom.env);
  const newer = { ...mine, args: [...mine.args, '--newer'] };
  assert.equal((await addServer('copilot-cli', newer, o)).changed, true);
  assert.deepEqual(copilotGet(mine.name).args, newer.args);
  // copilot's own commands still work on the file the kit wrote: it adds and removes beside the kit's.
  const extra = tiny('copilot-extra');
  assert.equal(ps(['copilot', 'mcp', 'add', extra.name, '--', node, ...extra.args], copilotEnv).status, 0);
  assert.equal(ps(['copilot', 'mcp', 'remove', extra.name], copilotEnv).status, 0);
  assert.deepEqual(serverStatus('copilot-cli', mine.name, o).entry, { command: node, args: newer.args }, "the kit's entry as it left it");
  assert.deepEqual([(await removeServer('copilot-cli', mine.name, o)).changed, copilotNames()], [true, [copilotFrom.name]]);
  assert.deepEqual([(await removeServer('copilot-cli', copilotFrom.name, o)).changed, copilotNames()], [true, []]);
});

// ---------------------------------------------------------------------------------------------------------------
// VS Code: code --add-mcp, with --user-data-dir a profile of its own (the home's AppData\Roaming\Code). VS Code has no
// command that lists its servers; its --add-mcp reads the file to add beside what is there, so that is its reading.

/** A VS Code fork's command line, run as its .cmd runs it (Electron as node, its cli.js), with no shell to quote JSON through. */
function vscodeCli(cmd: string | null): ((args: string[], env: NodeJS.ProcessEnv) => string) | null {
  if (!cmd) return null;
  const text = readFileSync(cmd, 'utf8');
  const exe = /"%~dp0([^"]+\.exe)"/.exec(text)?.[1];
  const cli = /"%~dp0([^"]+cli\.js)"/.exec(text)?.[1];
  if (!exe || !cli) return null;
  const at = path.dirname(cmd);
  return (args, env) => execFileSync(path.resolve(at, exe), [path.resolve(at, cli), ...args], { env: { ...env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }, encoding: 'utf8', timeout: 120_000, windowsHide: true });
}
const codeHome = dir('code-home');
const codeData = dir('code-home', 'AppData', 'Roaming', 'Code');
const codeFile = path.join(codeData, 'User', 'mcp.json');
const codeFrom = tiny('code-own', 'from code');
const addMcp = (s: { name: string; command: string; args: string[]; env: Record<string, string> }) => vscodeCli(whereIs('code.cmd'))!(['--user-data-dir', codeData, '--add-mcp', JSON.stringify(s)], { ...base, USERPROFILE: codeHome, HOME: codeHome });

test('VS Code: code --add-mcp writes the server, and the kit reads it connected', { skip: notInstalled('code.cmd'), timeout: 180_000 }, () => {
  assert.match(addMcp(codeFrom), new RegExp(`Added MCP servers: ${codeFrom.name}`));
  assert.deepEqual(serverStatus('vscode', codeFrom.name, { home: codeHome }), { id: 'vscode', name: codeFrom.name, state: 'connected', file: codeFile, entry: { command: node, args: codeFrom.args } });
});

test("VS Code: the kit writes, and code --add-mcp reads it back, adding its own beside the kit's; the kit removes its own, code's kept", { skip: notInstalled('code.cmd'), timeout: 300_000 }, async () => {
  const mine = tiny('code-kit');
  const o = { home: codeHome };
  const added = await addServer('vscode', mine, o);
  assert.deepEqual([added.ok, added.changed], [true, true], added.words);
  const later = tiny('code-later');
  assert.match(addMcp(later), new RegExp(`Added MCP servers: ${later.name}`));
  const servers = JSON.parse(readFileSync(codeFile, 'utf8')).servers;
  assert.deepEqual(Object.keys(servers), [codeFrom.name, mine.name, later.name]);
  assert.deepEqual(servers[mine.name], { type: 'stdio', command: node, args: mine.args, env: mine.env }, "the kit's entry as the kit wrote it, through VS Code's own write");
  assert.equal(serverStatus('vscode', later.name, o).state, 'connected');
  const removed = await removeServer('vscode', mine.name, o);
  assert.deepEqual([removed.ok, removed.changed], [true, true], removed.words);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(codeFile, 'utf8')).servers), [codeFrom.name, later.name]);
});

// ---------------------------------------------------------------------------------------------------------------
// Cursor: its agent CLI (cursor-agent, from cursor.com/install) lists ~/.cursor/mcp.json's servers, starting each. The
// editor's own --add-mcp writes VS Code's "mcp" key into its settings.json instead, which Cursor's agent doesn't read.

const cursorAgent = () => whereIs('cursor-agent') ?? (existsSync(path.join(process.env.LOCALAPPDATA ?? '', 'cursor-agent', 'cursor-agent.cmd')) ? path.join(process.env.LOCALAPPDATA!, 'cursor-agent', 'cursor-agent.cmd') : null);
const cursorSkip = !LIVE ? skip : process.platform !== 'win32' ? 'these live tests run on Windows' : cursorAgent() ? false : "Cursor's agent CLI (cursor-agent) isn't installed here";

test("Cursor: the kit writes ~/.cursor/mcp.json, and cursor-agent mcp list starts it, ready, beside the person's own; removed", { skip: cursorSkip, timeout: 300_000 }, async () => {
  const home = dir('cursor-home');
  const theirs = tiny('cursor-own', 'theirs');
  mkdirSync(path.join(home, '.cursor'));
  writeFileSync(path.join(home, '.cursor', 'mcp.json'), `${JSON.stringify({ mcpServers: { [theirs.name]: { command: theirs.command, args: theirs.args, env: theirs.env } } }, null, 2)}\n`);
  const env = { ...base, USERPROFILE: home, HOME: home };
  const list = () => ps([cursorAgent()!, 'mcp', 'list'], env, dir('cursor-work')).out;
  const mine = tiny('cursor-kit');
  const added = await addServer('cursor', mine, { home });
  assert.deepEqual([added.ok, added.changed], [true, true], added.words);
  const out = list();
  assert.match(out, new RegExp(`${mine.name}: ready`), out);
  assert.match(out, new RegExp(`${theirs.name}: ready`), out);
  assert.ok(started(mine), 'cursor-agent started it, with the env the kit gave it');
  assert.deepEqual([(await removeServer('cursor', mine.name, { home })).changed], [true]);
  const after = list();
  assert.doesNotMatch(after, new RegExp(mine.name));
  assert.match(after, new RegExp(`${theirs.name}: ready`));
});

// ---------------------------------------------------------------------------------------------------------------
// The apps with no command that reads their servers, started for real (STEWARD_LIVE_APPS=1: their windows open for a
// few seconds): each with a profile and home of its own, first alone (so it writes its own settings, as it does), then
// after the kit added its server beside the person's own. The server's log says the app started it.

const APPS = process.env.STEWARD_LIVE_APPS === '1';
const programs = path.join(process.env.LOCALAPPDATA ?? '', 'Programs');
const appSkip = (exe: string) => (!APPS ? 'set STEWARD_LIVE_APPS=1 to start the real apps (their windows open)' : process.platform !== 'win32' ? 'these live tests run on Windows' : existsSync(exe) ? false : `${exe} isn't installed here`);
const starts = (s: { name: string }) => (existsSync(path.join(tmp, `${s.name}.log`)) ? readFileSync(path.join(tmp, `${s.name}.log`), 'utf8').match(/^started/gm)?.length ?? 0 : 0);

/** Starts an app, until `done` or `seconds` pass (and a few more, for what it starts beside), then ends it and all it started. */
async function launch(exe: string, args: string[], env: NodeJS.ProcessEnv, done: () => boolean, seconds = 90): Promise<void> {
  const app = spawn(exe, args, { env, stdio: 'ignore', windowsHide: false });
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < seconds * 1000 && !done()) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 4000));
  } finally {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true });
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const zedExe = path.join(programs, 'Zed', 'zed.exe');
test("Zed: started with the kit's server beside the person's own, it starts both; the kit's taken out, it starts only theirs", { skip: appSkip(zedExe), timeout: 300_000 }, async () => {
  // Zed's --user-data-dir keeps its settings in <dir>\config; the kit's home has AppData\Roaming\Zed joined to it.
  const data = dir('zed-data');
  const home = dir('zed-home');
  await launch(zedExe, ['--user-data-dir', data, '--foreground', dir('zed-work')], base, () => existsSync(path.join(data, 'config')), 30);
  dir('zed-home', 'AppData', 'Roaming');
  execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', path.join(home, 'AppData', 'Roaming', 'Zed'), path.join(data, 'config')], { windowsHide: true });
  const file = path.join(data, 'config', 'settings.json');
  const theirs = tiny('zed-own', 'theirs');
  // As Zed's Add Custom Server writes it.
  writeFileSync(file, `// Zed settings\n{\n  "context_servers": {\n    "${theirs.name}": { "source": "custom", "command": ${JSON.stringify(node)}, "args": ${JSON.stringify(theirs.args)}, "env": ${JSON.stringify(theirs.env)} }\n  }\n}\n`);
  const mine = tiny('zed-kit');
  const added = await addServer('zed', mine, { home });
  assert.deepEqual([added.ok, added.changed], [true, true], added.words);
  await launch(zedExe, ['--user-data-dir', data, '--foreground', dir('zed-work')], base, () => started(mine) && started(theirs));
  assert.deepEqual([starts(mine), starts(theirs)], [1, 1], 'Zed started both');
  assert.deepEqual([(await removeServer('zed', mine.name, { home })).changed], [true]);
  assert.match(readFileSync(file, 'utf8'), /^\/\/ Zed settings\n/, 'its comment kept');
  await launch(zedExe, ['--user-data-dir', data, '--foreground', dir('zed-work')], base, () => starts(theirs) === 2);
  assert.deepEqual([starts(mine), starts(theirs)], [1, 2], 'Zed started only theirs');
});

/** VS Code with a profile, extensions folder and home of their own, and the extension `id` installed in it. */
function vscodeWith(id: string, at: string) {
  const home = dir(at, 'home');
  const data = dir(at, 'home', 'AppData', 'Roaming', 'Code');
  const extensions = dir(at, 'extensions');
  const env = { ...base, USERPROFILE: home, HOME: home };
  const cli = vscodeCli(path.join(programs, 'Microsoft VS Code', 'bin', 'code.cmd'))!;
  cli(['--user-data-dir', data, '--extensions-dir', extensions, '--install-extension', id], env);
  writeFileSync(path.join(dir(at, 'home', 'AppData', 'Roaming', 'Code', 'User'), 'settings.json'), '{ "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off" }\n');
  const exe = path.join(programs, 'Microsoft VS Code', 'Code.exe');
  const work = dir(at, 'work');
  return { home, run: (done: () => boolean, seconds?: number) => launch(exe, ['--user-data-dir', data, '--extensions-dir', extensions, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window', work], env, done, seconds) };
}
const codeExe = path.join(programs, 'Microsoft VS Code', 'Code.exe');

test("Cline in VS Code: it writes its own settings, the kit adds its server there, and Cline starts it beside the person's own", { skip: appSkip(codeExe), timeout: 600_000 }, async () => {
  const vs = vscodeWith('saoudrizwan.claude-dev', 'cline');
  // Cline 4 keeps them in ~/.cline/data, and makes nothing in VS Code's storage for it.
  const file = path.join(vs.home, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
  await vs.run(() => existsSync(file), 60);
  assert.ok(existsSync(file), 'Cline made its own settings file');
  assert.equal(assistantsFound(vs.home).find((a) => a.id === 'cline')?.file, file, 'the kit finds Cline by it');
  const theirs = tiny('cline-own', 'theirs');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  settings.mcpServers = { ...settings.mcpServers, [theirs.name]: { command: node, args: theirs.args, env: theirs.env, disabled: false, autoApprove: [] } };
  writeFileSync(file, JSON.stringify(settings, null, 2));
  const mine = tiny('cline-kit');
  const added = await addServer('cline', mine, { home: vs.home });
  assert.deepEqual([added.ok, added.changed], [true, true], added.words);
  await vs.run(() => started(mine) && started(theirs));
  assert.deepEqual([started(mine), started(theirs)], [true, true], 'Cline started both');
  assert.deepEqual([(await removeServer('cline', mine.name, { home: vs.home })).changed, serverStatus('cline', theirs.name, { home: vs.home }).state], [true, 'connected']);
});

test("Continue in VS Code: it writes its own config.yaml, the kit adds its server to it, and Continue starts it", { skip: appSkip(codeExe), timeout: 600_000 }, async () => {
  const vs = vscodeWith('Continue.continue', 'continue');
  const file = path.join(vs.home, '.continue', 'config.yaml');
  await vs.run(() => existsSync(file), 60);
  assert.ok(existsSync(file), 'Continue made its own config.yaml');
  const own = readFileSync(file, 'utf8');
  const mine = tiny('continue-kit');
  const added = await addServer('continue', mine, { home: vs.home });
  assert.deepEqual([added.ok, added.changed], [true, true], added.words);
  await vs.run(() => started(mine));
  assert.ok(started(mine), 'Continue started it');
  assert.deepEqual([(await removeServer('continue', mine.name, { home: vs.home })).changed], [true]);
  assert.equal(readFileSync(file, 'utf8').replace(/^mcpServers: \[\]\r?\n/m, ''), own.replace(/^mcpServers: \[\]\r?\n/m, ''), 'the rest of its config.yaml as Continue wrote it');
});

// ---------------------------------------------------------------------------------------------------------------
// This PC's own assistants: found where each keeps its servers, read only.

test("this PC's assistants are found, each with the settings file it reads", { skip: !LIVE && skip, timeout: 60_000 }, () => {
  const found = new Map(assistantsFound(undefined, { env: base }).map((a) => [a.id, a]));
  const home = os.homedir();
  if (whereIs('claude')) assert.equal(found.get('claude-code')?.canWrite, true, 'claude on PATH: the kit adds through it');
  if (existsSync(path.join(home, '.codex'))) assert.equal(found.get('codex')?.file, path.join(home, '.codex', 'config.toml'));
  if (existsSync(path.join(home, '.gemini'))) assert.equal(found.get('gemini')?.file, path.join(home, '.gemini', 'settings.json'));
  // Claude Desktop from the Store keeps its data in %LOCALAPPDATA%\Claude-Data\<package>, its old folders left marked.
  const data = path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Claude-Data', 'Claude_pzs8sxrjxfjjc');
  if (existsSync(path.join(data, 'claude_desktop_config.json'))) assert.equal(found.get('claude-desktop')?.file?.toLowerCase(), path.join(data, 'claude_desktop_config.json').toLowerCase());
});

test('nothing of yours was written: no settings of this PC has this run\'s servers, and the decoy folder is empty', { skip: !LIVE && skip }, () => {
  const files = assistantsFound(undefined, { env: base })
    .map((a) => a.file)
    .filter((f): f is string => !!f && existsSync(f));
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const n of NAMES) assert.ok(!text.includes(n), `${f} has ${n}`);
  }
  assert.deepEqual(readdirSync(decoy), []);
});
