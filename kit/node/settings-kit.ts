import { copyFileSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { isDeveloper } from './developer.ts';
import { readJson, writeJson } from './store.ts';

/**
 * Settings a person changes on the agent's page (its Settings panel), never by editing a file.
 *
 * Each agent describes its settings once, as a schema next to its DEFAULT_SETTINGS (settings.ts). From
 * that schema the kit
 * - serves GET /api/settings: {schema, values, defaults, problems, warnings, file};
 * - checks POST /api/settings {values: {key: value, ...}}, the changed values only: an unknown key, a
 *   wrong type or a value out of range is refused with a message for that field, and nothing is
 *   written. A good change goes into settings.json (written atomically, as every file is), and the
 *   saved settings come back, with a note for each change that waits for the agent's next start;
 * - builds the panel on the page (settings-panel.js), with each field's value, default and help.
 *
 * settings.json stays the store, so a file written by an older version, or by hand, keeps working.
 * The server is the authority: the agent's own normalizeSettings runs on the result, and whatever it
 * would have to fix is refused rather than fixed quietly.
 */

/**
 * When a change is used: from the agent's next round or at once ('now'), from its next start ('restart'), from its
 * next install or update ('reinstall': it's written into what the install sets up, like a scheduled task), or only
 * when an administrator next installs it ('admin': what it sets up needs one). The page marks each but 'now' with its
 * note (APPLIES_NOTE), and a save says it for each such setting it changed.
 */
export type Applies = 'now' | 'restart' | 'reinstall' | 'admin';

/** What the page says beside a setting that isn't used at once, and what a save says when it changes one. */
export const APPLIES_NOTE: Record<Exclude<Applies, 'now'>, string> = {
  restart: 'takes effect at the next start',
  reinstall: 'takes effect at the next install or update',
  admin: 'takes effect when installed as an administrator',
};

export interface Option {
  value: string;
  label: string;
}

/** What a path must be. */
export interface PathRule {
  is: 'folder' | 'file' | 'either';
  /** A path that doesn't exist: saved with a warning (used once it exists), or refused. */
  missing: 'warn' | 'refuse';
  /** The warning for a missing path, when the agent does something about it ("The Miller makes it"). */
  missingNote?: string;
  /** %NAME% is expanded from the environment (%USERPROFILE%\Mill), as Windows does. */
  env?: boolean;
}

/** Rules for a piece of text: a text field, a list's items, a map's keys and values. */
export interface TextRules {
  /** At most this many characters (default 500). */
  maxLength?: number;
  /** The whole value must match this regular expression (its source). */
  pattern?: string;
  /** What `pattern` asks for, in words, for the message: "owner/name, like microsoft/onnxruntime". */
  patternHint?: string;
  /** The value is itself a regular expression, and must compile. */
  regex?: boolean;
  /** The value is a full path. */
  path?: PathRule;
  /** Empty is allowed, and means this ("find one by itself"). */
  empty?: string;
  /** Shown in an empty box, as an example. */
  placeholder?: string;
}

interface Common {
  key: string;
  /** A short label. */
  label: string;
  /** One line on what it does. */
  help?: string;
  /** Default 'now'. */
  applies?: Applies;
  /** null is allowed, and means this ("Automatic: the folders Windows uses"). */
  nullable?: string;
  /** Inside a record or a group: may be left empty, and is then left out of the file. */
  optional?: boolean;
  /** Shown, never changed from the page. */
  readOnly?: boolean;
  /**
   * Seldom changed: the page folds it under Advanced, after the rest (a top-level key, or a group's field), and onboarding
   * never shows it. Most of a person's day-one choices are not this; the knobs that have one sane value nearly always are.
   */
  advanced?: boolean;
  /**
   * Shown only while another top-level setting holds one of these values (as text: a switch is "true" or "false"):
   * the Herald's `stocks` while its `variant` is general or financial. Hidden, it keeps its value and is still saved, so
   * switching back restores it; onboarding follows the same rule, and a message about it shows it anyway.
   */
  shownWhen?: { key: string; is: string[] };
}

export type Field =
  | (Common & { kind: 'switch' })
  | (Common & { kind: 'whole' | 'number'; min: number; max: number; unit?: string })
  | (Common & TextRules & { kind: 'text' })
  /** One value from a list. */
  | (Common & { kind: 'choice'; options: Option[] })
  /** Any number of values from a list (kept in the list's order). */
  | (Common & { kind: 'choices'; options: Option[] })
  /** A list of text: folders, repos, names. No item twice: ignoring case, unless `matchCase` (keywords). */
  | (Common & { kind: 'list'; item: TextRules & { label: string }; matchCase?: boolean; minItems?: number; maxItems?: number })
  /** A list of small records, each with the same fields. */
  | (Common & {
      kind: 'records';
      fields: Field[];
      /** What one record is, for "Add port", "Remove port 2" (default "entry"). */
      noun?: string;
      /** A new record starts as this (else each field empty). */
      blank?: Record<string, unknown>;
      /** The field that names a record, for its heading. */
      title?: string;
      /** A field no two records may share (compared ignoring case). */
      unique?: string;
      minItems?: number;
      maxItems?: number;
    })
  /** A few settings kept together as one object. */
  | (Common & { kind: 'group'; fields: Field[] })
  /** Text by text: an object whose keys a person chooses. */
  | (Common & { kind: 'map'; keyLabel: string; valueLabel: string; keyRules?: TextRules; valueRules?: TextRules; maxItems?: number });

/** Messages by field path: "intervalMinutes", "npu.pieceTokens", "folders.2", "projects.0.path"; "" for the whole form. */
export type Messages = Record<string, string>;

export interface Findings {
  errors?: Messages;
  warnings?: Messages;
}

/** One agent's settings, as the kit needs them. */
export interface SettingsSpec<S extends object = any> {
  schema: Field[];
  defaults: S;
  file: () => string;
  /** The agent's own reading of a settings object: what it uses, and what it had to fix to use it. */
  normalize: (raw: unknown) => { settings: S; problems: string[] };
  /**
   * Checks across fields, or against the PC (a folder Windows knows): errors refuse, warnings don't.
   * `next` is what the agent would use; `raw` the settings as they'd be written, before the agent reads
   * them (the changed values as checked, the rest as the file has them).
   */
  check?: (next: S, changed: string[], raw: Record<string, unknown>) => Findings | Promise<Findings>;
  /** After a save: apply what can be applied at once (reschedule the rounds, say). */
  onSaved?: (next: S, before: S) => void;
  /** When a saved change is used, for the panel's first line (default "from the next round on"). */
  usedFrom?: string;
}

/** The largest POST /api/settings body the server reads (an allowlist of long command lines fits). */
export const SETTINGS_BODY_LIMIT = 128 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);

