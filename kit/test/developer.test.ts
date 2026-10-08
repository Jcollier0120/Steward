import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The manor's Developer options, as every agent obeys them (node/developer.ts, spec/DEVELOPER-OPTIONS.md). Nothing
// here reads the real Manor's settings, or the agent's.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'kit-developer-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
const agentHome = path.join(tmp, 'agent');
mkdirSync(agentHome, { recursive: true });
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = agentHome;
process.env.REEVE_HOME = path.join(tmp, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(tmp, 'locks', 'npu');
process.env.MANOR_HOME = path.join(tmp, 'no-manor');

const { developer, developerOnly, failureFor, isDeveloper, ownDeveloperOptions, withoutDeveloper } = await import('./fixture/src/kit/developer.ts');
const { PLAIN_PROBLEM, PLAIN_REFUSAL, saveSettingsReply, settingsReply } = await import('./fixture/src/kit/settings-kit.ts');
const { SETTINGS_SPEC } = await import('./fixture/src/settings.ts');

const ownFile = path.join(agentHome, 'settings.json');
/** The agent's own settings.json, or none. */
const own = (v: unknown) => (v === undefined ? rmSync(ownFile, { force: true }) : writeFileSync(ownFile, JSON.stringify(v)));
/** A Manor folder: settings.json and, when installed, its app folder. */
function manorAt(name: string, settings: unknown, installed = true): string {
  const home = path.join(tmp, name);
  mkdirSync(installed ? path.join(home, 'app') : home, { recursive: true });
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  return home;
}

test("standalone (no Manor): the agent's own switch, off unless its settings.json says true", () => {
  own(undefined);
  assert.deepEqual(developer(), { on: false, setBy: null }, 'nothing said: off');
  assert.equal(isDeveloper(), false);
  for (const v of [{}, { developerOptions: false }, { developerOptions: 'true' }, { developerOptions: 1 }, [true], null]) {
    own(v);
    assert.equal(ownDeveloperOptions(), false, JSON.stringify(v));
  }
  writeFileSync(ownFile, '{ "developerOptions": true');
  assert.equal(ownDeveloperOptions(), false, 'unreadable: off');
  own({ developerOptions: true, folders: [] });
  assert.equal(ownDeveloperOptions(), true);
  assert.deepEqual(developer(), { on: true, setBy: null });
  assert.equal(developer({ own: false }).on, false, 'a caller may pass its own');
  own(undefined);
});

test("under Manor, Manor's value wins over the agent's own, both ways; a Manor that hasn't said leaves the agent's", () => {
  const on = manorAt('manor-on', { name: 'Weasel Manor', developerOptions: true });
  const off = manorAt('manor-off', { developerOptions: false });
  const silent = manorAt('manor-silent', { name: 'Quiet Manor' });
  const notInstalled = manorAt('manor-gone', { developerOptions: true }, false);
  own({ developerOptions: false });
  const d = developer({ home: on });
  assert.equal(d.on, true);
  assert.equal(d.setBy?.name, 'Weasel Manor', "Manor's: the agent shows developerOptionsNote() in place of its own switch");
  own({ developerOptions: true });
  assert.deepEqual(developer({ home: off }).on, false, "the agent's own on, Manor's off: off");
  assert.deepEqual(developer({ home: silent }), { on: true, setBy: null }, "Manor hasn't said: the agent's own");
  assert.deepEqual(developer({ home: notInstalled }), { on: true, setBy: null }, 'no Manor installed: the agent\'s own');
  own(undefined);
  assert.equal(developer({ home: silent }).on, false);
});

test('a live flip: changed in Manor, the next call has it, with nothing restarted', () => {
  const home = manorAt('manor-flip', { developerOptions: false });
  const was = process.env.MANOR_HOME;
  process.env.MANOR_HOME = home;
  try {
    assert.equal(isDeveloper(), false);
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ developerOptions: true }));
    assert.equal(isDeveloper(), true);
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ developerOptions: false, theme: 'onyx' }));
    assert.equal(isDeveloper(), false);
  } finally {
    process.env.MANOR_HOME = was;
  }
});

