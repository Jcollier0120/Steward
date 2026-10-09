import type { Runner } from '../run.ts';
import type { Host } from '../scm.ts';
import type { Employee } from '../settings.ts';
import { GitHub } from './github.ts';
import { GitLab, whereIs } from './gitlab.ts';
import type { SourceHost } from './host.ts';

export { must, type Answer, type PrState, type SourceHost } from './host.ts';

/**
 * The host a repository lives on (host.ts), asked from `neutralDir`: GitLab's for one the context's `host` (scm.ts's
 * hostOf) says is worked with GitLab's way, else GitHub's. One worked with plain git asks none: the stages pass over it
 * before they would. With no repository named, GitHub (the Steward's own repository, the Wright's queue).
 */
export function hostFor(o: { run: Runner; neutralDir: string; host?: (e: Pick<Employee, 'repo'>) => Host }, e?: Pick<Employee, 'repo'>): SourceHost {
  if (e && o.host?.(e) === 'gitlab') return new GitLab(o.run, o.neutralDir, whereIs(e.repo).hostname);
  return new GitHub(o.run, o.neutralDir);
}
