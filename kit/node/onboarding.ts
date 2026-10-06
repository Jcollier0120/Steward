import type { Field } from './settings-kit.ts';

/**
 * An agent's onboarding, which the kit's react part draws as its page's tour (react/tour.tsx, at #/tour): Manor
 * starts empty and a person hires one employee at a time, and each new hire walks them through three steps.
 *   1. `intro`: what the role is, in its own words.
 *   2. `settings`: the few settings only that person can choose on day one (where they are, what to watch, a path
 *      only they know), drawn by the Settings form. At most ONBOARDING_MAX_SETTINGS, none advanced: everything else
 *      has a default that works, and is in Settings. With none, the step says so.
 *   3. `tour`: what its page shows, part by part, each by its data-tour name (the kit's frame names titlebar, status,
 *      settings, theme, action, settings-panel and work; the agent names its own sections).
 * `required` names the settings among `settings` the agent can't work without (the Chamberlain without a mail
 * account): each entry a key that must be filled, or a list of keys of which one must be. Until they are, its rounds
 * wait (required.ts), its page and /api/ping say so, and the tour's settings step holds until they're filled.
 * An agent keeps it in src/onboarding.ts as ONBOARDING, and passes it to pageShell(); agent-checks.ts checks it.
 */
export interface Onboarding {
  intro: { title: string; text: string };
  settings: string[];
  tour: { tour: string; title?: string; text: string }[];
  required?: Required[];
}

/** A required setting: its key, or the keys of which one is enough ("Thunderbird, or a mail account"). */
export type Required = string | string[];

/** Onboarding asks for this many settings at most: a short step is the point. */
export const ONBOARDING_MAX_SETTINGS = 3;

/** Each required entry as the keys of which one must be filled. */
export const requiredGroups = (o: Pick<Onboarding, 'required'>): string[][] => (o.required ?? []).map((r) => (Array.isArray(r) ? r : [r]));

/**
 * Whether a setting's value is filled in: a switch on, a number other than 0, text that isn't blank, a list with
 * something filled in it; a group by its `on` (or `enabled`) switch when it has one, else by anything filled in it.
 */
export function filled(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.some(filled);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const sw of ['on', 'enabled']) if (typeof o[sw] === 'boolean') return o[sw] as boolean;
    return Object.values(o).some(filled);
  }
  return false;
}

/** The required entries not met by these settings, each as its keys; none when the agent can work. */
export const unmetRequired = (o: Pick<Onboarding, 'required'>, values: Record<string, unknown>): string[][] => requiredGroups(o).filter((keys) => !keys.some((k) => filled(values[k])));

/** "Mail accounts", or "Thunderbird or Mail accounts": an unmet entry by its fields' labels. */
export function requiredText(keys: string[], schema: Field[]): string {
  const labels = keys.map((k) => schema.find((f) => f.key === k)?.label ?? k);
  return labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
}

/** What's wrong with an agent's onboarding, in words; none when it's right. */
export function onboardingProblems(o: Onboarding, schema: Field[]): string[] {
  const out: string[] = [];
  if (!o.intro?.title?.trim() || !o.intro?.text?.trim()) out.push('The intro needs a title and a text.');
  if (o.settings.length > ONBOARDING_MAX_SETTINGS) out.push(`It asks for ${o.settings.length} settings; at most ${ONBOARDING_MAX_SETTINGS}, the ones only the person can choose on day one.`);
  for (const k of o.settings) {
    const f = schema.find((x) => x.key === k);
    if (!f) out.push(`"${k}" isn't a setting in its schema.`);
    else if (f.advanced) out.push(`"${k}" is advanced: onboarding never shows an advanced setting.`);
    else if (f.readOnly) out.push(`"${k}" can't be changed from the page.`);
  }
  if (new Set(o.settings).size !== o.settings.length) out.push('A setting is asked for twice.');
  const groups = requiredGroups(o);
  groups.forEach((keys, i) => {
    if (!keys.length) out.push(`Required entry ${i + 1} names no setting.`);
    for (const k of keys) if (!o.settings.includes(k)) out.push(`"${k}" is required but not among its onboarding's settings: the tour must ask for it.`);
  });
  if (new Set(groups.flat()).size !== groups.flat().length) out.push('A setting is required twice.');
  o.tour.forEach((s, i) => {
    if (!/^[a-z][a-z0-9-]*$/.test(s.tour)) out.push(`Tour step ${i + 1} names "${s.tour}": a data-tour name is lowercase letters, digits and dashes.`);
    if (!s.text?.trim()) out.push(`Tour step ${i + 1} says nothing.`);
  });
  return out;
}
