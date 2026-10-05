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
 * An agent keeps it in src/onboarding.ts as ONBOARDING, and passes it to pageShell(); agent-checks.ts checks it.
 */
export interface Onboarding {
  intro: { title: string; text: string };
  settings: string[];
  tour: { tour: string; title?: string; text: string }[];
}

/** Onboarding asks for this many settings at most: a short step is the point. */
export const ONBOARDING_MAX_SETTINGS = 3;

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
  o.tour.forEach((s, i) => {
    if (!/^[a-z][a-z0-9-]*$/.test(s.tour)) out.push(`Tour step ${i + 1} names "${s.tour}": a data-tour name is lowercase letters, digits and dashes.`);
    if (!s.text?.trim()) out.push(`Tour step ${i + 1} says nothing.`);
  });
  return out;
}
