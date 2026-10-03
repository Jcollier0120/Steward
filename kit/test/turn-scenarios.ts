#!/usr/bin/env node
/**
 * Writes kit/spec/turn-vectors.json: the turn and the plain lock, step by step, in the situations a
 * driver meets. Each scenario is a little world (the lock folders and tickets on a pretend disk, which
 * processes are running, what happens when) that the core's machine runs against; what it does and what
 * it is told are recorded, and every driver replays them (kit/test/vectors.test.ts, the dotnet tests).
 * Review the file's diff when the core changes: it is the core's behaviour, written out.
 *
 *   npm run turn-vectors       (node kit/test/turn-scenarios.ts --write)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../core/index.js';
import type { Action, Result, Step } from '../core/index.js';

const RULES = core.checkRules(JSON.parse(readFileSync(new URL('../spec/rules.json', import.meta.url), 'utf8')));
const T0 = 1_790_000_000_000;
const ME = 4100;
const ALIVE = 5200;
const OTHER = 5300;
const GONE = 6300;

/** A pretend disk below the locks folder, processes, and what happens when. */
class World {
  dirs = new Map<string, number>([['', T0 - 3_600_000]]);
  files = new Map<string, { text: string; mtimeMs: number }>();
  alive = new Set<number>([ME, ALIVE, OTHER]);
  /** Failures to give, once each, by op and path. */
  failures: { op: string; path: string; error: string }[] = [];
  events: { at: number; then: (w: World) => void }[] = [];
  now = T0;

  dir(p: string, mtimeMs = T0 - 60_000) {
    this.dirs.set(p, mtimeMs);
    return this;
  }
  file(p: string, text: string, mtimeMs = T0 - 500) {
    const parent = p.split('/').slice(0, -1).join('/');
    if (!this.dirs.has(parent)) this.dir(parent);
    this.files.set(p, { text, mtimeMs });
    return this;
  }
  owner(dir: string, pid: number, since: number) {
    this.dir(dir, since);
    return this.file(`${dir}/owner.json`, core.ownerText({ pid, since }), since);
  }
  ticket(lane: core.Lane, timeUs: number, pid: number, nonce: string, mtimeMs = T0 - 500, queue = 'npu.queue') {
    return this.file(`${queue}/${core.ticketName(lane, timeUs, pid, nonce)}`, core.ticketText(lane, timeUs, pid, 'other'), mtimeMs);
  }
  fail(op: string, p: string, error: string) {
    this.failures.push({ op, path: p, error });
    return this;
  }
  at(ms: number, then: (w: World) => void) {
    this.events.push({ at: T0 + ms, then });
    return this;
  }
  removeDir(p: string) {
    for (const d of [...this.dirs.keys()]) if (d === p || d.startsWith(`${p}/`)) this.dirs.delete(d);
    for (const f of [...this.files.keys()]) if (f.startsWith(`${p}/`)) this.files.delete(f);
  }
  /** The events due by now. */
  advance(to: number) {
    this.now = to;
    for (const e of this.events.filter((x) => x.at <= to)) {
      this.events.splice(this.events.indexOf(e), 1);
      e.then(this);
    }
  }
  perform(a: Action): Result {
    const p = 'path' in a ? a.path.join('/') : '';
    const failure = this.failures.find((f) => f.op === a.op && f.path === p);
    if (failure) {
      this.failures.splice(this.failures.indexOf(failure), 1);
      return { error: failure.error };
    }
    const parent = p.split('/').slice(0, -1).join('/');
    switch (a.op) {
      case 'mkdirs': {
        const parts = p ? p.split('/') : [];
        for (let i = 1; i <= parts.length; i++) {
          const d = parts.slice(0, i).join('/');
          if (!this.dirs.has(d)) this.dirs.set(d, this.now);
        }
        return null;
      }
      case 'write':
        if (!this.dirs.has(parent)) return { error: 'ENOENT' };
        this.files.set(p, { text: a.text, mtimeMs: this.now });
        return null;
      case 'touch': {
        const f = this.files.get(p);
        if (!f) return { error: 'ENOENT' };
        f.mtimeMs = this.now;
        return null;
      }
      case 'list': {
        if (!this.dirs.has(p)) return { error: 'ENOENT' };
        const entries = [...this.files.entries()].filter(([f]) => f.split('/').slice(0, -1).join('/') === p).map(([f, v]) => ({ name: f.split('/').pop()!, mtimeMs: v.mtimeMs }));
        return { entries: entries.sort((x, y) => (x.name < y.name ? -1 : 1)) };
      }
      case 'alive':
        return { alive: a.pids.map((pid) => this.alive.has(pid)) };
      case 'remove':
        if (!this.files.delete(p)) return { error: 'ENOENT' };
        return null;
      case 'mkdir':
        if (!this.dirs.has(parent)) return { error: 'ENOENT' };
        if (this.dirs.has(p)) return { error: 'EEXIST' };
        this.dirs.set(p, this.now);
        return null;
      case 'read': {
        const f = this.files.get(p);
        return f ? { text: f.text } : { error: 'ENOENT' };
      }
      case 'stat': {
        const m = this.dirs.get(p) ?? this.files.get(p)?.mtimeMs;
        return m === undefined ? { error: 'ENOENT' } : { mtimeMs: m };
      }
      case 'rmdir':
        this.removeDir(p);
        return null;
      case 'note':
        return null;
    }
  }
}

