import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// On the PC that releases Castellan, an agent that carries the kit is on the kit's stages however it came to be looked
// after: picked with Look after (found.ts), or looked after before Look after knew one (employ.ts' takeOntoKit).
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-onto-kit-'));
process.env.STEWARD_HOME = path.join(home, 'steward');
mkdirSync(process.env.STEWARD_HOME, { recursive: true });
process.env.MANOR_HOME = path.join(home, 'no-manor');
after(() => rmSync(home, { recursive: true, force: true }));

const { makersPcForTests } = await import('../src/maker.ts');
const { lookAfter } = await import('../src/found.ts');
const { takeOntoKit } = await import('../src/employ.ts');
const { fakeEmployee } = await import('./helpers.ts');

makersPcForTests(() => true);
const none = new Set<string>();
const ANNOUNCE = (id: string, name: string) => JSON.stringify({ agent: { id, name }, roles: [] });
const PKG = '{\n  "name": "fake",\n  "version": "0.4.0",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test", "release": "node tools/release.ts" }\n}\n';

/** A clone of one of Castellan's agents with the kit (or, kit: null, a repository without it). */
function agent(name: string, o: { kit?: null } = {}) {
  const files: Record<string, string> = { 'package.json': PKG, 'tsconfig.json': '{}\n', 'tools/kit.ts': '', 'src/cli.ts': '', 'manor-agent.json': ANNOUNCE(name.toLowerCase(), name) };
  return fakeEmployee(path.join(home, name), { kit: o.kit, files }).checkout;
}

/** An employee as Look after made one before this version: off the kit, nothing to fill, merging and releasing off. */
const lookedAfter = (id: string, checkout: string, extra: Record<string, unknown> = {}) => ({
  id, name: id[0].toUpperCase() + id.slice(1), repo: `Jcollier0120/${id}`, checkout, branch: 'main', merges: false, usesKit: false, fill: '',
  test: ['npm run typecheck', 'npm test'], versionFiles: ['package.json'], release: '', install: '', approve: '', installed: '', ...extra,
});

test('Look after takes an agent with the kit onto it, merging and releasing as ticked; a repository without it as before', () => {
  const butler = agent('Butler');
  const site = agent('Site', { kit: null });
  const found = { at: new Date().toISOString(), from: 'reeve' as const, error: null, repos: [
    { repo: 'Jcollier0120/Butler', name: 'Butler', path: butler, branch: 'main', lockfiles: [], push: true },
    { repo: 'Jcollier0120/Site', name: 'Site', path: site, branch: 'main', lockfiles: [], push: true },
  ] };
  const file = path.join(home, 'look-after.json');
  writeFileSync(file, JSON.stringify({ releasesCastellan: true, employees: [] }));
  const took = lookAfter('Jcollier0120/Butler', { merges: true, release: true, found, file });
  assert.ok('employee' in took, 'error' in took ? took.error : '');
  const e = took.employee;
  assert.deepEqual([e.id, e.name, e.repo, e.usesKit, e.merges, e.fill, e.install], ['butler', 'Butler', 'Jcollier0120/Butler', true, true, 'node tools/kit.ts', 'node src/cli.ts install']);
  assert.deepEqual(e.test, ['npx tsc -p . --noEmit', 'npm test']);
  assert.notEqual(e.release, '');
  const plain = lookAfter('Jcollier0120/Site', { merges: false, release: false, found, file });
  assert.ok('employee' in plain);
  assert.deepEqual([plain.employee.usesKit, plain.employee.fill, plain.employee.merges], [false, '', false]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).employees.map((x: { id: string }) => x.id), ['butler', 'site']);
});

test('Look after with releasing unticked leaves the release empty, so the Release stage passes it over', () => {
  const marshal = agent('Marshal');
  const found = { at: new Date().toISOString(), from: 'reeve' as const, error: null, repos: [{ repo: 'Jcollier0120/Marshal', name: 'Marshal', path: marshal, branch: 'main', lockfiles: [], push: true }] };
  const file = path.join(home, 'no-release.json');
  writeFileSync(file, JSON.stringify({ releasesCastellan: true, employees: [] }));
  const took = lookAfter('Jcollier0120/Marshal', { merges: false, release: false, found, file });
  assert.ok('employee' in took);
  assert.deepEqual([took.employee.usesKit, took.employee.merges, took.employee.release, took.employee.fill], [true, false, '', 'node tools/kit.ts']);
});

test('employees looked after off the kit that carry it are taken onto it; the rest, and the Steward, are left alone', () => {
  const scribe = agent('Scribe');
  const cellarer = agent('Cellarer');
  const strata = agent('Strata', { kit: null });
  const self = agent('Steward');
  const file = path.join(home, 'settings.json');
  const porter = { ...lookedAfter('porter', 'C:\\nowhere'), usesKit: true, fill: 'node tools/kit.ts', merges: true };
  const before = {
    releasesCastellan: true,
    team: ['someone'],
    employees: [
      porter,
      lookedAfter('scribe', scribe, { note: 'kept' }),
      // Taken on the kit but with nothing to fill: its fill and the rest are the hire's too.
      lookedAfter('cellarer', cellarer, { usesKit: true }),
      lookedAfter('strata', strata),
      lookedAfter('steward', self),
    ],
  };
  writeFileSync(file, JSON.stringify(before));
  const isSelf = (dir: string) => dir === self;
  const o = { settingsFile: file, internal: none, staff: none, isSelf };
  let now = 1_000_000_000_000;
  assert.deepEqual(takeOntoKit({ ...o, now }), ['scribe', 'cellarer']);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after.team, ['someone'], 'everything else kept');
  const [p, s, c, st, self2] = after.employees;
  assert.deepEqual(p, porter);
  assert.deepEqual([s.id, s.name, s.repo, s.checkout, s.note], ['scribe', 'Scribe', 'Jcollier0120/scribe', scribe, 'kept'], 'who it is, as Settings had it');
  assert.deepEqual([s.usesKit, s.merges, s.fill, s.install], [true, true, 'node tools/kit.ts', 'node src/cli.ts install']);
  assert.deepEqual(s.test, ['npx tsc -p . --noEmit', 'npm test']);
  assert.deepEqual(s.versionFiles, ['package.json', 'package-lock.json', 'src/app.ts']);
  assert.notEqual(s.release, '');
  assert.deepEqual([c.usesKit, c.fill], [true, 'node tools/kit.ts']);
  assert.deepEqual(st, before.employees[3], 'no kit.json: left as it is');
  assert.deepEqual(self2, before.employees[4], "the Steward's own clone: left as it is");
  // Looked at again only every few minutes, and then nothing is left to take on: the file isn't written.
  writeFileSync(file, JSON.stringify({ ...after, employees: [...after.employees, lookedAfter('late', agent('Late'))] }));
  assert.deepEqual(takeOntoKit({ ...o, now: now + 60_000 }), [], 'too soon');
  now += 10 * 60_000;
  assert.deepEqual(takeOntoKit({ ...o, now }), ['late']);
  now += 10 * 60_000;
  assert.deepEqual(takeOntoKit({ ...o, now }), []);
});

test('off the PC that releases Castellan nothing is taken onto the kit', () => {
  const file = path.join(home, 'customer.json');
  const before = { releasesCastellan: false, employees: [lookedAfter('chronicler', agent('Chronicler'))] };
  writeFileSync(file, JSON.stringify(before));
  assert.deepEqual(takeOntoKit({ settingsFile: file, now: 2_000_000_000_000, internal: none, staff: none }), []);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), before);
});
