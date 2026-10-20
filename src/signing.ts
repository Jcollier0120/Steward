import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions } from './kitfiles.ts';
import { CERTUM_TIMESTAMP, nativeOf, nativeSources, type Native } from './kit/native.ts';
import { AGAIN_MS, findSignTool, KEY_GONE, signArgs, signProblem, TRIAL_FAILED, TRIAL_TRIES } from './kit/sign.ts';
import { keptSigned, signedKey, signedStoreOf, sourcesAt } from './kit/signed-native.ts';
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
 *
 * Nor does a sign-in that starts waiting while a release builds (0.36.62). The kit's release gave up on signtool only
 * after ten minutes, in words signingDown didn't know, so the release failed for good, and each release after it in the
 * round built and waited its ten minutes too. Now those words are a signing wait (signingHung), the release that met
 * them stands as the look at its certificate for HUNG_MS (noteSigningDown), and kit 2.77.9 tries a trial signature with
 * TRIAL_MS before it signs, so it gives up in a minute.
 *
 * Nor a key whose session dropped while its app ran (0.36.161). On 2026-10-20 SimplySign Desktop had been running for
 * four days but its session had dropped, and signtool said "The specified CSP could not be found.": words neither the
 * look nor signingDown knew, so the look said "can sign", Envoy 0.1.25 built, failed signing, and the rounds left it to a
 * person. Now those words (the kit's KEY_GONE) are the key gone; the look is a real signature, timestamped as a
 * release's, and any failure of it is "can't sign", in signtool's words; and a release waiting between builds is
 * released by itself (a build of its own, pipeline.ts's `signed`) once a round's look can sign again. A release whose kit
 * takes its signed native files from a release before (KEEPS_SIGNED_KIT, the kit's signed-native.ts) is looked at only
 * when it will sign (needsSigning): most then don't wait for SimplySign at all.
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

/**
 * What the look before a build found (stages/round.ts's signingAhead, Steward 0.36.161): this PC can't sign now, and the
 * build at `build` (ISO) would sign these releases ("Envoy 0.1.26"); for an alarm an hour ahead, so the person can
 * reconnect SimplySign Desktop in time.
 */
export interface SigningAhead {
  build: string;
  names: string[];
  why: string;
  since: string;
}

export const signingAheadFile = () => dataFile('signing-ahead.json');
export const loadSigningAhead = () => readJson<SigningAhead | null>(signingAheadFile(), null);

/** Keeps what the look before a build found, or that nothing waits (null); writes only when it changed. */
export function noteSigningAhead(a: SigningAhead | null): void {
  if (JSON.stringify(loadSigningAhead()) !== JSON.stringify(a)) writeJson(signingAheadFile(), a);
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

/** signtool that gave up waiting, in the kit's words and Manor's tools/sign.ts's (the kit's before 2.77.9 too): its sign-in waiting. */
const HUNG = /signtool didn't (?:finish|answer) within/i;

/** Whether a line signingDown found says signtool hung (SimplySign Desktop's sign-in waiting), not just that the key is gone. */
export const signingHung = (line: string): boolean => HUNG.test(line);

/**
 * The line in a release's output that says it couldn't reach the code-signing key, or null when none does: signtool's
 * own words for it (the kit's KEY_GONE: "No certificates were found", "The specified CSP could not be found", "Keyset
 * does not exist"), and the kit's and Manor's for a key they found missing before building, for a signtool that didn't
 * answer, and for a test signature that failed (kit 2.92.0); last, the kit's line for any signer it couldn't have.
 */
export function signingDown(output: string): string | null {
  const lines = output.replace(/\r/g, '').split('\n').map((l) => l.trim());
  const said = [
    /signtool can't reach the signing certificate's key/i,
    /SimplySign Desktop isn't running/i,
    /the signing certificate \([0-9a-f]{40}\) isn't in Cert:/i,
    KEY_GONE,
    HUNG,
    new RegExp(TRIAL_FAILED, 'i'),
    /Not published: its native files can't be signed/i,
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

/**
 * Takes what a release that failed for the key said as the look at its certificate: the releases after it in the round
 * don't build only to find the same, and when signtool hung there (its sign-in waiting), none waits on it again for
 * HUNG_MS, as after a trial signature that didn't answer.
 */
export function noteSigningDown(thumbprint: string, why: string, o: { now?: number } = {}): void {
  looks.set(thumbprint, { at: o.now ?? Date.now(), answer: Promise.resolve(why), forMs: Promise.resolve(signingHung(why) ? HUNG_MS : LOOK_MS) });
}

const quotedPs = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Whether this PC can sign with the certificate now: null when it can, else why, in a line a person can act on. The
 * certificate in Cert:\CurrentUser\My with its key, then a trial signature of a throwaway script, timestamped as a
 * release's are, as the kit's readySigner does before a release builds (kit 2.92.0): signtool's words for a key it
 * can't reach (KEY_GONE) while SimplySign Desktop isn't connected or its session has dropped; no answer within TRIAL_MS,
 * its sign-in waiting; anything else (a timestamp server that didn't answer) tried again after AGAIN_MS, TRIAL_TRIES in
 * all as the kit's, then said as signtool said it. One look a minute per certificate, shared by the releases that ask at
 * once; one whose trial didn't answer stands for HUNG_MS. Never throws.
 */
export async function signingProblem(run: Runner, thumbprint: string, o: { now?: number; signtool?: string | null; timestamp?: string; pause?: (ms: number) => Promise<void> } = {}): Promise<string | null> {
  const now = o.now ?? Date.now();
  const was = looks.get(thumbprint);
  if (was && now - was.at < (await was.forMs)) return was.answer;
  const pause = o.pause ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const seen = look(run, thumbprint, o.signtool === undefined ? findSignTool() : o.signtool, o.timestamp ?? CERTUM_TIMESTAMP, pause).catch(() => ({ why: null, hung: false }));
  const answer = seen.then((s) => s.why);
  looks.set(thumbprint, { at: now, answer, forMs: seen.then((s) => (s.hung ? HUNG_MS : LOOK_MS)) });
  return answer;
}

const connect = 'connect SimplySign Desktop (your SimplySign ID and the token from the phone app)';

/** One look: why this PC can't sign (null: it can), and whether that is a trial signature that didn't answer. */
async function look(run: Runner, thumbprint: string, signtool: string | null, timestamp: string, pause: (ms: number) => Promise<void>): Promise<{ why: string | null; hung: boolean }> {
  const said = await lookFor(run, thumbprint, signtool, timestamp, pause);
  return typeof said === 'object' && said !== null ? said : { why: said, hung: false };
}

async function lookFor(run: Runner, thumbprint: string, signtool: string | null, timestamp: string, pause: (ms: number) => Promise<void>): Promise<string | null | { why: string; hung: true }> {
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
    for (let attempt = 1; ; attempt++) {
      const t = await run(signtool, signArgs([file], thumbprint, timestamp), { timeoutMs: TRIAL_MS });
      if (t.code === 0) return null;
      // Its sign-in waiting for someone: no release builds meanwhile, and no round waits on it again for a while.
      if (t.timedOut) return { why: `signtool didn't answer within ${TRIAL_MS / 1000} seconds with the code-signing key (${thumbprint}): SimplySign Desktop may be waiting for you to sign in (your SimplySign ID and the token from the phone app)`, hung: true };
      const text = `${t.out}\n${t.err}`;
      if (signProblem(text, thumbprint)) return `signtool can't reach the code-signing key (${thumbprint}): ${connect}`;
      if (attempt < TRIAL_TRIES) {
        await pause(AGAIN_MS);
        continue;
      }
      const last = text.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || `exit ${t.code}`;
      return `${TRIAL_FAILED} with the code-signing key (${thumbprint}): ${last.length > 200 ? `${last.slice(0, 199)}…` : last}`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The kit from which a release takes the signed native files a release before kept (the kit's signed-native.ts). */
export const KEEPS_SIGNED_KIT = '2.92.0';

/**
 * Whether a release at `commit` will sign anything, so the look before it is worth taking (and a release that won't
 * isn't held while this PC can't sign): yes for one that signs every time (Manor's setup, its tools/sign.ts; an agent
 * whose kit is older than KEEPS_SIGNED_KIT); for an agent's native files, unless a release before kept their signed
 * files for every processor from the native sources `commit` has (the kit's signedKey, in the agent's checkout data
 * folder: signedStoreOf). Anything the Steward can't read is "yes". Never throws.
 */
export async function needsSigning(run: Runner, o: { id: string; repo: string; commit: string; kitJson: string | null; env?: NodeJS.ProcessEnv; home?: string }): Promise<boolean> {
  let native: Native | null = null;
  let kit: unknown;
  try {
    const pin = JSON.parse((o.kitJson ?? '').replace(/^﻿/, ''));
    kit = pin?.kit;
    const n = nativeOf(pin);
    native = n && !('error' in n) ? n : null;
  } catch {
    return true;
  }
  if (!native?.thumbprint || typeof kit !== 'string' || compareVersions(kit, KEEPS_SIGNED_KIT) < 0) return true;
  const objects: Record<string, string | null> = {};
  for (const p of nativeSources(native)) {
    const r = await run('git', ['rev-parse', `${o.commit}:${p}`], { cwd: o.repo, timeoutMs: 60_000 }).catch(() => null);
    objects[p] = r && r.code === 0 ? r.out.trim() : null;
  }
  const sources = sourcesAt(native, (p) => objects[p] ?? null);
  if (!sources) return true;
  const store = signedStoreOf(o.id, o.env, o.home);
  return native.arch.some((a) => !keptSigned(store, signedKey(native, a, sources)));
}
