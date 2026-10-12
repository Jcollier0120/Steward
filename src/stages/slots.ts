import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { LockTimeout, withLock } from '../kit/lock.ts';
import { dataFile } from '../kit/store.ts';

/**
 * Stages side by side. Settings' stagesAtOnce stages run at the same time on this PC, the page's and a terminal's
 * alike, each holding one of that many slots (locks\stage, locks\stage.2 …: the first is the one lock an older
 * Steward took for every stage). Each stage works on a repository only while it holds that repository's lock
 * (locks\repo-<id>), so two stages never touch one repository at once: the second waits for the first to finish
 * with it, as if they had run one after the other there. Rounds also hold locks\round: one round at a time.
 */

export const stageSlot = (n: number) => dataFile('locks', n === 1 ? 'stage' : `stage.${n}`);
const roundLock = () => dataFile('locks', 'round');
export const repoLock = (id: string) => dataFile('locks', `repo-${id}`);

/** A stage's hold, and a repository's: one whose process is gone is seen at once; a live one this long is overstayed. */
export const STAGE_STALE_MS = 3 * 3600_000;

/** What the slots are waited for: a stage started while all are taken waits this long, then gives up (LockTimeout). */
const SLOT_POLL_MS = 250;

/** The stage this code runs in, for a line saying what a repository waits for. */
const inStage = new AsyncLocalStorage<string>();
/** The repositories this code holds already: one asked for again inside them is just used. */
const held = new AsyncLocalStorage<ReadonlySet<string>>();
/** Which stage of this process holds each repository, for that line. */
const holders = new Map<string, string>();

/**
 * Runs `fn` as the stage `name` in one of `slots` slots: the first free one, else waits up to `waitMs` for one, then
 * throws LockTimeout. A round takes the round's lock too, at once or not at all: one round at a time.
 */
export async function withStageSlot<T>(name: string, slots: number, fn: () => Promise<T>, o: { waitMs?: number } = {}): Promise<T> {
  const deadline = Date.now() + (o.waitMs ?? 2000);
  const run = () => inStage.run(name, () => (name === 'round' ? withLock(roundLock(), fn, { waitMs: 0, staleMs: STAGE_STALE_MS }) : fn()));
  for (;;) {
    for (let n = 1; n <= Math.max(1, slots); n++) {
      let entered = false;
      try {
        return await withLock(
          stageSlot(n),
          () => {
            entered = true;
            return run();
          },
          { waitMs: 0, staleMs: STAGE_STALE_MS },
        );
      } catch (e) {
        // A slot taken: the next. What failed inside the stage is the stage's.
        if (entered || !(e instanceof LockTimeout)) throw e;
      }
    }
    if (Date.now() >= deadline) throw new LockTimeout(`all ${slots} of the stages' slots are taken`);
    await new Promise((r) => setTimeout(r, SLOT_POLL_MS));
  }
}

/**
 * Runs `fn` holding employee `id`'s repository: at once when it's free, or already held here; else after a line in the
 * stage's log, once the stage holding it has finished with it.
 */
export async function withRepo<T>(log: (line: string) => void, id: string, fn: () => Promise<T>): Promise<T> {
  const mine = held.getStore();
  if (mine?.has(id)) return fn();
  if (existsSync(repoLock(id))) {
    const by = holders.get(id);
    log(`[${id}] waits for ${by ? `the ${by} running beside this one` : 'another stage (in a terminal, say)'} to finish with it`);
  }
  const next = new Set(mine);
  next.add(id);
  return withLock(
    repoLock(id),
    async () => {
      holders.set(id, inStage.getStore() ?? 'stage');
      try {
        return await held.run(next, fn);
      } finally {
        holders.delete(id);
      }
    },
    { waitMs: STAGE_STALE_MS, staleMs: STAGE_STALE_MS },
  );
}

/** Whether another stage is working on employee `id`'s repository now: then a look at it leaves its clone alone. */
export const repoBusy = (id: string): boolean => !held.getStore()?.has(id) && existsSync(repoLock(id));
