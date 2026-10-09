import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The license a PC holds, as Manor keeps it and every agent reads it (kit 2.45.0): Manor's licence.json, `{ token,
 * licence }`, in Manor's folder (%USERPROFILE%\.manor, or MANOR_HOME). `licence` is a compact JWS (EdDSA, Ed25519) the
 * Exchequer signs; it is read offline against the public keys carried here (LICENSE_KEYS), never by asking the
 * Exchequer. The token is Manor's secret for the Exchequer: nothing here uses it, and nothing here writes the file.
 *
 * Shared by Manor (its license.ts reads and keeps the license) and the agents (license-check.ts, the trial's end):
 * one copy of the keys, the payload and the check of a signature. Nothing here imports the agent's app.ts, so Manor
 * and any agent can use it as it is.
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

/** A license's tier: what it holds. An agent's own tier is `free`, `household` or `workshop`. */
export type LicenseTier = 'household' | 'workshop' | 'trial';

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
    typeof p.lic !== 'string' || (p.tier !== 'household' && p.tier !== 'workshop' && p.tier !== 'trial') || !(p.updatesUntil === null || iso(p.updatesUntil)) ||
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
