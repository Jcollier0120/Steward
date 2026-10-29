import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The license a PC holds, as Manor keeps it and every agent reads it (kit 2.45.0): Manor's licence.json, `{ token,
 * licence }`, in Manor's folder (%USERPROFILE%\.manor, or MANOR_HOME). `licence` is a compact JWS (EdDSA, Ed25519) the
 * Exchequer signs; it is read offline against the public keys carried here (LICENSE_KEYS), never by asking the
 * Exchequer. The token is Manor's secret for the Exchequer: nothing here uses it, and nothing here writes the file.
 *
 * Shared by Manor (its license.ts reads and keeps the license) and the agents (license-check.ts, the trial's end):
 * one copy of the keys, the payload and the check of a signature, and of this PC's id (deviceIdFor, isThisPc, kit
 * 2.110.0). Nothing here imports the agent's app.ts, so Manor and any agent can use it as it is.
 */

/** licence.json, in Manor's folder: the file name keeps Manor's spelling, as it is on disk. */
export const LICENSE_FILE = 'licence.json';

/**
 * The public keys a license may be signed with: the Exchequer's license signing key, as `npm run keys` in the
 * Exchequer's repository prints it (an Ed25519 public JWK). Compare a key's `kid` with the one the Exchequer's GET
 * /api/v1/health shows. A rotation carries both keys for a while (the Exchequer's docs/DEPLOY.md, "Rotating keys"),
 * then a later kit drops the old one. Not secret: these are public keys. MANOR_LICENCE_KEYS may add more, for
 * development and tests (trustedKeys).
 */
export const LICENSE_KEYS: readonly JsonWebKey[] = [
  // The Exchequer's first license signing key, made 2026-10-06.
  { kty: 'OKP', crv: 'Ed25519', x: 'W6O2WhitICK24HcImbinHcTV6OvADrhM2b0_YN2VQlE', kid: '-X2Q5MnESm2aqCbITQ05JKgEQmixpZ4n06EaZx99Sr8', alg: 'EdDSA', use: 'sig' },
];

/**
 * A license's tier: what it holds. An agent's own tier is `free`, `household`, `workshop` or `workshop-pro`, each
 * holding the ones before it; a trial holds every one (Workshop Pro, kit 2.144.1).
 */
export type LicenseTier = 'household' | 'workshop' | 'workshop-pro' | 'trial';

/** The tiers a license may have: a license of any other is refused, so a kit learns a tier before the Exchequer sells it. */
export const LICENSE_TIERS: readonly LicenseTier[] = ['household', 'workshop', 'workshop-pro', 'trial'];

/** The license's payload, exactly the Exchequer's (its src/domain/license.ts). */
export interface LicensePayload {
  lic: string;
  tier: LicenseTier;
  /** Releases published up to it are this license's; null while a paid license's first payment isn't confirmed. */
  updatesUntil: string | null;
  /** A trial's end: the only date that ever stops an agent. */
  runsUntil?: string;
  devices: number;
  /** The PC's id (Manor's device.json). */
  sub: string;
  /** When it was signed (seconds): the Exchequer's clock, so the time is at least this. */
  iat: number;
  exp: number;
}

/** licence.json as Manor writes it. */
export interface Held {
  token: string;
  licence: string;
}

/**
 * The keys a license may be signed with: the ones carried (LICENSE_KEYS), and MANOR_LICENCE_KEYS's for development
 * (a JWK, or a JSON list of them). One that can't be read is left out.
 */
export function trustedKeys(env: NodeJS.ProcessEnv = process.env, carried: readonly JsonWebKey[] = LICENSE_KEYS): JsonWebKey[] {
  const keys = [...carried];
  const extra = env.MANOR_LICENCE_KEYS?.trim();
  if (extra) {
    try {
      const j = JSON.parse(extra) as unknown;
      for (const k of Array.isArray(j) ? j : [j]) if (k && typeof k === 'object') keys.push(k as JsonWebKey);
    } catch { /* not JSON: none from it */ }
  }
  return keys.filter((k) => k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string');
}

/**
 * Whether this process reads this PC's license: always, but under node --test, where it reads it only with
 * MANOR_LICENSE_CHECK=on (so no agent's tests read this PC's own license). license-check.ts and developer-pro.ts ask.
 */
export const licenseCheckOn = (env: NodeJS.ProcessEnv = process.env) => !env.NODE_TEST_CONTEXT || env.MANOR_LICENSE_CHECK === 'on';

const b64 = (s: string) => Buffer.from(s, 'base64url');

/**
 * Verifies a compact JWS (EdDSA, Ed25519) against the trusted keys, the one its header's `kid` names first: its
 * payload, or why it isn't a license to trust, in words. Expiry isn't checked: an expired license is only stale.
 */
export function verifyLicense(jws: string, keys: readonly JsonWebKey[]): { payload: LicensePayload } | { error: string } {
  const parts = typeof jws === 'string' ? jws.split('.') : [];
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) return { error: "it isn't a signed license" };
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(b64(parts[0]).toString('utf8')) as Record<string, unknown>;
  } catch {
    return { error: "its header can't be read" };
  }
  if (header.alg !== 'EdDSA') return { error: `it's signed with ${String(header.alg)}, not EdDSA` };
  if (!keys.length) return { error: 'this copy of Castellan carries no key to check it with yet' };
  const kid = typeof header.kid === 'string' ? header.kid : null;
  // The key its kid names; a key that has no kid is tried too (one pasted without it).
  const tried = kid ? keys.filter((k) => (k as { kid?: unknown }).kid === kid || (k as { kid?: unknown }).kid === undefined) : keys;
  if (!tried.length) return { error: "it's signed with a key this copy of Castellan doesn't carry (a newer one may)" };
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = b64(parts[2]);
  const good = tried.some((k) => {
    try {
      const key = createPublicKey({ key: { kty: k.kty, crv: k.crv, x: k.x }, format: 'jwk' });
      return key.asymmetricKeyType === 'ed25519' && verify(null, data, key, signature);
    } catch {
      return false;
    }
  });
  if (!good) return { error: "its signature doesn't verify: it isn't one the Exchequer signed, or it was changed" };
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(b64(parts[1]).toString('utf8')) as Record<string, unknown>;
  } catch {
    return { error: "its payload can't be read" };
  }
  const iso = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
  if (
    typeof p.lic !== 'string' || !LICENSE_TIERS.includes(p.tier as LicenseTier) || !(p.updatesUntil === null || iso(p.updatesUntil)) ||
    (p.runsUntil !== undefined && !iso(p.runsUntil)) || typeof p.devices !== 'number' || typeof p.sub !== 'string' || typeof p.iat !== 'number' || typeof p.exp !== 'number'
  ) {
    return { error: "its payload isn't a license's" };
  }
  return { payload: p as unknown as LicensePayload };
}