interface Scenario {
  case: string;
  start: Record<string, unknown> & { machine: 'turn' | 'lock' };
  world: World;
  /** Let go once held (default true). */
  release?: boolean;
  /** What happens while it holds the lock. */
  whileHeld?: (w: World) => void;
}

const turn = (o: Record<string, unknown> = {}) => ({ machine: 'turn' as const, slots: ['npu'], pid: ME, nowMs: T0, nowUs: T0 * 1000, nonce: 'a1b2c3d4', lane: 'background', who: 'test', ...o });
const lock = (o: Record<string, unknown> = {}) => ({ machine: 'lock' as const, folder: 'build', pid: ME, nowMs: T0, ...o });
const mine = (lane: core.Lane = 'background', queue = 'npu.queue') => `${queue}/${core.ticketName(lane, T0 * 1000, ME, 'a1b2c3d4')}`;

const scenarios: Scenario[] = [
  {
    case: 'a free NPU: the ticket goes in, heads the line, takes the lock and leaves the line; the release removes the lock',
    start: turn(),
    world: new World(),
  },
  {
    case: 'a person waiting is named lane 0 and goes ahead of background work that came first',
    start: turn({ lane: 'interactive', who: 'person' }),
    world: new World().ticket('background', T0 * 1000 - 9_000_000, ALIVE, 'b2b2b2b2'),
  },
  {
    case: 'behind a holder and a live ticket: look every 100 ms; at the head, try every 50 ms; take the lock when it is let go',
    start: turn(),
    world: new World()
      .owner('npu', ALIVE, T0 - 2000)
      .ticket('background', T0 * 1000 - 1_000_000, OTHER, 'c3c3c3c3')
      .at(240, (w) => {
        w.removeDir('npu');
        w.files.delete(`npu.queue/${core.ticketName('background', T0 * 1000 - 1_000_000, OTHER, 'c3c3c3c3')}`);
        w.owner('npu', OTHER, w.now);
      })
      .at(400, (w) => w.removeDir('npu')),
  },
  {
    case: 'a late ticket ahead whose process is gone is dead: deleted, and the line moves on',
    start: turn(),
    world: new World().ticket('background', T0 * 1000 - 30_000_000, GONE, 'deadbeef', T0 - 6000),
  },
  {
    case: 'a late ticket ahead whose process runs is still waiting',
    start: turn({ waitMs: 150 }),
    world: new World().ticket('background', T0 * 1000 - 30_000_000, ALIVE, 'e5e5e5e5', T0 - 6000),
  },
  {
    case: 'a ticket with no heartbeat for over 15 s is dead whatever its pid says, and nobody is asked',
    start: turn(),
    world: new World().ticket('background', T0 * 1000 - 30_000_000, ALIVE, 'f6f6f6f6', T0 - 16_000),
  },
  {
    case: 'the heartbeat: the ticket is touched every 2 s; a touch that fails writes the ticket again',
    start: turn({ waitMs: 2300 }),
    world: new World().ticket('interactive', T0 * 1000 - 1_000_000, ALIVE, 'abababab').fail('touch', mine(), 'EPERM'),
  },
  {
    case: 'a ticket taken for dead (a long pause) goes back in under the same name, which keeps its place',
    start: turn({ waitMs: 180 }),
    world: new World()
      .owner('npu', ALIVE, T0 - 1000)
      .at(60, (w) => w.files.delete(mine())),
  },
  {
    case: 'the line folder removed: the ticket write puts it back',
    start: turn({ waitMs: 180 }),
    world: new World()
      .owner('npu', ALIVE, T0 - 1000)
      .at(60, (w) => w.removeDir('npu.queue')),
  },
  {
    case: 'a holder that overstayed 10 minutes is evicted, whatever its pid says',
    start: turn(),
    world: new World().owner('npu', ALIVE, T0 - 11 * 60_000),
  },
  {
    case: 'a holder whose process is gone is evicted',
    start: turn(),
    world: new World().owner('npu', GONE, T0 - 1000),
  },
  {
    case: 'a lock folder with no owner.json for over 10 s is a crash leftover: evicted',
    start: turn(),
    world: new World().dir('npu', T0 - 11_000),
  },
  {
    case: 'a lock folder with no owner.json yet is a holder about to write it: the waiter gives up when the wait is over, and leaves the line',
    start: turn({ waitMs: 120 }),
    world: new World().dir('npu', T0 - 2000),
  },
  {
    case: 'an eviction that finds a file open in the folder tries again every 25 ms, checking it is still stale',
    start: turn(),
    world: new World().owner('npu', GONE, T0 - 1000).fail('rmdir', 'npu', 'EBUSY').fail('rmdir', 'npu', 'EPERM'),
  },
  {
    case: 'a holder that comes back to life during an eviction is left alone',
    start: turn({ waitMs: 100 }),
    world: new World()
      .owner('npu', GONE, T0 - 1000)
      .fail('rmdir', 'npu', 'EBUSY')
      .at(5, (w) => w.alive.add(GONE)),
  },
  {
    case: 'two slots: the first held by a live holder (a program that knows no slots), the second taken',
    start: turn({ slots: ['gpu-x', 'gpu-x.2'], what: 'the graphics card' }),
    world: new World().owner('gpu-x', ALIVE, T0 - 1000),
  },
  {
    case: 'maxAhead: a line already that long ends at once, full, without joining',
    start: turn({ maxAhead: 2 }),
    world: new World().ticket('background', T0 * 1000 - 2_000_000, ALIVE, 'a0a0a0a0').ticket('interactive', T0 * 1000 - 1_000_000, OTHER, 'b0b0b0b0'),
  },
  {
    case: 'maxAhead: dead tickets are cleared before counting, and with room it joins',
    start: turn({ maxAhead: 1 }),
    world: new World().ticket('background', T0 * 1000 - 40_000_000, ALIVE, 'c0c0c0c0', T0 - 20_000),
  },
  {
    case: "a release lets go only while owner.json still names this holder: an evicted holder leaves the next one's lock",
    start: turn(),
    world: new World(),
    // Overstayed, evicted, and the lock taken by another meanwhile.
    whileHeld: (w) => {
      w.removeDir('npu');
      w.owner('npu', ALIVE, w.now);
    },
  },
  {
    case: 'a release that finds a file open in the folder tries again every 25 ms',
    start: turn(),
    world: new World().fail('rmdir', 'npu', 'EBUSY'),
  },
  {
    case: 'the disk refuses the lock folder: no turn, and the ticket leaves the line',
    start: turn(),
    world: new World().fail('mkdir', 'npu', 'EACCES'),
  },
  {
    case: 'the plain lock: free, taken, and released',
    start: lock({ what: 'C:\\locks\\build' }),
    world: new World(),
  },
  {
    case: 'the plain lock: held by a live holder, tried every 150 ms until the wait runs out',
    start: lock({ waitMs: 400 }),
    world: new World().owner('build', ALIVE, T0 - 1000),
  },
  {
    case: 'the plain lock: a dead holder is evicted',
    start: lock(),
    world: new World().owner('build', GONE, T0 - 1000),
  },
];

