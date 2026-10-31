import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Detection } from './detect.ts';
import { checkSchema } from './json-schema.ts';
import { acceleratorsDir } from './lock.ts';
import type { NpuCheckReport } from './npu-check.ts';
import { type NpuRoute, type NpuSupport, type NpuVendor, NPU_VENDORS, pciDevice } from './npu-vendors.ts';
import { writeJson } from './store.ts';

/**
 * The NPU report (spec/NPU-REPORTS.md): how this PC's NPU did when setup set it up (or the NPU check measured it), as
 * hardware ids, versions and times only, kept on the PC beside npu-note.json and sent by the app only on its owner's
 * word. Nothing here sends it.
 */

export const NPU_REPORT_FORMAT = 'castellan-npu-report/1';

/** Its schema (spec/npu-report.schema.json): what the Exchequer accepts, field by field. */
export const NPU_REPORT_SCHEMA = JSON.parse(readFileSync(new URL('./spec/npu-report.schema.json', import.meta.url), 'utf8').replace(/^﻿/, ''));

/** The step that failed, as a code (never setup's words, which can hold a path): setup's, then the NPU check's. */
export const NPU_FAIL_STEPS = NPU_REPORT_SCHEMA.properties.failed.properties.step.enum as readonly string[];
export type NpuFailStep =
  | 'not-supported'
  | 'driver'
  | 'memory'
  | 'download'
  | 'install'
  | 'runtime'
  | 'pull'
  | 'checksum'
  | 'test-timeout'
  | 'test-nonsense'
  | 'test'
  | 'measure'
  | 'too-slow'
  | 'embed'
  | 'detect'
  | 'requirements'
  | 'setup'
  | 'start'
  | 'first-answer'
  | 'warm'
  | 'speed'
  | 'read'
  | 'cap'
  | 'two-at-once'
  | 'restart'
  | 'kit-test';

export interface NpuSpeeds {
  /** From the server's start to the test's answers (a first compile included); null when it was running already. */
  coldMs: number | null;
  warmMs: number | null;
  tokensPerSecond: number | null;
  readTokens: number | null;
  readMs: number | null;
}

export interface NpuReport {
  format: typeof NPU_REPORT_FORMAT;
  /** A random id made for these reports alone (reporterId), so one PC's reports count once. */
  reporter: string;
  day: string;
  source: 'setup' | 'npu-check';
  kit: string;
  /** The app that ran it and its version ("manor 0.16.200"), when it said. */
  app: string | null;
  chip: {
    vendor: NpuVendor | null;
    generation: string | null;
    pciDevice: string | null;
    cpu: string | null;
    npu: string | null;
    driver: string | null;
    driverDate: string | null;
    arch: string | null;
    ramGb: number;
    windows: string | null;
  };
  route: { server: string; version: string; model: string; cap: number; verified: boolean } | null;
  ok: boolean;
  failed: { step: NpuFailStep } | null;
  speeds: NpuSpeeds;
}

export const NO_SPEEDS: NpuSpeeds = { coldMs: null, warmMs: null, tokensPerSecond: null, readTokens: null, readMs: null };

/** npu-report.json, beside npu-note.json: the last report setup or the NPU check made on this PC. */
export const npuReportFile = () => path.join(acceleratorsDir, 'npu-report.json');

/** npu-reporter.json: the reporter id, made once. */
export const npuReporterFile = () => path.join(acceleratorsDir, 'npu-reporter.json');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Written whole through store.ts' writeJson (kit 2.146.5): a rename Windows refuses for a moment is tried again. */
const writeWhole = (file: string, value: unknown): void => writeJson(file, value);

const readJson = (file: string): any => {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};

/** This PC's reporter id: random, made the first time and kept; used for nothing but counting its reports once. */
export function reporterId(file = npuReporterFile()): string {
  const had = readJson(file)?.id;
  if (typeof had === 'string' && UUID.test(had)) return had;
  const id = randomUUID();
  writeWhole(file, { id, about: 'A random id made for NPU reports alone, so several reports from this PC count once. Nothing else uses it.' });
  return id;
}

