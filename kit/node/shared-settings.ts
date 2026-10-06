import type { Field } from './settings-kit.ts';

/**
 * Settings every agent that has them shares, with one key, one label and one meaning across the manor: an agent puts
 * the field in its schema, its default in DEFAULT_SETTINGS, and reads the value with the matching read function in its
 * normalizer (which also takes the value over from the agent's older key).
 *
 * - roundEvery: minutes between rounds (roundEveryField, readRoundEvery), handed to every() as roundEveryMs().
 * - plainNotes: whether a local model writes a short note in plain words (plainNotesField, readPlainNotes).
 * - modelCallsPerRound: the most requests to the local model in a round (modelCallsField, readModelCalls).
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
  return { key: 'roundEvery', kind: 'whole', min: r.min, max: r.max, unit: 'minutes', label: o.label ?? 'A round every', help: o.help ?? 'Minutes between rounds while it is on duty. Run now still runs one at any time.', advanced: true };
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
  return { key: 'plainNotes', kind: 'switch', label: 'Plain-words notes', help: o.help ?? 'A short note in plain words by a local model on this PC (unverified, and labelled with where it ran). Off: none is asked for.' };
}

/** Whether to ask for plain-words notes: `plainNotes`, or else the agent's older switch (`was`), or else `fallback`. */
export function readPlainNotes(raw: unknown, fallback: boolean, o: { was?: string } = {}): boolean {
  const s = isObject(raw) ? raw : {};
  const v = s.plainNotes !== undefined ? s.plainNotes : o.was !== undefined ? s[o.was] : undefined;
  return typeof v === 'boolean' ? v : fallback;
}

/** An agent's bounds for its model calls in a round (0 is always allowed: none). */
export interface ModelCalls {
  max: number;
  default: number;
}

/** The most requests to the local model in a round: under Advanced. `unit` names what one call is for ("notes"). */
export function modelCallsField(c: ModelCalls, o: { unit?: string; help?: string } = {}): Field {
  checkBounds('modelCallsField', { min: 0, ...c });
  return { key: 'modelCallsPerRound', kind: 'whole', min: 0, max: c.max, unit: o.unit ?? 'calls', label: 'Model calls per round', help: o.help ?? 'At most this many requests to the local model in one round; the rest wait for the next. 0: none.', advanced: true };
}

/** The model calls a round may make: `modelCallsPerRound`, or else the agent's older key (`was`), or else the default. */
export function readModelCalls(raw: unknown, c: ModelCalls, o: { was?: string; problems?: string[] } = {}): number {
  const s = isObject(raw) ? raw : {};
  const v = s.modelCallsPerRound !== undefined || o.was === undefined ? s.modelCallsPerRound : s[o.was];
  return whole(v, { min: 0, max: c.max }, c.default, 'modelCallsPerRound', o.problems);
}
