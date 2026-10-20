import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CERTUM_TIMESTAMP } from './native.ts';

/**
 * Code-signing a release's native files (native.ts, kit 2.62.0), as Manor signs its setup (Manor's tools/sign.ts). A
 * cloud certificate's key (Certum's SimplySign) shows itself to Windows as a smart card only while its desktop app is
 * connected, and its key provider comes as x64 and x86 DLLs only, which an Arm64 process can't load: so this always
 * runs the Windows SDK's x64 signtool (emulated on an Arm PC). Each file is signed, timestamped (RFC 3161, so the
 * signature outlives the certificate) and checked: Windows trusts it, it's the certificate's, it's timestamped.
 *
 * A trial signature that doesn't answer is "can't sign" (kit 2.77.9). SimplySign Desktop asks for its sign-in when its
 * session has ended, and holds signtool until someone answers: a trial that timed out said nothing signProblem knew, so
 * the release built and then sat in signFiles for SIGN_MS, the Steward's round waiting on it. Now the trial has TRIAL_MS,
 * and signFiles tries one again before it signs, since the session may have ended while the release built.
 *
 * And a trial that fails at all is "can't sign" (kit 2.92.0). On 2026-10-20 SimplySign Desktop was running but its
 * session had dropped, and signtool said "The specified CSP could not be found.", words signProblem didn't know: the
 * trial left them to the real signing, Envoy 0.1.25 built for minutes, and then failed three times signing. Now the
 * trial is a real signature, timestamped as a release's are, that must succeed before anything is built; signtool's
 * words for a key it can't reach include the CSP's; and anything else it says is tried once more, then said as it is.
 */

/** The longest one signtool run may take: a cloud key's sign-in, waiting where no one sees it, would hang a release. */
const SIGN_MS = 10 * 60_000;
/** How long a trial signature may take: a key in the cloud signs and timestamps a small script in seconds. */
export const TRIAL_MS = 60_000;
const TRIES = 3;
/** Trial signatures before the trial says what signtool said: the timestamp server fails now and then. */
export const TRIAL_TRIES = 2;
/** How long between one try and the next. */
export const AGAIN_MS = 15_000;
/** Files signed per signtool run: one sign-in prompt per run at most, and a command line well under Windows' limit. */
const BATCH = 40;

const versionParts = (v: string) => v.split('.').map(Number);
const newestFirst = (a: string, b: string) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

/** The newest Windows SDK's x64 signtool (never its Arm64 one: see above); null when none is installed. */
export function findSignTool(env: NodeJS.ProcessEnv = process.env, list: (dir: string) => string[] = readdirSync, exists: (p: string) => boolean = existsSync): string | null {
  const bin = path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  let versions: string[];
  try {
    versions = list(bin).filter((d) => /^\d+(\.\d+){3}$/.test(d));
  } catch {
    return null;
  }
  for (const v of versions.sort(newestFirst)) {
    const tool = path.join(bin, v, 'x64', 'signtool.exe');
    if (exists(tool)) return tool;
  }
  return null;
}

/** signtool's arguments to sign and timestamp files with one certificate. */
export const signArgs = (files: string[], thumbprint: string, timestamp: string) => ['sign', '/sha1', thumbprint, '/fd', 'SHA256', '/tr', timestamp, '/td', 'SHA256', ...files];

/**
 * signtool's words for a certificate in the store whose key it can't reach: "No certificates were found" (SimplySign
 * Desktop not connected), "The specified CSP could not be found" (running, but its session dropped: 2026-10-20) and
 * "Keyset does not exist" (the key provider there, the key not).
 */
export const KEY_GONE = /No certificates were found that met all the given criteria|The specified CSP could not be found|Keyset does not exist/i;

/**
 * Why signtool couldn't sign, in words a person can act on, from what it said; null when it said something else: the
 * key can't be reached (KEY_GONE), a cloud key's app not connected or its session ended (it ends on its own).
 */
export function signProblem(text: string, thumbprint: string): string | null {
  if (!KEY_GONE.test(text)) return null;
  return `signtool can't reach the signing certificate's key (${thumbprint}). If its key is in Certum's cloud, connect SimplySign Desktop (your SimplySign ID and the token from the phone app), then release again`;
}

const powershell = (script: string, timeout = 60_000) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });

/** Waits, holding this thread (the release is a command line, with nothing else to do meanwhile). */
const pauseFor = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** signtool's last line or few, for a message. */
const lastLines = (text: string, n = 1) => text.trim().split(/\r?\n/).slice(-n).join('\n');

