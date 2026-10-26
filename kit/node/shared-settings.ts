import { manorShared } from './manor.ts';
import type { Field } from './settings-kit.ts';

/**
 * Settings every agent that has them shares, with one key, one label and one meaning across the manor: an agent puts
 * the field in its schema, its default in DEFAULT_SETTINGS, and reads the value with the matching read function in its
 * normalizer (which also takes the value over from the agent's older key).
 *
 * - roundEvery: minutes between rounds (roundEveryField, readRoundEvery), handed to every() as roundEveryMs().
 * - modelCallsPerRound: the most requests to the local model in a round (modelCallsField, readModelCalls).
 * - plainNotes: whether a local model writes a short note in plain words (plainNotesField, readPlainNotes).
 * - semanticRerank: whether search results are re-ranked by meaning (semanticRerankField, readSemanticRerank).
 * - preset: the video copies' quality (videoQualityField, readVideoQuality).
 * - keepVideoTags: whether a video copy keeps where it was filmed and the camera (keepVideoTagsField, readKeepVideoTags).
 *
 * With Manor installed they're set on Manor's Settings, Staff settings (kit 2.140.0), each field's `inManor` says how,
 * and the agent's own Settings leaves them out (settings-kit.ts' settingsReply says where they are instead):
 * - 'own' (roundEvery, modelCallsPerRound): each agent's own value, as before, kept in its own settings.json; Manor's
 *   Settings shows it beside the agent's name and saves it through the agent's GET and POST /api/settings?manor=1.
 * - 'shared' (the others): one value for the whole manor, settings.json's "shared" in Manor's folder (manorShared()),
 *   which the read function takes first when Manor says; the agent's own value counts only while Manor doesn't.
 *
 * Token sizes are not a setting: the room for a prompt is the client's budget(answerTokens) (npu.ts), worked out
 * from the accelerators that would serve the request (their context and slots), so no agent asks for a piece size.
 */

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

/** An agent's bounds for its round interval, in minutes. */
export interface RoundEvery {
  min: number;
  max: number;
  default: number;
}

function checkBounds(what: string, b: { min: number; max: number; default: number }) {
  if (![b.min, b.max, b.default].every(Number.isInteger) || b.min > b.default || b.default > b.max) throw new Error(`${what}: min <= default <= max, whole numbers (${b.min}, ${b.default}, ${b.max})`);
}

/** The round interval: always under Advanced, used from the next wait on (every() reads it each time). */
export function roundEveryField(r: RoundEvery, o: { label?: string; help?: string } = {}): Field {
  checkBounds('roundEveryField', r);
  if (r.min < 1) throw new Error('roundEveryField: a round needs at least a minute between');
  return { key: 'roundEvery', kind: 'whole', min: r.min, max: r.max, unit: 'minutes', label: o.label ?? 'A round every', help: o.help ?? 'Minutes between rounds while it is on duty. Run now still runs one at any time.', advanced: true, inManor: 'own' };
}

/** A whole number in [min, max] from `v`; `fallback` for nothing, a note in `problems` for anything else. */
function whole(v: unknown, b: { min: number; max: number }, fallback: number, key: string, problems?: string[]): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    problems?.push(`${key} should be a whole number from ${b.min} to ${b.max}; using ${fallback}.`);
    return fallback;
  }
  const n = Math.min(b.max, Math.max(b.min, Math.round(v)));
  if (n !== v) problems?.push(`${key} should be a whole number from ${b.min} to ${b.max}; using ${n}.`);
  return n;
}

/**
 * The round interval from settings.json, in minutes: `roundEvery`, or else the agent's older key (`was`, in its own
 * unit: `minutes` per unit, 60 for hours), or else the default. Out of bounds, the nearest bound.
 */
export function readRoundEvery(raw: unknown, r: RoundEvery, o: { was?: { key: string; minutes?: number }; problems?: string[] } = {}): number {
  const s = isObject(raw) ? raw : {};
  if (s.roundEvery !== undefined || !o.was || s[o.was.key] === undefined) return whole(s.roundEvery, r, r.default, 'roundEvery', o.problems);
  const old = s[o.was.key];
  return whole(typeof old === 'number' ? old * (o.was.minutes ?? 1) : old, r, r.default, 'roundEvery', o.problems);
}

/**
 * The wait between rounds for every() (schedule.ts), read from the settings each time a wait is set, so a change on the
 * Settings page is used from the next wait (onSaved's reschedule() applies it to the wait under way):
 * `every(roundEveryMs(() => settings, ROUND), round)`.
 */
export function roundEveryMs(settings: () => unknown, r: RoundEvery): () => number {
  return () => readRoundEvery(settings(), r) * 60_000;
}

/** The plain-words notes switch: on the page (not Advanced), and one an onboarding may offer. */
export function plainNotesField(o: { help?: string } = {}): Field {
  return { key: 'plainNotes', kind: 'switch', label: 'Plain-words notes', help: o.help ?? 'A short note in plain words by the local AI on this PC, labelled unverified. Off: none is asked for.', inManor: 'shared' };
}

