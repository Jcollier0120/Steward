import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { stillFor, until } from '../kit/test/until.ts';

// Stages side by side: Settings' stagesAtOnce slots, one round at a time, and each repository held by one stage at once.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-slots-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { apart, apartNow, repoBusy, withRepo, withStageSlot } = await import('../src/stages/slots.ts');
const { LockTimeout } = await import('../src/kit/lock.ts');
const { DEFAULT_SETTINGS, normalizeSettings } = await import('../src/settings.ts');

/** A gate a test opens when it likes: the stage holding it runs until then. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
};

test('as many stages run at once as there are slots; one more waits, then gives up', async () => {
  const g = gate();
  const inside: string[] = [];
  const a = withStageSlot('release', 2, async () => (inside.push('release'), g.opened));
  const b = withStageSlot('bump', 2, async () => (inside.push('bump'), g.opened));
  await until(() => inside.length === 2);
  assert.deepEqual(inside.sort(), ['bump', 'release'], 'two slots: both run at once');
  await assert.rejects(withStageSlot('push', 2, async () => inside.push('push'), { waitMs: 100 }), LockTimeout);
  assert.ok(!inside.includes('push'), 'every slot taken: the third never ran');
  // One slot: the second waits for the first, and runs once it ends.
  const c = withStageSlot('merge', 1, async () => inside.push('merge'), { waitMs: 5000 });
  await stillFor();
  assert.ok(!inside.includes('merge'), 'its one slot is taken');
  g.open();
  await Promise.all([a, b, c]);
  assert.ok(inside.includes('merge'), 'it ran once the slot was free');
});

test('one round at a time, whatever the slots; a round runs beside another stage', async () => {
  const g = gate();
  const ran: string[] = [];
  const release = withStageSlot('release', 3, async () => (ran.push('release'), g.opened));
  const round = withStageSlot('round', 3, async () => (ran.push('round'), g.opened));
  await until(() => ran.length === 2);
  assert.deepEqual(ran.sort(), ['release', 'round'], 'a round beside a release');
  await assert.rejects(withStageSlot('round', 3, async () => ran.push('round 2')), LockTimeout, 'a second round is refused at once');
  g.open();
  await Promise.all([release, round]);
});

test('what fails inside a stage is the stage’s, not a taken slot', async () => {
  await assert.rejects(withStageSlot('bump', 2, async () => { throw new Error('its checks failed'); }), /its checks failed/);
  // Its slot is free again.
  assert.equal(await withStageSlot('bump', 1, async () => 'ok', { waitMs: 0 }), 'ok');
});

test('two stages never work on one repository at once: the second waits, saying so; others go on', async () => {
  const g = gate();
  const order: string[] = [];
  const lines: string[] = [];
  const release = withStageSlot('release', 2, () => withRepo(lines.push.bind(lines), 'manor', async () => (order.push('release in'), await g.opened, order.push('release out'))));
  await until(() => repoBusy('manor'));
  assert.ok(repoBusy('manor'), 'busy, seen from outside it');
  const round = withStageSlot('round', 2, async () => {
    // Another repository at once; Manor once the release is done with it.
    await withRepo(lines.push.bind(lines), 'porter', async () => order.push('round porter'));
    await withRepo(lines.push.bind(lines), 'manor', async () => {
      assert.ok(!repoBusy('manor'), 'not busy for the stage holding it');
      order.push('round manor');
    });
  });
  await until(() => order.includes('round porter') && lines.length > 0);
  await stillFor();
  assert.deepEqual(order, ['release in', 'round porter'], 'the round waits for Manor, not for Porter');
  assert.deepEqual(lines, ['[manor] waits for the release running beside this one to finish with it']);
  g.open();
  await Promise.all([release, round]);
  assert.deepEqual(order, ['release in', 'round porter', 'release out', 'round manor']);
  assert.ok(!repoBusy('manor'), 'free again');
});

test('work apart is known by name while it runs, however many of it, and not once each has ended or failed', async () => {
  const [a, b] = [gate(), gate()];
  const one = apart('kit trial', () => a.opened);
  const two = apart('kit trial', () => b.opened.then(() => Promise.reject(new Error('cut short'))));
  assert.equal(apartNow('whole suite', 'kit trial'), 'kit trial');
  assert.equal(apartNow('whole suite'), null);
  a.open();
  await one;
  assert.equal(apartNow('kit trial'), 'kit trial', 'the other still runs');
  b.open();
  await assert.rejects(two, /cut short/);
  assert.equal(apartNow('kit trial'), null);
});

test('a repository asked for again inside its own hold is just used', async () => {
  const out = await withRepo(() => {}, 'reeve', () => withRepo(() => {}, 'reeve', async () => 'inner'));
  assert.equal(out, 'inner');
});

test('Stages at once: 2 unless set, 1 to 4', () => {
  assert.equal(DEFAULT_SETTINGS.stagesAtOnce, 2);
  const at = (v: unknown) => normalizeSettings({ ...DEFAULT_SETTINGS, stagesAtOnce: v }).settings.stagesAtOnce;
  assert.equal(at(1), 1);
  assert.equal(at(3), 3);
  assert.equal(at(9), 4);
  assert.equal(at(0), 1);
  assert.equal(at('two'), 2);
  assert.equal(normalizeSettings({ ...DEFAULT_SETTINGS, stagesAtOnce: undefined }).settings.stagesAtOnce, 2);
});