/**
 * licence.json in `home` (Manor's folder), as it is: `missing` when there's no file, `unreadable` (with why) when it
 * can't be read or isn't `{ token, licence }`, or what it holds.
 */
export function readHeldFile(home: string): { held: Held } | { missing: true } | { unreadable: string } {
  let text: string;
  try {
    text = readFileSync(path.join(home, LICENSE_FILE), 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { missing: true } : { unreadable: `it can't be read (${code ?? (e as Error).message})` };
  }
  let j: Partial<Held>;
  try {
    j = JSON.parse(text.replace(/^﻿/, '')) as Partial<Held>;
  } catch {
    return { unreadable: "it isn't JSON" };
  }
  return j && typeof j.token === 'string' && j.token && typeof j.licence === 'string' && j.licence
    ? { held: { token: j.token, licence: j.licence } }
    : { unreadable: "it doesn't hold a license" };
}

/** licence.json's token and license, or null when there's none or it can't be read (Manor's readHeld). */
export function readHeld(home: string): Held | null {
  const r = readHeldFile(home);
  return 'held' in r ? r.held : null;
}

// ---------------------------------------------------------------- this PC

/** device.json, beside licence.json (or in an Everyone install's shared license folder): the id a license's `sub` names. */
export const DEVICE_FILE = 'device.json';

/** An id made from this PC (deviceIdFor), a version 8 UUID. One from before 2026-10-21 is random (version 4). */
const MADE_HERE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The id a PC takes (Manor's license.ts deviceIdFor, the setup's LicenseFiles.DeviceIdFor): Windows' id for this
 * installation (MachineGuid) and Manor's folder, hashed (SHA-256, as a version 8 UUID). Nothing in it can be read back.
 */
export function deviceIdFor(guid: string, home: string): string {
  const h = createHash('sha256').update(`castellan/device/v1\n${guid.trim().toLowerCase()}\n${path.resolve(home).toLowerCase()}`, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

let guidRead: string | null | undefined;

/** Windows' id for this installation (HKLM\SOFTWARE\Microsoft\Cryptography's MachineGuid), asked once; null where there's none. */
export function machineGuid(env: NodeJS.ProcessEnv = process.env): string | null {
  if (guidRead !== undefined) return guidRead;
  guidRead = null;
  if (process.platform !== 'win32') return guidRead;
  // reg.exe by its full path: never one found first in the folder it runs in, or on PATH.
  const reg = path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'reg.exe');
  const r = spawnSync(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  guidRead = r.status === 0 ? (/MachineGuid\s+REG_SZ\s+([0-9a-f-]{36})/i.exec(r.stdout)?.[1] ?? null) : null;
  return guidRead;
}

/** device.json's id in `folder`, or null when there's none to read. */
export function readDeviceId(folder: string): string | null {
  try {
    const j = JSON.parse(readFileSync(path.join(folder, DEVICE_FILE), 'utf8').replace(/^﻿/, '')) as { id?: unknown };
    return typeof j?.id === 'string' ? j.id : null;
  } catch {
    return null;
  }
}

/**
 * Whether a license's `sub` is this PC's, looked for in Manor's folder and, in an Everyone install, the shared license
 * folder (`folders`, where device.json is kept):
 * - device.json's id where one is kept, as Manor's readLicense has it;
 * - with none (a licence.json copied from another PC alone), an id made from a PC (version 8) is made again here from
 *   MachineGuid and each folder, and must be the same.
 * An id from before 2026-10-21 (random) with no device.json, or a PC whose MachineGuid can't be read: there's nothing
 * to check it by, so it is this PC's.
 */
export function isThisPc(sub: string, folders: readonly string[], guid: string | null = machineGuid()): boolean {
  const kept = folders.map(readDeviceId).filter((id): id is string => !!id);
  if (kept.length) return kept.includes(sub);
  if (!MADE_HERE.test(sub) || !guid) return true;
  return folders.some((f) => deviceIdFor(guid, f) === sub);
}
