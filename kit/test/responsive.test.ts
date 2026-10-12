import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A process people wait on (gentle.ts keepResponsive, kit 2.57.1): its rounds never slow it. In a file of its own,
// since it lasts as long as the process.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-responsive-'));
after(() => rmSync(home, { recursive: true, force: true }));
process.env.FIXTURE_HOME = path.join(home, 'data');
process.env.KIT_GENTLE = '0'; // priority alone: no PowerShell worker
mkdirSync(process.env.FIXTURE_HOME, { recursive: true });

const { keepResponsive, paceProcess } = await import('./fixture/src/kit/gentle.ts');
const { BELOW_NORMAL, NORMAL } = { BELOW_NORMAL: os.constants.priority.PRIORITY_BELOW_NORMAL, NORMAL: os.constants.priority.PRIORITY_NORMAL };

test('kept responsive: back to normal priority, and a gentle round leaves it there', async () => {
  await paceProcess('gentle');
  assert.equal(os.getPriority(0), BELOW_NORMAL, 'a scheduled round at a gentle pace lowers it, as before');
  await keepResponsive();
  assert.equal(os.getPriority(0), NORMAL, 'lifted at once');
  await paceProcess('gentle');
  assert.equal(os.getPriority(0), NORMAL, 'its rounds no longer lower it');
});
