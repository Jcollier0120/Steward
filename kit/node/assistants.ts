import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The AI coding assistants an agent that is an MCP server can be connected to (kit 2.146.0): where each keeps its MCP
 * servers, whether it is installed on this PC, whether the agent's server is in it, and adding or removing that one
 * entry. The page's Connect your AI card (react/staff.tsx `ConnectAI`'s `assistants`) shows each one's state and its
 * Connect or Disconnect.
 *
 * The rules, for every assistant:
 * - Only the agent's own entry is added, changed or removed. Each file is edited in place, so everything else in it is
 *   kept as the person had it, its comments too where its format has them (JSON with comments, TOML, YAML).
 * - Nothing is written for an assistant that isn't installed (its folder isn't there).
 * - No secret goes into those files: an env value or argument that looks like a token or password is refused.
 * - The file is backed up (<file>.castellan.bak, once: the file as it was before the manor first wrote it).
 * - A file that doesn't parse is refused with a sentence, and left as it is.
 * - Claude Code's ~/.claude.json is never written: its servers are added with `claude mcp add`, or, without the claude
 *   command, the text to paste is given.
 */

export type AssistantId = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode' | 'windsurf' | 'gemini' | 'codex' | 'cline' | 'continue' | 'zed';

/** How an assistant keeps its servers: through its own command (cli), or in a file of JSON, JSON with comments, TOML or YAML. */
export type AssistantFormat = 'cli' | 'json' | 'jsonc' | 'toml' | 'yaml';

/**
 * Where a path starts: `~` the home folder, `{appData}` (Windows: AppData\Roaming; macOS: ~/Library/Application Support;
 * Linux: ~/.config), `{localAppData}` (Windows: AppData\Local).
 */
export interface AssistantPaths {
  win32: string[];
  darwin: string[];
  linux: string[];
}

export interface Assistant {
  id: AssistantId;
  name: string;
  /**
   * Its MCP settings files, per OS, the first that is there used (or, with none there, the first whose folder is). For
   * Claude Code, its own config, read only.
   */
  configPaths: AssistantPaths;
  format: AssistantFormat;
  /** The key its servers are under: mcpServers, servers, context_servers, mcp_servers. */
  key: string;
  /** The folders that are there when it is installed, per OS. */
  installedPaths: AssistantPaths;
}

/** An MCP server as an agent gives it: its name in the assistant, and the command that starts it. */
export interface McpServer {
  name: string;
  command: string;
  args?: string[];
  /** Environment for it: never a secret (refused). */
  env?: Record<string, string>;
}

/** The Claude desktop app's package, installed from the Microsoft Store or its MSIX installer. */
export const CLAUDE_MSIX = 'Claude_pzs8sxrjxfjjc';

const each = (p: string[]): AssistantPaths => ({ win32: p, darwin: p, linux: p });
const vscodeUser = (rest: string): AssistantPaths => ({ win32: [`{appData}/Code/User/${rest}`], darwin: [`{appData}/Code/User/${rest}`], linux: [`{appData}/Code/User/${rest}`] });

export const ASSISTANTS: readonly Assistant[] = [
  { id: 'claude-code', name: 'Claude Code', configPaths: each(['~/.claude.json']), format: 'cli', key: 'mcpServers', installedPaths: each(['~/.claude', '~/.claude.json']) },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    configPaths: {
      win32: [`{localAppData}/Packages/${CLAUDE_MSIX}/LocalCache/Roaming/Claude/claude_desktop_config.json`, '{appData}/Claude/claude_desktop_config.json'],
      darwin: ['{appData}/Claude/claude_desktop_config.json'],
      linux: ['{appData}/Claude/claude_desktop_config.json'],
    },
    format: 'json',
    key: 'mcpServers',
    installedPaths: { win32: [`{localAppData}/Packages/${CLAUDE_MSIX}`, '{appData}/Claude'], darwin: ['{appData}/Claude'], linux: ['{appData}/Claude'] },
  },
  { id: 'cursor', name: 'Cursor', configPaths: each(['~/.cursor/mcp.json']), format: 'json', key: 'mcpServers', installedPaths: each(['~/.cursor']) },
  { id: 'vscode', name: 'VS Code (Copilot)', configPaths: vscodeUser('mcp.json'), format: 'jsonc', key: 'servers', installedPaths: vscodeUser('') },
  { id: 'windsurf', name: 'Windsurf', configPaths: each(['~/.codeium/windsurf/mcp_config.json']), format: 'json', key: 'mcpServers', installedPaths: each(['~/.codeium/windsurf']) },
  { id: 'gemini', name: 'Gemini CLI', configPaths: each(['~/.gemini/settings.json']), format: 'jsonc', key: 'mcpServers', installedPaths: each(['~/.gemini']) },
  { id: 'codex', name: 'Codex CLI', configPaths: each(['~/.codex/config.toml']), format: 'toml', key: 'mcp_servers', installedPaths: each(['~/.codex']) },
  {
    id: 'cline',
    name: 'Cline',
    configPaths: vscodeUser('globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'),
    format: 'json',
    key: 'mcpServers',
    installedPaths: vscodeUser('globalStorage/saoudrizwan.claude-dev'),
  },
  { id: 'continue', name: 'Continue', configPaths: each(['~/.continue/config.yaml']), format: 'yaml', key: 'mcpServers', installedPaths: each(['~/.continue']) },
  {
    id: 'zed',
    name: 'Zed',
    configPaths: { win32: ['{appData}/Zed/settings.json'], darwin: ['~/.config/zed/settings.json'], linux: ['{appData}/zed/settings.json'] },
    format: 'jsonc',
    key: 'context_servers',
    installedPaths: { win32: ['{appData}/Zed'], darwin: ['~/.config/zed'], linux: ['{appData}/zed'] },
  },
];

/**
 * Where the assistants are looked for. `home` alone (a test's, or another account's) reads nothing of this PC's
 * environment: its AppData under it, and no PATH unless `env` gives one.
 */