/** %NAME% expanded from the environment (case-insensitive, as Windows does); unknown names stay. */
export function expandEnv(p: string, env: NodeJS.ProcessEnv = process.env): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  if (!lower.get('userprofile')) lower.set('userprofile', os.homedir());
  return p.replace(/%([^%]+)%/g, (m, name: string) => lower.get(name.toLowerCase()) ?? m);
}

/** A full Windows path: a drive (C:\...) or a share (\\server\share...). */
export const isFullPath = (p: string) => /^[a-z]:[\\/]/i.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p);

interface Out {
  errors: Messages;
  warnings: Messages;
}

const hasErrorAt = (out: Out, at: string) => Object.keys(out.errors).some((k) => k === at || k.startsWith(`${at}.`));

function range(f: { min: number; max: number; unit?: string }, whole: boolean): string {
  return `${whole ? 'a whole number' : 'a number'}${f.unit ? ` of ${f.unit}` : ''} from ${f.min} to ${f.max}`;
}

function checkPath(p: string, rule: PathRule, at: string, out: Out): void {
  const full = rule.env ? expandEnv(p) : p;
  const what = { file: 'file', folder: 'folder', either: 'file or folder' }[rule.is];
  if (!isFullPath(full)) {
    out.errors[at] = `Needs a full path, like ${rule.is === 'file' ? 'C:\\tools\\ffmpeg\\bin\\ffmpeg.exe' : 'C:\\Users\\you\\Documents'}.`;
    return;
  }
  let st;
  try {
    st = statSync(full);
  } catch {
    if (rule.missing === 'refuse') out.errors[at] = `There's no such ${what} on this PC.`;
    else out.warnings[at] = rule.missingNote ?? `There's no such ${what} on this PC (yet). It's kept, and used once it exists.`;
    return;
  }
  if (rule.is === 'folder' && !st.isDirectory()) out.errors[at] = "That's a file, not a folder.";
  if (rule.is === 'file' && st.isDirectory()) out.errors[at] = "That's a folder; name the file in it.";
}

