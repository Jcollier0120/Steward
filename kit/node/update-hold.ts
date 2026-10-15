import path from 'node:path';
import { APP, devCheckout } from '../app.ts';
import { readJsonFile } from './file-cache.ts';
import { manorHome } from './manor.ts';
import { dataFile } from './store.ts';

/**
 * A scheduled round waits a few minutes while Manor has an automatic update due for this agent (kit 2.75.2). Manor
 * installs one only while the agent is idle (its ping says it isn't busy), and looks every minute; an agent whose rounds
 * run back to back through a busy day (the Steward's, during a release) was never idle at that minute, so its updates
 * waited for hours, or for the person to press Update. Now a round due meanwhile waits instead, at most UPDATE_HOLD_MS
 * for a version, so Manor finds the agent idle at its next look. If the update hasn't come by then (Manor waits for
 * something of its own: the PC asleep, the Steward's build, or Manor isn't running), the rounds go on, and wait again
 * UPDATE_HOLD_AGAIN_MS later. A round someone asked for (Run now) never waits.
 */

/** How long a scheduled round waits, at most, for an update Manor has due. */
export const UPDATE_HOLD_MS = 5 * 60_000;
/** After a wait the update didn't come in, how long the rounds go on before they wait for it again. */
export const UPDATE_HOLD_AGAIN_MS = 30 * 60_000;
/** Manor's tries at one version before it leaves it for the person (its updates.ts MAX_TRIES), and its wait between them (RETRY_MS). */
const MANOR_TRIES = 3;
const MANOR_RETRY_MS = 30 * 60_000;

/** What a round waiting for Manor's update says it waits for (RoundState's waiting). */
export const updateWaiting = (version: string) => `Manor to update it to ${version}, a few minutes at most: Manor updates an agent only while it's idle`;

/** As Manor keeps them: updates.json (its last look at the releases, and its failed tries) and settings.json's switches. */
interface ManorUpdates {
  problem?: unknown;
  offline?: unknown;
  items?: { id?: unknown; latest?: unknown; available?: unknown }[];
  failures?: Record<string, { version?: unknown; at?: unknown; count?: unknown } | undefined>;
}

/** Compares dotted version numbers: negative, 0 or positive, as a is before, the same as, or after b. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(/[.+-]/).map((n) => Number(n) || 0);
  const y = b.split(/[.+-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The version Manor would install in this agent by itself now, as Manor's files say: newer than this one, with its
 * automatic updates on, Manor's last look not cut short by a problem or the network, and neither a version Manor has
 * given up on or waits to try again, nor one this agent's install refuses (rolled back, in unsafe-updates.json). Null
 * when there's none, when Manor isn't installed, and in a development checkout, which Manor doesn't update.
 */
export function updateDue(
  o: { home?: string; id?: string; version?: string; now?: number; dev?: boolean; unsafe?: Record<string, unknown> } = {},
): string | null {
  if (o.dev ?? devCheckout) return null;
  const home = o.home ?? manorHome();
  const id = o.id ?? APP.id;
  const auto = readJsonFile<{ autoUpdate?: Record<string, unknown> } | null>(path.join(home, 'settings.json'), null)?.autoUpdate;
  if (!auto || auto[id] !== true) return null;
  const u = readJsonFile<ManorUpdates | null>(path.join(home, 'updates.json'), null);
  if (!u || u.problem || u.offline || !Array.isArray(u.items)) return null;
  const item = u.items.find((i) => i?.id === id);
  const latest = item?.available === true && typeof item.latest === 'string' ? item.latest : null;
  if (!latest || compareVersions(latest, o.version ?? APP.version) <= 0) return null;
  const f = u.failures?.[id];
  if (f && f.version === latest) {
    if (Number(f.count) >= MANOR_TRIES) return null;
    const at = typeof f.at === 'string' ? Date.parse(f.at) : NaN;
    if (Number.isFinite(at) && (o.now ?? Date.now()) < at + MANOR_RETRY_MS) return null;
  }
  // safeinstall.ts's unsafeFile, read here: that module brings the installer with it.
  const unsafe = o.unsafe ?? readJsonFile<Record<string, unknown>>(dataFile('unsafe-updates.json'), {});
  return latest in unsafe ? null : latest;
}

/**
 * Whether a scheduled round waits for Manor's update now: what it waits for, in words, or null to go on. Each due
 * version is waited for UPDATE_HOLD_MS from the first round that asked, then not for UPDATE_HOLD_AGAIN_MS, then again.
 * `due` is updateDue()'s answer; a test gives its own.
 */
export function updateHolder(): (now?: number, due?: string | null) => string | null {
  let hold: { version: string; since: number } | null = null;
  return (now = Date.now(), due = updateDue({ now })) => {
    if (!due) {
      hold = null;
      return null;
    }
    if (!hold || hold.version !== due || now - hold.since >= UPDATE_HOLD_MS + UPDATE_HOLD_AGAIN_MS) hold = { version: due, since: now };
    return now - hold.since < UPDATE_HOLD_MS ? updateWaiting(due) : null;
  };
}

/** The agent's own: every schedule's rounds (schedule.ts every()), and an agent's rounds started beside its schedule (the Steward's), wait together. */
export const updateHold = updateHolder();