export interface AssistantOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Runs a command (the claude command); for tests. */
  run?: (cmd: string, args: string[]) => Promise<{ code: number; out: string; err: string }>;
}

interface Place {
  home: string;
  env: Record<string, string | undefined>;
  platform: 'win32' | 'darwin' | 'linux';
}

function placeOf(o: AssistantOptions = {}): Place {
  const platform = o.platform === 'win32' || o.platform === 'darwin' ? o.platform : o.platform ? 'linux' : process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
  const home = o.home ?? os.homedir();
  const env = o.env ?? (o.home ? {} : process.env);
  return { home, env, platform };
}

/** A path from ASSISTANTS, as a full path here. */
function resolve(p: string, at: Place): string {
  const appData =
    at.platform === 'win32'
      ? (at.env.APPDATA ?? path.join(at.home, 'AppData', 'Roaming'))
      : at.platform === 'darwin'
        ? path.join(at.home, 'Library', 'Application Support')
        : (at.env.XDG_CONFIG_HOME ?? path.join(at.home, '.config'));
  const localAppData = at.env.LOCALAPPDATA ?? path.join(at.home, 'AppData', 'Local');
  const full = p.replace(/^~(?=\/|$)/, at.home).replace('{appData}', appData).replace('{localAppData}', localAppData);
  return path.normalize(full.replace(/\/$/, ''));
}

const there = (p: string) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

/** The claude command on PATH, or null. */
function claudeOnPath(at: Place): string | null {
  const dirs = (at.env.PATH ?? at.env.Path ?? '').split(at.platform === 'win32' ? ';' : ':').filter(Boolean);
  const names = at.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'] : ['claude'];
  for (const d of dirs) for (const n of names) if (there(path.join(d, n))) return path.join(d, n);
  return null;
}

/** Claude Code's own config file, and the folder that says it is installed (CLAUDE_CONFIG_DIR when set). */
function claudeCodeFiles(at: Place): { json: string; dir: string } {
  const dir = at.env.CLAUDE_CONFIG_DIR;
  return dir ? { json: path.join(dir, '.claude.json'), dir } : { json: path.join(at.home, '.claude.json'), dir: path.join(at.home, '.claude') };
}

const assistantOf = (id: string) => ASSISTANTS.find((a) => a.id === id) ?? null;

function installedHere(a: Assistant, at: Place): boolean {
  if (a.id === 'claude-code') {
    const f = claudeCodeFiles(at);
    return !!claudeOnPath(at) || there(f.dir) || there(f.json);
  }
  return a.installedPaths[at.platform].some((p) => there(resolve(p, at)));
}

/**
 * The settings file an assistant's servers go in: the first of its files that is there; else, with none yet, the one
 * that goes with the first of its installed folders that is (Claude Desktop from the Store: its package's own copy).
 */
function fileOf(a: Assistant, at: Place): string | null {
  if (a.id === 'claude-code') return claudeCodeFiles(at).json;
  const files = a.configPaths[at.platform].map((p) => resolve(p, at));
  const installed = a.installedPaths[at.platform];
  return files.find(there) ?? files.find((_, i) => there(resolve(installed[Math.min(i, installed.length - 1)], at))) ?? null;
}

/** An assistant found on this PC, with the file its servers are in (null for Claude Code without its config yet). */
export interface AssistantFound extends Assistant {
  file: string | null;
  /** Whether the agent can add its server itself: a file it may write, or Claude Code's claude command. */
  canWrite: boolean;
}

/** The assistants installed on this PC (or under `home`), in ASSISTANTS' order. */
export function assistantsFound(home?: string, o: Omit<AssistantOptions, 'home'> = {}): AssistantFound[] {
  const at = placeOf({ ...o, home });
  return ASSISTANTS.filter((a) => installedHere(a, at)).map((a) => {
    const file = a.id === 'claude-code' ? (there(claudeCodeFiles(at).json) ? claudeCodeFiles(at).json : null) : fileOf(a, at);
    const continueOld = a.id === 'continue' && !!file && !there(file) && there(path.join(path.dirname(file), 'config.json'));
    return { ...a, file, canWrite: a.id === 'claude-code' ? !!claudeOnPath(at) : !!file && !continueOld };
  });
}

export type ServerState = 'not-installed' | 'installed' | 'connected';

export interface ServerStatus {
  id: string;
  name: string;
  state: ServerState;
  /** The file its servers are in, where there is one. */
  file: string | null;
  /** The agent's entry as the file has it: its command and arguments. */
  entry?: { command: string; args: string[] };
  /** Why its file couldn't be read, in a sentence: then state is installed, and nothing will be written. */
  problem?: string;
}

/** Whether `name` is in assistant `id`'s servers: not installed, installed (not connected), or connected. Reads only. */
export function serverStatus(id: string, name: string, o: AssistantOptions = {}): ServerStatus {
  const a = assistantOf(id);
  const at = placeOf(o);
  if (!a) return { id, name, state: 'not-installed', file: null, problem: `${id} isn't an AI assistant the kit knows: ${ASSISTANTS.map((x) => x.id).join(', ')}.` };
  if (!installedHere(a, at)) return { id, name, state: 'not-installed', file: null };
  const file = fileOf(a, at);
  if (!file || !there(file)) return { id, name, state: 'installed', file };
  const read = readEntries(a, file);
  if ('problem' in read) return { id, name, state: 'installed', file, problem: read.problem };
  const entry = read.entries.get(name);
  return entry ? { id, name, state: 'connected', file, entry } : { id, name, state: 'installed', file };
}

/** What adding or removing did. */
export interface AssistantChange {
  ok: boolean;
  /** Whether a file was written, or the claude command run. */
  changed: boolean;
  /** What happened, in a sentence, for the page. */
  words: string;
  file?: string;
  /** The backup made before this first write. */
  backup?: string;
  /** Text for the person to paste where the agent can't write (Claude Code without its claude command). */
  paste?: string;
}

