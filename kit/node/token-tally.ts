import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acceleratorsDir } from './lock.ts';

/**
 * How many tokens each agent's model requests send and get back, counted by day: what the NPU benchmark's three jobs
 * should weigh (spec/NPU-BENCHMARK.md, "The jobs' mix"), and how busy each accelerator was (busyToday, kit 2.85.0: the
 * work status's `today` on each accelerator's line). Counts only, never what was asked or answered, kept in the
 * accelerators folder on this PC (`usage\<day>\<agent>.json`, one file an agent so two never write the same one) for
 * 60 days. A day is the PC's own (its time zone) from kit 2.85.0, UTC's before. From kit 2.85.0 each row names its
 * accelerator (`acc`), and embeddings are counted too (work `embed`), which the benchmark's mix leaves out.
 */

/** The upper edges of the buckets requests are counted in (the last bucket is everything above). */
export const PROMPT_EDGES = [64, 128, 256, 512, 1024, 2048, 4096];
export const ANSWER_EDGES = [16, 32, 64, 128, 256, 512];
export const KEEP_DAYS = 60;

export interface TallyRow {
  /** chat, vision or embed, the lane (background or interactive), and the accelerator's kind (npu, gpu, cpu). */
  work: string;
  lane: string;
  kind: string;
  /** The accelerator's id (config.json's), kit 2.85.0; a row from before has none. */
  acc?: string;
  requests: number;
  promptTokens: number;
  answerTokens: number;
  ms: number;
  /** Requests in each bucket of PROMPT_EDGES and ANSWER_EDGES, one more than the edges for everything above. */
  prompts: number[];
  answers: number[];
}

export interface TallyFile {
  day: string;
  agent: string;
  rows: TallyRow[];
}

export const usageDir = (dir = acceleratorsDir) => path.join(dir, 'usage');

/** A day as the tally names it: the PC's own date (its time zone), YYYY-MM-DD. */
export const tallyDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** One request, as it is counted. */
export interface TallyRequest {
  work: string;
  lane: string;
  kind: string;
  acc?: string;
  promptTokens: number;
  answerTokens: number;
  ms: number;
}

const bucket = (n: number, edges: number[]) => {
  const i = edges.findIndex((e) => n <= e);
  return i < 0 ? edges.length : i;
};

/** Adds one request to a day's counts (a new row for a new work, lane, kind and accelerator). */
export function addToTally(file: TallyFile, r: TallyRequest): TallyFile {
  const rows = file.rows.map((x) => ({ ...x, prompts: [...x.prompts], answers: [...x.answers] }));
  let row = rows.find((x) => x.work === r.work && x.lane === r.lane && x.kind === r.kind && x.acc === r.acc);
  if (!row) {
    row = { work: r.work, lane: r.lane, kind: r.kind, ...(r.acc ? { acc: r.acc } : {}), requests: 0, promptTokens: 0, answerTokens: 0, ms: 0, prompts: Array(PROMPT_EDGES.length + 1).fill(0), answers: Array(ANSWER_EDGES.length + 1).fill(0) };
    rows.push(row);
  }
  row.requests++;
  row.promptTokens += Math.max(0, Math.round(r.promptTokens));
  row.answerTokens += Math.max(0, Math.round(r.answerTokens));
  row.ms += Math.max(0, Math.round(r.ms));
  row.prompts[bucket(r.promptTokens, PROMPT_EDGES)]++;
  row.answers[bucket(r.answerTokens, ANSWER_EDGES)]++;
  return { ...file, rows };
}

/**
 * Counts one answered request for this agent today. Never throws: a count that can't be written is a count lost, not
 * a request failed. A new day's first count clears days past KEEP_DAYS.
 */
export function tallyRequest(agent: string, r: TallyRequest, o: { dir?: string; now?: Date } = {}): void {
  try {
    const now = o.now ?? new Date();
    const day = tallyDay(now);
    const base = usageDir(o.dir);
    const dayDir = path.join(base, day);
    const file = path.join(dayDir, `${agent.replace(/[^\w.-]/g, '_')}.json`);
    let current: TallyFile = { day, agent, rows: [] };
    let fresh = false;
    try {
      current = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      fresh = true;
    }
    mkdirSync(dayDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(addToTally(current, r)) + '\n');
    renameSync(tmp, file);
    if (fresh) pruneTally(base, now);
  } catch {}
}

/** Removes the days older than KEEP_DAYS. */
export function pruneTally(base: string, now: Date): void {
  const oldest = tallyDay(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
  let days: string[] = [];
  try {
    days = readdirSync(base);
  } catch {
    return;
  }
  for (const d of days) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < oldest) rmSync(path.join(base, d), { recursive: true, force: true });
}

const share = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : '-');
const edgesSaid = (edges: number[]) => [...edges.map((e, i) => `${i ? edges[i - 1] + 1 : 0}-${e}`), `${edges[edges.length - 1] + 1}+`];