/** A name as Windows gives it, fit for a report: one line, at most 100 characters, and never anything like a path. */
export function reportText(s: string | null | undefined): string | null {
  const t = (s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || /[\\:]/.test(t)) return null;
  return [...t].slice(0, 100).join('').trim() || null;
}

/** Windows' build number from os.release() ("10.0.26200" is 26200). */
export const windowsBuild = (release = os.release()) => /^\d+\.\d+\.(\d{1,6})\b/.exec(release)?.[1] ?? null;

const dayOf = (d = new Date()) => d.toISOString().slice(0, 10);

/** The app's name and version, as a report takes it ("manor 0.16.200"), or null. */
export const reportApp = (app: string | null | undefined) => (app && /^[a-z][a-z0-9-]{0,30} \d{1,4}\.\d{1,4}\.\d{1,6}$/.test(app) ? app : null);

/** What detection found, as a report says it. */
export function reportChip(d: Pick<Detection, 'npu' | 'cpu' | 'ramBytes'>, o: { release?: string } = {}): NpuReport['chip'] {
  const n = d.npu;
  const driver = n?.driver && /^[0-9][0-9.]{0,39}$/.test(n.driver) ? n.driver : null;
  const date = n?.driverDate && /^\d{4}-\d{2}-\d{2}$/.test(n.driverDate) ? n.driverDate : null;
  const arch = d.cpu?.arch && /^[a-z0-9]{1,10}$/.test(d.cpu.arch) ? d.cpu.arch : null;
  const generation = n?.generation && /^[a-z0-9][a-z0-9-]{0,39}$/.test(n.generation) ? n.generation : null;
  return {
    vendor: n?.vendor && NPU_VENDORS.includes(n.vendor) ? n.vendor : null,
    generation,
    pciDevice: n?.deviceId ? pciDevice(n.deviceId) : null,
    cpu: reportText(d.cpu?.name),
    npu: reportText(n?.name),
    driver,
    driverDate: date,
    arch,
    ramGb: Math.max(0, Math.min(4096, Math.round((d.ramBytes || 0) / 1024 ** 3))),
    windows: windowsBuild(o.release),
  };
}

/** The route as a report names it: its server and version, its chat model, its cap, and whether its generation was verified. */
export function reportRoute(route: Pick<NpuRoute, 'server' | 'version' | 'models' | 'maxContextTokens'>, verified: boolean): NonNullable<NpuReport['route']> {
  const chat = route.models.find((m) => m.kinds.includes('chat')) ?? route.models[0];
  return { server: route.server, version: route.version, model: chat?.id ?? '', cap: route.maxContextTokens, verified };
}

/** Why setup left the NPU out before setting anything up, as a code: its support, its driver, or the PC's memory. */
export function skippedStep(support: Pick<NpuSupport, 'supported' | 'why'> | null, memoryShort: boolean): NpuFailStep | null {
  if (!support) return null;
  if (!support.supported) return /driver needs an update/.test(support.why ?? '') ? 'driver' : 'not-supported';
  return memoryShort ? 'memory' : null;
}

/** Each number rounded as a report keeps it, a writing speed to two decimals; one past what the schema allows is left out. */
function speedsOf(s: Partial<NpuSpeeds> | undefined): NpuSpeeds {
  const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(86_400_000, Math.round(v)) : null);
  const n = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
  const tps = n(s?.tokensPerSecond, NPU_REPORT_SCHEMA.properties.speeds.properties.tokensPerSecond.maximum);
  const read = n(s?.readTokens, NPU_REPORT_SCHEMA.properties.speeds.properties.readTokens.maximum);
  return { coldMs: ms(s?.coldMs), warmMs: ms(s?.warmMs), tokensPerSecond: tps === null ? null : Math.round(tps * 100) / 100, readTokens: read === null ? null : Math.round(read), readMs: ms(s?.readMs) };
}

/**
 * The report of a setup that set the NPU up, or found it can't: null on a PC without an NPU. `route` is what it set up
 * (none when it was left out: `skipped` says why), `failed` the step that failed, `speeds` what it measured.
 */