/** An env name or value, or an argument, that looks like a secret. */
const SECRET_NAME = /(^|[_-])(auth|token|secret|passw(or)?d|pwd|pass|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?)([_-]|$)/i;
const SECRET_VALUE = /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})$/;

/** Why a server can't be written: a secret in it, or a name or command it can't have. Null when it's fine. Pure. */
export function serverProblem(s: McpServer): string | null {
  if (!s || typeof s.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(s.name)) return "The server's name should be 1 to 64 letters, digits, dots, dashes or underscores.";
  if (typeof s.command !== 'string' || !s.command.trim()) return `${s.name} has no command to start it.`;
  if (s.args && (!Array.isArray(s.args) || !s.args.every((x) => typeof x === 'string'))) return `${s.name}'s arguments should be a list of words.`;
  for (const [k, v] of Object.entries(s.env ?? {})) {
    if (typeof v !== 'string') return `${s.name}'s env ${k} should be text.`;
    if (SECRET_NAME.test(k) || SECRET_VALUE.test(v.trim())) return `${s.name}'s env ${k} looks like a secret, and secrets never go in an AI assistant's settings: let the server read it from where it's kept.`;
  }
  for (const a of s.args ?? []) if (SECRET_VALUE.test(a.trim()) || /^--?(token|password|api-?key|secret)=/i.test(a)) return `One of ${s.name}'s arguments looks like a secret, and secrets never go in an AI assistant's settings.`;
  return null;
}

/** The entry an assistant keeps for a server, in its own words. */
function entryFor(a: Assistant, s: McpServer): Record<string, unknown> {
  const args = s.args ?? [];
  const env = s.env && Object.keys(s.env).length ? s.env : undefined;
  if (a.id === 'vscode') return { type: 'stdio', command: s.command, args, ...(env ? { env } : {}) };
  if (a.id === 'continue') return { name: s.name, command: s.command, args, ...(env ? { env } : {}) };
  return { command: s.command, args, ...(env ? { env } : {}) };
}

const psQuote = (s: string) => (/^[A-Za-z0-9_\-.:\\/=@]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);

/** The `claude mcp add` arguments for a server, for every project (user scope). */
export const claudeAddArgs = (s: McpServer): string[] => ['mcp', 'add', '--scope', 'user', ...Object.entries(s.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]), s.name, '--', s.command, ...(s.args ?? [])];

/** The text to paste to add a server to an assistant by hand: a command for Claude Code, else its settings' part. Pure. */
export function pasteFor(id: string, s: McpServer): string {
  const a = assistantOf(id);
  if (!a) return '';
  if (a.format === 'cli') return `claude ${claudeAddArgs(s).map(psQuote).join(' ')}`;
  const entry = entryFor(a, s);
  if (a.format === 'toml') return tomlBlock(s.name, entry);
  if (a.format === 'yaml') return `mcpServers:\n${yamlItem(entry, '  ')}`;
  return JSON.stringify({ [a.key]: { [s.name]: entry } }, null, 2);
}

/** Adds the agent's server to assistant `id`, or brings its entry up to date; nothing else in its settings changes. */
export async function addServer(id: string, server: McpServer, o: AssistantOptions = {}): Promise<AssistantChange> {
  return change(id, server.name, server, o);
}

/** Removes the agent's server `name` from assistant `id`; nothing else in its settings changes. */
export async function removeServer(id: string, name: string, o: AssistantOptions = {}): Promise<AssistantChange> {
  return change(id, name, null, o);
}

