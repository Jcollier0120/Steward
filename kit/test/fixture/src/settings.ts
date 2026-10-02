import type { Field, SettingsSpec } from './kit/settings-kit.ts';
import { dataFile, readJson } from './kit/store.ts';

/** The fixture's settings: one of each kind the kit's tests reach for. */
export interface Settings {
  intervalMinutes: number;
  notes: boolean;
  folders: string[];
  limits: { pieceTokens: number; share: number };
  agents: { port: number; name: string }[];
}

export const DEFAULT_SETTINGS: Settings = {
  intervalMinutes: 60,
  notes: true,
  folders: ['C:\\Users\\Public\\Documents'],
  limits: { pieceTokens: 600, share: 0.5 },
  agents: [{ port: 18383, name: 'Reeve' }],
};

export const SETTINGS_SCHEMA: Field[] = [
  { key: 'intervalMinutes', kind: 'whole', min: 1, max: 24 * 60, unit: 'minutes', label: 'A round every', help: 'Minutes between rounds.' },
  { key: 'notes', kind: 'switch', label: 'Notes', help: 'Ask the model for a note on each thing found.' },
  { key: 'folders', kind: 'list', label: 'Folders', help: 'Folders to look in.', item: { label: 'Folder', path: { is: 'folder', missing: 'warn', env: true } }, maxItems: 20 },
  {
    key: 'limits',
    kind: 'group',
    label: 'Limits',
    fields: [
      { key: 'pieceTokens', kind: 'whole', min: 100, max: 2000, unit: 'tokens', label: 'Piece size' },
      { key: 'share', kind: 'number', min: 0, max: 1, label: 'Share' },
    ],
  },
  {
    key: 'agents',
    kind: 'records',
    noun: 'agent',
    unique: 'port',
    label: 'Agents',
    maxItems: 50,
    fields: [
      { key: 'port', kind: 'whole', min: 1, max: 65535, label: 'Port' },
      { key: 'name', kind: 'text', label: 'Agent', maxLength: 100 },
    ],
  },
];

const clamp = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** settings.json over the defaults, each value checked: a bad one falls back to its default. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const d = DEFAULT_SETTINGS;
  return {
    intervalMinutes: Math.round(clamp(r.intervalMinutes, d.intervalMinutes, 1, 24 * 60)),
    notes: typeof r.notes === 'boolean' ? r.notes : d.notes,
    folders: Array.isArray(r.folders) ? r.folders.filter((x: unknown): x is string => typeof x === 'string' && x.trim() !== '') : d.folders,
    limits: {
      pieceTokens: Math.round(clamp(r.limits?.pieceTokens, d.limits.pieceTokens, 100, 2000)),
      share: clamp(r.limits?.share, d.limits.share, 0, 1),
    },
    agents: Array.isArray(r.agents)
      ? r.agents.filter((a: any) => Number.isInteger(a?.port) && a.port > 0 && a.port < 65536).map((a: any) => ({ port: a.port, name: String(a.name ?? a.port) }))
      : d.agents,
  };
}

export const settingsFile = () => dataFile('settings.json');

export const SETTINGS_SPEC: SettingsSpec<Settings> = {
  schema: SETTINGS_SCHEMA,
  defaults: DEFAULT_SETTINGS,
  file: settingsFile,
  normalize: (raw) => ({ settings: normalizeSettings(raw), problems: [] }),
};

export const loadSettings = (): Settings => normalizeSettings(readJson<unknown>(settingsFile(), {}));
