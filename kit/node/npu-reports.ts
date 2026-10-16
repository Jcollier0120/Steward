import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exchequerUrl, publisherKey, withoutKey } from './exchequer.ts';
import { calibrate, CALIBRATION, MAKERS, NPU_CATALOG, type NpuCatalog, type NpuGeneration, type NpuMeasuredSpeeds, type NpuRoute, type NpuVendor, NPU_VENDORS, routeFor, UNKNOWN_GENERATION } from './npu-vendors.ts';

/**
 * The owners' NPU reports into npu-vendors.json (spec/NPU-REPORTS.md): the Exchequer's summary of them, read against
 * this kit's catalog, gives per generation what they say and the JSON merge patch they support, as the NPU check prints
 * its own. Nothing is changed: a person reads it, merges it and releases the kit.
 *
 *   node <agent>\src\kit\npu-reports.ts <summary.json>
 *   node <agent>\src\kit\npu-reports.ts --fetch [--exchequer <url>]    (the publisher's key: EXCHEQUER_PUBLISHER_KEY, or ~/.steward/exchequer-publisher.key)
 */

export const NPU_SUMMARY_FORMAT = 'castellan-npu-summary/1';

/** A number over the PCs that measured it: its median, and its slow end (the 90th percentile of a time, the 10th of a speed). */
export interface NpuSpread {
  pcs: number;
  median: number | null;
  slow: number | null;
}

/** One chip on one route, as the Exchequer counts it (each PC once, by its latest report). */
export interface NpuSummaryGroup {
  vendor: NpuVendor | null;
  generation: string | null;
  /** The PCI id, for an `unknown` generation only. */
  pciDevice: string | null;
  server: string | null;
  version: string | null;
  model: string | null;
  reports: number;
  pcs: number;
  passedPcs: number;
  failedPcs: number;
  failures: Record<string, number>;
  drivers: string[];
  cpus: string[];
  firstDay: string | null;
  lastDay: string | null;
  /** Each null when no PC that passed measured it. */
  speeds: { tokensPerSecond: NpuSpread | null; coldMs: NpuSpread | null; warmMs: NpuSpread | null; readMsPer1k: NpuSpread | null };
}

const NONE: NpuSpread = { pcs: 0, median: null, slow: null };
/** A group's speeds, one unmeasured as no PCs, no median and no slow end. */
const speedsOf = (g: NpuSummaryGroup) => ({ tokensPerSecond: g.speeds?.tokensPerSecond ?? NONE, coldMs: g.speeds?.coldMs ?? NONE, warmMs: g.speeds?.warmMs ?? NONE, readMsPer1k: g.speeds?.readMsPer1k ?? NONE });

export interface NpuSummary {
  format: typeof NPU_SUMMARY_FORMAT;
  at: string;
  groups: NpuSummaryGroup[];
}

/**
 * The owner's rules (2026-10-16): a generation is verified by 3 PCs passing with under 1 in 5 of its PCs failing; its
 * measured speed is shown from 3 PCs passing; an unknown PCI id is worth a line in `devices` from 2 PCs.
 */
export const REPORT_RULES = { verifyPcs: 3, failingUnder: 0.2, measuredPcs: 3, unknownPcs: 2 };

/** What the reports say of one generation, and what of npu-vendors.json they'd change. */
export interface GenerationFinding {
  vendor: NpuVendor;
  generation: string;
  group: NpuSummaryGroup;
  /** The changes to its entry in npu-vendors.json; empty when they support none. */
  change: Partial<NpuGeneration>;
  lines: string[];
}

export interface ReportsPatch {
  findings: GenerationFinding[];
  /** PCI ids nobody has in `devices`, reported by enough PCs to be worth adding once their generation is known. */
  unknown: { vendor: NpuVendor; pciDevice: string; pcs: number; passedPcs: number; cpus: string[] }[];
  /** Reports on a server, version or model the route no longer runs, which count for nothing here. */
  stale: number;
  /** The JSON merge patch for npu-vendors.json, or null when the reports support no change. */
  patch: Record<string, unknown> | null;
  lines: string[];
}

/** Problems with a summary, in words; none when it is one this kit reads. */
export function checkSummary(s: any): string[] {
  if (!s || typeof s !== 'object') return ['the summary is not a JSON object'];
  if (s.format !== NPU_SUMMARY_FORMAT) return [`the summary's format is ${JSON.stringify(s.format)}, not ${NPU_SUMMARY_FORMAT}`];
  if (!Array.isArray(s.groups)) return ['the summary has no groups'];
  return s.groups.flatMap((g: any, i: number) => (g && typeof g === 'object' && typeof g.pcs === 'number' && typeof g.passedPcs === 'number' && typeof g.failedPcs === 'number' && g.speeds && typeof g.speeds === 'object' && g.failures && Array.isArray(g.drivers) && Array.isArray(g.cpus) ? [] : [`group ${i} isn't one the Exchequer counts`]));
}

