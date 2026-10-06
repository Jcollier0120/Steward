import type { Onboarding } from './kit/onboarding.ts';

/**
 * The Steward's onboarding, the kit's tour of its page at #/tour (Manor opens it when the Steward is hired): what it
 * is, the settings only you can choose (whose PRs it merges, whether it works by itself, whether it keeps the staff's
 * pages up), and what its page shows. Each step names a data-tour of src/web/steward.tsx.
 */
export const ONBOARDING: Onboarding = {
  intro: {
    title: 'The Steward runs the household staff',
    text: "It keeps the kit every agent shares (the page, Settings, install and release, the accelerators) and brings each new version of it to every employee at once: one change, tested in each agent, then merged and released together. On duty it can also merge your team's ready pull requests, release what's merged, and reopen an agent's page that stopped answering. Anything it can't settle becomes an alarm, here and in Manor.",
  },
  settings: ['team', 'byItself', 'tend'],
  tour: [
    { tour: 'alarms', title: 'Needs you', text: 'What it could not settle by itself: a PR that has waited, a release it gave up on, an update Manor could not install. Each clears by itself once it is fixed.' },
    { tour: 'staff', title: 'The staff', text: 'Each employee, the kit it carries, its version on its branch and its newest release, and its open pull requests.' },
    { tour: 'stages', title: 'The stages', text: 'Bump, Push, Merge and Release, each for every employee at once, when you want them by hand.' },
    { tour: 'last-stage', title: 'The last stage', text: 'What the last stage or round did, employee by employee, with the output of anything that failed.' },
    { tour: 'kit', title: 'The kit', text: 'The kit this Steward carries, and what each version changed.' },
  ],
};
