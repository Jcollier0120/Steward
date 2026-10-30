import path from 'node:path';
import { readJsonShared } from './kit/file-cache.ts';
import { manorHome } from './kit/manor.ts';

/**
 * The agents Manor has retired: its shipped staff.json marks them `"retired": true`, with `"heldBack"` (Manor reads them
 * so too: install.ts hireFrom). The Butler of game saves (Manor 0.16.99), the Aletaster and the Auditor, whose offices
 * the Assayer and the Smith hold now. Held back from customers, they still took every kit the rounds rolled out, and a
 * release for each: since 1 October some 160 of each one's commits were kit bumps. Now the rounds pass them over: no kit
 * rolled out to one (stages/rollout.ts), nor tried on it before the kit is released (stages/trial.ts), and no release of
 * one (stages/round.ts). And since Steward 0.36.261 none is an employee at all (settings.ts's inEffect): no row in the
 * staff's table, no glance, check or alarm, and no Bump, Push or Release of one; the stages' own guards stay for a
 * context whose staff names one.
 *
 * Only those marked retired. One Manor holds back until its first release (the Seneschal), or doesn't list at all (Workshop
 * Pro's Bailiff and Wright, still being made), takes every kit as before. No Manor here, or its staff.json unreadable:
 * none. Its 64 KB are parsed once while the file is unchanged (the kit's readJsonShared), so a round may ask each time.
 */
export function retiredStaff(home = manorHome()): Set<string> {
  const agents = readJsonShared<{ agents?: unknown } | null>(path.join(home, 'app', 'staff.json'), null)?.agents;
  return new Set(
    (Array.isArray(agents) ? agents : [])
      .filter((a) => a && a.heldBack === true && a.retired === true && typeof a.id === 'string')
      .map((a) => (a.id as string).toLowerCase()),
  );
}

/** The agents Manor has retired, as a stage sees them: those its context stands in with (tests), else Manor's staff.json. */
export const retiredOf = (ctx: { retired?: ReadonlySet<string> }): ReadonlySet<string> => ctx.retired ?? retiredStaff();

/** Why the rounds pass a retired agent over. */
export const RETIRED = "retired in Manor's staff.json, so the rounds roll no kit out to it and don't release it";