function cleanText(rules: TextRules & { nullable?: string; optional?: boolean }, v: unknown, at: string, out: Out): string | null | undefined {
  if (v === null && rules.nullable) return null;
  if (typeof v !== 'string') {
    out.errors[at] = 'Needs text.';
    return undefined;
  }
  let s = v.trim();
  if (rules.path) s = s.replace(/^"(.*)"$/, '$1').trim();
  if (!s) {
    if (rules.nullable) return null;
    if (rules.optional || rules.empty !== undefined) return '';
    out.errors[at] = "Can't be empty.";
    return undefined;
  }
  const max = rules.maxLength ?? 500;
  if (s.length > max) out.errors[at] = `Too long: at most ${max} characters.`;
  else if (/[\u0000-\u001f]/.test(s)) out.errors[at] = "Can't hold line breaks or control characters.";
  else if (rules.pattern && !new RegExp(`^(?:${rules.pattern})$`).test(s)) out.errors[at] = `Needs ${rules.patternHint ?? 'a different form'}.`;
  else if (rules.regex) {
    try {
      new RegExp(s);
    } catch (e) {
      out.errors[at] = `Isn't a regular expression: ${(e as Error).message.replace(/^Invalid regular expression: /, '')}.`;
    }
  }
  if (out.errors[at]) return undefined;
  if (rules.path) checkPath(s, rules.path, at, out);
  return s;
}

/** Checks the fields of one object (a group, or a record); unknown keys are refused. */
function cleanFields(fields: Field[], v: Record<string, unknown>, at: string, out: Out): Record<string, unknown> {
  const res: Record<string, unknown> = {};
  const p = (k: string) => (at ? `${at}.${k}` : k);
  for (const k of Object.keys(v)) if (!fields.some((f) => f.key === k)) out.errors[p(k)] = `There's no "${k}" here.`;
  for (const f of fields) {
    if (f.readOnly) {
      const x = v[f.key];
      if (x === undefined) continue;
      if ((typeof x === 'string' && x.length <= 200) || typeof x === 'number') res[f.key] = x;
      else out.errors[p(f.key)] = "This one can't be changed here.";
      continue;
    }
    if (f.optional && (v[f.key] === undefined || v[f.key] === null || v[f.key] === '')) continue;
    const c = cleanValue(f, v[f.key], p(f.key), out);
    if (f.optional && isEmpty(c)) continue;
    if (c !== undefined) res[f.key] = c;
  }
  return res;
}

function countCheck(f: { minItems?: number; maxItems?: number }, n: number, at: string, out: Out): void {
  if (f.maxItems !== undefined && n > f.maxItems) out.errors[at] = `At most ${f.maxItems}.`;
  else if (f.minItems !== undefined && n < f.minItems) out.errors[at] = f.minItems === 1 ? 'Needs at least one.' : `Needs at least ${f.minItems}.`;
}

/**
 * One value checked against its field: the cleaned value (text trimmed, optional empties left out),
 * or undefined with a message in `out.errors` under its path. Warnings (a folder that isn't there yet)
 * don't stop it.
 */
