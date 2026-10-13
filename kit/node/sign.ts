import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Code-signing a release's native files (native.ts, kit 2.62.0), as Manor signs its setup (Manor's tools/sign.ts). A
 * cloud certificate's key (Certum's SimplySign) shows itself to Windows as a smart card only while its desktop app is
 * connected, and its key provider comes as x64 and x86 DLLs only, which an Arm64 process can't load: so this always
 * runs the Windows SDK's x64 signtool (emulated on an Arm PC). Each file is signed, timestamped (RFC 3161, so the
 * signature outlives the certificate) and checked: Windows trusts it, it's the certificate's, it's timestamped.
 */

/** The longest one signtool run may take: a cloud key's sign-in, waiting where no one sees it, would hang a release. */
const SIGN_MS = 10 * 60_000;
const TRIES = 3;
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
 * Why signtool couldn't sign, in words a person can act on, from what it said; null when it said something else.
 * "No certificates were found" is its answer when the certificate is in the store but its key can't be reached: a
 * cloud key's app running but not connected (its session ends on its own).
 */
export function signProblem(text: string, thumbprint: string): string | null {
  if (!/No certificates were found that met all the given criteria/i.test(text)) return null;
  return `signtool can't reach the signing certificate's key (${thumbprint}). If its key is in Certum's cloud, connect SimplySign Desktop (your SimplySign ID and the token from the phone app), then release again`;
}

const powershell = (script: string, timeout = 60_000) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });

const run = (tool: string, args: string[], timeout: number) => {
  const r = spawnSync(tool, args, { encoding: 'utf8', windowsHide: true, timeout });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return { ok: false, timedOut: true, text: `signtool didn't finish within ${timeout / 60_000} minutes: is the certificate's sign-in waiting?` };
  return { ok: r.status === 0, timedOut: false, text: text || r.error?.message || `exit ${r.status}` };
};

const quotedPs = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface Signer {
  signtool: string;
  thumbprint: string;
  timestamp: string;
}

/**
 * Whether this PC can sign now, checked before a release builds anything: the signer, or why not in a line. A trial
 * signature (no timestamp) of a throwaway script finds a key that can't be reached before minutes of building do.
 */
export function readySigner(thumbprint: string, timestamp: string): Signer | { problem: string } {
  const signtool = findSignTool();
  if (!signtool) return { problem: 'the Windows SDK\'s signtool isn\'t installed (winget install Microsoft.WindowsSDK.10.0.26100 --override "/features OptionId.SigningTools /quiet /norestart")' };
  const r = powershell(`$c = Get-Item ${quotedPs(`Cert:\\CurrentUser\\My\\${thumbprint}`)} -ErrorAction SilentlyContinue; if (-not $c) { 'none' } elseif (-not $c.HasPrivateKey) { 'nokey' } else { 'ok' }`);
  const said = `${r.stdout ?? ''}`.trim();
  if (said === 'none') return { problem: `the signing certificate (${thumbprint}) isn't in Cert:\\CurrentUser\\My. If its key is in Certum's cloud, start SimplySign Desktop and connect` };
  if (said === 'nokey') return { problem: `the signing certificate (${thumbprint}) is here without its key` };
  if (said !== 'ok') return { problem: `couldn't look for the signing certificate: ${(r.stderr || said || r.error?.message || 'no answer').trim()}` };
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-sign-'));
  try {
    const file = path.join(dir, 'trial.ps1');
    writeFileSync(file, '# A trial signature, before the release builds.\r\n');
    const t = run(signtool, ['sign', '/sha1', thumbprint, '/fd', 'SHA256', file], 2 * 60_000);
    const problem = t.ok ? null : signProblem(t.text, thumbprint);
    if (problem) return { problem };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
 * and then); then checks every one is Valid, the certificate's, and timestamped. Throws with why when it can't.
 */
export function signFiles(s: Signer, files: string[], log: (line: string) => void = () => {}): void {
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    for (let attempt = 1; ; attempt++) {
      const r = run(s.signtool, signArgs(batch, s.thumbprint, s.timestamp), SIGN_MS);
      if (r.ok) break;
      const problem = signProblem(r.text, s.thumbprint);
      if (problem) throw new Error(`couldn't sign the native files: ${problem}`);
      if (r.timedOut || attempt >= TRIES) throw new Error(`couldn't sign the native files: ${r.text.split(/\r?\n/).slice(-5).join('\n')}`);
      log(`  signing failed (try ${attempt} of ${TRIES}), trying again in 15 s: ${r.text.split(/\r?\n/).pop()}`);
      spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 15'], { windowsHide: true });
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'kit-sign-'));
  try {
    const list = path.join(dir, 'files.txt');
    writeFileSync(list, files.join('\n'), 'utf8');
    const r = powershell(
      `Get-Content -LiteralPath ${quotedPs(list)} -Encoding UTF8 | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ne ${quotedPs(s.thumbprint)} -or -not $s.TimeStamperCertificate) { "$_|$($s.Status)" } }`,
      5 * 60_000,
    );
    const wrong = `${r.stdout ?? ''}`.trim();
    if (r.status !== 0 || wrong) throw new Error(`the native files' signatures don't check out (each should be Valid, ${s.thumbprint}'s, timestamped): ${wrong || (r.stderr ?? '').trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