/** One signtool run: whether it signed, whether it ran out of time, and what it said. */
export type SignRun = (tool: string, args: string[], timeout: number) => { ok: boolean; timedOut: boolean; text: string };

const signIn = 'SimplySign Desktop may be waiting for you to sign in (your SimplySign ID and the token from the phone app)';

const run: SignRun = (tool, args, timeout) => {
  const r = spawnSync(tool, args, { encoding: 'utf8', windowsHide: true, timeout });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return { ok: false, timedOut: true, text: `signtool didn't finish within ${timeout / 60_000} minutes: ${signIn}` };
  return { ok: r.status === 0, timedOut: false, text: text || r.error?.message || `exit ${r.status}` };
};

/** What the trial says when signtool signed nothing for a reason it gave in other words: what it said, as it is. */
export const TRIAL_FAILED = "signtool couldn't sign a test file";

/**
 * Why a trial signature of a throwaway script says this PC can't sign now, or null when it signed: a real one, with the
 * release's timestamp (signArgs), so whatever a release's signing needs (the key, the timestamp server) is proved before
 * minutes of building. The key can't be reached (signProblem's words), or no answer within TRIAL_MS (its sign-in
 * waiting), is said at once; anything else is tried again after AGAIN_MS, TRIAL_TRIES in all, then said as signtool said it.
 */
