import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Required settings (node/onboarding.ts's `required`, node/required.ts): what an agent can't work without. Until they're
// filled in, its rounds wait, /api/ping and the page say so, and the tour's settings step holds.
const home = mkdtempSync(path.join(os.tmpdir(), 'fixture-required-'));
process.env.FIXTURE_HOME = path.join(home, 'data');
after(() => rmSync(home, { recursive: true, force: true }));

const { filled, onboardingProblems, requiredText, unmetRequired } = await import('./fixture/src/kit/onboarding.ts');
const { needsSettings, watchRequired } = await import('./fixture/src/kit/required.ts');
const { every } = await import('./fixture/src/kit/schedule.ts');
const { pillOf } = await import('./fixture/src/kit/page.ts');
type Onboarding = import('./fixture/src/kit/onboarding.ts').Onboarding;
type Field = import('./fixture/src/kit/settings-kit.ts').Field;
type SettingsSpec = import('./fixture/src/kit/settings-kit.ts').SettingsSpec;

const schema = [
  { key: 'thunderbird', kind: 'switch', label: 'Thunderbird' },
  { key: 'imapAccounts', kind: 'list', label: 'Mail accounts', item: { label: 'Account' } },
  { key: 'documentFolders', kind: 'list', label: 'Document folders', item: { label: 'Folder' } },
] as Field[];

const mail: Onboarding = {
  intro: { title: 'The Chamberlain', text: 'Keeps your papers.' },
  settings: ['thunderbird', 'imapAccounts', 'documentFolders'],
  tour: [],
  required: [['thunderbird', 'imapAccounts']],
};

/** A settings spec on a file in the scratch folder: the defaults, with whatever the file says over them. */
function specOn(values: Record<string, unknown> | null): SettingsSpec {
  const file = path.join(home, `settings-${Math.random().toString(36).slice(2)}.json`);
  if (values) writeFileSync(file, JSON.stringify(values));
  const defaults = { thunderbird: false, imapAccounts: [], documentFolders: [] };
  return { schema, defaults, file: () => file, normalize: (raw) => ({ settings: { ...defaults, ...(raw as object) }, problems: [] }) };
}

test('filled: a switch on, a number but 0, text not blank, a list with something in it, a group by its on switch', () => {
  for (const v of [true, 3, 'x', ['a'], { on: true }, { host: 'imap.example' }]) assert.equal(filled(v), true, JSON.stringify(v));
  for (const v of [false, 0, '', '  ', [], [''], null, undefined, { on: false, host: 'imap.example' }, {}]) assert.equal(filled(v), false, JSON.stringify(v));
});

test('an entry of several keys is met by any one of them; each unmet entry is said by its labels', () => {
  const o = { required: [['thunderbird', 'imapAccounts'], 'documentFolders'] };
  assert.deepEqual(unmetRequired(o, { thunderbird: false, imapAccounts: [], documentFolders: [] }), [['thunderbird', 'imapAccounts'], ['documentFolders']]);
  assert.deepEqual(unmetRequired(o, { thunderbird: false, imapAccounts: ['me@example'], documentFolders: ['C:\\Docs'] }), []);
  assert.equal(requiredText(['thunderbird', 'imapAccounts'], schema), 'Thunderbird or Mail accounts');
  assert.equal(requiredText(['thunderbird', 'imapAccounts', 'documentFolders'], schema), 'Thunderbird, Mail accounts or Document folders');
  assert.equal(requiredText(['documentFolders'], schema), 'Document folders');
});

test("onboarding's checks: a required setting must be one the tour asks for, and required once", () => {
  assert.deepEqual(onboardingProblems(mail, schema), []);
  assert.match(onboardingProblems({ ...mail, settings: ['thunderbird'] }, schema).join('\n'), /"imapAccounts" is required but not among its onboarding's settings/);
  assert.match(onboardingProblems({ ...mail, required: ['thunderbird', ['thunderbird', 'imapAccounts']] }, schema).join('\n'), /required twice/);
  assert.match(onboardingProblems({ ...mail, required: [[]] }, schema).join('\n'), /names no setting/);
});

test('needsSettings: null without required settings or a settings spec; else what is missing, from the file as it is now', () => {
  assert.equal(needsSettings({ ...mail, required: [] }, specOn(null)), null);
  assert.equal(needsSettings(mail, null), null);
  assert.deepEqual(needsSettings(mail, specOn(null)), { keys: [['thunderbird', 'imapAccounts']], text: 'Thunderbird or Mail accounts' });
  assert.equal(needsSettings(mail, specOn({ thunderbird: true })), null);
});

test('the pill says it needs settings, before it says off duty', () => {
  const look = { busy: 'Working' } as Parameters<typeof pillOf>[0]['look'];
  const pill = pillOf({ look, duty: { onDuty: false, since: new Date().toISOString() }, needs: 'Thunderbird or Mail accounts' });
  assert.equal(pill.text, 'Needs settings');
  assert.match(pill.title, /Thunderbird or Mail accounts/);
});

test('its rounds wait for its required settings: Run now too, and no next round is due; a save lets them go', async () => {
  const spec = specOn(null);
  watchRequired(spec, mail);
  let ran = 0;
  const job = every(60_000, async () => void ran++, { firstDelayMs: 60_000, name: 'required' });
  try {
    assert.equal(job.runNow(), false, 'nothing to work with yet');
    assert.equal(job.state.nextRunAt, null);
    writeFileSync(spec.file(), JSON.stringify({ imapAccounts: ['me@example'] }));
    assert.equal(job.runNow(), true);
    while (job.running) await new Promise((r) => setTimeout(r, 5));
    assert.equal(ran, 1);
  } finally {
    job.stop();
    watchRequired(null);
  }
});