const chatModel = (route: NpuRoute) => (route.models.find((m) => m.kinds.includes('chat')) ?? route.models[0])?.id ?? null;
const n0 = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });
const s1 = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const BASIS_START = 'Measured on ';
const BASIS_MARK = " PCs by their owners' reports";

/** The sentence the reports add to a generation's basis, in place of the one they added before. */
export function reportsBasis(g: NpuSummaryGroup): string {
  const s = speedsOf(g);
  const drivers = g.drivers.length > 1 ? `NPU drivers ${g.drivers[0]} to ${g.drivers.at(-1)}` : g.drivers.length ? `NPU driver ${g.drivers[0]}` : 'NPU drivers unknown';
  const days = g.firstDay && g.lastDay && g.firstDay !== g.lastDay ? `${g.firstDay} to ${g.lastDay}` : (g.lastDay ?? '');
  const said: string[] = [];
  if (s.tokensPerSecond.median != null) said.push(`writes ${s.tokensPerSecond.median.toFixed(1)} tokens a second${s.tokensPerSecond.slow != null ? ` (the slowest tenth ${s.tokensPerSecond.slow.toFixed(1)})` : ''}`);
  if (s.warmMs.median != null) said.push(`a short answer warm in ${s1(s.warmMs.median)}${s.warmMs.slow != null ? ` (${s1(s.warmMs.slow)})` : ''}`);
  if (s.readMsPer1k.median != null) said.push(`1,000 tokens read in ${s1(s.readMsPer1k.median)}${s.readMsPer1k.slow != null ? ` (${s1(s.readMsPer1k.slow)})` : ''}`);
  if (s.coldMs.median != null) said.push(`the first start to an answer ${s1(s.coldMs.median)}${s.coldMs.slow != null ? ` (${s1(s.coldMs.slow)})` : ''}`);
  const failed = g.failedPcs ? `; ${g.failedPcs} of ${g.pcs} PCs failed (${Object.entries(g.failures).map(([k, v]) => `${k} ${v}`).join(', ')})` : '';
  return `${BASIS_START}${g.passedPcs}${BASIS_MARK} (${g.server} ${g.version}, ${g.model}), ${drivers}, ${days}: ${said.join('; ') || 'no speeds'}${failed}.`;
}

/** A basis with the reports' sentence put in, replacing the one they put in before. */
export function withReportsBasis(basis: string | undefined, sentence: string): string {
  const kept = (basis ?? '').replace(new RegExp(`\\s*${BASIS_START}\\d+${BASIS_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^]*?\\.(?=\\s|$)`), '').trim();
  return kept ? `${kept} ${sentence}` : sentence;
}

/**
 * The timeouts the slow end of the reports needs, by calibrate's formulas and bounds: the reading time measured (a
 * full-cap read at the slow end's time per 1,000 tokens) in place of its estimate. Only those over the generation's
 * values now: a timeout is never lowered from reports.
 */
export function reportsTimeouts(g: NpuSummaryGroup, route: NpuRoute): { timeouts: NpuRoute['timeouts']; tooSlow?: string } | null {
  const { tokensPerSecond: tps, warmMs, coldMs, readMsPer1k } = speedsOf(g);
  if (tps.slow == null || warmMs.slow == null || coldMs.slow == null || tps.slow <= 0) return null;
  // calibrate takes reading as a multiple of writing: the multiple the slow end measured, when it read.
  const readPerWrite = readMsPer1k.slow ? 1_000_000 / readMsPer1k.slow / tps.slow : (route.readPerWrite ?? CALIBRATION.readPerWrite);
  const c = calibrate({ tokensPerSecond: tps.slow, warmMs: warmMs.slow, coldMs: coldMs.slow }, { maxContextTokens: route.maxContextTokens, timeouts: route.timeouts, readPerWrite });
  const now = route.timeouts as Record<string, number | undefined>;
  const more = Object.fromEntries(Object.entries(c.timeouts).filter(([k, v]) => v > (now[k] ?? 0)));
  return { timeouts: more, ...(c.tooSlow ? { tooSlow: c.tooSlow } : {}) };
}

