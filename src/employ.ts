import path from 'node:path';
import { manorHome, originRepo } from './kit/manor.ts';
import { readJson, writeJson } from './kit/store.ts';
import { branchTree, employeeFromClone, folderTree, internalStaff } from './migrate.ts';
import type { Employee } from './settings.ts';

/**
 * A new agent taken on: `employ <its clone>` adds it to Settings' employees, so the Steward's page lists it and its
 * rounds test, merge and release it from then on, with no hand-editing of settings.json. Everything comes from the clone,
 * as the migration reads one (migrate.ts' employeeFromClone): its id and name from the manor-agent.json it announces
 * itself with (else its src/app.ts), its repository from the clone's origin, its kit parts from kit.json, and how to fill,
 * test, version and release it from its files, on its branch's tip.
 *
 * How it is released follows what Manor makes of it. Manor's internal staff (staff.local.json) are built and installed
 * here (RELEASE_HERE), never published. One that announces itself (manor-agent.json), or that Manor already lists as staff,
 * is published, so every Manor finds it and offers Hire. One that does neither is released here too, until it announces
 * itself: nothing of it reaches the public releases by surprise.
 */

/** What employ() makes of a clone: the new employee, the fields it couldn't fill in, and a note on its release. */
export interface Employed {
  employee: Employee;
  missing: string[];
  notes: string[];
  /** The kit parts its kit.json takes, as it says them (null: it has no kit.json). The Steward keeps no copy. */
  kitParts: string[] | null;
}

/** The id and name a clone gives itself: its manor-agent.json's agent, else its src/app.ts's APP. */
export function identityOf(read: (rel: string) => string | null): { id: string; name: string; announces: boolean } | null {
  try {
    const a = JSON.parse((read('manor-agent.json') ?? 'null').replace(/^﻿/, ''))?.agent;
    if (a && typeof a.id === 'string' && /^[a-z][a-z0-9-]*$/.test(a.id)) return { id: a.id, name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : a.id, announces: true };
  } catch {
    // Not JSON: its app.ts may still say.
  }
  const app = read('src/app.ts') ?? '';
  const id = /\bid:\s*'([a-z][a-z0-9-]*)'/.exec(app)?.[1];
  if (!id) return null;
  return { id, name: /\bname:\s*'([^']+)'/.exec(app)?.[1]?.trim() || id, announces: false };
}

/** The kit parts a kit.json takes, or null when it is no kit.json. kit.json is their one source: tools/kit.ts fills from it. */
export function partsOf(kitJson: string | null): string[] | null {
  try {
    const parts = JSON.parse((kitJson ?? 'null').replace(/^﻿/, ''))?.parts;
    return Array.isArray(parts) ? parts.filter((p): p is string => typeof p === 'string') : null;
  } catch {
    return null;
  }
}

/** The ids in Manor's own staff.json: agents it ships and offers, so published. */
export function manorStaff(home = manorHome()): Set<string> {
  const agents = readJson<{ agents?: { id?: unknown }[] } | null>(path.join(home, 'app', 'staff.json'), null)?.agents;
  return new Set((Array.isArray(agents) ? agents : []).map((a) => a?.id).filter((x): x is string => typeof x === 'string'));
}

/**
 * The employee a clone makes, or why it can't be one. `employees` are Settings' now: an agent, repository or clone the
 * Steward looks after already is refused. Pure but for reading the clone (and Manor's staff, unless given).
 */
export function employeeFor(
  checkout: string,
  employees: Employee[],
  o: { branch?: string; internal?: Set<string>; staff?: Set<string>; origin?: (dir: string) => string | null } = {},
): Employed | { error: string } {
  const dir = path.resolve(checkout);
  const branch = o.branch ?? 'main';
  const tree = branchTree(dir, branch);
  if (!tree) return { error: `${dir} isn't a clone with a ${branch} branch${folderTree(dir).has('.git') ? '' : ' (no .git here)'}.` };
  const me = identityOf((rel) => tree.read(rel));
  if (!me) return { error: `${dir} doesn't say who it is: no manor-agent.json with an agent id, and no id in src/app.ts, on ${branch}.` };
  const repo = (o.origin ?? originRepo)(dir);
  if (!repo) return { error: `${dir}'s origin isn't a GitHub repository, so there is nowhere to open or merge its pull requests.` };
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const already = employees.find((e) => same(e.id, me.id) || same(e.repo, repo) || (e.checkout && same(path.resolve(e.checkout), dir)));
  if (already) return { error: `The Steward looks after ${already.name} (${already.id}, ${already.repo}, ${already.checkout}) already.` };
  const internal = (o.internal ?? internalStaff()).has(me.id);
  const published = !internal && (me.announces || (o.staff ?? manorStaff()).has(me.id));
  const parts = partsOf(tree.read('kit.json'));
  const got = employeeFromClone({ id: me.id, name: me.name, repo, branch, checkout: { path: dir }, usesKit: parts !== null }, !published);
  if (!got) return { error: `${dir} couldn't be read as a clone.` };
  const notes = [
    internal
      ? "Manor lists it as internal staff: it is built and installed here, and never published."
      : published
        ? 'It is published with each release, so every Manor finds it and offers Hire.'
        : "It doesn't announce itself (no manor-agent.json) and Manor doesn't list it: it is built and installed here until it does. Change Release it in Settings to publish it.",
  ];
  if (parts === null) notes.push("It has no kit.json: listed, but the kit's stages pass over it until it takes the kit.");
  return { employee: got.employee, missing: got.missing, notes, kitParts: parts };
}

/**
 * Adds an employee to settings.json, keeping every other key as it is. The page's own saves are refused when the file
 * changed since it was read (the kit's settings), so a page left open can't write this one away unnoticed.
 */
export function addEmployee(file: string, e: Employee): void {
  const raw = readJson<Record<string, unknown>>(file, {});
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const employees = Array.isArray(s.employees) ? s.employees : [];
  writeJson(file, { ...s, employees: [...employees, e] });
}