async function change(id: string, name: string, server: McpServer | null, o: AssistantOptions): Promise<AssistantChange> {
  const a = assistantOf(id);
  if (!a) return { ok: false, changed: false, words: `${id} isn't an AI assistant the kit knows: ${ASSISTANTS.map((x) => x.id).join(', ')}.` };
  const at = placeOf(o);
  if (!installedHere(a, at)) return { ok: false, changed: false, words: `${a.name} isn't installed on this PC: nothing was written.` };
  const problem = server ? serverProblem(server) : !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) ? "The server's name should be 1 to 64 letters, digits, dots, dashes or underscores." : null;
  if (problem) return { ok: false, changed: false, words: `${problem} Nothing was written.` };
  if (a.id === 'claude-code') return claudeCode(a, at, name, server, o);
  const file = fileOf(a, at);
  if (!file) return { ok: false, changed: false, words: `${a.name}'s settings folder wasn't found: nothing was written.`, ...(server ? { paste: pasteFor(id, server) } : {}) };
  if (a.id === 'continue' && !there(file) && there(path.join(path.dirname(file), 'config.json'))) {
    return { ok: false, changed: false, file, words: `Continue keeps its settings in config.json here, not config.yaml: add the server there by hand, or move Continue to config.yaml first.`, ...(server ? { paste: pasteFor(id, server) } : {}) };
  }
  const existed = there(file);
  let before = '';
  if (existed) {
    try {
      before = readFileSync(file, 'utf8');
    } catch (e) {
      return { ok: false, changed: false, file, words: `${a.name}'s settings (${file}) couldn't be read: ${(e as Error).message}. Nothing was written.` };
    }
  }
  if (!server && !existed) return { ok: true, changed: false, file, words: `${a.name} doesn't have ${name}: nothing to remove.` };
  let after: string | null;
  try {
    after = edited(a, before, name, server ? entryFor(a, server) : null);
  } catch (e) {
    return { ok: false, changed: false, file, words: `${a.name}'s settings (${file}) ${(e as Error).message}, so they were left as they are. Put them right, or add ${name} by hand.`, ...(server ? { paste: pasteFor(id, server) } : {}) };
  }
  if (after === null || after === before) return { ok: true, changed: false, file, words: server ? `${a.name} already has ${name}, as it is.` : `${a.name} doesn't have ${name}: nothing to remove.` };
  const backup = `${file}.castellan.bak`;
  let made: string | undefined;
  try {
    if (existed && !there(backup)) {
      copyFileSync(file, backup);
      made = backup;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.castellan-${process.pid}.tmp`;
    writeFileSync(tmp, after);
    renameSync(tmp, file);
  } catch (e) {
    return { ok: false, changed: false, file, words: `${a.name}'s settings (${file}) couldn't be written: ${(e as Error).message}.` };
  }
  const restart = a.id === 'claude-desktop' || a.id === 'zed' ? ` Restart ${a.name} to use it.` : '';
  return { ok: true, changed: true, file, ...(made ? { backup: made } : {}), words: server ? `${a.name} has ${name} now.${restart}` : `${a.name} no longer has ${name}.` };
}

const cmdQuote = (s: string) => (/^[A-Za-z0-9_\-.:\\/=@]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

/** Runs a command, quietly: a .cmd or .bat through cmd.exe, as Windows needs. */
function runQuiet(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const viaCmd = /\.(cmd|bat)$/i.test(cmd);
  const file = viaCmd ? (process.env.ComSpec ?? 'cmd.exe') : cmd;
  const argv = viaCmd ? ['/d', '/s', '/c', `"${[cmd, ...args].map(cmdQuote).join(' ')}"`] : args;
  return new Promise((done) => {
    execFile(file, argv, { windowsHide: true, timeout: 60_000, windowsVerbatimArguments: viaCmd, encoding: 'utf8' }, (e, out, err) => done({ code: e ? (typeof (e as { code?: unknown }).code === 'number' ? ((e as { code: number }).code) : 1) : 0, out: String(out ?? ''), err: String(err ?? (e ? e.message : '')) }));
  });
}

/** Claude Code: its claude command adds and removes, for every project; its ~/.claude.json is only read. */
async function claudeCode(a: Assistant, at: Place, name: string, server: McpServer | null, o: AssistantOptions): Promise<AssistantChange> {
  const claude = claudeOnPath(at);
  const status = serverStatus(a.id, name, o);
  const paste = server ? pasteFor(a.id, server) : `claude mcp remove ${psQuote(name)} --scope user`;
  if (!claude && !o.run) return { ok: false, changed: false, words: `Claude Code's claude command isn't on this PC's PATH, so ${server ? 'add' : 'remove'} it yourself: run this once in a terminal.`, paste };
  const run = o.run ?? runQuiet;
  const cmd = claude ?? 'claude';
  if (server) {
    const want = [server.command, ...(server.args ?? [])].join(' ');
    if (status.state === 'connected' && status.entry && [status.entry.command, ...status.entry.args].join(' ') === want) return { ok: true, changed: false, words: `Claude Code already has ${name}, as it is.` };
    if (status.state === 'connected') await run(cmd, ['mcp', 'remove', name, '--scope', 'user']);
    const r = await run(cmd, claudeAddArgs(server));
    return r.code === 0 ? { ok: true, changed: true, words: `Claude Code has ${name} now, for every project: new sessions see it.` } : { ok: false, changed: false, words: `claude mcp add didn't work (${(r.err || r.out).trim().split(/\r?\n/).pop() || `exit ${r.code}`}): run this yourself.`, paste };
  }
  if (status.state !== 'connected') return { ok: true, changed: false, words: `Claude Code doesn't have ${name}: nothing to remove.` };
  const r = await run(cmd, ['mcp', 'remove', name, '--scope', 'user']);
  return r.code === 0 ? { ok: true, changed: true, words: `Claude Code no longer has ${name}.` } : { ok: false, changed: false, words: `claude mcp remove didn't work (${(r.err || r.out).trim().split(/\r?\n/).pop() || `exit ${r.code}`}): run this yourself.`, paste };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading each format's servers.

/** The servers a settings file has, by name, with their command and arguments; or why it can't be read. */
function readEntries(a: Assistant, file: string): { entries: Map<string, { command: string; args: string[] }> } | { problem: string } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { problem: `${a.name}'s settings (${file}) couldn't be read: ${(e as Error).message}.` };
  }
  const entries = new Map<string, { command: string; args: string[] }>();
  const put = (n: string, v: unknown) => {
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    const command = typeof o.command === 'string' ? o.command : o.command && typeof o.command === 'object' && typeof (o.command as { path?: unknown }).path === 'string' ? String((o.command as { path: string }).path) : '';
    const args = Array.isArray(o.args) ? o.args.filter((x): x is string => typeof x === 'string') : [];
    entries.set(n, { command, args });
  };
  try {
    if (a.format === 'toml') {
      tomlCheck(text);
      for (const b of tomlBlocks(text)) put(b.name, { command: b.command, args: b.args });
    } else if (a.format === 'yaml') {
      for (const item of yamlItems(text)) put(item.name, { command: item.command, args: item.args });
    } else {
      const value = jsonValue(text, a.format === 'json' || a.id === 'claude-code');
      const servers = value && typeof value === 'object' ? (value as Record<string, unknown>)[a.key] : undefined;
      if (servers && typeof servers === 'object' && !Array.isArray(servers)) for (const [n, v] of Object.entries(servers)) put(n, v);
    }
  } catch (e) {
    return { problem: `${a.name}'s settings (${file}) ${(e as Error).message}.` };
  }
  return { entries };
}

/** The settings with `name`'s entry set (entry) or gone (null); null when there's nothing to change. Throws, in words, for a file it can't read. */
function edited(a: Assistant, text: string, name: string, entry: Record<string, unknown> | null): string | null {
  if (a.format === 'toml') return tomlEdit(text, name, entry);
  if (a.format === 'yaml') return yamlEdit(text, name, entry);
  return jsonEdit(text, a.key, name, entry, a.format === 'json');
}

// ---------------------------------------------------------------------------------------------------------------
// JSON, with or without comments, edited in place.

interface JNode {
  kind: 'object' | 'array' | 'value';
  start: number;
  end: number;
  members: { key: string; start: number; end: number; value: JNode }[];
}

