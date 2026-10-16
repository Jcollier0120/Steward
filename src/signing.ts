import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSignTool, signProblem } from './kit/sign.ts';
import { dataFile, readJson, writeJson } from './kit/store.ts';
import type { Runner } from './run.ts';
import { checksLogOf } from './stages/bump.ts';

/**
 * Releases that sign wait for the key (Steward 0.36.30). The code-signing certificate's key is in Certum's cloud: Windows
 * reaches it only while SimplySign Desktop is connected, and its session ends on its own. A release that signs (an
 * agent's native files, kit.json's "native"; Manor's setup, its tools/sign.ts) checks the key itself before it builds,
 * and fails when it can't be reached; the rounds then left that commit to a person ("won't try it again"), one alarm per
 * release, and a Wright issue for each, for something no code change fixes. On 2026-10-14 Manor's, Envoy's and
 * Heiward's did.
 *
 * Now the Steward looks first: before a release that signs is started, whether this PC can sign with its certificate
 * (signingProblem: the certificate in the store with its key, and a trial signature). While it can't, the release waits
 * (`skipped`, nothing failed), signing-waits.json keeps it for one alarm that names them all, and the next round that can
 * sign releases them by itself. A release that fails anyway for the key (SimplySign's session ended mid-build) waits the
 * same way, and so does one a round gave up on for it before.
 *
 * Nor does the wait hold a round (0.36.60). A trial signature that didn't answer (SimplySign Desktop waiting for its
 * sign-in, which holds signtool until someone answers it) counted as "can sign", so the release went on to build and then
 * sat in its own signtool until its half-hour limit, the round and every merge after it waiting. Now the trial has
 * TRIAL_MS, one that doesn't answer in it is "can't sign", and that answer stands for HUNG_MS: the rounds meanwhile don't
 * wait on signtool again, and the release waits as above.
 */

/** A release waiting for the code-signing key, as signing-waits.json keeps it for the alarm. */
export interface SigningWait {
  version: string;
  commit: string;
  /** Why this PC can't sign, in a line. */
  why: string;
  /** When this version first waited. */
  since: string;
}

export const signingWaitsFile = () => dataFile('signing-waits.json');
export const loadSigningWaits = () => readJson<Record<string, SigningWait>>(signingWaitsFile(), {});

/** Keeps each employee's wait (an entry), or forgets it (null); writes only when something changed. */
export function noteSigningWaits(waits: Record<string, Omit<SigningWait, 'since'> | null>, now = new Date()): void {
  const all = loadSigningWaits();
  let changed = false;
  for (const [id, w] of Object.entries(waits)) {
    const was = all[id];
    if (!w) {
      if (was) {
        delete all[id];
        changed = true;
      }
      continue;
    }
    const since = was && was.version === w.version ? was.since : now.toISOString();
    if (was && was.version === w.version && was.commit === w.commit && was.why === w.why) continue;
    all[id] = { ...w, since };
    changed = true;
  }
  if (changed) writeJson(signingWaitsFile(), all);
}

const THUMBPRINT = /^[0-9a-f]{40}$/i;

/**
 * The certificate a release at a commit signs with (its SHA-1 thumbprint), or null when it signs nothing the Steward can
 * see: kit.json's `native.thumbprint` (kit 2.62.0) when its release command publishes, else a tools/sign.ts that names
 * one (`THUMBPRINT = '…'`, Manor's, whose setup is always signed).
 */
