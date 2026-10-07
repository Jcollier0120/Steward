/**
 * Publishing a release to the Exchequer, Castellan's release service (https://api.castellan-software.com): the staff
 * Castellan sells are downloaded from there by the PCs whose licence covers them (spec/RELEASES.md). release.ts calls
 * `publishToExchequer` after the release is on GitHub, with the very files it published there: the zip,
 * SHA256SUMS.txt and manor-agent.json when the agent announces itself.
 *
 * Since kit 2.37.0 every agent of Castellan's but Heiward, for sale or held back from sale, Manor among them, is
 * published here first and never to the public releases repository (release.ts' publishTo). `saleOf` (the list's
 * `forSale`) still says whether one is offered for hire.
 *
 * It publishes only an agent the Exchequer serves (its public `GET /api/v1/agents` lists it; Heiward never is, and
 * since kit 2.37.0 Manor is), and only with the publisher's key: `EXCHEQUER_PUBLISHER_KEY`, or `%USERPROFILE%\.steward\exchequer-publisher.key`.
 * The key is sent to the Exchequer alone, as a Bearer token, never to the storage its upload URLs point at, and never
 * printed: every line this module gives back has it taken out.
 *
 * Nothing here throws or fails the release: what happened is one line, and `ok`. GitHub's release stands either way.
 * Each step can be done again: a draft is made afresh, an upload replaces the file, and a release published already
 * (`409 already-published`, or `alreadyPublished` from /done) counts as published. So running it again finishes it:
 * `npm run release -- --exchequer` (release.ts) publishes a release already on GitHub from GitHub's own files.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the Exchequer is, unless EXCHEQUER_URL says. */
export const EXCHEQUER_URL = 'https://api.castellan-software.com';
/** The publisher's key, beside the Steward's data on the PC that releases. */
export const KEY_FILE = path.join('.steward', 'exchequer-publisher.key');
/**
 * Agents never published there, whatever it lists: Heiward, free, AGPL and public. Since kit 2.37.0 Manor is published
 * there (it updates from the Exchequer from 0.16.0 on), and nothing of Castellan's but Heiward is on GitHub.
 */
export const NEVER_SOLD = ['heiward'];
/** manor-agent.json, sent as the draft's announcement too (release.ts' ANNOUNCEMENT). */
const ANNOUNCEMENT = 'manor-agent.json';

/** How long a call waits: the agents list and the draft; each upload; /done, which hashes every byte (up to 300 s there). */
const ASK_MS = 30_000;
const UPLOAD_MS = 10 * 60_000;
const DONE_MS = 330_000;

/** What a release hands the Exchequer. `files` are the release's assets, as published on GitHub. */
export interface ExchequerRelease {
  id: string;
  version: string;
  commit: string;
  notes: string;
  files: string[];
}

/** Where to publish, and with what: from the environment and the home folder unless a caller (a test) says. */
export interface ExchequerOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetch?: typeof fetch;
}

/** What happened, in one line with no key in it. `ok` is false only when it should have been published and wasn't. */
export interface ExchequerOutcome {
  ok: boolean;
  outcome: 'published' | 'already' | 'not-sold' | 'no-key' | 'failed';
  line: string;
}

/** The start of the line when a release should have reached the Exchequer and didn't: the Steward's round notes it. */
export const NOT_PUBLISHED = 'Not published to the Exchequer:';

/** The Exchequer's address, without a trailing slash. */
export const exchequerUrl = (env: NodeJS.ProcessEnv = process.env) => (env.EXCHEQUER_URL?.trim() || EXCHEQUER_URL).replace(/\/+$/, '');

/** The publisher's key (EXCHEQUER_PUBLISHER_KEY, else the key file, trimmed), or where it was looked for. */
export function publisherKey(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): { key: string } | { missing: string } {
  const fromEnv = env.EXCHEQUER_PUBLISHER_KEY?.trim();
  if (fromEnv) return { key: fromEnv };
  const file = path.join(home, KEY_FILE);
  try {
    const key = existsSync(file) ? readFileSync(file, 'utf8').replace(/^﻿/, '').trim() : '';
    if (key) return { key };
  } catch {
    // Unreadable is missing.
  }
  return { missing: file };
}

