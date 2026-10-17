import type { Onboarding } from './kit/onboarding.ts';

/**
 * The Steward's onboarding, the kit's tour of its page at #/tour (Manor opens it when the Steward is hired): what it
 * is, the settings only you can choose (whose work it looks after, whether it works by itself, whether it keeps the staff's
 * pages up), and what its page shows. Each step names a data-tour of src/web/steward.tsx.
 */
export const ONBOARDING: Onboarding = {
  intro: {
    title: 'The Steward looks after your repositories',
    text: "Pick the repositories of yours it looks after, from the ones Reeve finds on this PC. For each it claims versions up front, so work started side by side never takes the same one, and it watches your pull requests and releases. You merge your own pull requests once their checks pass; at set times it builds, releasing what is new on each branch, only where you say yes, repository by repository, and on its own only once you switch that on. Anything it can't settle becomes an alarm, here and in Manor.",
  },
  settings: ['team', 'byItself', 'tend'],
  tour: [
    { tour: 'alarms', title: 'Needs you', text: 'What it could not settle by itself: a release it gave up on, say. Each clears by itself once it is fixed.' },
    { tour: 'last', title: 'Last stage', text: 'What it did last, a round or a stage you pressed: repository by repository, with the output of anything that failed.' },
    { tour: 'found', title: 'Found on this PC', text: 'Your repositories on GitHub that Reeve found here and you can push to. Look after one, and tick whether it may release new versions.' },
    { tour: 'staff', title: 'Your repositories', text: 'Each one it looks after: its version on its branch, its newest release, its open pull requests, and what you let it do.' },
    { tour: 'stages', title: 'Release', text: 'Release new versions when you want them by hand, rather than at the next build.' },
  ],
};