const lineAt = (text: string, i: number) => text.slice(0, i).split('\n').length;

/** A JSON (with comments and trailing commas, unless `strict`) text's tree, with where each part is. Throws, in words. */
function jsonTree(text: string, strict: boolean): JNode {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (what: string): never => {
    throw new Error(`don't parse as JSON${strict ? '' : ' with comments'} (${what}, line ${lineAt(text, i)})`);
  };
  const ws = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) {
        if (strict) fail('a comment');
        while (i < text.length && text[i] !== '\n') i++;
      } else if (text.startsWith('/*', i)) {
        if (strict) fail('a comment');
        const e = text.indexOf('*/', i + 2);
        if (e < 0) fail('a comment never closed');
        i = e + 2;
      } else return;
    }
  };
  const str = (): string => {
    const s = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if (text[i] === '\n') fail('a string broken across lines');
      i++;
    }
    if (i >= text.length) fail('a string never closed');
    i++;
    try {
      return JSON.parse(text.slice(s, i));
    } catch {
      return fail('a string it can\'t read');
    }
  };
  const value = (): JNode => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      const members: JNode['members'] = [];
      for (;;) {
        ws();
        if (text[i] === '}') break;
        if (text[i] !== '"') fail('a name expected');
        const ks = i;
        const key = str();
        ws();
        if (text[i] !== ':') fail('":" expected');
        i++;
        const v = value();
        members.push({ key, start: ks, end: v.end, value: v });
        ws();
        if (text[i] === ',') {
          i++;
          ws();
          if (text[i] === '}' && strict) fail('a comma before "}"');
          continue;
        }
        if (text[i] !== '}') fail('"," or "}" expected');
      }
      i++;
      return { kind: 'object', start, end: i, members };
    }
    if (c === '[') {
      i++;
      for (;;) {
        ws();
        if (text[i] === ']') break;
        value();
        ws();
        if (text[i] === ',') {
          i++;
          ws();
          if (text[i] === ']' && strict) fail('a comma before "]"');
          continue;
        }
        if (text[i] !== ']') fail('"," or "]" expected');
      }
      i++;
      return { kind: 'array', start, end: i, members: [] };
    }
    if (c === '"') {
      str();
      return { kind: 'value', start, end: i, members: [] };
    }
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
    if (!m) fail(i >= text.length ? 'it ends too soon' : 'a value expected');
    i += m![0].length;
    return { kind: 'value', start, end: i, members: [] };
  };
  const root = value();
  ws();
  if (i < text.length) fail('more after its end');
  return root;
}

/** A JSON text's value (comments and trailing commas taken out, unless `strict`); {} for an empty file. Throws, in words. */
function jsonValue(text: string, strict: boolean): unknown {
  if (!text.trim()) return {};
  const root = jsonTree(text, strict);
  if (root.kind !== 'object') throw new Error("aren't a JSON object");
  if (strict) return JSON.parse(text.replace(/^\uFEFF/, ''));
  return JSON.parse(stripJsonc(text));
}

