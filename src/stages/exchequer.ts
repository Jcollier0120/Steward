import { NOT_PUBLISHED } from '../kit/exchequer.ts';
import { dataFile, readJson, writeJson } from '../kit/store.ts';
import { networkLine, passingFailure } from './common.ts';

/**
 * Releases that reached GitHub but not the Exchequer. The kit's release (kit 2.36.0's publishTo) publishes Castellan's
 * agents to the Exchequer, then makes v<version> in the agent's own repository, and when the Exchequer didn't take it,
 * says "<tag> is in <repo> only" and exits 1. Manor installs them from the Exchequer alone, so no one is offered such a
 * release until it's there. On 2026-10-17 the Exchequer timed out for Bridgeward 0.2.26: the Steward counted the release
 * failed, nothing tried the Exchequer again, and the next round's look at GitHub took v0.2.26 for another Steward's.
 *
 * Now the release counts as this Steward's, and is kept here, by employee (the Steward's own by its id, 0.36.139), until
 * the agent's own release command with --exchequer (the kit's release.ts exchequerOnly: GitHub's own files, from the
 * commit released) puts it there:
 * - one the network or the Exchequer's own failing kept out (`passing`) is tried again by the rounds, further apart each
 *   time (dueAgain), and an alarm comes only once it has waited Settings' waiting hours;
 * - one the Exchequer refused (it doesn't sell the agent, or turned the draft down) isn't: an alarm says so at once.
 * Either alarm's "Publish it now" (askAgain) has a round try it at once, once the person has fixed what kept it out; an
 * employee's Release on the Steward's page does too.
 */
export interface ExchequerPending {
  version: string;
  /** The commit released, whole. */
  commit: string;
  /** Why the Exchequer didn't take it, in the kit's words. */
  why: string;
  /** The network, or the Exchequer's own failing: the rounds try it again. */
  passing: boolean;
  /** When the release missed it, and when it was last tried. */
  since: string;
  last: string;
  /** Tries since the release. */
  tries: number;
  /** When a person asked for it to be tried now (its alarm's button): the next round's, whatever kept it out. */
  asked?: string;
}

export const exchequerPendingFile = () => dataFile('exchequer-pending.json');
export const loadExchequerPending = () => readJson<Record<string, ExchequerPending>>(exchequerPendingFile(), {});

export function notePending(id: string, p: ExchequerPending): void {
  const all = loadExchequerPending();
  all[id] = p;
  writeJson(exchequerPendingFile(), all);
}

/**
 * Its alarm's "Publish it now" (exchequerConditions, alarms.ts), by the alarm's id ("exchequer:<id>:<version>:…"): the
 * next round tries it, whatever kept it out. False when that release no longer waits.
 */
export function askAgain(alarmId: string, now = new Date()): boolean {
  const [kind, id, version] = alarmId.split(':');
  const all = loadExchequerPending();
  const p = kind === 'exchequer' && id ? all[id] : undefined;
  if (!p || p.version !== version) return false;
  all[id] = { ...p, asked: now.toISOString() };
  writeJson(exchequerPendingFile(), all);
  return true;
}

/** Nothing waits at the Exchequer for this employee any more (published there, or a newer release reached it). */
export function clearPending(id: string): void {
  const all = loadExchequerPending();
  if (!(id in all)) return;
  delete all[id];
  writeJson(exchequerPendingFile(), all);
}

/** The kit's last line for a release on GitHub alone: "Not published to the Exchequer: <tag> is in <repo> only, …". */
const ON_GITHUB_ONLY = /^Not published to the Exchequer: \S+ is in \S+ only\b/;
/** The kit's line for an agent the Exchequer doesn't list (publishToExchequer's 'not-sold'). */
const NOT_SOLD = /^The Exchequer: (.+ isn't one of the agents it sells)\b/;

/**
 * Why the Exchequer didn't take a release, from the kit's lines: its own "Not published to the Exchequer: …" line, without
 * those words and the advice after them ("couldn't reach https://…: fetch failed (UND_ERR_CONNECT_TIMEOUT)"), or that it
 * doesn't sell the agent. Null when the output says neither.
 */
export function exchequerWhy(output: string): string | null {
  for (const raw of output.split(/\r?\n/).reverse()) {
    const line = raw.trim();
    if (line.startsWith(NOT_PUBLISHED) && !ON_GITHUB_ONLY.test(line)) {
      return line
        .slice(NOT_PUBLISHED.length)
        .replace(/\s*The GitHub release stands;.*$/, '')
        .replace(/\.$/, '')
        .trim()
        .slice(0, 300);
    }
    const sold = NOT_SOLD.exec(line);
    if (sold) return sold[1];
  }
  return null;
}

/** The Exchequer out of reach, or failing on its side: it timed out, 408/429/5xx, as the kit's why() words them ("(503 unavailable)"). */
const EXCHEQUER_PASSING = /couldn't reach |it timed out|\((?:408|429|5\d\d)\b|\bHTTP (?:408|429|5\d\d)\b/i;
export const exchequerPassing = (why: string) => passingFailure(why) || EXCHEQUER_PASSING.test(why);

/** A release's output that says it is on GitHub and not at the Exchequer: why, and whether that passes. Else null. */
export function missedExchequer(output: string): { why: string; passing: boolean } | null {
  if (!output.split(/\r?\n/).some((l) => ON_GITHUB_ONLY.test(l.trim()))) return null;
  const why = exchequerWhy(output) ?? "the Exchequer didn't take it";
  return { why, passing: exchequerPassing(why) };
}

/** Why a try with --exchequer failed, and whether that passes: the Exchequer's line, else GitHub's (its release read and downloaded). */
export function finishFailed(output: string): { why: string; passing: boolean } {
  const why = exchequerWhy(output);
  if (why) return { why, passing: exchequerPassing(why) };
  const net = networkLine(output);
  if (net) return { why: net, passing: true };
  const last = output.trim().split(/\r?\n/).pop()?.trim() || 'no output';
  return { why: last.slice(0, 300), passing: passingFailure(last) };
}

/**
 * The agent's release command, to publish what GitHub has to the Exchequer: its words with --exchequer for its flags
 * ("npm run release -- --publish" is "npm run release -- --exchequer"). Null for one that doesn't publish.
 */
export function exchequerCommand(release: string): string | null {
  const words = release.trim().split(/\s+/);
  if (!words.includes('--publish')) return null;
  const plain = words.filter((w) => !w.startsWith('--')).join(' ');
  return words[0] === 'npm' ? `${plain} -- --exchequer` : `${plain} --exchequer`;
}

const MINUTE = 60_000;

/**
 * A round's next try of one the network kept out: 15 minutes after the last, then 30, an hour, two, and every three. One
 * a person asked for now (askAgain) at once, whatever kept it out.
 */
export function dueAgain(p: ExchequerPending, now: Date): boolean {
  if (p.asked) return true;
  if (!p.passing) return false;
  const wait = Math.min(180 * MINUTE, 15 * MINUTE * 2 ** Math.max(0, p.tries - 1));
  return now.getTime() - Date.parse(p.last) >= wait;
}
