import { createPrivateKey, createPublicKey, createHash, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exchequerUrl, publisherKey, withoutKey } from './kit/exchequer.ts';

/**
 * The owner's recall list (Manor's src/recalls.ts, the Exchequer's src/domain/recalls.ts): retire an employee (no longer
 * offered; one at work goes on), or recall some of its versions (stopped on every PC, updated to a fix where there is
 * one, else taken off with its data kept). Each says why, in words for the person whose PC it's on.
 *
 * The list is signed here, with the recall key in .steward\recall-signing-key.pem, and only here: the Exchequer keeps
 * and hands out the latest, and every Manor checks the signature itself. Each new list is the one the Exchequer holds
 * with one change, numbered one beyond it (an older number is refused, so an old list replayed lifts nothing).
 */

export const RECALL_KEY_FILE = path.join('.steward', 'recall-signing-key.pem');
export const RECALLS_KIND = 'castellan-recalls';
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
const MAX_WHY = 500;

export interface RecallEntry {
  id: string;
  action: 'retire' | 'recall';
  versions?: { from?: string; to?: string };
  why: string;
  instead?: string;
  since: string;
}

export interface RecallList {
  kind: typeof RECALLS_KIND;
  seq: number;
  iat: number;
  entries: RecallEntry[];
}

/** The recall key, or where it should be. */
export function recallKey(home = os.homedir()): { key: KeyObject } | { missing: string } {
  const file = path.join(home, RECALL_KEY_FILE);
  if (!existsSync(file)) return { missing: file };
  const key = createPrivateKey(readFileSync(file, 'utf8'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} isn't an Ed25519 private key`);
  return { key };
}

/** A public key's RFC 7638 thumbprint: the kid Manor and the Exchequer carry beside it. */
export function kidOf(key: KeyObject): string {
  const j = createPublicKey(key).export({ format: 'jwk' }) as { crv: string; kty: string; x: string };
  return createHash('sha256').update(JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x })).digest('base64url');
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** The list as a compact JWS (EdDSA), signed with the recall key. */
export function signRecalls(list: RecallList, key: KeyObject): string {
  const head = `${b64({ alg: 'EdDSA', typ: 'JWT', kid: kidOf(key) })}.${b64(list)}`;
  return `${head}.${sign(null, Buffer.from(head), key).toString('base64url')}`;
}

/** A list signed with this key: its payload. Throws when it isn't one (signed with another key, or changed). */
export function readSigned(jws: string, key: KeyObject): RecallList {
  const parts = jws.split('.');
  if (parts.length !== 3 || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey(key), Buffer.from(parts[2], 'base64url'))) {
    throw new Error("the Exchequer's recall list isn't signed with this PC's recall key: it was changed, or signed elsewhere. Nothing was sent.");
  }
  const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as RecallList;
  if (p.kind !== RECALLS_KIND || !Number.isSafeInteger(p.seq) || !Array.isArray(p.entries)) throw new Error("the Exchequer's recall list isn't one");
  return p;
}

