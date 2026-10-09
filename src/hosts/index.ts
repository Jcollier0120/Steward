import type { Runner } from '../run.ts';
import type { Employee } from '../settings.ts';
import { GitHub } from './github.ts';
import type { SourceHost } from './host.ts';

export { must, type Answer, type PrState, type SourceHost } from './host.ts';

/**
 * The host an employee's repository lives on (host.ts), asked from `neutralDir`. GitHub today, for every repository the
 * Steward asks a host about: one worked with plain git (scm.ts, hostIs) asks none.
 */
export function hostFor(o: { run: Runner; neutralDir: string }, _e?: Pick<Employee, 'repo'>): SourceHost {
  return new GitHub(o.run, o.neutralDir);
}
