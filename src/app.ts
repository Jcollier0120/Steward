import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Who this agent is. Its page, its Manor entry and its data folder all follow from here. */
export const APP = {
  id: 'steward',
  name: 'Steward',
  /** One line: what it does. Manor shows it under the name. */
  role: 'Looks after your repositories: claims versions, merges your ready pull requests and releases, where you say yes',
  version: '0.35.2',
};

/** The folder above src/: the installed copy's app folder, or a checkout. */
export const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * A copy whose root holds .git (a folder, or the file a git worktree has) is a development checkout;
 * anything else is an installed copy. The two keep apart, so both can run on one PC: a checkout keeps
 * its data in %USERPROFILE%\.steward-dev and serves on its own port + 10000. To try development work as
 * the real Steward, build a release and install it (Manor's docs/INSTALLING.md).
 */
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

const place = placeFor({ id: APP.id, port: 19494, dev: devCheckout, home: os.homedir(), env: process.env });

/** The page's port: 19494 (29494 in a checkout), or STEWARD_PORT. */
export const port = place.port;

/** Browsers resolve every *.localhost name to this PC themselves, without a hosts file. */
export const HOST_NAME = `${APP.id}.localhost`;
export const pageUrl = `http://${HOST_NAME}:${port}/`;

/** %USERPROFILE%\.steward (\.steward-dev in a checkout), or STEWARD_HOME. Not AppData, as for every agent. */
export const dataDir = place.dataDir;