/** "0.4.26", "0.4.20..0.4.26", "..0.4.26" or "0.4.20..": the versions an entry covers, both ends included. */
export function parseVersions(text: string): { from?: string; to?: string } {
  const [from, to, more] = text.includes('..') ? text.split('..') : [text, text];
  if (more !== undefined || (!from && !to)) throw new Error(`--versions takes 0.4.26, 0.4.20..0.4.26, ..0.4.26 or 0.4.20.., not ${text}`);
  for (const v of [from, to]) if (v && !VERSION.test(v)) throw new Error(`${v} isn't a version`);
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

export type Change =
  | { kind: 'recall'; id: string; why: string; versions?: { from?: string; to?: string }; instead?: string }
  | { kind: 'retire'; id: string; why: string; instead?: string }
  | { kind: 'lift'; id: string };

/** The list after one change, numbered one beyond the one it came from. */
export function changed(was: RecallList | null, c: Change, now: Date): RecallList {
  if (!AGENT_ID.test(c.id)) throw new Error(`${c.id} isn't an agent id`);
  let entries = [...(was?.entries ?? [])];
  if (c.kind === 'lift') {
    if (!entries.some((e) => e.id === c.id)) throw new Error(`${c.id} isn't retired or recalled.`);
    entries = entries.filter((e) => e.id !== c.id);
  } else {
    const why = c.why.trim();
    if (!why) throw new Error(`--why is needed: the words the person whose PC it's on reads, saying why`);
    if (why.length > MAX_WHY) throw new Error(`--why is ${why.length} characters: at most ${MAX_WHY}`);
    if (c.instead !== undefined && !AGENT_ID.test(c.instead)) throw new Error(`--instead ${c.instead} isn't an agent id`);
    const entry: RecallEntry = {
      id: c.id,
      action: c.kind,
      ...(c.kind === 'recall' && c.versions ? { versions: c.versions } : {}),
      why: /[.!?]$/.test(why) ? why : `${why}.`,
      ...(c.instead ? { instead: c.instead } : {}),
      since: now.toISOString(),
    };
    // A retirement replaces the one before; a recall replaces one of the same versions, and sits beside others.
    const same = (e: RecallEntry) => e.id === c.id && e.action === c.kind && JSON.stringify(e.versions ?? null) === JSON.stringify(entry.versions ?? null);
    entries = [...entries.filter((e) => !same(e)), entry];
  }
  return { kind: RECALLS_KIND, seq: (was?.seq ?? 0) + 1, iat: Math.floor(now.getTime() / 1000), entries };
}

/** An entry in a line: "porter: recalled 0.4.26 (since 2026-10-11): It could delete files…" */
export function entryLine(e: RecallEntry): string {
  const v = e.versions ? (e.versions.from === e.versions.to ? e.versions.from : `${e.versions.from ?? ''}..${e.versions.to ?? ''}`) : null;
  const what = e.action === 'retire' ? 'retired' : `recalled ${v ?? 'every version'}`;
  return `${e.id}: ${what}${e.instead ? `, ${e.instead} instead` : ''} (since ${e.since.slice(0, 10)}): ${e.why}`;
}

export interface RecallsDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => Date;
}

/** The list the Exchequer holds now, as signed (null before the first). */
export async function heldRecalls(d: RecallsDeps = {}): Promise<string | null> {
  const f = d.fetch ?? fetch;
  const res = await f(`${exchequerUrl(d.env)}/api/v1/recalls`, { headers: { accept: 'application/json', 'user-agent': 'Steward' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`the Exchequer answered ${res.status} to GET /recalls${res.status === 404 ? ' (an Exchequer older than 0.7.20 has none)' : ''}`);
  const j = (await res.json()) as { recalls?: unknown };
  return typeof j.recalls === 'string' ? j.recalls : null;
}

/**
 * One change to the list, signed here and sent to the Exchequer (PUT /admin/recalls, with the publisher's key).
 * `dryRun`: only the list it would send.
 */
export async function sendChange(c: Change, o: RecallsDeps & { dryRun?: boolean } = {}): Promise<{ list: RecallList; sent: boolean }> {
  const k = recallKey(o.home);
  if ('missing' in k) throw new Error(`There's no recall key on this PC (${k.missing}): recalls are signed only on the PC that holds it.`);
  const held = await heldRecalls(o);
  const list = changed(held ? readSigned(held, k.key) : null, c, (o.now ?? (() => new Date()))());
  if (o.dryRun) return { list, sent: false };
  const pk = publisherKey(o.env, o.home);
  if ('missing' in pk) throw new Error(`There's no publisher key on this PC (${pk.missing}).`);
  const f = o.fetch ?? fetch;
  const res = await f(`${exchequerUrl(o.env)}/api/v1/admin/recalls`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${pk.key}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Steward' },
    body: JSON.stringify({ recalls: signRecalls(list, k.key) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let why = `${res.status}`;
    try {
      why = (JSON.parse(text) as { message?: string }).message ?? why;
    } catch { /* not JSON */ }
    throw new Error(`The Exchequer didn't take the recall list: ${withoutKey(why, pk.key)}`);
  }
  return { list, sent: true };
}
