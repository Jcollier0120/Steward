import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { until } from './until.ts';

// A scheduled round waits a few minutes while Manor has an automatic update due for the agent (update-hold.ts, kit
// 2.75.2), so Manor, which updates an agent only while it's idle, finds it so. Manor's files are written here, in a
// folder of the test's own: nothing reads this PC's Manor.
const home = mkdtempSync(path.join(os.tmpdir(), 'fixture-update-hold-'));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.MANOR_HOME = path.join(home, 'manor');
mkdirSync(process.env.MANOR_HOME, { recursive: true });
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });
after(() => rmSync(home, { recursive: true, force: true }));

const { UPDATE_HOLD_AGAIN_MS, UPDATE_HOLD_MS, updateDue, updateHolder } = await import('./fixture/src/kit/update-hold.ts');
const { every } = await import('./fixture/src/kit/schedule.ts');
const { setDuty } = await import('./fixture/src/kit/duty.ts');
const { forget } = await import('./fixture/src/kit/file-cache.ts');

const MIN = 60_000;
const manor = (file: string) => path.join(process.env.MANOR_HOME!, file);
/** Manor's settings.json and updates.json, as it writes them. */
function manorSays(o: { auto?: boolean; latest?: string; available?: boolean; problem?: string | null; offline?: boolean; failures?: Record<string, unknown> } = {}) {
  writeFileSync(manor('settings.json'), JSON.stringify({ name: 'Castellan', autoUpdate: { fixture: o.auto ?? true, other: true } }));
  writeFileSync(
    manor('updates.json'),
    JSON.stringify({
      checkedAt: '2026-10-15T20:00:00.000Z',
      problem: o.problem ?? null,
      offline: o.offline ?? false,
      items: [
        { id: 'other', name: 'Other', installed: '1.0.0', latest: '1.0.1', url: null, available: true, error: null },
        { id: 'fixture', name: 'Fixture', installed: '0.0.1', latest: o.latest ?? '0.0.2', url: null, available: o.available ?? true, error: null },
      ],
      failures: o.failures ?? {},
    }),
  );
  forget(manor('settings.json'));
  forget(manor('updates.json'));
}
const NOW = Date.parse('2026-10-15T21:00:00.000Z');
const due = (o: Parameters<typeof updateDue>[0] = {}) => updateDue({ dev: false, now: NOW, unsafe: {}, ...o });

test("an update is due when Manor has a newer version available, with the agent's automatic updates on", () => {
  manorSays();
  assert.equal(due(), '0.0.2');
  assert.equal(due({ version: '0.0.2' }), null, 'this version already');
  assert.equal(due({ version: '0.1.0' }), null, 'newer than Manor knows: its look is old');
  assert.equal(due({ dev: true }), null, "a development checkout, which Manor doesn't update");
  assert.equal(due({ unsafe: { '0.0.2': { why: 'rolled back' } } }), null, 'a version its install refuses');
  manorSays({ auto: false });
  assert.equal(due(), null, 'automatic updates off');
  manorSays({ available: false });
  assert.equal(due(), null);
  manorSays({ problem: 'GitHub said 503' });
  assert.equal(due(), null, "Manor's last look had a problem");
  manorSays({ offline: true });
  assert.equal(due(), null, 'offline');
  rmSync(manor('updates.json'));
  forget(manor('updates.json'));
  assert.equal(due(), null, 'Manor has never looked');
  assert.equal(updateDue({ dev: false, home: path.join(home, 'no-manor') }), null, 'no Manor');
});

test("an update Manor failed is due again once Manor tries it again, and never once it has given up (its three tries)", () => {
  const failed = (count: number, minutesAgo: number) => ({ fixture: { version: '0.0.2', at: new Date(NOW - minutesAgo * MIN).toISOString(), count, why: null } });
  manorSays({ failures: failed(1, 10) });
  assert.equal(due(), null, 'Manor waits 30 minutes before it tries again');
  manorSays({ failures: failed(1, 31) });
  assert.equal(due(), '0.0.2');
  manorSays({ failures: failed(3, 120) });
  assert.equal(due(), null, "left for the person: Manor won't try it by itself");
  manorSays({ latest: '0.0.3', failures: failed(3, 120) });
  assert.equal(due(), '0.0.3', 'a newer version is tried afresh');
});

test('the rounds wait 5 minutes at most for a version, then go on, and wait again 30 minutes later', () => {
  const hold = updateHolder();
  const t0 = NOW;
  assert.equal(hold(t0, null), null, 'nothing due: no wait');
  assert.match(hold(t0, '0.0.2')!, /Castellan to teach it the new skills of 0\.0\.2 \(its update\), a few minutes at most/);
  assert.ok(hold(t0 + UPDATE_HOLD_MS - 1, '0.0.2'));
  assert.equal(hold(t0 + UPDATE_HOLD_MS, '0.0.2'), null, 'its 5 minutes are up');
  assert.equal(hold(t0 + UPDATE_HOLD_MS + UPDATE_HOLD_AGAIN_MS - 1, '0.0.2'), null);
  assert.ok(hold(t0 + UPDATE_HOLD_MS + UPDATE_HOLD_AGAIN_MS, '0.0.2'), 'and again, half an hour on');
  // A newer version due is waited for afresh; nothing due ends the wait at once.
  const t1 = t0 + UPDATE_HOLD_MS + UPDATE_HOLD_AGAIN_MS + UPDATE_HOLD_MS;
  assert.ok(hold(t1, '0.0.3'));
  assert.equal(hold(t1 + MIN, null), null);
  assert.ok(hold(t1 + 2 * MIN, '0.0.3'), 'due again: a wait of its own');
});

test('a scheduled round waits while the update is due, saying so; a round asked for runs at once', async () => {
  setDuty(true);
  manorSays();
  let rounds = 0;
  const job = every(60 * MIN, async () => void rounds++, { firstDelayMs: 0, name: 'held-for-update', light: true });
  try {
    await until(() => job.state.waiting !== null, 5_000, 'the round to wait for the update');
    assert.match(job.state.waiting!, /Castellan to teach it the new skills of 0\.0\.2/);
    assert.equal(rounds, 0, 'no round ran');
    const next = Date.parse(job.state.nextRunAt!) - Date.now();
    assert.ok(next > 0 && next <= 30_000, `it looks again within 30 s (${next} ms)`);
    assert.ok(job.runNow());
    await until(() => rounds === 1 && !job.running, 5_000, 'the round asked for');
  } finally {
    job.stop();
  }
});