/** A manor-wide switch's value: Manor's (`home` for tests), when it says true or false. */
function manorSwitch(key: string, home?: string): boolean | undefined {
  const v = manorShared(key, home);
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Whether to ask for plain-words notes: Manor's, when it says; else `plainNotes`, or else the agent's older switch
 * (`was`), or else `fallback`.
 */
export function readPlainNotes(raw: unknown, fallback: boolean, o: { was?: string; home?: string } = {}): boolean {
  const manor = manorSwitch('plainNotes', o.home);
  if (manor !== undefined) return manor;
  const s = isObject(raw) ? raw : {};
  const v = s.plainNotes !== undefined ? s.plainNotes : o.was !== undefined ? s[o.was] : undefined;
  return typeof v === 'boolean' ? v : fallback;
}

/** The re-rank-by-meaning switch: under Advanced. `help` says what it re-ranks for this agent. */
export function semanticRerankField(o: { help?: string } = {}): Field {
  return { key: 'semanticRerank', kind: 'switch', label: 'Re-rank by meaning', help: o.help ?? 'Re-rank search results by meaning when the local AI on this PC is already running; it is never started for it.', advanced: true, inManor: 'shared' };
}

/** Whether to re-rank by meaning: Manor's, when it says; else `semanticRerank`, or else `fallback` (on). */
export function readSemanticRerank(raw: unknown, fallback = true, o: { home?: string } = {}): boolean {
  const manor = manorSwitch('semanticRerank', o.home);
  if (manor !== undefined) return manor;
  const s = isObject(raw) ? raw : {};
  return typeof s.semanticRerank === 'boolean' ? s.semanticRerank : fallback;
}

/** The video copies' quality, from the smallest files to the most detail: the `preset` setting's values. */
export const VIDEO_QUALITIES = ['smaller', 'balanced', 'better'] as const;
export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

/**
 * The video copies' quality: on the page (not Advanced). `developerHelp`, the encoders' own terms for a developer
 * (bit rates, CRF levels), in place of the plain words.
 */
export function videoQualityField(o: { help?: string; developerHelp?: string } = {}): Field {
  const help = o.help ?? 'Smaller files make the smallest copies; Better pictures keep more detail and make bigger ones. Balanced is in between.';
  return {
    key: 'preset',
    kind: 'choice',
    label: 'Video quality',
    help: o.developerHelp ?? help,
    ...(o.developerHelp ? { plain: { help } } : {}),
    options: [
      { value: 'smaller', label: 'Smaller files' },
      { value: 'balanced', label: 'Balanced' },
      { value: 'better', label: 'Better pictures' },
    ],
    inManor: 'shared',
  };
}

/** The video copies' quality: Manor's, when it says one; else `preset`, or else `fallback` (Balanced). */
export function readVideoQuality(raw: unknown, fallback: VideoQuality = 'balanced', o: { home?: string } = {}): VideoQuality {
  const known = (v: unknown): v is VideoQuality => VIDEO_QUALITIES.includes(v as VideoQuality);
  const manor = manorShared('preset', o.home);
  if (known(manor)) return manor;
  const s = isObject(raw) ? raw : {};
  return known(s.preset) ? s.preset : fallback;
}

/**
 * Whether a video copy keeps where it was filmed and the camera: under Advanced. `help` says what this agent copies.
 * Its label names GPS, not "a video's place" (kit 2.142.3), which read as where the videos are kept: a folder setting.
 */
export function keepVideoTagsField(o: { help?: string } = {}): Field {
  return {
    key: 'keepVideoTags',
    kind: 'switch',
    label: 'Keep GPS and camera details in video copies',
    help: o.help ?? "Off: a video copy keeps when it was recorded and each track's language, and leaves out where it was filmed (GPS), the camera and its owner's name. On: it keeps every detail the original has.",
    advanced: true,
    inManor: 'shared',
  };
}

/** Whether video copies keep every tag: Manor's, when it says; else `keepVideoTags`, or else `fallback` (off). */
export function readKeepVideoTags(raw: unknown, fallback = false, o: { home?: string } = {}): boolean {
  const manor = manorSwitch('keepVideoTags', o.home);
  if (manor !== undefined) return manor;
  const s = isObject(raw) ? raw : {};
  return typeof s.keepVideoTags === 'boolean' ? s.keepVideoTags : fallback;
}

/**
 * The settings Manor keeps for the whole staff (inManor 'shared'), as its Staff settings draws them, and the value each
 * has while neither Manor nor an agent says one: Manor reads the list from here, so a shared setting the kit adds is
 * there too.
 */
export const manorSharedFields = (): Field[] => [plainNotesField(), videoQualityField(), semanticRerankField(), keepVideoTagsField()];
export const MANOR_SHARED_DEFAULTS: Readonly<{ plainNotes: boolean; preset: VideoQuality; semanticRerank: boolean; keepVideoTags: boolean }> = { plainNotes: true, preset: 'balanced', semanticRerank: true, keepVideoTags: false };

/** An agent's bounds for its model calls in a round (0 is always allowed: none). */
export interface ModelCalls {
  max: number;
  default: number;
}

/** The most requests to the local model in a round: under Advanced. `unit` names what one call is for ("notes"). */
export function modelCallsField(c: ModelCalls, o: { unit?: string; help?: string } = {}): Field {
  checkBounds('modelCallsField', { min: 0, ...c });
  return { key: 'modelCallsPerRound', kind: 'whole', min: 0, max: c.max, unit: o.unit ?? 'calls', label: 'Model calls per round', help: o.help ?? 'At most this many requests to the local model in one round; the rest wait for the next. 0: none.', advanced: true, inManor: 'own' };
}

/** The model calls a round may make: `modelCallsPerRound`, or else the agent's older key (`was`), or else the default. */
export function readModelCalls(raw: unknown, c: ModelCalls, o: { was?: string; problems?: string[] } = {}): number {
  const s = isObject(raw) ? raw : {};
  const v = s.modelCallsPerRound !== undefined || o.was === undefined ? s.modelCallsPerRound : s[o.was];
  return whole(v, { min: 0, max: c.max }, c.default, 'modelCallsPerRound', o.problems);
}
