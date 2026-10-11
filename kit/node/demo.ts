import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appRoot } from '../app.ts';

/**
 * Demo mode (kit 2.53.0): the agent's page shown with made-up data, for pictures of it (Manor's hero pictures, each
 * employee's entry in the hire popup and on its role's page) that show it at work without anyone's own files, mail or
 * repositories. Started with `KIT_DEMO=1` (the agent's own `demo` folder) or `KIT_DEMO=<folder>`, beside its `<ID>_HOME`
 * pointing at an empty folder and `<ID>_PORT` at a free port, so nothing of the installed copy is read or touched.
 *
 * Then the page server answers each GET from the demo folder where it has a file for it (`/api/state` from
 * `api/state.json`), the agent's own handler otherwise (with an empty data folder, it shows nothing yet), adds
 * `demo: true` to its ping (with `api/ping.json` laid over it), and refuses every button: nothing changes. An agent's
 * own background work (watchers, first scans) checks `isDemo()` and stays off.
 */

/** Why a button does nothing in demo mode. */
export const DEMO_NO = 'This is a demo of the page: its buttons change nothing.';

/** The demo folder, or null outside demo mode. Read each time, so a test can set KIT_DEMO. */
export function demoDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.KIT_DEMO?.trim();
  if (!v || v === '0') return null;
  return v === '1' ? path.join(appRoot, 'demo') : path.resolve(v);
}

export const isDemo = (env: NodeJS.ProcessEnv = process.env) => demoDir(env) !== null;

/** The demo folder's answer to a GET of `pathname` (its file `<path>.json`), or undefined when it has none. */
export function demoAnswer(pathname: string, dir = demoDir()): unknown {
  if (!dir) return undefined;
  const parts = pathname.split('/').filter(Boolean);
  // Only plain names: nothing outside the demo folder is ever read.
  if (!parts.length || !parts.every((p) => /^[\w.-]+$/.test(p) && p !== '..' && p !== '.')) return undefined;
  const file = `${path.join(dir, ...parts)}.json`;
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}