export function npuReportFromSetup(o: {
  detection: Pick<Detection, 'npu' | 'cpu' | 'ramBytes'>;
  route?: Pick<NpuRoute, 'server' | 'version' | 'models' | 'maxContextTokens'> | null;
  verified?: boolean;
  skipped?: NpuFailStep | null;
  failed?: NpuFailStep | null;
  speeds?: Partial<NpuSpeeds>;
  kit: string;
  app?: string | null;
  reporter: string;
  day?: string;
  release?: string;
}): NpuReport | null {
  if (!o.detection.npu) return null;
  const failed = o.route ? (o.failed ?? null) : (o.skipped ?? 'not-supported');
  return {
    format: NPU_REPORT_FORMAT,
    reporter: o.reporter,
    day: o.day ?? dayOf(),
    source: 'setup',
    kit: o.kit,
    app: reportApp(o.app),
    chip: reportChip(o.detection, { release: o.release }),
    route: o.route ? reportRoute(o.route, !!o.verified) : null,
    ok: !failed,
    failed: failed ? { step: failed } : null,
    speeds: o.route ? speedsOf(o.speeds) : { ...NO_SPEEDS },
  };
}

/**
 * The report of an NPU check run on this PC's NPU (not a rehearsal): its steps' numbers, and the first step that
 * failed. `route` is the route it ran (the catalog's, for its server, model and cap).
 */
export function npuReportFromCheck(r: NpuCheckReport, o: { route: Pick<NpuRoute, 'server' | 'version' | 'models' | 'maxContextTokens'>; verified: boolean; ramBytes?: number; kit: string; app?: string | null; reporter: string; release?: string }): NpuReport {
  const step = (name: string) => r.steps.find((s) => s.step === name);
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const firstFailed = r.steps.find((s) => s.ok === false)?.step;
  const failed = firstFailed ? ((NPU_FAIL_STEPS.includes(firstFailed) ? firstFailed : 'test') as NpuFailStep) : null;
  const npu = r.npu as Record<string, any> | null;
  const detection: Pick<Detection, 'npu' | 'cpu' | 'ramBytes'> = {
    npu: npu ? ({ name: npu.name, vendor: npu.vendor, generation: r.generation ?? npu.generation, deviceId: npu.deviceId ?? '', driver: npu.driver ?? '', driverDate: npu.driverDate ?? '' } as any) : null,
    cpu: r.pc.cpu ? { name: r.pc.cpu, arch: r.pc.arch ?? '', cores: 0 } : null,
    ramBytes: o.ramBytes ?? r.pc.ramGb * 1024 ** 3,
  };
  return {
    format: NPU_REPORT_FORMAT,
    reporter: o.reporter,
    day: r.at.slice(0, 10),
    source: 'npu-check',
    kit: o.kit,
    app: reportApp(o.app),
    chip: reportChip(detection, { release: o.release }),
    route: reportRoute(o.route, o.verified),
    ok: r.ok && !failed,
    failed: failed ? { step: failed } : null,
    speeds: speedsOf({
      coldMs: num(step('first-answer')?.data?.loadMs),
      warmMs: step('warm')?.ok ? step('warm')?.ms : undefined,
      tokensPerSecond: num(step('speed')?.data?.tokensPerSecond) || undefined,
      readTokens: num(step('read')?.data?.promptTokens),
      readMs: step('read')?.ok !== false ? step('read')?.ms : undefined,
    }),
  };
}

/** What doesn't match the schema, in words; none when the report is one the Exchequer takes. */
export const checkNpuReport = (r: unknown) => checkSchema(r, NPU_REPORT_SCHEMA);

/** Keeps the report (npu-report.json), written whole; one that doesn't match its schema isn't kept. */
export function rememberNpuReport(r: NpuReport, file = npuReportFile()): string[] {
  const problems = checkNpuReport(r);
  if (!problems.length) writeWhole(file, r);
  return problems;
}

/** The report kept on this PC, or null when there is none or it doesn't match its schema. */
export function readNpuReport(file = npuReportFile()): NpuReport | null {
  const r = readJson(file);
  return r && !checkNpuReport(r).length ? (r as NpuReport) : null;
}

/**
 * What makes two reports the same, for offering one once: everything but the reporter and the day, as a short hash.
 * The same setup run again on the same PC with the same numbers isn't offered again.
 */
export function npuReportKey(r: NpuReport): string {
  const { reporter: _r, day: _d, ...rest } = r;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}