/** Text with the key taken out, wherever it is. */
export const withoutKey = (text: string, key: string | null) => (key ? text.split(key).join('[the publisher key]') : text);

/** The words of a failed call: the Exchequer's own message when it gave one, else its status. */
async function why(res: Response): Promise<string> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    // Its status will do.
  }
  try {
    const j = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof j.message === 'string' && j.message) return `${j.message} (${res.status}${typeof j.error === 'string' ? ` ${j.error}` : ''})`;
  } catch {
    // Not JSON.
  }
  return `HTTP ${res.status}${body ? `: ${body.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
}

async function errorCode(res: Response): Promise<{ code: string | null; text: string }> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { error?: unknown };
    return { code: typeof j.error === 'string' ? j.error : null, text };
  } catch {
    return { code: null, text };
  }
}

const tagOf = (r: Pick<ExchequerRelease, 'id' | 'version'>) => `${r.id}-v${r.version}`;

/**
 * Whether the Exchequer sells an agent, and so serves its releases alone (kit 2.35.0): its public `GET /api/v1/agents`
 * gives each agent's `forSale` (Exchequer 0.6.0). `forSale` is
 * - true: for sale. Its release is published to the Exchequer, and not to the public releases repository.
 * - false: not for sale (Manor, Heiward, an agent held back from sale), or one the Exchequer doesn't list. Published to
 *   GitHub as before, and to the Exchequer when it takes it, so one that goes on sale is there already.
 * - null: the Exchequer couldn't say: it didn't answer, or answered without `forSale` (one from before 0.6.0, or whose
 *   database isn't migrated yet). Published to GitHub as before: an unsure Exchequer never keeps a release from it.
 * `line` says which, in words. Never throws.
 */
export interface Sale {
  forSale: boolean | null;
  line: string;
}

export async function saleOf(id: string, o: ExchequerOptions = {}): Promise<Sale> {
  if (NEVER_SOLD.includes(id)) return { forSale: false, line: `The Exchequer: ${id} isn't sold there.` };
  const base = exchequerUrl(o.env ?? process.env);
  const unsure = (said: string): Sale => ({ forSale: null, line: `The Exchequer couldn't say whether ${id} is for sale (${said}), so its release goes to GitHub as before.` });
  try {
    const listed = await (o.fetch ?? fetch)(`${base}/api/v1/agents`, { signal: AbortSignal.timeout(ASK_MS) });
    if (!listed.ok) return unsure(await why(listed));
    const agents = ((await listed.json().catch(() => null)) as { agents?: unknown } | null)?.agents;
    if (!Array.isArray(agents)) return unsure(`${base} didn't list its agents`);
    const agent = (agents as { id?: unknown; forSale?: unknown }[]).find((a) => a?.id === id);
    if (!agent) return { forSale: false, line: `The Exchequer doesn't sell ${id}, so its release goes to GitHub as before.` };
    if (typeof agent.forSale !== 'boolean') return unsure(`${base} doesn't say which agents are for sale yet`);
    return agent.forSale
      ? { forSale: true, line: `The Exchequer sells ${id}: its release is published there, and not to the public releases repository.` }
      : { forSale: false, line: `The Exchequer doesn't sell ${id} yet: its release goes to GitHub as before, and to the Exchequer too.` };
  } catch (e) {
    const err = e as Error;
    return unsure(err.name === 'TimeoutError' ? `${base} timed out` : `couldn't reach ${base}: ${err.message}`);
  }
}

/** Whether a release reached the Exchequer: published by this call, or there already. */
export const reachedExchequer = (out: Pick<ExchequerOutcome, 'outcome'>) => out.outcome === 'published' || out.outcome === 'already';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Publishes a release to the Exchequer, when it sells the agent and the key is here: a draft listing each file's name,
 * size and SHA-256, each file PUT to the signed URL it hands back, then /done, where the Exchequer checks them and
 * publishes. Never throws.
 */