/** A JSON-with-comments text as plain JSON: its comments blanked and its trailing commas dropped. */
function stripJsonc(text: string): string {
  let out = '';
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const s = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(s, ++i);
    } else if (text.startsWith('//', i)) {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (text.startsWith('/*', i)) {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? text.length : e + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** The indent a JSON text uses (its first indented line's), two spaces when it says none. */
function indentOf(text: string): string {
  const m = /\n([ \t]+)["}\]]/.exec(text);
  if (!m) return '  ';
  return m[1].startsWith('\t') ? '\t' : m[1].length >= 2 && m[1].length <= 8 ? m[1].slice(0, Math.min(m[1].length, 4)) : '  ';
}

/** After `from`, past spaces and comments, on the same text. */
function skipSpace(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith('//', i)) while (i < text.length && text[i] !== '\n') i++;
    else if (text.startsWith('/*', i)) i = text.indexOf('*/', i + 2) < 0 ? text.length : text.indexOf('*/', i + 2) + 2;
    else return i;
  }
}

function jsonEdit(text: string, key: string, name: string, entry: Record<string, unknown> | null, strict: boolean): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const unit = indentOf(text);
  const pad = (depth: number) => unit.repeat(depth);
  const shown = (v: unknown, depth: number) => JSON.stringify(v, null, unit).split('\n').join(`${eol}${pad(depth)}`);
  if (!text.trim()) {
    if (!entry) return null;
    return `${JSON.stringify({ [key]: { [name]: entry } }, null, unit).split('\n').join(eol)}${eol}`;
  }
  const root = jsonTree(text, strict);
  if (root.kind !== 'object') throw new Error("aren't a JSON object");
  const top = root.members.find((m) => m.key === key);
  if (top && top.value.kind !== 'object') throw new Error(`have a "${key}" that isn't an object of servers`);
  const insert = (obj: JNode, member: string, depth: number) => {
    const close = obj.end - 1;
    if (!obj.members.length) {
      const inner = text.slice(obj.start + 1, close);
      return inner.trim() ? `${text.slice(0, obj.start + 1)}${eol}${pad(depth)}${member}${inner}${text.slice(close)}` : `${text.slice(0, obj.start + 1)}${eol}${pad(depth)}${member}${eol}${pad(depth - 1)}${text.slice(close)}`;
    }
    const last = obj.members[obj.members.length - 1];
    const next = skipSpace(text, last.end);
    if (text[next] === ',') return `${text.slice(0, next + 1)}${eol}${pad(depth)}${member},${text.slice(next + 1)}`;
    return `${text.slice(0, last.end)},${eol}${pad(depth)}${member}${text.slice(last.end)}`;
  };
  let out: string;
  if (!top) {
    if (!entry) return null;
    out = insert(root, `${JSON.stringify(key)}: ${shown({ [name]: entry }, 1)}`, 1);
  } else {
    const mine = top.value.members.find((m) => m.key === name);
    if (entry) {
      if (mine) {
        const now = shown(entry, 2);
        if (JSON.stringify(JSON.parse(stripJsonc(text.slice(mine.value.start, mine.value.end)))) === JSON.stringify(entry)) return null;
        out = `${text.slice(0, mine.value.start)}${now}${text.slice(mine.value.end)}`;
      } else out = insert(top.value, `${JSON.stringify(name)}: ${shown(entry, 2)}`, 2);
    } else {
      if (!mine) return null;
      out = removeMember(text, top.value, mine);
    }
  }
  // Read back before it's written: an edit that broke the file is never written.
  jsonValue(out, strict);
  return out;
}

/** The text without one member of an object, its comma and its line where it had one to itself. */
function removeMember(text: string, obj: JNode, m: JNode['members'][number]): string {
  const at = obj.members.indexOf(m);
  const lineStart = text.lastIndexOf('\n', m.start - 1) + 1;
  const start = /^[ \t]*$/.test(text.slice(lineStart, m.start)) ? lineStart : m.start;
  let end = m.end;
  let j = end;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
  const comma = text[j] === ',';
  if (comma) end = j + 1;
  let k = end;
  while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
  if (start === lineStart && (text.startsWith('\r\n', k) || text[k] === '\n')) end = k + (text[k] === '\r' ? 2 : 1);
  let out = `${text.slice(0, start)}${text.slice(end)}`;
  if (!comma && at > 0) {
    // The last one: the comma after the one before it goes too.
    const prev = obj.members[at - 1];
    const c = skipSpace(text, prev.end);
    if (text[c] === ',' && c < start) out = `${out.slice(0, c)}${out.slice(c + 1)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// TOML (Codex's config.toml): checked line by line, and the agent's [mcp_servers.<name>] table set or taken out.

const TOML_KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const TOML_DOTTED = String.raw`${TOML_KEY}(?:\s*\.\s*${TOML_KEY})*`;
const TOML_HEADER = new RegExp(String.raw`^\[(\[)?\s*(${TOML_DOTTED})\s*\](\])?\s*(?:#.*)?$`);
const TOML_PAIR = new RegExp(String.raw`^(${TOML_DOTTED})\s*=\s*(.*)$`);

/** A dotted TOML key's parts, unquoted. */
function tomlParts(key: string): string[] {
  const parts: string[] = [];
  const re = new RegExp(String.raw`\s*(${TOML_KEY})\s*(?:\.|$)`, 'y');
  let m: RegExpExecArray | null;
  while ((m = re.exec(key)) && m[0]) {
    const k = m[1];
    parts.push(k.startsWith('"') ? JSON.parse(k) : k.startsWith("'") ? k.slice(1, -1) : k);
    if (re.lastIndex >= key.length) break;
  }
  return parts;
}

/**
 * Whether a TOML text reads as TOML: each line a table's header, a key = value (its value whole, across lines for an
 * array, an inline table or a multi-line string), a comment or blank; no table twice. Throws, in words.
 */
function tomlCheck(text: string): void {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const tables = new Set<string>();
  const fail = (n: number, what: string): never => {
    throw new Error(`don't parse as TOML (${what}, line ${n + 1})`);
  };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line || line.startsWith('#')) continue;
    const h = TOML_HEADER.exec(line);
    if (h) {
      if (!!h[1] !== !!h[3]) fail(n, 'a header with its brackets unmatched');
      const name = tomlParts(h[2]).join('\u0000');
      if (!h[1]) {
        if (tables.has(name)) fail(n, `the table [${h[2]}] twice`);
        tables.add(name);
      }
      continue;
    }
    const p = TOML_PAIR.exec(line);
    if (!p) fail(n, 'neither a table, a key = value, nor a comment');
    // The value: scanned to its end, across lines while a bracket or a multi-line string is open.
    let rest = p![2];
    let depth = 0;
    let started = false;
    for (;;) {
      let i = 0;
      while (i < rest.length) {
        const c = rest[i];
        if (rest.startsWith('"""', i) || rest.startsWith("'''", i)) {
          const q = rest.slice(i, i + 3);
          let e = rest.indexOf(q, i + 3);
          while (e < 0) {
            if (++n >= lines.length) fail(n - 1, 'a multi-line string never closed');
            rest = `${rest}\n${lines[n]}`;
            e = rest.indexOf(q, i + 3);
          }
          i = e + 3;
          while (rest[i] === q[0]) i++;
          started = true;
        } else if (c === '"') {
          let j = i + 1;
          while (j < rest.length && rest[j] !== '"') j += rest[j] === '\\' ? 2 : 1;
          if (j >= rest.length) fail(n, 'a string never closed');
          i = j + 1;
          started = true;
        } else if (c === "'") {
          const j = rest.indexOf("'", i + 1);
          if (j < 0) fail(n, 'a string never closed');
          i = j + 1;
          started = true;
        } else if (c === '[' || c === '{') {
          depth++;
          i++;
          started = true;
        } else if (c === ']' || c === '}') {
          if (--depth < 0) fail(n, `a "${c}" with nothing to close`);
          i++;
        } else if (c === '#') {
          break;
        } else if (/\s|,|=/.test(c)) {
          i++;
        } else {
          const w = /^[A-Za-z0-9_+.:-]+/.exec(rest.slice(i));
          if (!w) fail(n, `"${c}" where a value should be`);
          if (depth === 0 && !/^([+-]?(\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?|0x[\da-fA-F_]+|0o[0-7_]+|0b[01_]+|inf|nan)|true|false|\d{4}-\d\d-\d\d([Tt ]?[\d:.]+)?(Z|[+-]\d\d:\d\d)?|\d\d:\d\d(:\d\d(\.\d+)?)?)$/.test(w![0])) fail(n, `"${w![0]}" isn't a value`);
          i += w![0].length;
          started = true;
        }
      }
      if (depth === 0) break;
      if (++n >= lines.length) fail(n - 1, 'a "[" or "{" never closed');
      rest = lines[n];
    }
    if (!started) fail(n, 'a key with no value');
  }
}

/** The [mcp_servers.<name>] tables a TOML text has: each one's name, command, arguments and lines (its sub-tables included). */
function tomlBlocks(text: string): { name: string; command: string; args: string[]; from: number; to: number }[] {
  const lines = text.split(/\r?\n/);
  const out: { name: string; command: string; args: string[]; from: number; to: number }[] = [];
  let cur: (typeof out)[number] | null = null;
  let lastReal = -1;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    const h = TOML_HEADER.exec(line);
    if (h) {
      const parts = tomlParts(h[2]);
      const ours = parts[0] === 'mcp_servers' && parts.length >= 2;
      if (cur && !(ours && parts[1] === cur.name && parts.length > 2)) {
        cur.to = lastReal;
        out.push(cur);
        cur = null;
      }
      if (ours && !cur && parts.length === 2) cur = { name: parts[1], command: '', args: [], from: n, to: n };
      lastReal = n;
      continue;
    }
    if (line && !line.startsWith('#')) lastReal = n;
    if (cur && !line.startsWith('#')) {
      const p = TOML_PAIR.exec(line);
      const k = p ? tomlParts(p[1]).join('.') : '';
      if (k === 'command') cur.command = tomlString(p![2]) ?? '';
      if (k === 'args') cur.args = [...p![2].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]));
    }
  }
  if (cur) {
    cur.to = lastReal;
    out.push(cur);
  }
  return out;
}

