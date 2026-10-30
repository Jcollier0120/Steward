import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A repository's own pipeline (Steward 0.36.264): how the Steward builds, tests, versions and releases it, by the
 * repository's instructions rather than the way it works with its own agents. Each option is Settings' for the
 * repository (its record's `pipeline`, or Settings' `pipelines` by its id or repository, for one Manor's Repositories
 * bring), and a `.steward.json` committed at the root of its clone overrides Settings, option by option. Left out, every
 * option is what the Steward did before it had them, read from the record's own fields: its tests, version files and
 * Release it. So a repository with no `.steward.json` and no `pipeline` is worked with exactly as before.
 *
 * The options (docs/PIPELINE.md says each with examples):
 * - `host`: the kind of host its repository is on (github, gitlab, azure, gitea, bitbucket, git), with `baseUrl` for one
 *   of your own (https://gitlab.acme.com); `none` for a repository with no host at all, kept on this PC alone.
 * - `build`: commands run before its tests, and before its release when it releases to a folder or by a command.
 * - `test`: its checks, in order; every one must pass.
 * - `release`: the command that releases it, run in a fresh worktree of the commit released (releaseTo: command).
 * - `versioning`: `claim` (each branch claims the next free version in its version files, as the Steward's agents do),
 *   `files` (the version in its version files, set by hand: nothing claimed), `tags` (no version files: each release
 *   is the patch after its newest release tag, when its branch has anything new) or `none` (never released).
 * - `versionFiles`: where its version is: package.json, package-lock.json, a .csproj or .props, VERSION, Cargo.toml,
 *   pyproject.toml, or a source file with version: 'x.y.z'.
 * - `tagFormat`: its release tags, {version} for the version: v{version} unless it says.
 * - `changelog`: `auto` (as before: changes/ entries stamped into CHANGELOG.md where its host takes pull requests, the
 *   release's notes its CHANGELOG.md entry), `changes-dir` (the same, said outright), `changelog-md` (CHANGELOG.md written
 *   by hand: nothing stamped, its entry the notes), `host` (the host's own notes from the commits) or `none` (no notes).
 * - `releaseTo`: `auto` (as before: a release on its host, or a tag on plain git), `host` (a release on its host),
 *   `tag` (only a tag, pushed to its origin), `command` (its release command), `none` (never released), or
 *   `{ "folder": "D:\\Releases\\app", "from": "dist" }`: what its build leaves in `from` copied to <folder>\<tag>.
 * - `mergeMethod`: how the Steward merges a pull request of its own there: merge (as before), squash or rebase.
 * - `vouch`: whether the Steward tests and vouches for its pull requests (true, as before).
 * - `sharedRefs`: whether its turns and version claims are kept on its origin (true, as before), so other PCs see them;
 *   false keeps them on this PC.
 */

export const PIPELINE_FILE = '.steward.json';

export const HOST_KINDS = ['github', 'gitlab', 'azure', 'gitea', 'bitbucket', 'git'] as const;
export type PipelineHostKind = (typeof HOST_KINDS)[number] | 'none';
export const VERSIONINGS = ['claim', 'files', 'tags', 'none'] as const;
export type Versioning = (typeof VERSIONINGS)[number];
export const CHANGELOGS = ['auto', 'changes-dir', 'changelog-md', 'host', 'none'] as const;
export type Changelog = (typeof CHANGELOGS)[number];
export const RELEASE_TO = ['auto', 'host', 'tag', 'command', 'none'] as const;
export type ReleaseTo = { kind: (typeof RELEASE_TO)[number] } | { kind: 'folder'; folder: string; from: string };
export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface RepoPipeline {
  /** Its host as said, or null when nothing says: then its repository's name and this PC's tools decide (scm.ts). */
  host: { kind: PipelineHostKind; baseUrl: string | null } | null;
  build: string[];
  test: string[];
  release: string;
  versioning: Versioning;
  versionFiles: string[];
  tagFormat: string;
  changelog: Changelog;
  releaseTo: ReleaseTo;
  mergeMethod: MergeMethod;
  vouch: boolean;
  sharedRefs: boolean;
}

export type PipelineKey = keyof RepoPipeline;
export const PIPELINE_KEYS: PipelineKey[] = ['host', 'build', 'test', 'release', 'versioning', 'versionFiles', 'tagFormat', 'changelog', 'releaseTo', 'mergeMethod', 'vouch', 'sharedRefs'];

/** Where an option's value came from. */
export type PipelineSource = 'default' | 'Settings' | typeof PIPELINE_FILE;

/** A repository's pipeline as the Steward works by it: each option, where it came from, and what was wrong with what was said. */
export interface ResolvedPipeline extends RepoPipeline {
  from: Record<PipelineKey, PipelineSource>;
  /** Each a sentence. Any at all and its build and release are held (heldBy), so nothing runs by a pipeline half read. */
  errors: string[];
}

/** The Steward's own way of making a release (Settings' Release it: tag), as settings.ts's TAG_RELEASE. */
const TAG = 'tag';

/** What the Steward did before a repository had a pipeline, from its record's fields. Pure. */
export function defaultPipeline(e: { test: string[]; versionFiles: string[]; release: string }): RepoPipeline {
  return {
    host: null,
    build: [],
    test: [...(e.test ?? [])],
    release: e.release && e.release !== TAG ? e.release : '',
    versioning: 'claim',
    versionFiles: [...(e.versionFiles ?? [])],
    tagFormat: 'v{version}',
    changelog: 'auto',
    releaseTo: { kind: !e.release ? 'none' : e.release === TAG ? 'auto' : 'command' },
    mergeMethod: 'merge',
    vouch: true,
    sharedRefs: true,
  };
}

/** A repository's pipeline: the one loadSettings resolved, else today's, from its fields. Pure. */
export const pipelineOf = (e: { test: string[]; versionFiles: string[]; release: string; resolvedPipeline?: ResolvedPipeline }): ResolvedPipeline => e.resolvedPipeline ?? asResolved(defaultPipeline(e));

const asResolved = (p: RepoPipeline): ResolvedPipeline => ({ ...p, from: Object.fromEntries(PIPELINE_KEYS.map((k) => [k, 'default'])) as Record<PipelineKey, PipelineSource>, errors: [] });

// What may be said, each read and checked: its value, or a sentence on what is wrong with it.
type Read<T> = { ok: T } | { error: string };

const MAX_COMMAND = 500;
const MAX_COMMANDS = 20;

function commands(v: unknown, key: string): Read<string[]> {
  const list = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(list)) return { error: `"${key}" must be a command, or a list of commands run in order, like ["npm ci", "npm run build"]` };
  if (list.length > MAX_COMMANDS) return { error: `"${key}" has ${list.length} commands: at most ${MAX_COMMANDS}` };
  const out: string[] = [];
  for (const [i, c] of list.entries()) {
    const at = list.length > 1 || Array.isArray(v) ? `"${key}"'s command ${i + 1}` : `"${key}"`;
    if (typeof c !== 'string') return { error: `${at} must be text, like "cargo test"` };
    const t = c.trim();
    if (!t) return { error: `${at} is empty: leave it out instead` };
    if (/[\r\n]/.test(t)) return { error: `${at} has a line break in it: give each command as its own entry` };
    if (t.length > MAX_COMMAND) return { error: `${at} is ${t.length} characters long: at most ${MAX_COMMAND}` };
    out.push(t);
  }
  return { ok: out };
}

function oneOf<T extends string>(v: unknown, key: string, options: readonly T[]): Read<T> {
  if (typeof v === 'string' && (options as readonly string[]).includes(v.trim())) return { ok: v.trim() as T };
  return { error: `"${key}" must be one of ${options.join(', ')}${typeof v === 'string' ? `, not "${v}"` : ''}` };
}

function bool(v: unknown, key: string): Read<boolean> {
  return typeof v === 'boolean' ? { ok: v } : { error: `"${key}" must be true or false${v === 'true' || v === 'false' ? ' (without quotes)' : ''}` };
}

/** A path inside the repository: relative, with no .. part, no drive and no leading slash. */
function insidePath(v: unknown, what: string): Read<string> {
  if (typeof v !== 'string' || !v.trim()) return { error: `${what} must be a path inside the repository, like dist` };
  const p = v.trim().replace(/\\/g, '/');
  if (/^[a-z]:/i.test(p) || p.startsWith('/') || p.split('/').includes('..')) return { error: `${what} must be a path inside the repository (no drive, leading slash or ..), not "${v}"` };
  if (p.length > 200) return { error: `${what} is ${p.length} characters long: at most 200` };
  return { ok: p.replace(/\/+$/, '') || '.' };
}

function versionFiles(v: unknown): Read<string[]> {
  if (!Array.isArray(v)) return { error: '"versionFiles" must be a list of files, like ["Cargo.toml"]' };
  if (v.length > 20) return { error: `"versionFiles" has ${v.length} files: at most 20` };
  const out: string[] = [];
  for (const [i, f] of v.entries()) {
    const r = insidePath(f, `"versionFiles"' file ${i + 1}`);
    if ('error' in r) return r;
    if (r.ok === '.') return { error: `"versionFiles"' file ${i + 1} must name a file, like package.json` };
    out.push(r.ok);
  }
  return { ok: [...new Set(out)] };
}

/** A tag format: {version} once, and otherwise what git takes in a tag's name. */
export function tagFormatProblem(f: string): string | null {
  const n = f.split('{version}').length - 1;
  if (!n) return `"tagFormat" must have {version} in it, like v{version} or release-{version}, not "${f}"`;
  if (n > 1) return `"tagFormat" must have {version} in it once, not ${n} times`;
  const bare = f.replace('{version}', '1.0.0');
  if (!/^[A-Za-z0-9._/-]+$/.test(bare)) return `"tagFormat" may have only letters, digits, ".", "_", "-" and "/" besides {version}, not "${f}"`;
  if (/^[-/.]|\/$|\.\.|\/\/|\.lock$|@\{/.test(bare)) return `"tagFormat" "${f}" doesn't make a name git takes for a tag (no "-", "." or "/" first, no "..", nothing ending in / or .lock)`;
  if (f.length > 100) return `"tagFormat" is ${f.length} characters long: at most 100`;
  return null;
}

function host(v: unknown): Read<RepoPipeline['host']> {
  const kinds = [...HOST_KINDS, 'none'] as const;
  if (typeof v === 'string') {
    const k = oneOf(v, 'host', kinds);
    return 'error' in k ? k : { ok: { kind: k.ok, baseUrl: null } };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: `"host" must be one of ${kinds.join(', ')}, or { "kind": "gitlab", "baseUrl": "https://gitlab.acme.com" } for one of your own` };
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'kind' && k !== 'baseUrl');
  if (extra.length) return { error: `"host" takes only "kind" and "baseUrl", not ${extra.map((k) => `"${k}"`).join(', ')}` };
  const k = oneOf(o.kind, 'host\'s "kind"', kinds);
  if ('error' in k) return k;
  if (o.baseUrl === undefined || o.baseUrl === null || o.baseUrl === '') return { ok: { kind: k.ok, baseUrl: null } };
  if (k.ok === 'none' || k.ok === 'git') return { error: `"host" ${k.ok} has no address: leave out "baseUrl", or give the kind of host it is (gitlab, say)` };
  const u = typeof o.baseUrl === 'string' ? o.baseUrl.trim() : '';
  const m = /^(https?):\/\/([^/?#\s@]+)(\/[^?#\s]*)?$/i.exec(u);
  if (!m) return { error: `"host"'s "baseUrl" must be the host's address, like https://gitlab.acme.com (no user name, password or query in it), not "${String(o.baseUrl)}"` };
  return { ok: { kind: k.ok, baseUrl: `${m[1].toLowerCase()}://${m[2].toLowerCase()}${(m[3] ?? '').replace(/\/+$/, '')}` } };
}

/** A folder to release to: a full path (a drive, a share), or one starting with %VAR%. */
const FULL = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]|%[A-Za-z_][A-Za-z0-9_]*%|\/)/i;

function releaseTo(v: unknown): Read<ReleaseTo> {
  if (typeof v === 'string') {
    const k = oneOf(v, 'releaseTo', RELEASE_TO);
    return 'error' in k ? { error: `${k.error}, or { "folder": "D:\\\\Releases\\\\app", "from": "dist" }` } : { ok: { kind: k.ok } };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: `"releaseTo" must be one of ${RELEASE_TO.join(', ')}, or { "folder": "D:\\\\Releases\\\\app", "from": "dist" }` };
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'folder' && k !== 'from');
  if (extra.length) return { error: `"releaseTo" takes only "folder" and "from", not ${extra.map((k) => `"${k}"`).join(', ')}` };
  const folder = typeof o.folder === 'string' ? o.folder.trim() : '';
  if (!folder || !FULL.test(folder)) return { error: `"releaseTo"'s "folder" must be a full path, like D:\\Releases\\app or %USERPROFILE%\\Releases\\app${folder ? `, not "${folder}"` : ''}` };
  if (folder.length > 260) return { error: `"releaseTo"'s "folder" is ${folder.length} characters long: at most 260` };
  const from = o.from === undefined ? { ok: '.' } : insidePath(o.from, `"releaseTo"'s "from"`);
  if ('error' in from) return from;
  return { ok: { kind: 'folder', folder, from: from.ok } };
}

/** Keys a file may carry that aren't options: its schema, and a word for whoever reads it. */
const IGNORED = new Set(['$schema', '//', 'comment', 'comments']);

/** How many letters one word is from another (added, dropped or changed): Levenshtein's. Pure. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/**
 * What one source says (Settings' pipeline, or a .steward.json's contents): each option it gives, read and checked, and
 * a sentence for each that is wrong, `where` first ("Settings", ".steward.json"). An option that is wrong is left out,
 * so it says nothing over the one before it. Pure.
 */
export function readPipeline(raw: unknown, where: string): { given: Partial<RepoPipeline>; errors: string[] } {
  const given: Partial<RepoPipeline> = {};
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { given, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { given, errors: [`${where} must be an object of pipeline options, like { "test": ["npm test"] }`] };
  const r = raw as Record<string, unknown>;
  const put = <K extends PipelineKey>(k: K, read: Read<RepoPipeline[K]>) => {
    if ('error' in read) errors.push(`${where}: ${read.error}`);
    else given[k] = read.ok;
  };
  for (const [k, v] of Object.entries(r)) {
    if (IGNORED.has(k)) continue;
    if (!(PIPELINE_KEYS as string[]).includes(k)) {
      // The option meant: the same but for case and dashes, else one a slip of a letter or two away (tagFormt).
      const bare = k.toLowerCase().replace(/[-_ ]/g, '');
      const like = PIPELINE_KEYS.find((o) => o.toLowerCase() === bare) ?? PIPELINE_KEYS.find((o) => bare.length > 3 && distance(o.toLowerCase(), bare) <= 2);
      errors.push(`${where}: "${k}" isn't a pipeline option${like ? ` (did you mean "${like}"?)` : ''}; the options are ${PIPELINE_KEYS.join(', ')}`);
      continue;
    }
    if (v === undefined) continue;
    switch (k as PipelineKey) {
      case 'host':
        put('host', host(v));
        break;
      case 'build':
        put('build', commands(v, 'build'));
        break;
      case 'test':
        put('test', commands(v, 'test'));
        break;
      case 'release': {
        const c = typeof v === 'string' && !v.trim() ? { ok: [''] } : commands(v, 'release');
        if ('ok' in c && c.ok.length > 1) put('release', { error: '"release" must be one command; put the steps before it in "build"' });
        else put('release', 'error' in c ? c : { ok: c.ok[0] ?? '' });
        break;
      }
      case 'versioning':
        put('versioning', oneOf(v, 'versioning', VERSIONINGS));
        break;
      case 'versionFiles':
        put('versionFiles', versionFiles(v));
        break;
      case 'tagFormat': {
        const f = typeof v === 'string' ? v.trim() : '';
        const why = typeof v !== 'string' ? '"tagFormat" must be text, like v{version}' : tagFormatProblem(f);
        put('tagFormat', why ? { error: why } : { ok: f });
        break;
      }
      case 'changelog':
        put('changelog', oneOf(v, 'changelog', CHANGELOGS));
        break;
      case 'releaseTo':
        put('releaseTo', releaseTo(v));
        break;
      case 'mergeMethod':
        put('mergeMethod', oneOf(v, 'mergeMethod', MERGE_METHODS));
        break;
      case 'vouch':
        put('vouch', bool(v, 'vouch'));
        break;
      case 'sharedRefs':
        put('sharedRefs', bool(v, 'sharedRefs'));
        break;
    }
  }
  return { given, errors };
}

/**
 * A repository's pipeline: today's (defaultPipeline, from its record), Settings' options over it, and its
 * .steward.json's over those. Then what the options say together is checked, but only where one of them was said: a
 * repository that says nothing is never refused for what its record always was. Pure.
 */
export function resolvePipeline(e: { repo: string; test: string[]; versionFiles: string[]; release: string }, o: { settings?: unknown; settingsError?: string | null; file?: unknown; fileError?: string | null } = {}): ResolvedPipeline {
  const base = defaultPipeline(e);
  const from = Object.fromEntries(PIPELINE_KEYS.map((k) => [k, 'default'])) as Record<PipelineKey, PipelineSource>;
  const s = readPipeline(o.settings, `Settings' pipeline for ${e.repo || 'it'}`);
  const f = readPipeline(o.file, PIPELINE_FILE);
  const errors = [...(o.settingsError ? [o.settingsError] : []), ...s.errors, ...(o.fileError ? [o.fileError] : []), ...f.errors];
  const p: RepoPipeline = { ...base };
  for (const [given, where] of [
    [s.given, 'Settings'],
    [f.given, PIPELINE_FILE],
  ] as const) {
    for (const k of PIPELINE_KEYS) {
      if (given[k] === undefined) continue;
      (p as unknown as Record<string, unknown>)[k] = given[k];
      from[k] = where;
    }
  }
  // A release command said, with no word on where it goes: it is the release.
  if (from.release !== 'default' && from.releaseTo === 'default' && p.release) p.releaseTo = { kind: 'command' };
  const said = (...keys: PipelineKey[]) => keys.some((k) => from[k] !== 'default');
  const releases = p.versioning !== 'none' && p.releaseTo.kind !== 'none';
  if (releases && (p.versioning === 'claim' || p.versioning === 'files') && !p.versionFiles.length && said('versioning', 'versionFiles', 'releaseTo', 'release'))
    errors.push(`versioning ${p.versioning} reads the version from "versionFiles", and it names none: list where the version is (package.json, Cargo.toml, pyproject.toml, a .csproj), or set "versioning" to tags`);
  if (p.releaseTo.kind === 'command' && !p.release && said('releaseTo', 'release')) errors.push('"releaseTo" is command, and there is no "release" command to run: give one, like "npm publish"');
  if (p.versioning === 'tags' && p.versionFiles.length && said('versionFiles')) errors.push('versioning tags takes the version from its tags, so "versionFiles" would never be read: leave them out, or set "versioning" to files');
  const kind = p.host?.kind;
  if ((kind === 'git' || kind === 'none') && p.releaseTo.kind === 'host' && said('host', 'releaseTo')) errors.push(`"releaseTo" is host, but host is ${kind}, which has no releases: release to a tag, a folder or by a command`);
  if (kind === 'none' && p.releaseTo.kind === 'tag' && said('host', 'releaseTo')) errors.push('"releaseTo" is tag, but host is none, so there is no origin to push the tag to: release to a folder or by a command (a local tag is made either way)');
  if (kind === 'none' && from.sharedRefs !== 'default' && p.sharedRefs) errors.push('"sharedRefs" is true, but host is none, so there is no origin to share them on: leave it out');
  const onGitlab = kind === 'gitlab' || (!kind && /^[^/]*gitlab[^/]*\//i.test(e.repo));
  if (onGitlab && p.mergeMethod === 'rebase' && said('mergeMethod')) errors.push('"mergeMethod" is rebase, but GitLab takes a merge request\'s method from the project\'s own settings (Merge requests: Fast-forward merge): set it there, and "mergeMethod" to merge or squash');
  return { ...p, from, errors };
}

/** A release's tag for a version, by the repository's format. Pure. */
export const tagOf = (p: Pick<RepoPipeline, 'tagFormat'>, version: string) => p.tagFormat.replace('{version}', version);

/** The version a tag is a release of, by the format (v{version}: v1.2.3 is 1.2.3), or null for a tag of another kind. Pure. */
export function versionOfTag(format: string, tag: string): string | null {
  const [before, after] = format.split('{version}');
  if (after === undefined || !tag.startsWith(before) || !tag.endsWith(after)) return null;
  const v = tag.slice(before.length, tag.length - after.length);
  return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

/** Whether its pipeline keeps changes/ entries that are stamped into CHANGELOG.md before a release (changelog: auto or changes-dir). Pure. */
export const stampsChanges = (p: Pick<RepoPipeline, 'changelog'>) => p.changelog === 'auto' || p.changelog === 'changes-dir';

/**
 * Whether a repository's releases are its tags, read with git rather than asked of its host: worked with plain git (as
 * before), released to a tag alone, or released by a command its pipeline names (which makes no host release: the
 * Steward tags what it released). Pure.
 */
export const tagsRelease = (p: Pick<ResolvedPipeline, 'releaseTo' | 'from'>, hostKind: string) => hostKind === 'git' || p.releaseTo.kind === 'tag' || (p.releaseTo.kind === 'command' && (p.from.release !== 'default' || p.from.releaseTo !== 'default'));

/** The glob `git ls-remote` is asked for a format's tags (refs/tags/v*). Pure. */
export const tagGlob = (format: string) => `refs/tags/${format.split('{version}')[0]}*`;

/**
 * Why a repository's build and release are held, or null: its pipeline says something that couldn't be read. Its
 * errors are the reason, so the person sees what to fix where the release would have been. Pure.
 */
export const heldBy = (p: Pick<ResolvedPipeline, 'errors'>): string | null => (p.errors.length ? `its pipeline can't be read, so nothing is built or released until it's fixed: ${p.errors.join('; ')}` : null);

/** The file's text, read once while it is unchanged (its size and time). */
const files = new Map<string, { key: string; text: string }>();

/**
 * A clone's .steward.json: its contents, null when it has none, or a sentence when it can't be read as JSON. Read from
 * the clone's working tree, so commit it: every PC then reads the same. No git started; read again only once it changed.
 */
export function readPipelineFile(checkout: string): { raw: unknown; error: string | null } {
  const file = path.join(checkout, PIPELINE_FILE);
  let text = '';
  try {
    const st = statSync(file);
    const key = `${st.size}:${st.mtimeMs}`;
    const kept = files.get(file);
    if (kept?.key === key) text = kept.text;
    else {
      text = st.size > 64 * 1024 ? '' : readFileSync(file, 'utf8');
      if (files.size > 500) files.clear();
      files.set(file, { key, text });
    }
    if (text === '' && st.size > 64 * 1024) return { raw: null, error: `${PIPELINE_FILE} is ${Math.round(st.size / 1024)} KB: at most 64 KB` };
  } catch {
    return { raw: null, error: null };
  }
  try {
    return { raw: JSON.parse(text.replace(/^\uFEFF/, '')), error: null };
  } catch (err) {
    return { raw: null, error: `${PIPELINE_FILE} isn't JSON: ${(err as Error).message}` };
  }
}

/**
 * An employee as its pipeline makes it (loadSettings, after inEffect): its tests the pipeline's builds and then its
 * tests, its version files the pipeline's, and its Release it what the pipeline releases to, so every stage that reads
 * them works by the pipeline; the pipeline itself kept beside them. One that says nothing comes back with the very
 * fields it had. Pure.
 */
export function withPipeline<E extends { repo: string; test: string[]; versionFiles: string[]; release: string }>(e: E, p: ResolvedPipeline): E & { resolvedPipeline?: ResolvedPipeline } {
  // One that says nothing comes back as it was, the very object; one whose pipeline couldn't be read keeps its fields,
  // and is held (heldBy) where it would be built or released.
  if (!p.errors.length && !PIPELINE_KEYS.some((k) => p.from[k] !== 'default')) return e;
  if (p.errors.length) return { ...e, resolvedPipeline: p };
  const releases = p.versioning !== 'none' && p.releaseTo.kind !== 'none';
  return {
    ...e,
    test: p.from.build === 'default' && p.from.test === 'default' ? e.test : [...p.build, ...p.test],
    versionFiles: p.versioning === 'tags' ? [] : p.versionFiles,
    release: !releases ? '' : p.releaseTo.kind === 'command' ? p.release : TAG,
    resolvedPipeline: p,
  };
}

/** One step of a dry run: what it is, and the command or what the Steward does itself. */
export interface DryStep {
  stage: 'build' | 'test' | 'version' | 'changelog' | 'release' | 'merge' | 'vouch' | 'refs';
  what: string;
  command?: string;
}

/**
 * What a build of a repository would do, step by step, and run nothing: `steward build --dry-run <repo>`. `hostKind` is
 * how the Steward works with it here (scm.ts), and `where` its clone. Pure.
 */
export function dryRunSteps(e: { name: string; repo: string; branch: string; checkout: string; resolvedPipeline?: ResolvedPipeline; test: string[]; versionFiles: string[]; release: string }, hostKind: string): DryStep[] {
  const p = pipelineOf(e);
  const steps: DryStep[] = [];
  // A local one's (no host) is its own branch: it has no origin to fetch from (git.ts's remoteOf).
  const at = `a fresh worktree of ${p.host?.kind === 'none' ? e.branch : `origin/${e.branch}`}`;
  for (const c of p.build) steps.push({ stage: 'build', what: `in ${at}`, command: c });
  for (const c of p.test) steps.push({ stage: 'test', what: `in ${at}; must pass`, command: c });
  if (!p.build.length && !p.test.length) steps.push({ stage: 'test', what: 'no tests: released untested' });
  const tagged = (v: string) => tagOf(p, v);
  const versionWords: Record<Versioning, string> = {
    claim: `the version in ${p.versionFiles.join(', ') || '(no version files)'}, each branch claiming the next free one`,
    files: `the version in ${p.versionFiles.join(', ') || '(no version files)'}, as you set it; nothing claimed`,
    tags: `the patch after the newest ${tagged('x.y.z')} tag, when ${e.branch} has commits since it (${tagged('0.1.0')} first)`,
    none: 'none: never released',
  };
  steps.push({ stage: 'version', what: versionWords[p.versioning] });
  const releases = p.versioning !== 'none' && p.releaseTo.kind !== 'none';
  if (releases) {
    const notes: Record<Changelog, string> = {
      auto: hostKind === 'git' ? "the version's CHANGELOG.md entry (changes/ entries are yours to stamp: plain git takes no pull requests)" : "changes/ entries stamped into CHANGELOG.md through a pull request first; the version's CHANGELOG.md entry as the notes",
      'changes-dir': "changes/ entries stamped into CHANGELOG.md first; the version's CHANGELOG.md entry as the notes",
      'changelog-md': "the version's CHANGELOG.md entry, as written by hand",
      host: "the host's own notes, from the commits",
      none: 'no notes',
    };
    steps.push({ stage: 'changelog', what: notes[p.changelog] });
    const host = hostKind === 'git' ? 'its origin' : hostKind;
    const to = p.releaseTo;
    if (to.kind === 'folder') {
      steps.push({ stage: 'release', what: `copies ${to.from === '.' ? 'the worktree' : to.from} to ${to.folder}\\${tagged('<version>')}, and tags ${tagged('<version>')} in your clone` });
    } else if (to.kind === 'command') {
      steps.push({ stage: 'release', what: `in a fresh worktree of the commit released${hostKind === 'git' ? `, then tags ${tagged('<version>')} on ${host}` : ''}`, command: p.release });
    } else if (to.kind === 'tag' || (to.kind === 'auto' && hostKind === 'git')) {
      steps.push({ stage: 'release', what: `tags ${tagged('<version>')} at the commit and pushes it to ${p.host?.kind === 'none' ? 'nowhere (local only)' : host}` });
    } else {
      steps.push({ stage: 'release', what: `a ${hostKind} release ${tagged('<version>')} of the commit` });
    }
  } else steps.push({ stage: 'release', what: 'never released' });
  steps.push({ stage: 'merge', what: hostKind === 'git' ? 'none: plain git has no pull requests' : `its own pull requests merged with ${p.mergeMethod}` });
  steps.push({ stage: 'vouch', what: hostKind === 'git' ? "none: plain git has no pull requests to vouch for (test a branch with steward vouch's dry run, or push it to the branch)" : p.vouch ? 'pull requests tested here and vouched for' : 'pull requests not vouched for' });
  steps.push({ stage: 'refs', what: p.sharedRefs && p.host?.kind !== 'none' ? 'turns and version claims kept on its origin, for other PCs' : 'turns and version claims kept on this PC alone' });
  return steps;
}

/** A dry run's lines, as the console prints them. Pure. */
export function dryRunLines(e: Parameters<typeof dryRunSteps>[0], hostKind: string): string[] {
  const p = pipelineOf(e);
  const said = PIPELINE_KEYS.filter((k) => p.from[k] !== 'default');
  const lines = [
    `${e.name} (${e.repo || 'no repository'}), branch ${e.branch}, worked with ${hostKind === 'git' ? 'plain git' : hostKind}${p.host?.kind === 'none' ? ' (no host: local only)' : ''}`,
    said.length ? `pipeline: ${said.map((k) => `${k} from ${p.from[k]}`).join(', ')}` : `pipeline: the defaults (no ${PIPELINE_FILE}, nothing in Settings)`,
    ...p.errors.map((x) => `error: ${x}`),
  ];
  const held = heldBy(p);
  if (held) return [...lines, `held: ${held}`];
  for (const [i, s] of dryRunSteps(e, hostKind).entries()) lines.push(`${String(i + 1).padStart(2)}. ${s.stage.padEnd(9)} ${s.command ? `${s.command}  (${s.what})` : s.what}`);
  lines.push('Nothing was run (dry run).');
  return lines;
}
