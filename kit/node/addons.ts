import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The model's add-ons (spec/ACCELERATORS.md, Add-ons): LoRA adapters for Qwen3-VL-2B-Instruct, one per job, pinned in
 * spec/addons.json. A request names its job (AskOptions.job: `warrener.name`); the kit maps the job to its add-on and
 * applies it per request (llama-server's `lora: [{id, scale}]`), on a server that loaded it at its start
 * (`--lora <file> --lora-init-without-apply`). Every request to such a server names every add-on it carries, each at 0
 * but the one applied (addonsOff, addonFor): llama.cpp b11645 runs a request that names none with each at its load
 * scale, 1, whatever --lora-init-without-apply says (measured on the X2's NPU, 2026-11-06: 8 names of 8 the add-on's,
 * writing 63 tokens a second against 73), and its --lora-scaled can't take a Windows path (it splits at the drive's
 * colon). Never through `POST /lora-adapters`, which changes every later request's, and leaves the cached prompt of the
 * add-on before it.
 *
 * Where it runs, by the owner's rule (2026-11-06): on a PC with an NPU, an add-on stays on the NPU. A Snapdragon's NPU
 * applies it (llama-server on the Hexagon); an NPU whose route can't (Intel's OpenVINO, AMD's FastFlowLM, a Snapdragon
 * that fell back to GenieX) runs the request without it. A graphics card or the processor loads one only on a PC with no
 * NPU. Setup downloads a pinned add-on like a model, its SHA-256 checked, once the staff member that uses it is hired
 * (wantedAddons). The answer says whether it was applied, and which (NpuAnswer.addon), so a cache can key by it.
 */

export interface AddonPin {
  /** Its name, the one answers report: `warrener-r1-qv`. */
  id: string;
  /** The staff member that uses it (their id): setup fetches it once they're hired here. */
  staff: string;
  /** The jobs that ask for it, as requests name them (AskOptions.job). */
  jobs: string[];
  /** The model it was trained for. */
  base: string;
  file: string;
  size: number;
  sha256: string;
  /** Where setup downloads it from (its public release). */
  url: string;
  /** Whether the file is up at `url`: until then nothing downloads it, and only a copy put in place by hand is used. */
  published: boolean;
  /** `f16`: the only kind pinned (a Q8_0 add-on gives NaN on the Hexagon). */
  type: string;
  rank: number;
  targets: string[];
  licence: string;
  basis: string;
}

export interface AddonCatalog {
  version: number;
  addons: AddonPin[];
}

/** The spec's addons.json, as the node part brings it. */
export const ADDONS: AddonCatalog = JSON.parse(readFileSync(new URL('./spec/addons.json', import.meta.url), 'utf8').replace(/^﻿/, ''));

/** The add-on pinned for a job (its first, in the catalog's order), or null: a job without one runs as any request does. */
export function addonForJob(job: string | undefined, catalog: AddonCatalog = ADDONS): AddonPin | null {
  if (!job) return null;
  return catalog.addons.find((a) => a.jobs.includes(job)) ?? null;
}

/** Where setup keeps an add-on: the tools home's models\addons, under its pinned file name. */
export const addonFile = (pin: Pick<AddonPin, 'file'>, tools: string) => path.join(tools, 'models', 'addons', pin.file);

/** A staff member's home on this PC (`<ID>_HOME`, else `%USERPROFILE%\.<id>`), as page-access.ts' staffHome has it. */
const staffHome = (id: string, env: Record<string, string | undefined>) => env[`${id.toUpperCase().replace(/-/g, '_')}_HOME`] || path.join(os.homedir(), `.${id}`);

/** Whether a staff member is hired here: its app is installed (`<home>\app`, as the keeper finds the Smith's). */
export const hired = (staff: string, o: { env?: Record<string, string | undefined>; exists?: (p: string) => boolean } = {}) =>
  (o.exists ?? existsSync)(path.join(staffHome(staff, o.env ?? process.env), 'app'));

export interface WantedAddon {
  pin: AddonPin;
  /** Where it is (or will be) in the tools home. */
  file: string;
  /** Whether a file is there already (at its size; setup checks its SHA-256 before it's loaded). */
  have: boolean;
}

/**
 * The add-ons this PC's servers should load: each pinned F16 one whose staff member is hired here, and that is either
 * published (setup downloads it) or already in place (a copy put there by hand before its release). In the catalog's
 * order, which is the order of their `--lora` flags, so of their ids on the server.
 */
