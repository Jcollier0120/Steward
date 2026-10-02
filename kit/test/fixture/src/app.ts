import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The fixture: the smallest agent the kit runs in, for the kit's own tests (kit\test). Its src\kit\ is
 * filled from kit\src by `npm run kit` in the Steward, as a hire's is from a kit release. Everything an
 * agent gives the kit is here and in settings.ts, cli.ts, art\icon.svg and package.json: the agent
 * interface (the Steward's README).
 */
export const APP = {
  id: 'fixture',
  name: 'Fixture',
  /** One line: what it does. Manor shows it under the name. */
  role: "The kit's test agent: it does nothing but carry the kit",
  version: '0.0.1',
};

/** The folder above src/: the installed copy's app folder, or a checkout. */
export const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** A copy whose root holds .git (a folder, or a worktree's file) is a development checkout; anything else is installed. */
export function isDevCheckout(root: string, exists: (p: string) => boolean = existsSync): boolean {
  return exists(path.join(root, '.git'));
}

export const devCheckout = isDevCheckout(appRoot);

/** A copy's data folder and port: <ID>_HOME and <ID>_PORT if they're set, else its kind's own. */
export function placeFor(o: { id: string; port: number; dev: boolean; home: string; env: Record<string, string | undefined> }): { dataDir: string; port: number } {
  const env = o.id.toUpperCase().replace(/-/g, '_');
  return {
    dataDir: o.env[`${env}_HOME`] ?? path.join(o.home, o.dev ? `.${o.id}-dev` : `.${o.id}`),
    port: Number(o.env[`${env}_PORT`] ?? (o.dev ? o.port + 10000 : o.port)),
  };
}

const place = placeFor({ id: APP.id, port: 17979, dev: devCheckout, home: os.homedir(), env: process.env });

/** The page's port: its own (+ 10000 in a checkout), or FIXTURE_PORT (the tests set one). */
export const port = place.port;

export const HOST_NAME = `${APP.id}.localhost`;
export const pageUrl = `http://${HOST_NAME}:${port}/`;

/** %USERPROFILE%\.fixture, or FIXTURE_HOME (the tests set one). */
export const dataDir = place.dataDir;
