import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from './core/index.js';
import { acceleratorsDir } from './lock.ts';
import { RULES } from './rules.ts';
import { writeJson } from './store.ts';

/**
 * How fast each accelerator answers on this boot against earlier boots (spec/ACCELERATORS.md, "A slow start"): some PCs
 * come up from a restart with their memory slower until the next restart, and only the speed shows it. Each program
 * keeps the decode speeds its servers report (FastFlowLM's usage.decoding_speed_tps) in the accelerators folder on this
 * PC (`speed\<program>.json`, one file a program so two never write the same one), speeds only, never what was asked or
 * answered. bootSpeedOf reads them all, and the Manor's accelerator card says when this boot is slow.
 */

export const speedDir = (dir = acceleratorsDir) => path.join(dir, 'speed');

/** When this PC started, in milliseconds since the epoch: Windows' uptime goes on through sleep and standby, and only a restart starts it again. */
export const bootMs = (now = Date.now()) => Math.round(now - os.uptime() * 1000);

const fileOf = (dir: string, agent: string) => path.join(dir, `${agent.replace(/[^\w.-]/g, '_')}.json`);

/** Keeps one answer's speed for this program. Never throws: a speed that can't be written is a speed lost, not a request failed. */
export function noteSpeed(agent: string, s: core.Speed, o: { dir?: string; bootMs?: number } = {}): void {
  try {
    if (core.speedSize(s.answerTokens) === null || !(s.tokensPerSecond > 0)) return;
    const dir = speedDir(o.dir);
    const file = fileOf(dir, agent);
    let current: core.Speeds | null = null;
    try {
      current = core.speedsOf(readFileSync(file, 'utf8'));
    } catch {}
    // writeJson writes core.sharedText's text (2-space JSON and a newline), and tries a refused rename again.
    writeJson(file, core.addSpeed(RULES, current, agent, o.bootMs ?? bootMs(), s));
  } catch {}
}

/** Every program's speeds on this PC (none when there are none yet). */
export function readSpeeds(o: { dir?: string } = {}): core.Speeds[] {
  const dir = speedDir(o.dir);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {}
  const out: core.Speeds[] = [];
  for (const f of names) {
    try {
      const s = core.speedsOf(readFileSync(path.join(dir, f), 'utf8'));
      if (s) out.push(s);
    } catch {}
  }
  return out;
}

/** This boot's speed on an accelerator against earlier boots' (the core's bootSpeed), or null until there's enough to say. */
export function bootSpeedOf(acc: string, o: { dir?: string; bootMs?: number } = {}): core.BootSpeed | null {
  return core.bootSpeed(RULES, readSpeeds(o), o.bootMs ?? bootMs(), acc);
}