export function wantedAddons(o: { tools: string; env?: Record<string, string | undefined>; exists?: (p: string) => boolean; size?: (p: string) => number | null; catalog?: AddonCatalog }): WantedAddon[] {
  const exists = o.exists ?? existsSync;
  const size = o.size ?? ((p: string) => statSync(p, { throwIfNoEntry: false })?.size ?? null);
  const out: WantedAddon[] = [];
  for (const pin of (o.catalog ?? ADDONS).addons) {
    if (pin.type !== 'f16' || !hired(pin.staff, { env: o.env, exists })) continue;
    const file = addonFile(pin, o.tools);
    const have = exists(file) && size(file) === pin.size;
    if (pin.published || have) out.push({ pin, file, have });
  }
  return out;
}

/** A file's SHA-256, read as a stream (npu-vendors.ts' sha256File, here so npu-vendors.ts can take addonArgs from this module). */
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** An add-on's file checked against its pin: null when it's the pinned one, else what's wrong. */
export async function checkAddon(w: Pick<WantedAddon, 'pin' | 'file'>, hash: (f: string) => Promise<string> = sha256File): Promise<string | null> {
  const s = statSync(w.file, { throwIfNoEntry: false });
  if (!s) return `${w.pin.file} isn't there`;
  if (s.size !== w.pin.size) return `${w.pin.file} is ${s.size} bytes, not ${w.pin.size}`;
  const sum = await hash(w.file);
  return sum === w.pin.sha256 ? null : `${w.pin.file}'s SHA-256 ${sum} isn't the pinned ${w.pin.sha256}`;
}

/** llama-server's arguments that load these add-ons at its start, each off until a request turns it on; none for none. */
export const addonArgs = (files: string[]): string[] => (files.length ? [...files.flatMap((f) => ['--lora', f]), '--lora-init-without-apply'] : []);

/**
 * The add-ons a server loads, by llama-server's ids: its startCommand's `--lora` files in order (the id is that order),
 * each with its pin, matched by file name (null for a file no pin names: someone's own).
 */
export function loadedAddons(startCommand: readonly string[] | undefined, catalog: AddonCatalog = ADDONS): { id: number; file: string; pin: AddonPin | null }[] {
  const out: { id: number; file: string; pin: AddonPin | null }[] = [];
  const cmd = startCommand ?? [];
  for (let i = 1; i < cmd.length - 1; i++) {
    if (cmd[i] !== '--lora') continue;
    const file = cmd[i + 1];
    const name = path.win32.basename(file).toLowerCase();
    out.push({ id: out.length, file, pin: catalog.addons.find((a) => a.file.toLowerCase() === name) ?? null });
  }
  return out;
}

/**
 * The `lora` field that keeps every add-on a server carries off (each at scale 0, by its id: its `--lora` order), for a
 * request that applies none; none for a server that carries none.
 */
export function addonsOff(startCommand: readonly string[] | undefined): { lora: { id: number; scale: number }[] } | Record<string, never> {
  const n = (startCommand ?? []).filter((a, i, all) => a === '--lora' && i < all.length - 1).length;
  return n ? { lora: Array.from({ length: n }, (_, id) => ({ id, scale: 0 })) } : {};
}

/** What an answer says of the add-on its job asked for (NpuAnswer.addon): present only on a request that named a job. */
export interface AddonUse {
  /** The job the request named. */
  job: string;
  /** The add-on pinned for it, applied or not; null when the job has none. */
  id: string | null;
  /** Whether it was applied to this answer. */
  applied: boolean;
  /** Why it wasn't, in words: no add-on for the job, or the server that answered doesn't carry it. */
  why?: string;
}

/**
 * The add-on a request for `job` gets on the server whose chat endpoint starts with `startCommand`: the request's `lora`
 * field (every add-on the server carries, that one at 1 and the others at 0), or why it isn't applied. `onNpu` and `pcHasNpu` keep the owner's rule: on a PC with an NPU,
 * a graphics card's or the processor's server never applies one (setup loads none there, and one loaded by hand isn't
 * used either).
 */
export function addonFor(job: string | undefined, o: { startCommand?: readonly string[]; onNpu: boolean; pcHasNpu: boolean; catalog?: AddonCatalog }): { use: AddonUse; lora?: { id: number; scale: number }[] } | null {
  if (!job) return null;
  const pin = addonForJob(job, o.catalog);
  if (!pin) return { use: { job, id: null, applied: false, why: 'no add-on is pinned for this job' } };
  if (!o.onNpu && o.pcHasNpu) return { use: { job, id: pin.id, applied: false, why: 'on a PC with an NPU, add-ons run only on the NPU' } };
  const loaded = loadedAddons(o.startCommand, o.catalog).find((l) => l.pin?.id === pin.id);
  if (!loaded) return { use: { job, id: pin.id, applied: false, why: o.onNpu ? "the NPU's server doesn't carry it" : "this server doesn't carry it" } };
  return { use: { job, id: pin.id, applied: true }, lora: loadedAddons(o.startCommand, o.catalog).map((l) => ({ id: l.id, scale: l.id === loaded.id ? 1 : 0 })) };
}