export function cleanValue(f: Field, v: unknown, at: string, out: Out): unknown {
  if (v === null && f.nullable && f.kind !== 'text') return null;
  switch (f.kind) {
    case 'switch':
      if (typeof v === 'boolean') return v;
      out.errors[at] = 'Needs on or off.';
      return undefined;
    case 'whole':
    case 'number': {
      const whole = f.kind === 'whole';
      if (typeof v !== 'number' || !Number.isFinite(v) || (whole && !Number.isInteger(v)) || v < f.min || v > f.max) {
        out.errors[at] = `Needs ${range(f, whole)}.`;
        return undefined;
      }
      return v;
    }
    case 'text':
      return cleanText(f, v, at, out);
    case 'choice':
      if (typeof v === 'string' && f.options.some((o) => o.value === v)) return v;
      out.errors[at] = `Needs one of: ${f.options.map((o) => o.label).join(', ')}.`;
      return undefined;
    case 'choices': {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
        out.errors[at] = `Needs a list of any of: ${f.options.map((o) => o.label).join(', ')}.`;
        return undefined;
      }
      const unknown = v.filter((x) => !f.options.some((o) => o.value === x));
      if (unknown.length) {
        out.errors[at] = `Not one of the choices: ${unknown.join(', ')}.`;
        return undefined;
      }
      return f.options.map((o) => o.value).filter((o) => v.includes(o));
    }
    case 'list': {
      if (!Array.isArray(v)) {
        out.errors[at] = 'Needs a list.';
        return undefined;
      }
      const res: string[] = [];
      const seen = new Map<string, number>();
      v.forEach((x, i) => {
        const s = cleanText({ ...f.item, empty: undefined }, x, `${at}.${i}`, out);
        if (typeof s !== 'string') return;
        const k = f.matchCase ? s : s.toLowerCase();
        if (seen.has(k)) out.errors[`${at}.${i}`] = `Listed twice (also number ${seen.get(k)! + 1}).`;
        else seen.set(k, i);
        res.push(s);
      });
      countCheck(f, v.length, at, out);
      return hasErrorAt(out, at) ? undefined : res;
    }
    case 'records': {
      if (!Array.isArray(v)) {
        out.errors[at] = 'Needs a list.';
        return undefined;
      }
      const res: Record<string, unknown>[] = [];
      const seen = new Map<string, number>();
      v.forEach((x, i) => {
        if (!isObject(x)) {
          out.errors[`${at}.${i}`] = `Needs ${f.fields.map((g) => g.label.toLowerCase()).join(', ')}.`;
          return;
        }
        const r = cleanFields(f.fields, x, `${at}.${i}`, out);
        if (f.unique && typeof r[f.unique] !== 'undefined') {
          const k = String(r[f.unique]).toLowerCase();
          if (seen.has(k)) out.errors[`${at}.${i}.${f.unique}`] = `Already listed (number ${seen.get(k)! + 1}).`;
          else seen.set(k, i);
        }
        res.push(r);
      });
      countCheck(f, v.length, at, out);
      return hasErrorAt(out, at) ? undefined : res;
    }
    case 'group': {
      if (!isObject(v)) {
        out.errors[at] = `Needs ${f.fields.map((g) => g.label.toLowerCase()).join(', ')}.`;
        return undefined;
      }
      const r = cleanFields(f.fields, v, at, out);
      return hasErrorAt(out, at) ? undefined : r;
    }
    case 'map': {
      if (!isObject(v)) {
        out.errors[at] = `Needs ${f.keyLabel.toLowerCase()} and ${f.valueLabel.toLowerCase()} pairs.`;
        return undefined;
      }
      const res: Record<string, string> = {};
      Object.entries(v).forEach(([k, x], i) => {
        const key = cleanText({ ...f.keyRules }, k, `${at}.${i}.key`, out);
        const val = cleanText({ ...f.valueRules }, x, `${at}.${i}.value`, out);
        if (typeof key === 'string' && typeof val === 'string') res[key] = val;
      });
      countCheck(f, Object.keys(v).length, at, out);
      return hasErrorAt(out, at) ? undefined : res;
    }
  }
}