export function signsWith(o: { kitJson: string | null; signTs: string | null; release: string }): string | null {
  try {
    const native = JSON.parse((o.kitJson ?? '').replace(/^﻿/, ''))?.native;
    const t = native?.thumbprint;
    if (typeof t === 'string' && THUMBPRINT.test(t) && /(^|\s)--publish(\s|$)/.test(o.release)) return t.toUpperCase();
  } catch {
    // No kit.json, or one that isn't JSON: the kit's release says so itself.
  }
  const m = /\bTHUMBPRINT\s*=\s*['"]([0-9a-f]{40})['"]/i.exec(o.signTs ?? '');
  return m ? m[1].toUpperCase() : null;
}

/**
 * The line in a release's output that says it couldn't reach the code-signing key, or null when none does: signtool's
 * own words for it, and the kit's and Manor's for a key they found missing before building.
 */
export function signingDown(output: string): string | null {
  const lines = output.replace(/\r/g, '').split('\n').map((l) => l.trim());
  const said = [
    /signtool can't reach the signing certificate's key/i,
    /SimplySign Desktop isn't running/i,
    /the signing certificate \([0-9a-f]{40}\) isn't in Cert:/i,
    /No certificates were found that met all the given criteria/i,
  ];
  for (const re of said) {
    const line = lines.findLast((l) => re.test(l));
    if (line) return line.length > 300 ? `${line.slice(0, 299)}…` : line;
  }
  return null;
}

/** A release's kept output (failure.ts's keepFailure, beside its worktree) said it couldn't reach the key. */
export function keptSigningDown(dir: string): boolean {
  try {
    return signingDown(readFileSync(checksLogOf(dir), 'utf8')) !== null;
  } catch {
    return false;
  }
}

/** How long one look at a certificate answers for: the releases of one round share it. */
const LOOK_MS = 60_000;
/** How long a trial signature may take: a key in the cloud signs a small script in seconds. */
export const TRIAL_MS = 60_000;
/** How long a look whose trial signature didn't answer stands: the rounds within it don't wait on signtool again. */
export const HUNG_MS = 15 * 60_000;
const looks = new Map<string, { at: number; answer: Promise<string | null>; forMs: Promise<number> }>();

/** Forgets the looks taken (for a test). */
export const forgetSigningLooks = () => looks.clear();

const quotedPs = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Whether this PC can sign with the certificate now: null when it can, else why, in a line a person can act on. The
 * certificate in Cert:\CurrentUser\My with its key, then a trial signature of a throwaway script (no timestamp), as the
 * kit's readySigner does before a release builds: "No certificates were found" is signtool's answer while SimplySign
 * Desktop isn't connected; no answer within TRIAL_MS, its sign-in waiting. Anything else the trial says is left to the
 * release, which says it better. One look a minute per certificate, shared by the releases that ask at once; one whose
 * trial didn't answer stands for HUNG_MS. Never throws.
 */
export async function signingProblem(run: Runner, thumbprint: string, o: { now?: number; signtool?: string | null } = {}): Promise<string | null> {
  const now = o.now ?? Date.now();
  const was = looks.get(thumbprint);
  if (was && now - was.at < (await was.forMs)) return was.answer;
  const seen = look(run, thumbprint, o.signtool === undefined ? findSignTool() : o.signtool).catch(() => ({ why: null, hung: false }));
  const answer = seen.then((s) => s.why);
  looks.set(thumbprint, { at: now, answer, forMs: seen.then((s) => (s.hung ? HUNG_MS : LOOK_MS)) });
  return answer;
}

const connect = 'connect SimplySign Desktop (your SimplySign ID and the token from the phone app)';

/** One look: why this PC can't sign (null: it can), and whether that is a trial signature that didn't answer. */
async function look(run: Runner, thumbprint: string, signtool: string | null): Promise<{ why: string | null; hung: boolean }> {
  const said = await lookFor(run, thumbprint, signtool);
  return typeof said === 'object' && said !== null ? said : { why: said, hung: false };
}

async function lookFor(run: Runner, thumbprint: string, signtool: string | null): Promise<string | null | { why: string; hung: true }> {
  if (!signtool) return "the Windows SDK's signtool isn't installed, so nothing can be signed here";
  const store = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$c = Get-Item ${quotedPs(`Cert:\\CurrentUser\\My\\${thumbprint}`)} -ErrorAction SilentlyContinue; if (-not $c) { 'none' } elseif (-not $c.HasPrivateKey) { 'nokey' } else { 'ok' }`], { timeoutMs: 60_000 });
  const said = store.out.trim();
  if (said === 'none') return `the code-signing certificate (${thumbprint}) isn't in Cert:\\CurrentUser\\My: if its key is in Certum's cloud, ${connect}`;
  if (said === 'nokey') return `the code-signing certificate (${thumbprint}) is here without its key`;
  if (said !== 'ok') return null;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'steward-sign-'));
  try {
    const file = path.join(dir, 'trial.ps1');
    writeFileSync(file, '# A trial signature, before a release that signs.\r\n');
    const t = await run(signtool, ['sign', '/sha1', thumbprint, '/fd', 'SHA256', file], { timeoutMs: TRIAL_MS });
    if (t.code === 0) return null;
    // Its sign-in waiting for someone: no release builds meanwhile, and no round waits on it again for a while.
    if (t.timedOut) return { why: `signtool didn't answer within ${TRIAL_MS / 1000} seconds with the code-signing key (${thumbprint}): SimplySign Desktop may be waiting for you to sign in (your SimplySign ID and the token from the phone app)`, hung: true };
    return signProblem(`${t.out}\n${t.err}`, thumbprint) ? `signtool can't reach the code-signing key (${thumbprint}): ${connect}` : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
