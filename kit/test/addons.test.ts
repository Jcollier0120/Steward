import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The model's add-ons (addons.ts, kit 2.152.2): a job mapped to its pinned add-on, applied per request on a server that
// loaded it, every other add-on it carries held at 0; the owner's rule that on a PC with an NPU only the NPU applies one;
// the add-ons wanted on a PC; and their pinned file checked by its SHA-256. Everything in a scratch folder.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-addons-'));
after(() => rmSync(home, { recursive: true, force: true }));

const A = await import('./fixture/src/kit/addons.ts');
const { chatBody, visionBody } = await import('./fixture/src/kit/accelerators.ts');

const pin = A.ADDONS.addons[0];
const other = { ...pin, id: 'reeve-r1-qv', staff: 'reeve', jobs: ['reeve.summary'], file: 'reeve-r1-qv-f16.gguf' };
const catalog = { version: 1, addons: [pin, other] };
const server = ['C:\\tools\\llama-server.exe', '--port', '18181', '-m', 'C:\\m.gguf', ...A.addonArgs([`C:\\tools\\models\\addons\\${other.file}`, `C:\\tools\\models\\addons\\${pin.file}`])];

test("the Warrener's pin: F16 (a Q8_0 add-on gives NaN on the Hexagon), its job, size and SHA-256; unpublished until the owner says", () => {
  assert.equal(pin.id, 'warrener-r1-qv');
  assert.equal(pin.type, 'f16');
  assert.deepEqual(pin.jobs, ['warrener.name']);
  assert.equal(pin.size, 12_853_088);
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.match(pin.url, /^https:\/\/github\.com\/[^/]+\/Manor-releases\/releases\/download\//);
  assert.equal(pin.published, false);
  assert.equal(A.addonForJob('warrener.name')?.id, pin.id);
  assert.equal(A.addonForJob('warrener.folder'), null);
  assert.equal(A.addonForJob(undefined), null);
});

test("a server's add-ons by llama-server's ids (their --lora order), loaded off; a request that applies none holds each at 0", () => {
  assert.deepEqual(A.addonArgs([]), []);
  assert.deepEqual(A.addonArgs(['a.gguf']), ['--lora', 'a.gguf', '--lora-init-without-apply']);
  assert.deepEqual(A.loadedAddons(server, catalog).map((l) => [l.id, l.pin?.id]), [[0, other.id], [1, pin.id]]);
  assert.deepEqual(A.loadedAddons(['x.exe', '--lora', 'C:\\mine.gguf'], catalog).map((l) => l.pin), [null], "someone's own: no pin");
  // b11645 runs a request that names none at each add-on's load scale, 1, whatever --lora-init-without-apply says.
  assert.deepEqual(A.addonsOff(server), { lora: [{ id: 0, scale: 0 }, { id: 1, scale: 0 }] });
  assert.deepEqual(A.addonsOff(['x.exe', '--port', '1']), {});
  assert.deepEqual(A.addonsOff(undefined), {});
  // The kit's requests to such a server carry it; to any other, nothing new.
  const acc = { id: 'npu', kind: 'npu', quirks: [] } as any;
  const ep = { baseUrl: 'http://127.0.0.1:18181', model: 'm', startCommand: server } as any;
  assert.deepEqual((chatBody(acc, ep, [{ role: 'user', content: 'hi' }], 8) as any).lora, [{ id: 0, scale: 0 }, { id: 1, scale: 0 }]);
  assert.deepEqual((visionBody(acc, ep, 'data:image/png;base64,AA', 'what?', 8) as any).lora, [{ id: 0, scale: 0 }, { id: 1, scale: 0 }]);
  assert.equal('lora' in chatBody(acc, { ...ep, startCommand: ['geniex.exe', 'serve'] }, [{ role: 'user', content: 'hi' }], 8), false);
});

test("a job's add-on: applied on the NPU that carries it, the others at 0; never on a graphics card or the processor of a PC with an NPU; on one with none, wherever it's loaded; why not, when it isn't", () => {
  const job = 'warrener.name';
  assert.equal(A.addonFor(undefined, { startCommand: server, onNpu: true, pcHasNpu: true, catalog }), null, 'no job: as before');
  assert.deepEqual(A.addonFor(job, { startCommand: server, onNpu: true, pcHasNpu: true, catalog }), { use: { job, id: pin.id, applied: true }, lora: [{ id: 0, scale: 0 }, { id: 1, scale: 1 }] });
  assert.deepEqual(A.addonFor(job, { startCommand: server, onNpu: false, pcHasNpu: true, catalog }), { use: { job, id: pin.id, applied: false, why: 'on a PC with an NPU, add-ons run only on the NPU' } });
  assert.deepEqual(A.addonFor(job, { startCommand: server, onNpu: false, pcHasNpu: false, catalog })?.use, { job, id: pin.id, applied: true });
  assert.deepEqual(A.addonFor(job, { startCommand: ['geniex.exe', 'serve'], onNpu: true, pcHasNpu: true, catalog }), { use: { job, id: pin.id, applied: false, why: "the NPU's server doesn't carry it" } });
  assert.deepEqual(A.addonFor(job, { startCommand: ['llama-server.exe'], onNpu: false, pcHasNpu: false, catalog })?.use.why, "this server doesn't carry it");
  assert.deepEqual(A.addonFor('warrener.folder', { startCommand: server, onNpu: true, pcHasNpu: true, catalog }), { use: { job: 'warrener.folder', id: null, applied: false, why: 'no add-on is pinned for this job' } });
});

test('the add-ons wanted on a PC: F16 ones whose staff member is hired, published or put in place at their size; and a file checked by its SHA-256', async () => {
  const tools = path.join(home, 'tools');
  const file = A.addonFile(pin, tools);
  assert.equal(file, path.join(tools, 'models', 'addons', pin.file));
  const env = { WARRENER_HOME: path.join(home, 'warrener') };
  const hiredApp = path.join(env.WARRENER_HOME, 'app');
  const on = (o: { hired?: boolean; have?: boolean; size?: number; published?: boolean; type?: string }) =>
    A.wantedAddons({ tools, env, exists: (p) => (p === hiredApp ? o.hired !== false : p === file ? o.have === true : false), size: () => o.size ?? pin.size, catalog: { version: 1, addons: [{ ...pin, published: o.published ?? false, type: o.type ?? 'f16' }] } });
  assert.deepEqual(on({ have: true }), [{ pin, file, have: true }], 'put in place by hand');
  assert.deepEqual(on({}), [], 'unpublished and not here: nothing to download');
  assert.deepEqual(on({ published: true }).map((w) => w.have), [false], 'published: setup downloads it');
  assert.deepEqual(on({ have: true, size: 5 }), [], 'not its size: not in place');
  assert.deepEqual(on({ have: true, hired: false }), [], 'its staff member not hired here');
  assert.deepEqual(on({ have: true, type: 'q8_0' }), [], 'only F16');
  assert.equal(A.hired('warrener', { env, exists: (p) => p === hiredApp }), true);

  assert.match((await A.checkAddon({ pin, file }))!, /isn't there/);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'short');
  assert.match((await A.checkAddon({ pin, file }))!, /is 5 bytes, not 12853088/);
  writeFileSync(file, Buffer.alloc(pin.size));
  assert.equal(await A.checkAddon({ pin, file }, async () => pin.sha256), null);
  assert.match((await A.checkAddon({ pin, file }, async () => 'f'.repeat(64)))!, /isn't the pinned/);
  assert.match((await A.checkAddon({ pin, file }))!, /isn't the pinned/, 'the real hash of zeros');
});