/** Every value of a settings object checked against the schema (the defaults must pass, say). */
export function checkValues(schema: Field[], values: object): { errors: Messages; warnings: Messages } {
  const out: Out = { errors: {}, warnings: {} };
  for (const f of schema) if (!f.readOnly) cleanValue(f, (values as Record<string, unknown>)[f.key], f.key, out);
  return out;
}

/**
 * Where the schema and the defaults disagree: a default with no field, or a field with no default.
 * Groups are compared key by key; a list of records by the keys its default records hold. A test in
 * every agent asks for none, so the two can't drift apart.
 */
export function schemaGaps(fields: Field[], defaults: unknown, at = ''): string[] {
  const gaps: string[] = [];
  const p = (k: string) => (at ? `${at}.${k}` : k);
  if (!isObject(defaults)) return [`${at || 'the defaults'}: not an object`];
  for (const k of Object.keys(defaults)) if (!fields.some((f) => f.key === k)) gaps.push(`${p(k)}: in the defaults, not in the schema`);
  for (const f of fields) {
    const d = defaults[f.key];
    if (!(f.key in defaults)) {
      if (!f.optional) gaps.push(`${p(f.key)}: in the schema, not in the defaults`);
      continue;
    }
    if (f.kind === 'group' && d !== null) gaps.push(...schemaGaps(f.fields, d, p(f.key)));
    if (f.kind === 'records' && Array.isArray(d)) {
      d.forEach((item, i) => {
        if (!isObject(item)) return void gaps.push(`${p(f.key)}.${i}: not an object`);
        for (const k of Object.keys(item)) if (!f.fields.some((g) => g.key === k)) gaps.push(`${p(f.key)}.${i}.${k}: in the defaults, not in the schema`);
        for (const g of f.fields) {
          if (!(g.key in item)) {
            if (!g.optional && !g.readOnly) gaps.push(`${p(f.key)}.${i}.${g.key}: in the schema, not in the defaults`);
          } else if (g.kind === 'group' && item[g.key] !== null) gaps.push(...schemaGaps(g.fields, item[g.key], `${p(f.key)}.${i}.${g.key}`));
        }
      });
    }
  }
  return gaps;
}

/** settings.json as an object, or null when there's none; `broken` when it's there but unreadable. */
function readRaw(file: string): { raw: Record<string, unknown> | null; broken: boolean } {
  if (!existsSync(file)) return { raw: null, broken: false };
  const bad = Symbol('unreadable');
  const raw = readJson<unknown>(file, bad);
  return isObject(raw) ? { raw, broken: false } : { raw: null, broken: true };
}

/** The settings the agent uses now, as its normalize() reads the file (the defaults where it has none). */
export function readSettings<S extends object>(spec: SettingsSpec<S>): S {
  return spec.normalize(readRaw(spec.file()).raw ?? {}).settings;
}

const brokenNote = (file: string) => `${file} isn't a JSON object, so the defaults are in use. Saving here replaces it; the old file is kept as settings.json.broken.`;

/**
 * What someone without the manor's Developer options (developer.ts) is told in place of settings.json's problems:
 * the problems themselves name the file, its keys and their JSON, which are a developer's.
 */
export const PLAIN_PROBLEM = "Some of the saved settings couldn't be used as they were, so their defaults are in use. Saving here puts that right.";
/** And in place of the agent's own rules' words when a save is refused for them. */
export const PLAIN_REFUSAL = "These settings can't be used together as they are. Check the ones you changed.";

/**
 * GET /api/settings: the schema, the values in use, the defaults, and anything worth a word. With the manor's Developer
 * options off (`developer`, read now unless given), `file` is empty and `problems` says them in one plain line
 * (PLAIN_PROBLEM): a path and settings.json's own words are developer content (spec/DEVELOPER-OPTIONS.md).
 */