/** One scenario, run: the start and every step after it, as a driver would see them. */
function run(s: Scenario) {
  const w = s.world;
  const { machine, ...opts } = s.start;
  let r: Step = machine === 'turn' ? core.startTurn(RULES, opts as unknown as core.TurnOptions) : core.startLock(RULES, opts as unknown as core.LockOptions);
  const out: Record<string, unknown>[] = [shape(r)];
  let released = false;
  for (let i = 0; i < 400; i++) {
    const results = r.actions.map((a) => w.perform(a));
    if (r.done) {
      if ('held' in r.done && s.release !== false && !released) {
        released = true;
        s.whileHeld?.(w);
        w.advance(w.now + 1);
        r = core.release(r.state, w.now);
        out.push({ release: { nowMs: w.now }, ...shape(r) });
        continue;
      }
      return out;
    }
    w.advance(w.now + r.waitMs + 1);
    const observe = { nowMs: w.now, results };
    r = core.step(r.state, observe);
    out.push({ observe, ...shape(r) });
  }
  throw new Error(`${s.case}: no end in 400 steps`);
}

const shape = (r: Step) => ({ actions: r.actions, ...(r.waitMs ? { waitMs: r.waitMs } : {}), ...(r.done ? { done: r.done } : {}) });

export function makeTurnVectors() {
  return {
    about:
      "The kit's core, step by step (core/turn.js): a turn on an accelerator and the plain lock, in the situations a driver meets, with the timings of rules.json beside this file. Each case gives the start's options and then every step: what the driver saw (`observe`: the clock and each action's result) or a `release`, and what the core then decides (`actions` in order, `waitMs` when it waits, `done` when it has ended). Every driver of the core replays them: the core directly, the node part through its drive loop, the dotnet part through Jint. Made by kit/test/turn-scenarios.ts; take this file from a kit release, unchanged.",
    rules: 'rules.json',
    cases: scenarios.map((s) => ({ case: s.case, start: s.start, steps: run(s) })),
  };
}

/** The vectors as JSON, a step a line, so a change to the core reads as a diff of the steps it changes. */
export function vectorsText(v: ReturnType<typeof makeTurnVectors>): string {
  const cases = v.cases.map(
    (c) => `  {\n    "case": ${JSON.stringify(c.case)},\n    "start": ${JSON.stringify(c.start)},\n    "steps": [\n${c.steps.map((st) => `      ${JSON.stringify(st)}`).join(',\n')}\n    ]\n  }`,
  );
  return `{\n "about": ${JSON.stringify(v.about)},\n "rules": ${JSON.stringify(v.rules)},\n "cases": [\n${cases.join(',\n')}\n ]\n}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = vectorsText(makeTurnVectors());
  if (process.argv.includes('--write')) {
    writeFileSync(new URL('../spec/turn-vectors.json', import.meta.url), text);
    console.log(`kit/spec/turn-vectors.json: ${scenarios.length} cases`);
  } else process.stdout.write(text);
}
