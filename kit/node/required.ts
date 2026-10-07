import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appRoot } from '../app.ts';
import { requiredText, unmetRequired, type Onboarding } from './onboarding.ts';
import { readSettings, type Field, type SettingsSpec } from './settings-kit.ts';

/**
 * The agent's onboarding (onboarding.ts), from its src/onboarding.ts's ONBOARDING when it has one, read once as it
 * starts: src/onboarding.js in a release, which is built. An agent adds the file and nothing else; agent-checks.ts checks
 * it, react-page.ts's pageShell() puts it in the shell, and its `required` settings hold the rounds (below).
 */
const ONBOARDING_FILE = ['ts', 'js'].map((x) => path.join(appRoot, 'src', `onboarding.${x}`)).find((f) => existsSync(f));
export const AGENT_ONBOARDING: Onboarding | null = ONBOARDING_FILE ? ((await import(pathToFileURL(ONBOARDING_FILE).href)) as { ONBOARDING?: Onboarding }).ONBOARDING ?? null : null;

/** The settings whose required ones are checked (the agent's, as serve() is given them), and the onboarding naming them. */
let watched: SettingsSpec | null = null;
let naming: Onboarding | null = AGENT_ONBOARDING;

/** serve() hands the agent's settings over, so its rounds can wait for the required ones; a test may name its own onboarding. */
export function watchRequired(spec: SettingsSpec | null | undefined, onboarding: Onboarding | null = AGENT_ONBOARDING): void {
  watched = spec ?? null;
  naming = onboarding;
}

/** What the agent still needs from the person before it can work: each unmet entry's keys, and a line saying them. */
export interface NeedsSettings {
  keys: string[][];
  text: string;
}

/**
 * The required settings (its onboarding's `required`) not filled in yet, or null when it can work: its rounds wait
 * (schedule.ts), /api/ping says `needsSettings`, its page says so, and the tour's settings step holds. Read from the
 * settings file each time, so a save lets the rounds go at once; with no onboarding or settings, nothing is needed.
 */
export function needsSettings(o: Onboarding | null = naming, spec: SettingsSpec | null = watched): NeedsSettings | null {
  if (!o?.required?.length || !spec) return null;
  let values: Record<string, unknown>;
  try {
    values = readSettings(spec) as Record<string, unknown>;
  } catch {
    return null; // settings it can't read are said elsewhere (the Settings view); the rounds aren't held for them
  }
  const keys = unmetRequired(o, values);
  if (!keys.length) return null;
  const words = keys.map((k) => requiredText(k, spec.schema as Field[]));
  return { keys, text: words.length < 2 ? words.join('') : `${words.slice(0, -1).join('; ')}; and ${words.at(-1)}` };
}