/** What the reports say of each generation in the catalog, and the patch they support. */
export function reportsPatch(summary: NpuSummary, catalog: NpuCatalog = NPU_CATALOG): ReportsPatch {
  const findings: GenerationFinding[] = [];
  let stale = 0;
  const day = summary.at.slice(0, 10);
  for (const g of summary.groups) {
    if (!g.vendor || !NPU_VENDORS.includes(g.vendor) || !g.generation || g.generation === UNKNOWN_GENERATION) continue;
    const route = catalog.routes[g.vendor];
    if (!route || !Object.hasOwn(route.generations, g.generation)) continue;
    // Only the route as it runs now: its server's version and its chat model. A report without a route (the NPU left
    // out) says nothing of how the route runs.
    if (!g.server) continue;
    if (g.server !== route.server || g.version !== route.version || g.model !== chatModel(route)) {
      stale += g.reports;
      continue;
    }
    const gen = route.generations[g.generation];
    const run = routeFor(route, g.generation);
    const change: Partial<NpuGeneration> = {};
    const lines: string[] = [];
    const failing = g.pcs ? g.failedPcs / g.pcs : 0;
    const failures = Object.entries(g.failures).map(([k, v]) => `${k} on ${v}`).join(', ');
    lines.push(`${g.passedPcs} of ${g.pcs} PCs passed (${g.reports} reports, ${g.firstDay} to ${g.lastDay})${g.failedPcs ? `; failed: ${failures}` : ''}.`);
    if (!gen.verified) {
      if (g.passedPcs >= REPORT_RULES.verifyPcs && failing < REPORT_RULES.failingUnder) {
        change.verified = true;
        lines.push(`verified: ${g.passedPcs} PCs passed, ${g.failedPcs} failed (under 1 in ${Math.round(1 / REPORT_RULES.failingUnder)}).`);
      } else if (failing >= REPORT_RULES.failingUnder && g.failedPcs) lines.push(`not verified: ${g.failedPcs} of ${g.pcs} PCs failed (${failures}), 1 in ${Math.round(1 / REPORT_RULES.failingUnder)} or more.`);
      else lines.push(`not verified yet: ${REPORT_RULES.verifyPcs - g.passedPcs} more PC${REPORT_RULES.verifyPcs - g.passedPcs === 1 ? '' : 's'} passing needed.`);
    } else if (failing >= REPORT_RULES.failingUnder && g.failedPcs) lines.push(`verified, but ${g.failedPcs} of ${g.pcs} PCs failed (${failures}): worth a look.`);
    if (g.passedPcs >= REPORT_RULES.verifyPcs) {
      const t = reportsTimeouts(g, run);
      if (t?.tooSlow) lines.push(`the slow end is too slow: ${t.tooSlow}.`);
      if (t && Object.keys(t.timeouts).length) {
        change.timeouts = { ...gen.timeouts, ...t.timeouts };
        lines.push(`timeouts: ${Object.entries(t.timeouts).map(([k, v]) => `${k} ${n0(v as number)} (now ${n0((run.timeouts as Record<string, number>)[k] ?? 0)})`).join(', ')}.`);
      }
    }
    const s = speedsOf(g);
    if (g.passedPcs >= REPORT_RULES.measuredPcs && s.tokensPerSecond.median != null && s.coldMs.median != null) {
      const measured: NpuMeasuredSpeeds = { pcs: g.passedPcs, server: g.server, model: g.model!, tokensPerSecond: Math.round(s.tokensPerSecond.median * 10) / 10, coldStartS: Math.round(s.coldMs.median / 1000), at: day };
      const had = gen.measured;
      if (!had || had.pcs !== measured.pcs || had.server !== measured.server || had.model !== measured.model || had.tokensPerSecond !== measured.tokensPerSecond || had.coldStartS !== measured.coldStartS) {
        change.measured = measured;
        lines.push(`measured, for the site: about ${measured.tokensPerSecond} tokens a second, a first answer ${measured.coldStartS} s from a cold start, on ${measured.pcs} PCs.`);
      }
    }
    if (change.verified || change.timeouts) change.basis = withReportsBasis(gen.basis, reportsBasis(g));
    findings.push({ vendor: g.vendor, generation: g.generation, group: g, change, lines });
  }
  const known = (v: NpuVendor, id: string) => Object.hasOwn(catalog.devices[v] ?? {}, id);
  const unknown = summary.groups
    .filter((g) => g.vendor && NPU_VENDORS.includes(g.vendor) && g.generation === UNKNOWN_GENERATION && g.pciDevice && !known(g.vendor, g.pciDevice))
    .reduce<ReportsPatch['unknown']>((all, g) => {
      const had = all.find((u) => u.vendor === g.vendor && u.pciDevice === g.pciDevice);
      // The same PCI id on several routes (or none): counted on its route with the most PCs.
      if (had) {
        if (g.pcs > had.pcs) Object.assign(had, { pcs: g.pcs, passedPcs: g.passedPcs, cpus: g.cpus });
      } else all.push({ vendor: g.vendor!, pciDevice: g.pciDevice!, pcs: g.pcs, passedPcs: g.passedPcs, cpus: g.cpus });
      return all;
    }, [])
    .filter((u) => u.pcs >= REPORT_RULES.unknownPcs);

  const generations: Record<string, Record<string, unknown>> = {};
  for (const f of findings) if (Object.keys(f.change).length) (generations[f.vendor] ??= {})[f.generation] = f.change;
  const patch = Object.keys(generations).length ? { routes: Object.fromEntries(Object.entries(generations).map(([v, gens]) => [v, { generations: gens }])) } : null;

  const lines: string[] = [`The owners' NPU reports, as the Exchequer counted them at ${summary.at}:`];
  for (const f of findings) lines.push(`${MAKERS[f.vendor]} ${f.generation}:`, ...f.lines.map((l) => `  ${l}`));
  if (!findings.length) lines.push('  none on a generation and route this kit runs now.');
  if (stale) lines.push(`${stale} report${stale === 1 ? '' : 's'} on a server, version or model the route no longer runs: not counted.`);
  for (const u of unknown) lines.push(`An NPU nobody has listed: ${MAKERS[u.vendor]} device ${u.pciDevice}, on ${u.pcs} PCs (${u.passedPcs} passed on guessed values; ${u.cpus.slice(0, 3).join('; ') || 'processors unknown'}): add "${u.pciDevice}": "<its generation>" to devices.${u.vendor} once its generation is known.`);
  lines.push(patch ? 'The patch for npu-vendors.json (a JSON merge patch: read it, merge it, release the kit):' : 'No change to npu-vendors.json.');
  return { findings, unknown, stale, patch, lines };
}

