import type { Onboarding } from './kit/onboarding.ts';

/**
 * The Steward's onboarding, the kit's tour of its page at #/tour (Manor opens it when the Steward is hired): what it
 * is, the settings only you can choose (whose PRs it merges, whether it works by itself, whether it keeps the staff's
 * pages up), and what its page shows. Each step names a data-tour of src/web/steward.tsx.
 */
export const ONBOARDING: Onboarding = {
  intro: {
    title: 'The Steward looks after your repositories',
    text: "Pick the repositories of yours it looks after, from the ones Reeve finds on this PC. For each it claims versions up front, so work started side by side never takes the same one, and it watches your pull requests and releases. It merges your ready, green pull requests and releases new versions only where you say yes, repository by repository, and on its own only once you switch that on. Anything it can't settle becomes an alarm, here and in Manor.",
  },
  settings: ['team', 'byItself', 'tend'],
  tour: [
    { tour: 'alarms', title: 'Needs you', text: 'What it could not settle by itself: a pull request that has waited, a release it gave up on. Each clears by itself once it is fixed.' },
    { tour: 'found', title: 'Found on this PC', text: 'Your repositories on GitHub that Reeve found here and you can push to. Look after one, and tick whether it may merge your ready pull requests and release new versions.' },
    { tour: 'staff', title: 'Your repositories', text: 'Each one it looks after: its version on its branch, its newest release, its open pull requests, and what you let it do.' },
    { tour: 'stages', title: 'Merge and release', text: 'Merge your ready pull requests, or release new versions, when you want them by hand.' },
    { tour: 'last-stage', title: 'The last stage', text: 'What the last stage or round did, repository by repository, with the output of anything that failed.' },
  ],
};