test("payload gating: developer-only data is never sent, or even worked out, while the switch is off", () => {
  let worked = 0;
  const tail = () => (worked++, 'C:\\agent\\log.txt: exit code 1');
  assert.equal(developerOnly(tail, undefined, false), undefined);
  assert.equal(worked, 0, 'a function is not called when off');
  assert.equal(developerOnly(tail, null, false), null, 'the fallback, when given');
  assert.equal(developerOnly(tail, undefined, true), 'C:\\agent\\log.txt: exit code 1');
  assert.equal(developerOnly('a value', 'plain', true), 'a value');
  assert.equal(developerOnly('a value', 'plain'), 'plain', 'read now: no Manor, no switch of its own, so off');

  const payload = { rounds: 3, pid: 4120, port: 18585, items: [{ name: 'a', pid: 1, path: 'C:\\a' }, { name: 'b' }], nested: { pid: 2, ok: true } };
  const plain = withoutDeveloper(payload, ['pid', 'port', 'path'], false);
  assert.deepEqual(plain, { rounds: 3, items: [{ name: 'a' }, { name: 'b' }], nested: { ok: true } });
  assert.doesNotMatch(JSON.stringify(plain), /pid|port|path|4120|C:/, 'gone from the JSON, not blanked');
  assert.equal(payload.pid, 4120, 'the payload itself is left as it was');
  assert.equal(withoutDeveloper(payload, ['pid'], true), payload, 'on: as it is');
  assert.deepEqual(withoutDeveloper([{ pid: 1, a: 1 }], ['pid'], false), [{ a: 1 }]);
  assert.equal(withoutDeveloper(null, ['pid'], false), null);

  const e = new Error('spawn C:\\tools\\llama-server.exe ENOENT');
  assert.equal(failureFor(e, "The local AI couldn't start. It tries again in a minute.", false), "The local AI couldn't start. It tries again in a minute.");
  assert.equal(failureFor(e, 'plain', true), 'spawn C:\\tools\\llama-server.exe ENOENT');
  assert.equal(failureFor('exit 3', 'plain', true), 'exit 3');
});

test("/api/settings, both ways: the file's path and settings.json's own words only for a developer", async () => {
  const file = SETTINGS_SPEC.file();
  writeFileSync(file, '{ not json');
  try {
    const off = (await settingsReply(SETTINGS_SPEC, false)) as { file: string; problems: string[] };
    assert.equal(off.file, '');
    assert.deepEqual(off.problems, [PLAIN_PROBLEM]);
    assert.doesNotMatch(JSON.stringify(off.problems), /json|settings\.|[A-Z]:\\/i, 'no file, no JSON');
    const on = (await settingsReply(SETTINGS_SPEC, true)) as { file: string; problems: string[] };
    assert.equal(on.file, file);
    assert.match(on.problems.join(' '), /isn't a JSON object/);
    rmSync(file, { force: true });
    assert.deepEqual(((await settingsReply(SETTINGS_SPEC, false)) as { problems: string[] }).problems, [], 'nothing wrong: nothing said');
  } finally {
    rmSync(file, { force: true });
    rmSync(`${file}.broken`, { force: true });
  }
});

test("a save refused by the agent's own rules: its words for a developer, plain words for everyone else", async () => {
  const strict = { ...SETTINGS_SPEC, normalize: (raw: unknown) => ({ settings: SETTINGS_SPEC.normalize(raw).settings, problems: (raw as { folders?: unknown[] })?.folders?.includes(tmp) ? ['settings.json: "folders" may not name this test\'s folder.'] : [] }) };
  const folders = SETTINGS_SPEC.schema.find((f: { key: string }) => f.key === 'folders');
  assert.ok(folders, "the fixture's folders setting");
  try {
    const off = await saveSettingsReply(strict, { values: { folders: [tmp] } }, false);
    assert.equal(off.status, 400);
    assert.equal((off.json as { errors: Record<string, string> }).errors[''], PLAIN_REFUSAL);
    const on = await saveSettingsReply(strict, { values: { folders: [tmp] } }, true);
    assert.match((on.json as { errors: Record<string, string> }).errors[''], /settings\.json: "folders"/);
  } finally {
    rmSync(SETTINGS_SPEC.file(), { force: true });
  }
});
