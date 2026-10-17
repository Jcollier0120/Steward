import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandEnv } from '../kit/settings-kit.ts';
import { splitCommand, tail, type Ran } from '../run.ts';
import type { Employee } from '../settings.ts';
import { checkoutOf, hostIs, type Ctx } from './common.ts';

/**
 * Plain git's events (scm.ts): a repository worked with plain git has no pull requests, so what the Steward does where
 * a host would have one is the person's to say, as commands in Settings.
 *
 * - When a branch is ready: the Steward lands no one's work (Steward 0.36.121), so whoever wrote a branch lands it in
 *   the employee's branch themselves, as they would merge a PR; each build releases what is there. The When a branch is
 *   ready command is kept in Settings, and no longer run.
 * - After a release (`whenReleased`): run in the clone once the release's tag is pushed (release.ts).
 *
 * Each command line is split into words first and its {placeholders} filled in word by word, so a value with spaces or
 * quotes stays one word and nothing reaches a shell (a command that wants one starts it: cmd /c, powershell -Command).
 * %USERPROFILE% and the like are expanded. A placeholder it doesn't know is left as it is.
 */

/** A command's words with {name} filled in from values, each word on its own; null when there's no command. */
export function fillCommand(line: string, values: Record<string, string>): string[] | null {
  const words = splitCommand(expandEnv(line)).map((w) => w.replace(/\{([a-zA-Z]+)\}/g, (all, k: string) => (Object.hasOwn(values, k) ? values[k] : all)));
  return words.length ? words : null;
}

/** Runs a filled-in command in a folder. */
export async function runFilled(ctx: Ctx, line: string, values: Record<string, string>, cwd: string, timeoutMs = 30 * 60_000): Promise<Ran> {
  const words = fillCommand(line, values);
  if (!words) return { code: 2, out: '', err: 'no command' };
  const [cmd, ...args] = words;
  return ctx.run(cmd, args, { cwd, timeoutMs });
}

/** The last line a command said, for a round's line. */
const said = (r: Ran) => (r.err || r.out).trim().split('\n').pop()?.trim() || 'no output';

/**
 * After a release of a repository worked with plain git (release.ts): its After a release command, run in the clone.
 * Null when it ran (or there is none); else what it said, for a note on the release's line. Never throws.
 */
export async function runWhenReleased(ctx: Ctx, e: Employee, o: { commit: string; version: string; notes: string | null }): Promise<string | null> {
  if (hostIs(ctx, e) !== 'git' || !e.whenReleased) return null;
  const notesDir = mkdtempSync(path.join(os.tmpdir(), 'steward-released-'));
  try {
    const notesFile = path.join(notesDir, 'notes.md');
    writeFileSync(notesFile, o.notes ?? '');
    const repo = checkoutOf(e);
    const values = { repo: e.repo, checkout: repo, base: e.branch, tag: `v${o.version}`, version: o.version, commit: o.commit, notesFile };
    ctx.log(`[${e.id}] after its release: ${fillCommand(e.whenReleased, values)?.join(' ') ?? ''}`);
    const r = await runFilled(ctx, e.whenReleased, values, repo);
    for (const line of tail(`${r.out}\n${r.err}`, 15).split('\n')) if (line.trim()) ctx.log(`[${e.id}]   ${line}`);
    return r.code === 0 ? null : `exit ${r.code}: ${said(r)}`;
  } catch (err) {
    return (err as Error).message;
  } finally {
    rmSync(notesDir, { recursive: true, force: true });
  }
}
