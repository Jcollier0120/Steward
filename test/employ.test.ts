import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// employ: a new agent taken on from its clone, its entry as the migration would make it, published only when it
// announces itself (or Manor lists it), and refused when the Steward looks after it already.
const home = mkdtempSync(path.join(os.tmpdir(), 'steward-employ-'));
process.env.STEWARD_HOME = home;
process.env.MANOR_HOME = path.join(home, 'no-manor');
after(() => rmSync(home, { recursive: true, force: true }));

const { addEmployee, employeeFor, identityOf, partsOf } = await import('../src/employ.ts');
const { normalizeSettings, RELEASE_HERE } = await import('../src/settings.ts');
const { employee, fakeEmployee, sh } = await import('./helpers.ts');

const PKG = '{\n  "name": "fake",\n  "version": "0.4.0",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test", "release": "node tools/release.ts" }\n}\n';
const ANNOUNCE = JSON.stringify({ agent: { id: 'fake', name: 'Fake Agent' }, roles: [] });
const REPO = 'Jcollier0120/Fake';
const origin = () => REPO;
const none = new Set<string>();

/** A clone of a new agent, as the Wright or a person leaves one: kit, tests, release, and maybe its announcement. */
function clone(name: string, o: { announce?: boolean; kit?: string | null } = {}) {
  const files: Record<string, string> = { 'package.json': PKG, 'tsconfig.json': '{}\n', 'tools/kit.ts': '', 'src/cli.ts': '', ...(o.announce ? { 'manor-agent.json': ANNOUNCE } : {}) };
  const { checkout } = fakeEmployee(path.join(home, name), { kit: o.kit, files });
  if (o.kit !== null) writeFileSync(path.join(checkout, 'kit.json'), '{\n  "kit": "2.28.1",\n  "parts": ["node", "web", "spec", "react"]\n}\n');
  if (o.kit !== null) {
    sh(checkout, 'commit', '--quiet', '-am', 'Take the react part');
    sh(checkout, 'push', '--quiet', 'origin', 'main');
  }
  return checkout;
}

test('identityOf takes the announcement first, then src/app.ts', () => {
  const read = (files: Record<string, string>) => (rel: string) => files[rel] ?? null;
  assert.deepEqual(identityOf(read({ 'manor-agent.json': ANNOUNCE, 'src/app.ts': "id: 'other'" })), { id: 'fake', name: 'Fake Agent', announces: true });
  assert.deepEqual(identityOf(read({ 'manor-agent.json': '{not json', 'src/app.ts': "  id: 'assayer',\n  name: 'Assayer',\n" })), { id: 'assayer', name: 'Assayer', announces: false });
  assert.equal(identityOf(read({ 'manor-agent.json': JSON.stringify({ agent: { id: 'Bad Id' } }) })), null);
  assert.equal(identityOf(read({})), null);
  // In whichever quotes app.ts uses (the Pinder's and the Crier's are double), its name as written.
  assert.deepEqual(identityOf(read({ 'src/app.ts': '  id: "crier",\n  name: "Crier",\n' })), { id: 'crier', name: 'Crier', announces: false });
  assert.deepEqual(identityOf(read({ 'src/app.ts': "  id: `fake`,\n  name: `Fake Agent`,\n" })), { id: 'fake', name: 'Fake Agent', announces: false });
  assert.deepEqual(identityOf(read({ 'src/app.ts': '  id: "fake",\n  name: "The Crier\'s cousin",\n' })), { id: 'fake', name: "The Crier's cousin", announces: false });
  assert.equal(identityOf(read({ 'src/app.ts': "  id: 'fake\",\n" })), null, 'quotes that don\'t match are no id');
});

test('partsOf reads kit.json as it is, react and all, and is null with no kit.json', () => {
  assert.deepEqual(partsOf('{"kit":"2.28.1","parts":["node","web","spec","react"]}'), ['node', 'web', 'spec', 'react']);
  assert.deepEqual(partsOf('\uFEFF{"parts":["dotnet"]}'), ['dotnet']);
  assert.equal(partsOf(null), null);
  assert.equal(partsOf('nope'), null);
});

