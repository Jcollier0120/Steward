/**
 * The Settings form's values: the schema GET /api/settings sends (the node part's settings-kit.ts, mirrored here,
 * since the browser's bundle imports nothing of the server's), and the rules web/settings-panel.js has always used to
 * compare, describe, start and tidy them. The server checks everything and is the authority; these only decide what
 * changed, and what a field says about its default.
 */

export type Applies = 'now' | 'restart';
export interface SettingsOption {
  value: string;
  label: string;
}
export interface TextRules {
  maxLength?: number;
  pattern?: string;
  patternHint?: string;
  regex?: boolean;
  path?: { is: 'folder' | 'file' | 'either'; missing: 'warn' | 'refuse'; missingNote?: string; env?: boolean };
  empty?: string;
  placeholder?: string;
}
interface Common {
  key: string;
  label: string;
  help?: string;
  applies?: Applies;
  nullable?: string;
  optional?: boolean;
  readOnly?: boolean;
  /** Folded under Advanced on the page; never in onboarding. */
  advanced?: boolean;
  /** Shown only while the top-level `key` holds one of `is` (as text). */
  shownWhen?: { key: string; is: string[] };
}
export type SettingsField =
  | (Common & { kind: 'switch' })
  | (Common & { kind: 'whole' | 'number'; min: number; max: number; unit?: string })
  | (Common & TextRules & { kind: 'text' })
  | (Common & { kind: 'choice'; options: SettingsOption[] })
  | (Common & { kind: 'choices'; options: SettingsOption[] })
  | (Common & { kind: 'list'; item: TextRules & { label: string }; matchCase?: boolean; minItems?: number; maxItems?: number })
  | (Common & { kind: 'records'; fields: SettingsField[]; noun?: string; blank?: Record<string, unknown>; title?: string; unique?: string; minItems?: number; maxItems?: number })
  | (Common & { kind: 'group'; fields: SettingsField[] })
  | (Common & { kind: 'map'; keyLabel: string; valueLabel: string; keyRules?: TextRules; valueRules?: TextRules; maxItems?: number });

/** Messages by field path: "intervalMinutes", "npu.pieceTokens", "folders.2", "projects.0.path"; "" for the whole form. */
export type Messages = Record<string, string>;

/** GET /api/settings's answer. */
export interface SettingsData {
  schema: SettingsField[];
  values: Record<string, unknown>;
  defaults: Record<string, unknown>;
  problems: string[];
  warnings: Messages;
  file: string;
  usedFrom?: string;
}

/** The kinds drawn as one control on one line. */
export const SCALAR = ['switch', 'whole', 'number', 'text', 'choice'];

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
export const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
export const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);

/** A value as the server would keep it, for comparing: text trimmed, empty optional fields left out. */
export function canon(f: SettingsField, v: unknown): unknown {
  if (v === null && f.nullable) return null;
  switch (f.kind) {
    case 'switch':
      return v === true;
    case 'whole':
    case 'number':
      return typeof v === 'number' ? v : v === undefined || v === null ? '' : String(v);
    case 'text': {
      const s = typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v);
      return s === '' && f.nullable ? null : s;
    }
    case 'choice':
      return v === undefined || v === null ? '' : String(v);
    case 'choices':
      return Array.isArray(v) ? f.options.map((o) => o.value).filter((o) => v.includes(o)) : [];
    case 'list':
      return Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
    case 'records':
      return Array.isArray(v) ? v.map((r) => canonFields(f.fields, r)) : [];
    case 'group':
      return canonFields(f.fields, v ?? {});
    case 'map': {
      const o: Record<string, string> = {};
      for (const [k, x] of Object.entries(asObj(v))) if (String(k).trim()) o[String(k).trim()] = String(x ?? '').trim();
      return o;
    }
  }
}

