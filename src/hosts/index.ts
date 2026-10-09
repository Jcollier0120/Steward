import type { Runner } from '../run.ts';
import type { Host } from '../scm.ts';
import type { Employee } from '../settings.ts';
import { AzureDevOps, whereAzure } from './azure.ts';
import { GitHub } from './github.ts';
import { GitLab, whereIs } from './gitlab.ts';
import type { SourceHost } from './host.ts';

export { must, type Answer, type PrState, type SourceHost } from './host.ts';

/**
 * The host a repository lives on (host.ts), asked from `neutralDir`: GitLab's or Azure DevOps' for one the context's
 * `host` (scm.ts's hostOf) says is worked with its way, else GitHub's. One worked with plain git asks none: the stages
 * pass over it before they would. With no repository named, GitHub (the Steward's own repository, the Wright's queue).
 */
export function hostFor(o: { run: Runner; neutralDir: string; host?: (e: Pick<Employee, 'repo'>) => Host }, e?: Pick<Employee, 'repo'>): SourceHost {
  const host = e ? o.host?.(e) : undefined;
  if (e && host === 'gitlab') return new GitLab(o.run, o.neutralDir, whereIs(e.repo).hostname);
  const azure = e && host === 'azure' ? whereAzure(e.repo) : null;
  if (azure) return new AzureDevOps(o.run, o.neutralDir, azure.base);
  return new GitHub(o.run, o.neutralDir);
}
