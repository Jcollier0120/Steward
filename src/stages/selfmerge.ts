import { APP } from '../app.ts';
import type { Settings, Employee } from '../settings.ts';

/**
 * The Steward's own repository, as a build sees an employee's: main tested once at its head unless a vouch covers it
 * (stages/mainbuild.ts), its changes/ stamped (stages/stamp.ts). Not an employee: it takes no kit rollout (it carries
 * the kit), and its releases are its own (stages/self.ts). What it releases, Manor then installs, behind the install's
 * fail-safe (src/safeinstall.ts).
 */
export const stewardEmployee = (s: Settings, checkout = s.stewardCheckout): Employee => ({
  id: APP.id,
  name: APP.name,
  repo: s.stewardRepo,
  checkout,
  branch: 'main',
  // Its own repository: the Steward merges only the kit and stamp PRs it opens there itself (Steward 0.36.121).
  merges: true,
  // Not "on the kit": a rollout passes it over.
  usesKit: false,
  // Its kit and the kit tests' fixture, from its own kit\ (npm run kit), then the checks a person runs before a PR.
  fill: 'npm run kit',
  test: ['npm run typecheck', 'npm test'],
  versionFiles: ['package.json', 'package-lock.json', 'src/app.ts'],
  release: '',
  install: '',
  approve: '',
  installed: '',
});