export async function publishToExchequer(r: ExchequerRelease, o: ExchequerOptions = {}): Promise<ExchequerOutcome> {
  const env = o.env ?? process.env;
  const go = o.fetch ?? fetch;
  const tag = tagOf(r);
  if (NEVER_SOLD.includes(r.id)) return { ok: true, outcome: 'not-sold', line: `The Exchequer: ${r.id} isn't sold there, so ${tag} is on GitHub alone.` };
  const found = publisherKey(env, o.home ?? os.homedir());
  if ('missing' in found) return { ok: true, outcome: 'no-key', line: `${NOT_PUBLISHED} no publisher key at ${found.missing} (or EXCHEQUER_PUBLISHER_KEY).` };
  const key = found.key;
  const base = exchequerUrl(env);
  const failed = (what: string): ExchequerOutcome => ({
    ok: false,
    outcome: 'failed',
    line: withoutKey(`${NOT_PUBLISHED} ${what}. The GitHub release stands; npm run release -- --exchequer finishes it.`, key),
  });
  const auth = { authorization: `Bearer ${key}` };
  try {
    const listed = await go(`${base}/api/v1/agents`, { signal: AbortSignal.timeout(ASK_MS) });
    if (!listed.ok) return failed(`couldn't ask ${base} which agents it sells: ${await why(listed)}`);
    const agents = ((await listed.json()) as { agents?: { id?: unknown }[] }).agents;
    if (!Array.isArray(agents)) return failed(`${base} didn't list the agents it sells`);
    if (!agents.some((a) => a?.id === r.id)) return { ok: true, outcome: 'not-sold', line: `The Exchequer: ${r.id} isn't one of the agents it sells, so ${tag} is on GitHub alone.` };

    let files: { name: string; bytes: Buffer }[];
    let announcement: unknown;
    try {
      files = r.files.map((f) => ({ name: path.basename(f), bytes: readFileSync(f) }));
      const announced = files.find((f) => f.name === ANNOUNCEMENT);
      announcement = announced ? JSON.parse(announced.bytes.toString('utf8').replace(/^﻿/, '')) : undefined;
    } catch (e) {
      return failed(`its files couldn't be read: ${(e as Error).message}`);
    }
    const assets = files.map((f) => ({ name: f.name, size: f.bytes.length, sha256: sha256(f.bytes) }));
    const at = `${base}/api/v1/publish/${encodeURIComponent(r.id)}/${encodeURIComponent(r.version)}`;

    const draft = await go(at, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ commit: r.commit, notes: r.notes, assets, ...(announcement ? { announcement } : {}) }),
      signal: AbortSignal.timeout(ASK_MS),
    });
    if (draft.status === 409) {
      const { code, text } = await errorCode(draft);
      if (code === 'already-published') return { ok: true, outcome: 'already', line: `The Exchequer has ${tag} published already.` };
      return failed(`${at} refused the draft: ${text.slice(0, 200) || 'HTTP 409'}`);
    }
    if (!draft.ok) return failed(`the draft of ${tag} was refused: ${await why(draft)}`);
    const uploads = ((await draft.json()) as { uploads?: { name?: unknown; url?: unknown; method?: unknown; headers?: unknown }[] }).uploads ?? [];
    for (const f of files) {
      const u = uploads.find((x) => x?.name === f.name);
      if (!u || typeof u.url !== 'string') return failed(`it gave no upload address for ${f.name}`);
      // The signed URL carries its own permission: the publisher's key never goes to the storage.
      const headers = u.headers && typeof u.headers === 'object' ? (u.headers as Record<string, string>) : {};
      const put = await go(u.url, { method: typeof u.method === 'string' ? u.method : 'PUT', headers, body: new Uint8Array(f.bytes), signal: AbortSignal.timeout(UPLOAD_MS) });
      if (!put.ok) return failed(`uploading ${f.name} failed: ${await why(put)}`);
    }
    const done = await go(`${at}/done`, { method: 'POST', headers: auth, signal: AbortSignal.timeout(DONE_MS) });
    if (!done.ok) return failed(`${tag} wasn't published after its upload: ${await why(done)}`);
    const said = (await done.json().catch(() => ({}))) as { alreadyPublished?: unknown };
    if (said.alreadyPublished === true) return { ok: true, outcome: 'already', line: `The Exchequer has ${tag} published already.` };
    return { ok: true, outcome: 'published', line: `Published to the Exchequer: ${tag} (${files.map((f) => f.name).join(', ')}).` };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const cause = err.cause?.code ?? err.cause?.message;
    return failed(`couldn't reach ${base}: ${err.name === 'TimeoutError' ? 'it timed out' : `${err.message}${cause ? ` (${cause})` : ''}`}`);
  }
}
