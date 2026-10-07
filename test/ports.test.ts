import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Ports claimed up front, as versions are: the next free one of the agents' series, with its development twin free;
// an agent that has one keeps it; the same again for the same agent; and two agents on one port are an alarm.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-ports-'));
process.env.STEWARD_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { appPort, claimPort, clashes, liveClaims, loadPortClaims, manorUses, nextPort, portClashConditions, portOfUrl, releasePort, seriesAfter } = await import('../src/ports.ts');
import type { PortUse } from '../src/ports.ts';

const DAY = 86_400_000;
const use = (id: string, port: number, source: PortUse['source'] = 'staff'): PortUse => ({ id, port, source });

test("an agent's port, from its src/app.ts or its Manor entry", () => {
  assert.equal(appPort("const place = placeFor({ id: APP.id, port: 19393, dev: devCheckout, home: os.homedir(), env: process.env });"), 19393);
  assert.equal(appPort('export const DEFAULT_PORT = 18585;'), 18585);
  assert.equal(appPort("/** The page's port: 19494 (29494 in a checkout). */"), null, 'a comment is no port');
  assert.equal(appPort(null), null);
  assert.equal(portOfUrl('http://pinder.localhost:19393/'), 19393);
  assert.equal(portOfUrl('not a url'), null);
});

test("the agents' series: two digits twice after the first, x0000 and x0101 left out", () => {
  assert.deepEqual([19000, 19090, 19999, 20707, 20808, 20909].map(seriesAfter), [19090, 19191, 20202, 20808, 20909, 21010]);
  assert.equal(nextPort([use('crier', 20808)]), 20909);
  assert.equal(nextPort([use('crier', 20808), use('x', 30909, 'clone')]), 21010, "20909's development twin is taken");
  assert.equal(nextPort([use('crier', 20808), use('manor', 18585, 'manor'), use('reeve', 18383)]), 20909, 'ports below the series are no agent page');
});

test("what Manor knows: its own port, its staff, this PC's own staff, and the agents announced on GitHub", () => {
  const manor = path.join(home, 'manor');
  mkdirSync(path.join(manor, 'app'), { recursive: true });
  writeFileSync(path.join(manor, 'app', 'staff.json'), JSON.stringify({ agents: [{ id: 'shepherd', home: 'http://shepherd.localhost:20707/', ping: 'http://127.0.0.1:20707/api/ping' }] }));
  writeFileSync(path.join(manor, 'staff.local.json'), JSON.stringify({ agents: [{ id: 'crier', home: 'http://crier.localhost:20808/' }] }));
  writeFileSync(path.join(manor, 'announced.json'), JSON.stringify({ agents: [{ repo: 'me/Assayer', agent: { id: 'assayer', home: 'http://assayer.localhost:20707/' } }] }));
  const uses = manorUses(manor);
  assert.deepEqual(uses, [use('manor', 18585, 'manor'), use('shepherd', 20707), use('crier', 20808, 'this PC'), use('assayer', 20707, 'announced')]);
  // The Assayer and the Shepherd: Manor offered only one, and the Assayer's role sat with no one to hire.
  assert.deepEqual(clashes(uses), [{ port: 20707, ids: ['shepherd', 'assayer'], where: ['shepherd (staff)', 'assayer (announced)'] }]);
  const [alarm] = portClashConditions(uses);
  assert.equal(alarm.id, 'port-plan:20707');
  assert.equal(alarm.title, 'shepherd and assayer have the same port, 20707');
  assert.ok(alarm.detail.some((d) => d.includes('claim-port assayer')));
  assert.deepEqual(clashes([use('pinder', 19393, 'staff'), use('pinder', 19393, 'clone')]), [], 'one agent in two places is no clash');
});

test('a claim: the next free port, the same again for the same agent, and a different one for the next agent', async () => {
  const uses = [use('crier', 20808, 'this PC'), use('manor', 18585, 'manor')];
  const now = Date.parse('2026-10-07T12:00:00Z');
  const a = await claimPort({ id: 'tallyman', branch: 'claude/tallyman', by: 'claude', for: 'the Tallyman', uses, now });
  assert.equal(a.port, 20909);
  assert.equal(a.again, false);
  assert.equal(a.already, null);
  const again = await claimPort({ id: 'tallyman', branch: 'claude/other', by: 'claude', for: 'x', uses, now });
  assert.deepEqual([again.port, again.again], [20909, true], 'one port an agent, whichever branch asks');
  const b = await claimPort({ id: 'cooper', branch: null, by: 'claude', for: 'the Cooper', uses, now });
  assert.equal(b.port, 21010, "the Tallyman's claim is taken");
  assert.equal(loadPortClaims().length, 2);
  assert.equal(await releasePort('cooper'), true);
  assert.equal(await releasePort('cooper'), false);
  assert.equal((await claimPort({ id: 'cooper', by: 'claude', for: '', uses, now })).port, 21010, 'given back, it is free again');
});

test('an agent with a port keeps it; a claim ends when its port lands, or after 14 days', async () => {
  const uses = [use('crier', 20808, 'this PC')];
  const kept = await claimPort({ id: 'crier', by: 'claude', for: '', uses });
  assert.deepEqual([kept.port, kept.already?.source, kept.claim], [20808, 'this PC', null]);
  const claim = { id: 'tallyman', port: 20909, branch: null, by: 'claude', for: '', at: '2026-10-01T00:00:00Z' };
  const t0 = Date.parse(claim.at);
  assert.equal(liveClaims([claim], uses, t0 + 13 * DAY).length, 1);
  assert.equal(liveClaims([claim], uses, t0 + 14 * DAY).length, 0, 'stale');
  assert.equal(liveClaims([claim], [...uses, use('tallyman', 20909, 'clone')], t0 + DAY).length, 0, 'landed: its clone says so');
  await assert.rejects(claimPort({ id: 'Not An Id', by: 'claude', for: '', uses }), /isn't an agent id/);
});