export function canonFields(fields: SettingsField[], obj: unknown): Obj {
  const o: Obj = {};
  const from = asObj(obj);
  for (const f of fields) {
    const raw = from[f.key];
    if (f.readOnly) {
      if (raw !== undefined) o[f.key] = raw;
      continue;
    }
    const c = canon(f, raw);
    if (f.optional && isEmpty(c)) continue;
    o[f.key] = c;
  }
  return o;
}

export const same = (f: SettingsField, a: unknown, b: unknown) => JSON.stringify(canon(f, a)) === JSON.stringify(canon(f, b));

/** A value in words, for "Default: …". */
export function words(f: SettingsField, v: unknown): string {
  if (v === null || v === undefined) return f.kind === 'text' ? 'empty' : f.nullable || 'none';
  const label = (x: unknown) => ('options' in f ? f.options.find((o) => o.value === x)?.label : undefined) ?? String(x);
  const few = (list: string[]) => (list.length <= 4 ? list.join(', ') : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`);
  const n = (count: number) => `${count} ${count === 1 ? 'entry' : 'entries'}`;
  switch (f.kind) {
    case 'switch':
      return v ? 'on' : 'off';
    case 'whole':
    case 'number':
      return `${v}${f.unit ? ` ${v === 1 ? f.unit.replace(/s$/, '') : f.unit}` : ''}`;
    case 'text':
      return v === '' ? 'empty' : String(v);
    case 'choice':
      return label(v);
    case 'choices':
      return Array.isArray(v) && v.length ? v.map(label).join(', ') : 'none';
    case 'list':
      return Array.isArray(v) && v.length ? few(v.map(String)) : 'none';
    case 'records':
      return Array.isArray(v) && v.length ? (f.title ? few(v.map((r) => String(asObj(r)[f.title!]))) : n(v.length)) : 'none';
    case 'map': {
      const count = Object.keys(asObj(v)).length;
      return count ? n(count) : 'none';
    }
  }
  return '';
}

/** What a new record's field starts as. */
export function blank(f: SettingsField): unknown {
  if (f.nullable) return null;
  switch (f.kind) {
    case 'switch':
      return false;
    case 'choice':
      return f.options[0]?.value ?? '';
    case 'choices':
    case 'list':
    case 'records':
      return [];
    case 'group':
      return Object.fromEntries(f.fields.map((g) => [g.key, blank(g)]));
    case 'map':
      return {};
  }
  return '';
}

/**
 * Before saving: a list's empty items, a map's empty rows and a record with nothing in it go, so the server's item
 * numbers in its messages ("folders.2") are the ones the form shows.
 */
export function tidy(f: SettingsField, v: unknown): unknown {
  if (v === null) return v;
  switch (f.kind) {
    case 'list':
      return Array.isArray(v) ? v.filter((s) => String(s ?? '').trim()) : v;
    case 'map':
      return Object.fromEntries(Object.entries(asObj(v)).filter(([k, x]) => k.trim() || String(x ?? '').trim()));
    case 'records':
      return Array.isArray(v)
        ? v
            .filter((r) => f.fields.some((g) => !g.readOnly && g.kind !== 'switch' && !isEmpty(canon(g, asObj(r)[g.key]))))
            .map((r) => Object.fromEntries(f.fields.map((g) => [g.key, tidy(g, asObj(r)[g.key])]).filter(([, x]) => x !== undefined)))
        : v;
    case 'group':
      return Object.fromEntries(f.fields.map((g) => [g.key, tidy(g, asObj(v)[g.key])]));
  }
  return v;
}

/** Whether a field shows, by its `shownWhen`, given the form's top-level values now. */
export const shownNow = (f: SettingsField, top: Record<string, unknown>) => !f.shownWhen || f.shownWhen.is.includes(String(top[f.shownWhen.key] ?? ''));

/** A time (an ISO string) as its day, for a read-only field; nothing as a dash. */
export const shown = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : String(v).replace(/^(\d{4}-\d\d-\d\d)T[\d:.]+Z$/, '$1'));