/** The summary from the Exchequer, with the publisher's key. */
export async function fetchSummary(o: { env?: NodeJS.ProcessEnv; home?: string; exchequer?: string; fetch?: typeof fetch } = {}): Promise<{ summary: NpuSummary } | { error: string }> {
  const env = o.env ?? process.env;
  const found = publisherKey(env, o.home);
  if ('missing' in found) return { error: `no publisher key at ${found.missing} (or EXCHEQUER_PUBLISHER_KEY)` };
  const url = `${(o.exchequer ?? exchequerUrl(env)).replace(/\/+$/, '')}/api/v1/admin/npu-reports/summary`;
  try {
    const res = await (o.fetch ?? fetch)(url, { headers: { authorization: `Bearer ${found.key}`, 'user-agent': 'Steward kit npu-reports' }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) return { error: withoutKey(`${url} answered ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`, found.key) };
    const summary = JSON.parse(text);
    const bad = checkSummary(summary);
    return bad.length ? { error: bad.join('; ') } : { summary };
  } catch (e: any) {
    return { error: withoutKey(`${url}: ${e?.message ?? e}`, found.key) };
  }
}

export async function npuReportsCommand(args: string[], o: { log?: (line: string) => void; env?: NodeJS.ProcessEnv; home?: string; fetch?: typeof fetch; catalog?: NpuCatalog } = {}): Promise<number> {
  const log = o.log ?? console.log;
  const usage = 'Usage: node npu-reports.ts <summary.json> | --fetch [--exchequer <url>]';
  let summary: NpuSummary;
  if (args[0] === '--fetch') {
    const at = args.indexOf('--exchequer');
    if (at >= 0 && !args[at + 1]) {
      log(usage);
      return 2;
    }
    const got = await fetchSummary({ env: o.env, home: o.home, fetch: o.fetch, exchequer: at >= 0 ? args[at + 1] : undefined });
    if ('error' in got) {
      log(`The summary couldn't be fetched: ${got.error}`);
      return 1;
    }
    summary = got.summary;
  } else if (args.length === 1 && !args[0].startsWith('-')) {
    try {
      summary = JSON.parse(readFileSync(args[0], 'utf8').replace(/^﻿/, ''));
    } catch (e: any) {
      log(`${args[0]} couldn't be read: ${e?.message ?? e}`);
      return 1;
    }
    const bad = checkSummary(summary);
    if (bad.length) {
      log(`${args[0]}: ${bad.join('; ')}`);
      return 1;
    }
  } else {
    log(usage);
    return 2;
  }
  const r = reportsPatch(summary, o.catalog);
  for (const l of r.lines) log(l);
  if (r.patch) log(JSON.stringify(r.patch, null, 2));
  return 0;
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await npuReportsCommand(process.argv.slice(2));
}