const tomlString = (v: string): string | null => {
  const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(v);
  return m ? (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]) : null;
};

const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

/** The agent's table, as Codex reads it: [mcp_servers.<name>], its command, args and env. */
function tomlBlock(name: string, entry: Record<string, unknown>): string {
  const lines = [`[mcp_servers.${tomlKey(name)}]`, `command = ${JSON.stringify(entry.command)}`, `args = [${((entry.args as string[]) ?? []).map((a) => JSON.stringify(a)).join(', ')}]`];
  const env = entry.env as Record<string, string> | undefined;
  if (env && Object.keys(env).length) lines.push(`env = { ${Object.entries(env).map(([k, v]) => `${tomlKey(k)} = ${JSON.stringify(v)}`).join(', ')} }`);
  return lines.join('\n');
}

function tomlEdit(text: string, name: string, entry: Record<string, unknown> | null): string | null {
  tomlCheck(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // The agent's server written any other way ([mcp_servers] with name = { … }, or mcp_servers.name.command = …): by hand.
  let table: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    const h = TOML_HEADER.exec(t);
    if (h) table = tomlParts(h[2]);
    else {
      const p = TOML_PAIR.exec(t);
      const k = p ? [...table, ...tomlParts(p[1])] : [];
      if (k[0] === 'mcp_servers' && k[1] === name && (table.length < 2 || table[1] !== name)) throw new Error(`have ${name} written inside another table, not as [mcp_servers.${name}]`);
    }
  }
  const mine = tomlBlocks(text).find((b) => b.name === name);
  const block = entry ? tomlBlock(name, entry).split('\n') : [];
  let out: string[];
  if (mine) {
    if (entry && lines.slice(mine.from, mine.to + 1).join('\n') === block.join('\n')) return null;
    let from = mine.from;
    // Taken out with the blank line before it, so none piles up.
    if (!entry && from > 0 && !lines[from - 1].trim()) from--;
    out = [...lines.slice(0, from), ...block, ...lines.slice(mine.to + 1)];
  } else {
    if (!entry) return null;
    const body = [...lines];
    while (body.length && !body[body.length - 1].trim()) body.pop();
    out = [...body, ...(body.length ? [''] : []), ...block, ''];
  }
  const result = out.join(eol);
  tomlCheck(result);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// YAML (Continue's config.yaml): its top-level mcpServers list, the agent's item set or taken out.

/** A YAML scalar as written: unquoted (its comment off), or its quotes taken off. */
function yamlScalar(v: string): string {
  const t = v.trim();
  const dq = /^"((?:[^"\\]|\\.)*)"/.exec(t);
  if (dq) {
    try {
      return JSON.parse(`"${dq[1]}"`);
    } catch {
      return dq[1];
    }
  }
  const sq = /^'((?:[^']|'')*)'/.exec(t);
  if (sq) return sq[1].replace(/''/g, "'");
  return t.replace(/\s+#.*$/, '').trim();
}

/**
 * Whether a YAML text reads as block-style YAML, as Continue's is: no tabs to indent, keys or list items at its top,
 * each quote and bracket closed (a quoted or bracketed value may run on to the lines after). Throws, in words.
 */
