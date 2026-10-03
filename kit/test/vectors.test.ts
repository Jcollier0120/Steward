import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The spec's vectors, run against the kit's core directly and through the node part (the fixture's
// src/kit, as an agent has it): the queue's (npu-queue-vectors.json), the turn's step by step
// (turn-vectors.json) and the accelerators' (accelerator-vectors.json). The dotnet part runs the same
// files in kit/test/dotnet. Everything the node part writes goes to a scratch folder.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-vectors-'));
process.env.FIXTURE_HOME = path.join(home, 'agent');
process.env.REEVE_HOME = path.join(home, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'npu-agent', 'locks', 'npu');
after(() => rmSync(home, { recursive: true, force: true }));

const core = await import('../core/index.js');
const Q = await import('./fixture/src/kit/npu-queue.ts');
const A = await import('./fixture/src/kit/accelerators.ts');
const N = await import('./fixture/src/kit/npu.ts');
const { locksDir } = await import('./fixture/src/kit/lock.ts');

type Step = import('../core/index.js').Step;
type Action = import('../core/index.js').Action;
type Result = import('../core/index.js').Result;

const spec = (f: string) => JSON.parse(readFileSync(new URL(`../spec/${f}`, import.meta.url), 'utf8'));
const RULES = core.checkRules(spec('rules.json'));
const queue = spec('npu-queue-vectors.json');
const turns = spec('turn-vectors.json');
const accel = spec('accelerator-vectors.json');

// ---------------------------------------------------------------- the queue

for (const c of queue.order) {
  test(`queue vectors, order: ${c.case}`, () => {
    for (const [parse, compare] of [
      [core.parseTicket, (a: any, b: any) => core.compareTickets(RULES, a, b, queue.nowUs)],
      [Q.parseTicket, (a: any, b: any) => Q.compareTickets(a, b, queue.nowUs)],
    ] as const) {
      const parsed = (c.tickets as string[]).map(parse).filter((t) => !!t);
      parsed.sort(compare);
      assert.deepEqual(parsed.map((t) => t!.name), c.expected);
    }
  });
}

for (const d of queue.dead) {
  test(`queue vectors, dead: ${d.case}`, () => {
    assert.equal(core.isDeadTicket(RULES, d.ageMs, d.pidAlive), d.dead);
    let asked = false;
    assert.equal(Q.isDeadTicket(d.ageMs, () => ((asked = true), d.pidAlive)), d.dead);
    assert.equal(asked, core.ticketState(RULES, d.ageMs) === 'late', 'the process is asked about only when the ticket is late');
  });
}

for (const h of queue.holders) {
  test(`queue vectors, holders: ${h.case}`, () => {
    const nowMs = 1_790_000_000_000;
    const o = {
      owner: h.owner ? { pid: 4242, since: nowMs - h.sinceAgeMs } : null,
      folderMtimeMs: h.folderAgeMs === undefined || h.folderAgeMs === null ? null : nowMs - h.folderAgeMs,
      nowMs,
      ...(h.staleMs ? { staleMs: h.staleMs } : {}),
    };
    const first = core.holderState(RULES, o);
    const verdict = first === 'ask' ? core.holderState(RULES, { ...o, pidAlive: h.pidAlive }) : first;
    assert.equal(verdict === 'stale', h.stale);
  });
}

for (const c of queue.slots) {
  test(`queue vectors, slots: ${c.case}`, () => {
    const names = core.lockFoldersOf({ id: c.id, slots: c.slots });
    assert.deepEqual(names, c.folders);
    assert.equal(core.queueName(names[0]), c.queue);
    const dirs = A.lockDirsOf({ id: c.id, slots: c.slots });
    assert.deepEqual(dirs.map((d) => path.relative(locksDir, d)), c.folders);
    assert.equal(path.relative(locksDir, Q.queueDirFor(dirs[0])), c.queue);
  });
}

// ---------------------------------------------------------------- the turn, step by step

const startOf = (s: any): Step => {
  const { machine, ...o } = s;
  return machine === 'turn' ? core.startTurn(RULES, o) : core.startLock(RULES, o);
};

/** A step as the vectors write it: its actions, its wait (left out when none) and how it ended. */
const shape = (r: Step) => ({ actions: r.actions, waitMs: r.waitMs, done: r.done });
const expected = (s: any) => ({ actions: s.actions, waitMs: s.waitMs ?? 0, done: s.done });

for (const c of turns.cases) {
  test(`turn vectors, the core: ${c.case}`, () => {
    let r = startOf(c.start);
    assert.deepEqual(shape(r), expected(c.steps[0]), 'the start');
    for (let i = 1; i < c.steps.length; i++) {
      const s = c.steps[i];
      r = s.release ? core.release(r.state, s.release.nowMs) : core.step(r.state, s.observe);
      assert.deepEqual(shape(r), expected(s), `step ${i}`);
      assert.deepEqual(JSON.parse(JSON.stringify(r.state)), r.state, 'a state is plain data');
    }
  });

  test(`turn vectors, the node part's drive loop: ${c.case}`, async () => {
    const steps = c.steps;
    let i = 0;
    let k = 0;
    const waits: number[] = [];
    const env = {
      perform: (a: Action): Result => {
        assert.deepEqual(a, steps[i].actions[k], `step ${i}, action ${k}`);
        const next = steps[i + 1];
        return next?.observe ? next.observe.results[k++] : (k++, null);
      },
      clock: () => {
        assert.equal(k, steps[i].actions.length, `every action of step ${i} carried out`);
        i++;
        k = 0;
        return steps[i].observe.nowMs;
      },
      sleep: async (ms: number) => void waits.push(ms),
    };
    let r = await Q.drive(startOf(c.start), env);
    assert.deepEqual(r.done, steps[i].done);
    if (i + 1 < steps.length) {
      i++;
      k = 0;
      r = await Q.drive(core.release(r.state, steps[i].release.nowMs), env);
      assert.deepEqual(r.done, steps[i].done);
    }
    assert.equal(i, steps.length - 1, 'every step taken');
    assert.deepEqual(waits, steps.filter((s: any) => s.waitMs && !s.done).map((s: any) => s.waitMs));
  });
}

test('the drive loop aborts a machine that throws: its ticket leaves the line, and the error is passed on', async () => {
  const done: Action[] = [];
  const first = core.startTurn(RULES, { slots: ['npu'], pid: 1, nowMs: 0, nowUs: 0, nonce: 'aaaaaaaa', who: 't' });
  await assert.rejects(
    Q.drive(first, {
      perform: (a) => {
        done.push(a);
        if (a.op === 'list') throw new Error('the disk went away');
        return null;
      },
      clock: () => 1,
      sleep: async () => {},
    }),
    /the disk went away/,
  );
  assert.deepEqual(done.at(-1), { op: 'remove', path: ['npu.queue', first.state.ticket] });
});

// ---------------------------------------------------------------- the accelerators

const NOW = accel.nowMs as number;
const configOf = (raw: unknown) => {
  const c = core.parseAccelerators(RULES, raw);
  if ('error' in c) throw new Error(c.error);
  return c.accelerators;
};

test('accelerator vectors: ids, and the names behind them', () => {
  for (const { name, id } of accel.ids) {
    assert.equal(core.acceleratorId('gpu', name), id, name);
    assert.equal(A.acceleratorId('gpu', name), id, name);
  }
  for (const { id, valid, kind } of accel.isId) {
    assert.equal(core.isId(id), valid, id);
    assert.equal(core.kindOfId(id), kind, id);
  }
  for (const c of accel.lockFolders) {
    assert.deepEqual(core.lockFoldersOf(c), c.folders, c.case);
    assert.deepEqual(A.lockDirsOf(c).map((d) => path.relative(locksDir, d)), c.folders, c.case);
  }
  for (const c of accel.cards) {
    assert.deepEqual(core.keyedCards(c.adapters, { software: c.software }).map((x) => x.key), c.keys, c.case);
    if (!c.software) assert.deepEqual(A.keyedCards(c.adapters).map((x) => x.key), c.keys, c.case);
  }
});

for (const c of accel.configs) {
  test(`accelerator vectors, Reeve's config: ${c.case}`, () => {
    assert.deepEqual(core.parseAccelerators(RULES, c.raw), c.expect);
    assert.deepEqual(A.parseAccelerators(c.raw), c.expect);
  });
}

test("accelerator vectors: Reeve's config.json read from its file, through the node part", () => {
  const dir = path.join(home, 'config-files');
  mkdirSync(dir, { recursive: true });
  accel.files.forEach((f: any, i: number) => {
    assert.deepEqual(core.readConfig(RULES, f.file, f.text), f.expect, f.case);
    const file = path.join(dir, `config-${i}.json`);
    if (f.text !== null) writeFileSync(file, f.text);
    const want = JSON.parse(JSON.stringify(f.expect).split(JSON.stringify(f.file).slice(1, -1)).join(JSON.stringify(file).slice(1, -1)));
    const got = A.loadAccelerators(file);
    // The message of a file that isn't JSON is the JSON reader's own, which may differ between engines.
    if ('error' in want && /couldn't be read/.test(want.error)) assert.match((got as { error: string }).error, new RegExp(`^${file.replace(/[\\.]/g, '\\$&')} couldn't be read: `), f.case);
    else assert.deepEqual(got, want, f.case);
  });
});

test('accelerator vectors: failure markers, read through the node part from their files', () => {
  for (const f of accel.failures) {
    assert.deepEqual(core.failureOf(RULES, f.text, NOW), f.expect, f.case);
    rmSync(A.failedFile('gpu-v'), { force: true });
    if (f.text !== null) {
      mkdirSync(path.dirname(A.failedFile('gpu-v')), { recursive: true });
      writeFileSync(A.failedFile('gpu-v'), f.text);
    }
    assert.deepEqual(A.readFailure('gpu-v', NOW), f.expect, f.case);
  }
  for (const r of accel.reasons) assert.equal(core.oneLine(RULES, r.text), r.expect, JSON.stringify(r.text));
  for (const r of accel.records) {
    assert.equal(core.sharedText(core.failureRecord(RULES, r.reason, r.by, r.nowMs)), r.expect);
    A.markFailed('gpu-w', r.reason, r.by, r.nowMs);
    assert.equal(readFileSync(A.failedFile('gpu-w'), 'utf8'), r.expect, 'markFailed writes it, whole');
  }
});

test('accelerator vectors: games', () => {
  for (const g of accel.games) {
    assert.deepEqual(core.gameCards(RULES, g.load, configOf(g.config), { self: g.self }), g.expect, g.case);
    assert.deepEqual(A.gameCards(g.load, configOf(g.config), { self: g.self }), g.expect, g.case);
  }
  for (const s of accel.serverNames) assert.deepEqual(A.serverNames(configOf(s.config)), s.expect);
  for (const g of accel.gamesStale) {
    assert.equal(core.gamesStale(RULES, g.games, NOW), g.stale, g.case);
    assert.equal(A.gamesStale(g.games, NOW), g.stale, g.case);
  }
});

for (const c of accel.candidates) {
  test(`accelerator vectors, candidates: ${c.case}`, () => {
    const accs = configOf(c.config);
    const plain = (r: { list: { id: string }[]; skipped: { acc: { id: string }; why: string; detail: string }[] }) => ({
      list: r.list.map((a) => a.id),
      skipped: r.skipped.map((s) => ({ id: s.acc.id, why: s.why, detail: s.detail })),
    });
    assert.deepEqual(plain(core.candidates(RULES, accs, c.need, { failures: c.failures, games: c.games, deferredMs: c.deferredMs, nowMs: NOW })), c.expect);
    const viaNode = A.candidates(accs, c.need, {
      failure: c.failures ? (id) => c.failures[id] ?? null : undefined,
      games: c.games,
      deferredMs: c.deferredMs ? (id) => c.deferredMs[id] ?? 0 : undefined,
      now: NOW,
    });
    assert.deepEqual(plain(viaNode), c.expect);
  });
}

for (const c of accel.pick) {
  test(`accelerator vectors, the pick: ${c.case}`, () => {
    const list = configOf(c.config).filter((a) => c.candidates.includes(a.id));
    const plain = (r: { acc: { id: string } } | { deferred: string }) => ('acc' in r ? { acc: r.acc.id } : r);
    assert.deepEqual(plain(core.pick(RULES, list, c.lane, c.looks)), c.expect);
    assert.deepEqual(plain(A.pick(list, c.lane, (a) => c.looks[a.id])), c.expect);
  });
}

test('accelerator vectors: why none could take a request, the messages, and the size of a request', () => {
  for (const w of accel.whyNone) {
    const skipped = w.skipped.map((s: any) => ({ ...s, acc: { id: s.id, name: s.id } }));
    assert.deepEqual(core.whyNone(skipped, w.first), w.expect, w.case);
  }
  for (const m of accel.messages) {
    assert.equal(core.theAccelerator(m.ref), m.theAccelerator, m.case);
    assert.equal(A.theAccelerator(m.ref), m.theAccelerator, m.case);
    assert.equal(A.noteLabel(m.ref), m.noteLabel, m.case);
  }
  for (const t of accel.tokens) {
    if (t.text !== undefined) assert.equal(N.estimateTokens(t.text), t.estimate);
    if (t.chat) assert.equal(core.chatTokens(RULES, t.chat), t.estimate);
    if (t.vision) assert.equal(core.visionTokens(RULES, t.vision), t.estimate);
  }
  for (const p of accel.pieces) assert.deepEqual(N.pieces(p.text, p.budget), p.expect);
});