export async function settingsReply<S extends object>(spec: SettingsSpec<S>, developer = isDeveloper()) {
  const file = spec.file();
  const { raw, broken } = readRaw(file);
  const { settings, problems } = spec.normalize(raw ?? {});
  if (broken) problems.unshift(brokenNote(file));
  const out: Out = { errors: {}, warnings: {} };
  for (const f of spec.schema) if (!f.readOnly) cleanValue(f, (settings as any)[f.key], f.key, out);
  const extra = await spec.check?.(settings, [], raw ?? {});
  const said = developer ? problems : problems.length ? [PLAIN_PROBLEM] : [];
  return { schema: spec.schema, values: settings, defaults: spec.defaults, problems: said, warnings: { ...out.warnings, ...extra?.warnings }, file: developer ? file : '', ...(spec.usedFrom ? { usedFrom: spec.usedFrom } : {}) };
}

/**
 * POST /api/settings {values}: the changed settings, checked, then written. A refusal is 400 with
 * {error, errors}, where `errors` has a message per field path, and the file is left as it was.
 */
export async function saveSettingsReply<S extends object>(spec: SettingsSpec<S>, body: unknown, developer?: boolean): Promise<{ json: unknown; status?: number }> {
  const changes = isObject(body) ? body.values : undefined;
  if (!isObject(changes)) return { json: { ok: false, error: 'Send {"values": {...}} with the settings to change.', errors: {} }, status: 400 };
  const out: Out = { errors: {}, warnings: {} };
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) {
    const f = spec.schema.find((x) => x.key === k);
    if (!f) out.errors[k] = `There's no setting called "${k}".`;
    else if (f.readOnly) out.errors[k] = "This one can't be changed here.";
    else {
      const c = cleanValue(f, v, k, out);
      if (!hasErrorAt(out, k)) clean[k] = c;
    }
  }
  const refuse = () => {
    const n = Object.keys(out.errors).length;
    const general = out.errors[''];
    return {
      json: { ok: false, error: general && n === 1 ? `Not saved: ${general}` : `Not saved: ${n === 1 ? 'one setting needs' : `${n} settings need`} fixing.`, errors: out.errors },
      status: 400,
    };
  };
  if (Object.keys(out.errors).length) return refuse();

  const file = spec.file();
  const { raw, broken } = readRaw(file);
  const base: Record<string, unknown> = raw ?? structuredClone(spec.defaults as Record<string, unknown>);
  const before = spec.normalize(base);
  const next = { ...base, ...clean };
  const after = spec.normalize(next);
  const extra = await spec.check?.(after.settings, Object.keys(clean), next);
  Object.assign(out.errors, extra?.errors);
  Object.assign(out.warnings, extra?.warnings);
  // The agent's own rules: whatever its normalizeSettings would have to fix is refused, not fixed
  // quietly (said for the whole form, unless the agent's check already said it beside a field). Its words name
  // settings.json and its keys: only a developer reads them (developer.ts), everyone else PLAIN_REFUSAL.
  const fresh = after.problems.filter((p) => !before.problems.includes(p));
  if (fresh.length && !Object.keys(out.errors).length) out.errors[''] = (developer ?? isDeveloper()) ? fresh.join(' ') : PLAIN_REFUSAL;
  if (Object.keys(out.errors).length) return refuse();

  // Each changed setting is written as the agent reads it; the rest of the file stays as it was.
  const stored: Record<string, unknown> = { ...base };
  for (const k of Object.keys(clean)) stored[k] = (after.settings as Record<string, unknown>)[k];
  if (broken) copyFileSync(file, `${file}.broken`);
  writeJson(file, stored);

  const saved = spec.normalize(stored).settings;
  const changed = Object.keys(clean).filter((k) => JSON.stringify((saved as any)[k]) !== JSON.stringify((before.settings as any)[k]));
  const notes = changed
    .map((k) => spec.schema.find((f) => f.key === k)!)
    .filter((f) => f.applies && f.applies !== 'now')
    .map((f) => `${f.label}: ${APPLIES_NOTE[f.applies as Exclude<Applies, 'now'>]}.`);
  try {
    spec.onSaved?.(saved, before.settings);
  } catch (e) {
    console.error(`${new Date().toISOString()} after saving the settings: ${(e as Error).message}`);
  }
  return { json: { ok: true, message: changed.length ? 'Saved.' : 'Nothing changed.', values: saved, warnings: out.warnings, notes, changed } };
}