/** The tally as lines to read: each work, lane and kind's requests, averages, and how prompts and answers spread over the buckets. */
export function mixSummary(t: { from: string; to: string; agents: string[]; rows: TallyRow[] }): string[] {
  const rows = t.rows.filter((r) => r.requests > 0).sort((a, b) => b.requests - a.requests);
  const lines = [`What agents sent from ${t.from} to ${t.to}: ${rows.reduce((n, r) => n + r.requests, 0)} requests from ${t.agents.length ? t.agents.join(', ') : 'no agents'}`];
  if (!rows.length) return [...lines, 'Nothing counted yet: agents count their requests as they make them.'];
  const p = edgesSaid(PROMPT_EDGES);
  const a = edgesSaid(ANSWER_EDGES);
  for (const r of rows) {
    lines.push('');
    lines.push(`${r.work}, ${r.lane}, on the ${r.kind}: ${r.requests} requests, prompts ${Math.round(r.promptTokens / r.requests)} tokens and answers ${Math.round(r.answerTokens / r.requests)} on average, ${Math.round(r.ms / r.requests)} ms each`);
    lines.push(`  prompts: ${r.prompts.map((n, i) => (n ? `${p[i]} ${share(n, r.requests)}` : '')).filter(Boolean).join(', ')}`);
    lines.push(`  answers: ${r.answers.map((n, i) => (n ? `${a[i]} ${share(n, r.requests)}` : '')).filter(Boolean).join(', ')}`);
  }
  return lines;
}

/** Every agent's counts over the last `days` days, added together by work, lane and kind (chat and vision only). */
export function readTally(days: number, o: { dir?: string; now?: Date } = {}): { from: string; to: string; agents: string[]; rows: TallyRow[] } {
  const now = o.now ?? new Date();
  const to = tallyDay(now);
  const from = tallyDay(new Date(now.getTime() - (days - 1) * 86_400_000));
  const base = usageDir(o.dir);
  const rows: TallyRow[] = [];
  const agents = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(base).filter((d) => d >= from && d <= to);
  } catch {}
  for (const d of names) {
    let files: string[] = [];
    try {
      files = readdirSync(path.join(base, d)).filter((f) => f.endsWith('.json'));
    } catch {}
    for (const f of files) {
      try {
        const t: TallyFile = JSON.parse(readFileSync(path.join(base, d, f), 'utf8'));
        agents.add(t.agent);
        for (const { acc: _acc, ...row } of t.rows) {
          if (row.work !== 'chat' && row.work !== 'vision') continue;
          const m = rows.find((x) => x.work === row.work && x.lane === row.lane && x.kind === row.kind);
          if (!m) {
            rows.push({ ...row, prompts: [...row.prompts], answers: [...row.answers] });
            continue;
          }
          m.requests += row.requests;
          m.promptTokens += row.promptTokens;
          m.answerTokens += row.answerTokens;
          m.ms += row.ms;
          row.prompts.forEach((n, i) => (m.prompts[i] = (m.prompts[i] ?? 0) + n));
          row.answers.forEach((n, i) => (m.answers[i] = (m.answers[i] ?? 0) + n));
        }
      } catch {}
    }
  }
  return { from, to, agents: [...agents].sort(), rows };
}

/** One accelerator's day: how long its requests took together, how many, and their tokens, from every agent's counts. */
export interface AcceleratorDay {
  /** The accelerator's id; a count from before kit 2.85.0 names only its kind, and is that kind's here. */
  id: string;
  kind: string;
  /** The requests' own time added together (each from sent to answered, in its turn), ms. The NPU serves one at a time, so on it this is the time it was busy. */
  busyMs: number;
  requests: number;
  promptTokens: number;
  answerTokens: number;
  /** The agents whose requests these were. */
  agents: string[];
}

/**
 * How busy each accelerator was on a day (today, unless `now` says another), every agent's counts added together by
 * accelerator: the work status's `today` (work-status.ts, kit 2.85.0). Chat, vision and embeddings alike. Never throws.
 */
export function busyToday(o: { dir?: string; now?: Date } = {}): { day: string; accelerators: AcceleratorDay[] } {
  const day = tallyDay(o.now ?? new Date());
  const dayDir = path.join(usageDir(o.dir), day);
  const by = new Map<string, AcceleratorDay>();
  let files: string[] = [];
  try {
    files = readdirSync(dayDir).filter((f) => f.endsWith('.json'));
  } catch {}
  for (const f of files) {
    try {
      const t: TallyFile = JSON.parse(readFileSync(path.join(dayDir, f), 'utf8'));
      for (const row of t.rows) {
        const id = row.acc || row.kind;
        const a = by.get(id) ?? { id, kind: row.kind, busyMs: 0, requests: 0, promptTokens: 0, answerTokens: 0, agents: [] };
        a.busyMs += row.ms;
        a.requests += row.requests;
        a.promptTokens += row.promptTokens;
        a.answerTokens += row.answerTokens;
        if (!a.agents.includes(t.agent)) a.agents.push(t.agent);
        by.set(id, a);
      }
    } catch {}
  }
  return { day, accelerators: [...by.values()].map((a) => ({ ...a, agents: a.agents.sort() })).sort((a, b) => b.busyMs - a.busyMs) };
}
