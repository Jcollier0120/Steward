import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The settings the staff share, set on Manor's Settings (shared-settings.ts, settings-kit.ts' FormPlace, kit 2.140.0):
// the manor-wide ones read from Manor's settings.json first, and each form as it's asked for, on the agent's own page
// (Manor's left out, and said in a line) or on Manor's Settings (?manor=1: only those).
const id: string = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8')).name;
const home = mkdtempSync(path.join(os.tmpdir(), `${id}-in-manor-test-`));
after(() => rmSync(home, { recursive: true, force: true }));
process.env[`${id.toUpperCase().replace(/-/g, '_')}_HOME`] = home;
process.env.MANOR_HOME = path.join(home, 'no-manor');

const ss = await import('./fixture/src/kit/shared-settings.ts');
const { manorLink, manorShared, sharedSettingsManor } = await import('./fixture/src/kit/manor.ts');
const { saveSettingsReply, settingsReply } = await import('./fixture/src/kit/settings-kit.ts');
type Field = import('./fixture/src/kit/settings-kit.ts').Field;
type SettingsSpec = import('./fixture/src/kit/settings-kit.ts').SettingsSpec;

/** A Manor's folder: its settings.json, and the app beside it that says it's installed. */
function manorAt(name: string, settings: unknown): string {
  const dir = path.join(home, name);
  mkdirSync(path.join(dir, 'app'), { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return dir;
}

test("the shared fields say where they're set: the agent's own rounds and calls, the manor's switches and quality", () => {
  assert.equal(ss.roundEveryField({ min: 5, max: 60, default: 15 }).inManor, 'own');
  assert.equal(ss.modelCallsField({ max: 10, default: 6 }).inManor, 'own');
  for (const f of [ss.plainNotesField(), ss.semanticRerankField(), ss.videoQualityField(), ss.keepVideoTagsField()]) assert.equal(f.inManor, 'shared', f.key);
  const q = ss.videoQualityField({ developerHelp: 'CRF 30 / 27 / 23.' });
  assert.equal(q.key, 'preset');
  assert.deepEqual((q as any).options.map((o: any) => o.value), [...ss.VIDEO_QUALITIES]);
  assert.equal(q.help, 'CRF 30 / 27 / 23.', "a developer's words");
  assert.match(q.plain?.help ?? '', /^Smaller files/, 'and the plain ones for everyone else');
  assert.equal(ss.semanticRerankField().advanced, true);
  assert.equal(ss.keepVideoTagsField().advanced, true);
  assert.equal(ss.videoQualityField().advanced, undefined, 'on the page');
});

test("the manor-wide ones: Manor's value when it says; the agent's own while it doesn't, or says something it can't use", () => {
  const manor = manorAt('manor-says', { name: 'Oakfield', shared: { plainNotes: false, semanticRerank: false, preset: 'better', keepVideoTags: true } });
  const own = { plainNotes: true, semanticRerank: true, preset: 'smaller', keepVideoTags: false };
  assert.equal(ss.readPlainNotes(own, true, { home: manor }), false);
  assert.equal(ss.readSemanticRerank(own, true, { home: manor }), false);
  assert.equal(ss.readVideoQuality(own, 'balanced', { home: manor }), 'better');
  assert.equal(ss.readKeepVideoTags(own, false, { home: manor }), true);

  const odd = manorAt('manor-odd', { shared: { plainNotes: 'no', preset: 'huge' } });
  assert.equal(ss.readPlainNotes(own, true, { home: odd }), true, 'not a switch: the agent’s own');
  assert.equal(ss.readVideoQuality(own, 'balanced', { home: odd }), 'smaller', 'not a quality: the agent’s own');
  assert.equal(ss.readSemanticRerank({}, true, { home: odd }), true, 'unsaid, and none of its own: the default');
  assert.equal(ss.readVideoQuality({ preset: 'huge' }, 'balanced', { home: odd }), 'balanced');

  const older = manorAt('manor-older', { name: 'Oakfield' });
  assert.equal(manorShared('keepVideoTags', older), undefined, 'an older Manor says nothing');
  assert.equal(ss.readKeepVideoTags({ keepVideoTags: true }, false, { home: older }), true);
  assert.equal(manorShared('plainNotes', path.join(home, 'nowhere')), undefined, 'no Manor at all');
  assert.equal(manorShared('plainNotes'), undefined, 'and under node --test, none unless a test says where');
  assert.equal(sharedSettingsManor(), null);
});

const file = path.join(home, 'settings.json');
const read = () => JSON.parse(readFileSync(file, 'utf8'));
const schema: Field[] = [
  { key: 'folders', kind: 'list', label: 'Folders', item: { label: 'Folder' } },
  ss.plainNotesField(),
  ss.roundEveryField({ min: 5, max: 60, default: 15 }, { label: 'Look every' }),
  ss.modelCallsField({ max: 10, default: 6 }),
];
const defaults = { folders: [], plainNotes: true, roundEvery: 15, modelCallsPerRound: 6 };
const spec: SettingsSpec = {
  schema,
  defaults,
  file: () => file,
  normalize: (raw: any) => ({ settings: { ...structuredClone(defaults), ...raw }, problems: [] }),
};
const keys = (r: any) => r.schema.map((f: Field) => f.key);

test("the agent's own page: without Manor every field; with Manor, the ones set there left out and said in a line", async () => {
  writeFileSync(file, JSON.stringify({ folders: ['D:\\Clips'], roundEvery: 30 }));
  const alone = await settingsReply(spec, false, { manor: null, asked: false });
  assert.deepEqual(keys(alone), ['folders', 'plainNotes', 'roundEvery', 'modelCallsPerRound']);
  assert.equal(alone.inManor, undefined);

  const manor = manorLink(manorAt('manor-page', { name: 'Oakfield Manor', port: 18585 }))!;
  const page = await settingsReply(spec, false, { manor, asked: false });
  assert.deepEqual(keys(page), ['folders']);
  assert.deepEqual(page.inManor, { manor: 'Oakfield Manor', url: 'http://castellan.localhost:18585/#/settings/staff', labels: ['Plain-words notes', 'Look every', 'Model calls per round'] });

  const refused: any = await saveSettingsReply(spec, { values: { roundEvery: 45, plainNotes: false } }, false, { manor, asked: false });
  assert.equal(refused.status, 400);
  assert.match(refused.json.errors.roundEvery, /Oakfield Manor's Settings, Staff settings/);
  assert.match(refused.json.errors.plainNotes, /whole staff/);
  assert.equal(read().roundEvery, 30, 'nothing written');

  const ok: any = await saveSettingsReply(spec, { values: { folders: ['D:\\Clips', 'E:\\Video'] } }, false, { manor, asked: false });
  assert.equal(ok.status, undefined, JSON.stringify(ok.json));
  assert.deepEqual(read(), { folders: ['D:\\Clips', 'E:\\Video'], roundEvery: 30 }, "the rest of the file as it was");
});

test("Manor's Settings (?manor=1): the shared fields to read, the agent's own ones to save, never a manor-wide one", async () => {
  writeFileSync(file, JSON.stringify({ folders: ['D:\\Clips'], roundEvery: 30 }));
  const manor = manorLink(manorAt('manor-asks', { name: 'Oakfield Manor' }))!;
  const asked = await settingsReply(spec, false, { manor, asked: true });
  assert.deepEqual(keys(asked), ['plainNotes', 'roundEvery', 'modelCallsPerRound']);
  assert.equal(asked.values.roundEvery, 30);
  assert.equal(asked.inManor, undefined, 'Manor knows where they are');

  const saved: any = await saveSettingsReply(spec, { values: { roundEvery: 45, modelCallsPerRound: 0 } }, false, { manor, asked: true });
  assert.equal(saved.status, undefined, JSON.stringify(saved.json));
  assert.deepEqual(read(), { folders: ['D:\\Clips'], roundEvery: 45, modelCallsPerRound: 0 });

  const wide: any = await saveSettingsReply(spec, { values: { plainNotes: false } }, false, { manor, asked: true });
  assert.equal(wide.status, 400);
  assert.match(wide.json.errors.plainNotes, /whole staff/, "Manor's own to keep, in its settings.json");
  const other: any = await saveSettingsReply(spec, { values: { folders: [] } }, false, { manor, asked: true });
  assert.equal(other.status, 400, "the agent's other settings aren't Manor's to change");
  assert.equal(read().plainNotes, undefined);
});