test('an agent that announces itself is published, and installed from its release', () => {
  const checkout = clone('announced', { announce: true });
  const got = employeeFor(checkout, [], { origin, internal: none, staff: none });
  assert.ok(!('error' in got), 'error' in got ? got.error : '');
  const e = got.employee;
  assert.deepEqual([e.id, e.name, e.repo, e.checkout, e.branch], ['fake', 'Fake Agent', REPO, path.resolve(checkout), 'main']);
  assert.equal('parts' in e, false, 'the Steward keeps no copy of the kit parts: kit.json is their one source');
  assert.deepEqual(got.kitParts, ['node', 'web', 'spec', 'react'], 'its kit.json, as it says them');
  assert.equal(e.usesKit, true);
  assert.equal(e.fill, 'node tools/kit.ts');
  assert.deepEqual(e.test, ['npx tsc -p . --noEmit', 'npm test']);
  assert.deepEqual(e.versionFiles, ['package.json', 'package-lock.json', 'src/app.ts']);
  assert.equal(e.release, 'npm run release -- --publish');
  assert.equal(e.install, 'node src/cli.ts install');
  assert.equal(e.installed, '%USERPROFILE%\\.fake\\app');
  assert.deepEqual(got.missing, []);
  assert.match(got.notes[0], /offers Hire/);
});

test("one that doesn't announce itself is built and installed here, unless Manor lists it; internal staff always are", () => {
  const checkout = clone('quiet');
  const quiet = employeeFor(checkout, [], { origin, internal: none, staff: none });
  assert.ok(!('error' in quiet));
  assert.equal(quiet.employee.release, RELEASE_HERE);
  assert.equal(quiet.employee.install, '');
  assert.match(quiet.notes[0], /until it does/);
  const staff = employeeFor(checkout, [], { origin, internal: none, staff: new Set(['fake']) });
  assert.ok(!('error' in staff));
  assert.equal(staff.employee.release, 'npm run release -- --publish');
  const internal = employeeFor(clone('internal', { announce: true }), [], { origin, internal: new Set(['fake']), staff: new Set(['fake']) });
  assert.ok(!('error' in internal));
  assert.equal(internal.employee.release, RELEASE_HERE);
  assert.match(internal.notes[0], /internal staff/);
});

test('it reads the branch as origin has it, not the working tree, and an agent off the kit is listed but passed over', () => {
  const checkout = clone('offkit', { kit: null });
  writeFileSync(path.join(checkout, 'manor-agent.json'), ANNOUNCE);
  const got = employeeFor(checkout, [], { origin, internal: none, staff: none });
  assert.ok(!('error' in got));
  assert.equal(got.employee.release, RELEASE_HERE, "the uncommitted announcement isn't on main");
  assert.equal(got.employee.usesKit, false);
  assert.match(got.notes.at(-1)!, /no kit\.json/);
});

test('it refuses one it looks after already, a folder that is no clone, and a clone with nowhere to push', () => {
  const checkout = clone('twice', { announce: true });
  const refused = (employees = [] as ReturnType<typeof employee>[], o: Parameters<typeof employeeFor>[2] = { origin, internal: none, staff: none }, dir = checkout) => {
    const got = employeeFor(dir, employees, o);
    return 'error' in got ? got.error : '';
  };
  assert.match(refused([employee('C:\\elsewhere')]), /looks after Fake .* already/);
  assert.match(refused([employee('C:\\elsewhere', { id: 'other', repo: 'jcollier0120/fake' })]), /already/);
  assert.match(refused([employee(checkout, { id: 'other', repo: 'o/other' })]), /already/);
  assert.match(refused([], { origin: () => null, internal: none, staff: none }), /has no origin/);
  const bare = path.join(home, 'not-a-clone');
  mkdirSync(bare);
  assert.match(refused([], undefined, bare), /isn't a clone/);
  assert.match(refused([], { origin, internal: none, staff: none, branch: 'nope' }), /with a nope branch/);
});

test('addEmployee appends to settings.json and keeps everything else', () => {
  const file = path.join(home, 'settings.json');
  writeFileSync(file, JSON.stringify({ employees: [employee('C:\\Porter', { id: 'porter', name: 'Porter' })], team: ['someone'], byItself: true, somethingNew: 1 }));
  const got = employeeFor(clone('added', { announce: true }), [], { origin, internal: none, staff: none });
  assert.ok(!('error' in got));
  addEmployee(file, got.employee);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(raw.employees.map((e: { id: string }) => e.id), ['porter', 'fake']);
  assert.deepEqual([raw.team, raw.byItself, raw.somethingNew], [['someone'], true, 1]);
  const { settings, problems } = normalizeSettings(raw);
  assert.deepEqual(problems, []);
  assert.deepEqual(settings.employees[1], got.employee);
});