export function trialProblem(signtool: string, thumbprint: string, o: { run?: SignRun; timestamp?: string; pause?: (ms: number) => void } = {}): string | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-sign-'));
  try {
    const file = path.join(dir, 'trial.ps1');
    writeFileSync(file, '# A trial signature, before a release signs.\r\n');
    for (let attempt = 1; ; attempt++) {
      const t = (o.run ?? run)(signtool, signArgs([file], thumbprint, o.timestamp ?? CERTUM_TIMESTAMP), TRIAL_MS);
      if (t.ok) return null;
      if (t.timedOut) return `signtool didn't answer within ${TRIAL_MS / 1000} seconds with the signing certificate's key (${thumbprint}): ${signIn}`;
      const gone = signProblem(t.text, thumbprint);
      if (gone) return gone;
      if (attempt >= TRIAL_TRIES) return `${TRIAL_FAILED} with the signing certificate (${thumbprint}), ${TRIAL_TRIES} tries: ${lastLines(t.text, 2).replace(/\r?\n/g, ' ')}`;
      (o.pause ?? pauseFor)(AGAIN_MS);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const quotedPs = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface Signer {
  signtool: string;
  thumbprint: string;
  timestamp: string;
}

/**
 * Whether this PC can sign now, checked before a release builds anything: the signer, or why not in a line. A trial
 * signature of a throwaway script, timestamped (trialProblem), finds a key that can't be reached before minutes of
 * building do.
 */
export function readySigner(thumbprint: string, timestamp: string): Signer | { problem: string } {
  const signtool = findSignTool();
  if (!signtool) return { problem: 'the Windows SDK\'s signtool isn\'t installed (winget install Microsoft.WindowsSDK.10.0.26100 --override "/features OptionId.SigningTools /quiet /norestart")' };
  const r = powershell(`$c = Get-Item ${quotedPs(`Cert:\\CurrentUser\\My\\${thumbprint}`)} -ErrorAction SilentlyContinue; if (-not $c) { 'none' } elseif (-not $c.HasPrivateKey) { 'nokey' } else { 'ok' }`);
  const said = `${r.stdout ?? ''}`.trim();
  if (said === 'none') return { problem: `the signing certificate (${thumbprint}) isn't in Cert:\\CurrentUser\\My. If its key is in Certum's cloud, start SimplySign Desktop and connect` };
  if (said === 'nokey') return { problem: `the signing certificate (${thumbprint}) is here without its key` };
  if (said !== 'ok') return { problem: `couldn't look for the signing certificate: ${(r.stderr || said || r.error?.message || 'no answer').trim()}` };
  const problem = trialProblem(signtool, thumbprint, { timestamp });
  if (problem) return { problem };
  return { signtool, thumbprint, timestamp };
}

/** Of these files, the ones whose Authenticode signature isn't Valid (unsigned, or signed in a way Windows won't trust). */
export function unsignedOf(files: string[]): string[] {
  if (!files.length) return [];
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-sign-'));
  try {
    const list = path.join(dir, 'files.txt');
    writeFileSync(list, files.join('\n'), 'utf8');
    const r = powershell(`Get-Content -LiteralPath ${quotedPs(list)} -Encoding UTF8 | ForEach-Object { if ((Get-AuthenticodeSignature -LiteralPath $_).Status -ne 'Valid') { $_ } }`, 5 * 60_000);
    if (r.status !== 0) throw new Error(`couldn't read the native files' signatures: ${(r.stderr || r.error?.message || '').trim()}`);
    const out = new Set(`${r.stdout ?? ''}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    return files.filter((f) => out.has(f));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Signs files and timestamps them, a batch at a time, trying a batch again when it fails (the timestamp server does now
 * and then); then checks every one is Valid, the certificate's, and timestamped. Throws with why when it can't. A trial
 * signature first: the key's session may have ended while the release built, and its sign-in would hold a batch for
 * SIGN_MS where the trial gives up in TRIAL_MS. A key that can't be reached (signProblem) isn't tried again.
 */
export function signFiles(s: Signer, files: string[], log: (line: string) => void = () => {}, o: { run?: SignRun; pause?: (ms: number) => void } = {}): void {
  const sign = o.run ?? run;
  const pause = o.pause ?? pauseFor;
  const lost = files.length ? trialProblem(s.signtool, s.thumbprint, { run: sign, timestamp: s.timestamp, pause }) : null;
  if (lost) throw new Error(`couldn't sign the native files: ${lost}`);
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    for (let attempt = 1; ; attempt++) {
      const r = sign(s.signtool, signArgs(batch, s.thumbprint, s.timestamp), SIGN_MS);
      if (r.ok) break;
      const problem = signProblem(r.text, s.thumbprint);
      if (problem) throw new Error(`couldn't sign the native files: ${problem}`);
      if (r.timedOut || attempt >= TRIES) throw new Error(`couldn't sign the native files: ${lastLines(r.text, 5)}`);
      log(`  signing failed (try ${attempt} of ${TRIES}), trying again in ${AGAIN_MS / 1000} s: ${lastLines(r.text)}`);
      pause(AGAIN_MS);
    }
  }
  const wrong = signaturesWrong(files, s.thumbprint);
  if (wrong) throw new Error(`the native files' signatures don't check out (each should be Valid, ${s.thumbprint}'s, timestamped): ${wrong}`);
}

/**
 * Of these files, the ones whose signature isn't Valid, the certificate's and timestamped, a line each ("<file>|<status>"),
 * or '' when every one is; what PowerShell said when it couldn't look.
 */
function signaturesWrong(files: string[], thumbprint: string): string {
  if (!files.length) return '';
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-sign-'));
  try {
    const list = path.join(dir, 'files.txt');
    writeFileSync(list, files.join('\n'), 'utf8');
    const r = powershell(
      `Get-Content -LiteralPath ${quotedPs(list)} -Encoding UTF8 | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ne ${quotedPs(thumbprint)} -or -not $s.TimeStamperCertificate) { "$_|$($s.Status)" } }`,
      5 * 60_000,
    );
    const wrong = `${r.stdout ?? ''}`.trim();
    return r.status !== 0 ? wrong || `${r.stderr ?? ''}`.trim() || r.error?.message || `PowerShell exited ${r.status}` : wrong;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether signed files kept from a release before still check out, with no key needed (signed-native.ts): `signtool
 * verify /pa` accepts every one (Windows' Authenticode policy: a signature it trusts, its maker's or this certificate's),
 * and those signed here are this certificate's and timestamped. Null when they do; else why, in a line.
 */
export function verifySigned(signtool: string | null, files: string[], signedHere: string[], thumbprint: string, o: { run?: SignRun; wrong?: typeof signaturesWrong } = {}): string | null {
  if (!signtool && files.length) return "the Windows SDK's signtool isn't installed, so they can't be verified";
  for (let i = 0; i < files.length; i += BATCH) {
    const r = (o.run ?? run)(signtool!, ['verify', '/pa', ...files.slice(i, i + BATCH)], SIGN_MS);
    if (!r.ok) return `signtool verify /pa refused them: ${lastLines(r.text, 3).replace(/\r?\n/g, ' ')}`;
  }
  const wrong = (o.wrong ?? signaturesWrong)(signedHere, thumbprint);
  return wrong ? `their signatures aren't all ${thumbprint}'s and timestamped: ${wrong.replace(/\r?\n/g, '; ')}` : null;
}
