import type { Onboarding } from './kit/onboarding.ts';

/** The fixture's onboarding: the shape every agent's src/onboarding.ts has, which agent-checks.ts holds it to. */
export const ONBOARDING: Onboarding = {
  intro: { title: 'The fixture', text: 'It carries the kit, so the kit can be tested on an agent of its own.' },
  settings: ['folders'],
  tour: [
    { tour: 'status', title: 'Its status', text: 'On duty, off duty, or the work it is doing now.' },
    { tour: 'settings', text: 'Everything else it can be told, with a default that works.' },
  ],
};