function yamlCheck(lines: string[]): void {
  const fail = (n: number, what: string): never => {
    throw new Error(`don't parse as YAML (${what}, line ${n + 1})`);
  };
  let block = -1;
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n];
    if (/^\s*(#.*)?$/.test(l)) continue;
    const indent = /^ */.exec(l)![0].length;
    if (/^ *\t/.test(l)) fail(n, 'a tab to indent');
    // A block scalar's lines (key: | or >) are text.
    if (block >= 0 && indent > block) continue;
    block = -1;
    const body = l.slice(indent);
    if (indent === 0 && !/^(---|\.\.\.)\s*$|^- |^-$|^[^\s#:][^:]*:(\s|$)|^"[^"]*"\s*:(\s|$)|^'[^']*'\s*:(\s|$)/.test(body)) fail(n, 'neither a key nor a list item');
    const value = /^(?:- +)?(?:[^\s#:"'[{][^:]*|"[^"]*"|'[^']*')\s*:(?:\s+(.*))?$/.exec(body)?.[1] ?? (body.startsWith('-') ? body.replace(/^-\s*/, '') : body);
    const v = (value ?? '').trim();
    if (/^[|>][+-]?\d*(\s+#.*)?$/.test(v)) block = indent;
    // A quoted or bracketed value, read on across lines until it closes.
    if (/^["'[{]/.test(v)) {
      let rest = v;
      const start = n;
      for (;;) {
        const unquoted = rest.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '""');
        const open = /["']/.test(unquoted.replace(/""/g, ''));
        let depth = 0;
        for (const c of unquoted.replace(/#.*$/, '')) depth += c === '[' || c === '{' ? 1 : c === ']' || c === '}' ? -1 : 0;
        if (!open && depth <= 0) {
          if (depth < 0) fail(n, 'a "]" or "}" with nothing to close');
          break;
        }
        if (++n >= lines.length) fail(start, open ? 'a quote never closed' : 'a "[" or "{" never closed');
        rest = `${rest} ${lines[n].trim()}`;
      }
    }
  }
}

/** The mcpServers list in a YAML text: its key's line, how its items are indented, and each item (its name, command, args, lines). */
function yamlList(text: string): { lines: string[]; key: number; inline: string; indent: number; items: { name: string; command: string; args: string[]; from: number; to: number }[]; end: number } | { lines: string[]; key: -1 } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  yamlCheck(lines);
  const key = lines.findIndex((l) => /^mcpServers\s*:/.test(l));
  if (key < 0) return { lines, key: -1 };
  const inline = lines[key].replace(/^mcpServers\s*:/, '').replace(/\s+#.*$/, '').trim();
  const items: { name: string; command: string; args: string[]; from: number; to: number }[] = [];
  let indent = -1;
  let end = key;
  let cur: (typeof items)[number] | null = null;
  let field = '';
  for (let n = key + 1; n < lines.length; n++) {
    const l = lines[n];
    if (/^\s*(#.*)?$/.test(l)) continue;
    const ind = /^ */.exec(l)![0].length;
    const isItem = /^ *-(\s|$)/.test(l);
    if (indent < 0) {
      if (!isItem) break;
      indent = ind;
    }
    if (ind < indent || (ind === indent && !isItem)) break;
    end = n;
    if (ind === indent && isItem) {
      if (cur) items.push(cur);
      cur = { name: '', command: '', args: [], from: n, to: n };
      field = '';
    }
    if (!cur) continue;
    cur.to = n;
    const body = l.slice(ind).replace(/^-\s*/, '');
    const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(body);
    if (kv && (ind === indent || ind === indent + 2 || /^ *- /.test(l))) {
      field = kv[1];
      if (field === 'name') cur.name = yamlScalar(kv[2]);
      if (field === 'command') cur.command = yamlScalar(kv[2]);
      if (field === 'args' && kv[2].trim().startsWith('[')) cur.args = kv[2].trim().slice(1, -1).split(',').map((x) => yamlScalar(x)).filter(Boolean);
    } else if (field === 'args' && /^-\s/.test(l.trim())) cur.args.push(yamlScalar(l.trim().slice(2)));
  }
  if (cur) items.push(cur);
  return { lines, key, inline, indent: indent < 0 ? 2 : indent, items, end };
}

function yamlItems(text: string): { name: string; command: string; args: string[] }[] {
  const l = yamlList(text);
  return l.key < 0 ? [] : (l as Exclude<ReturnType<typeof yamlList>, { key: -1 }>).items;
}

const yq = (s: string) => JSON.stringify(s);

/** The agent's item in Continue's mcpServers, at `pad`. */
function yamlItem(entry: Record<string, unknown>, pad: string): string {
  const out = [`${pad}- name: ${yq(String(entry.name))}`, `${pad}  command: ${yq(String(entry.command))}`];
  const args = (entry.args as string[]) ?? [];
  out.push(args.length ? `${pad}  args:\n${args.map((a) => `${pad}    - ${yq(a)}`).join('\n')}` : `${pad}  args: []`);
  const env = entry.env as Record<string, string> | undefined;
  if (env && Object.keys(env).length) out.push(`${pad}  env:\n${Object.entries(env).map(([k, v]) => `${pad}    ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : yq(k)}: ${yq(v)}`).join('\n')}`);
  return out.join('\n');
}

function yamlEdit(text: string, name: string, entry: Record<string, unknown> | null): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const list = yamlList(text);
  const lines = list.lines;
  const join = (ls: string[]) => `${bom}${ls.join(eol)}`;
  if (list.key < 0) {
    if (!entry) return null;
    const body = [...lines];
    while (body.length && !body[body.length - 1].trim()) body.pop();
    // A new config.yaml: what Continue needs at its top, then the list.
    const head = body.length ? body : ['name: Local Assistant', 'version: 1.0.0', 'schema: v1'];
    return join([...head, 'mcpServers:', ...yamlItem(entry, '  ').split('\n'), '']);
  }
  const l = list as Exclude<typeof list, { key: -1 }>;
  if (l.inline && l.inline !== '[]') throw new Error('have mcpServers written on one line (in brackets), which only a person should rewrite');
  const pad = ' '.repeat(l.indent);
  const mine = l.items.find((x) => x.name === name);
  const block = entry ? yamlItem(entry, pad).split('\n') : [];
  let out: string[];
  if (mine) {
    if (entry && lines.slice(mine.from, mine.to + 1).join('\n') === block.join('\n')) return null;
    out = [...lines.slice(0, mine.from), ...block, ...lines.slice(mine.to + 1)];
    // The last one gone: an empty list, not a key with nothing under it.
    if (!entry && l.items.length === 1) out[l.key] = `${out[l.key].replace(/\s+$/, '')} []`;
  } else {
    if (!entry) return null;
    const at = l.inline === '[]' ? l.key : l.end;
    const keyLine = l.inline === '[]' ? lines[l.key].replace(/\[\]/, '').replace(/\s+$/, '') : null;
    out = [...lines.slice(0, at), ...(keyLine !== null ? [keyLine] : [lines[at]]), ...block, ...lines.slice(at + 1)];
  }
  yamlCheck(out);
  return join(out);
}
