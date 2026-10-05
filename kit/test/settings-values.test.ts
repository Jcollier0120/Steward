import assert from 'node:assert/strict';
import { test } from 'node:test';

// The React Settings form's value rules (react/settings-values.ts), which are web/settings-panel.js's, and the
// onboarding contract (node/onboarding.ts).
const { blank, canon, same, shownNow, tidy, words } = await import('../react/settings-values.ts');
const { onboardingProblems, ONBOARDING_MAX_SETTINGS } = await import('./fixture/src/kit/onboarding.ts');
type F = import('../react/settings-values.ts').SettingsField;

const text = { key: 't', kind: 'text', label: 'T', nullable: 'Automatic' } as F;
const whole = { key: 'n', kind: 'whole', label: 'N', min: 1, max: 60, unit: 'minutes' } as F;
const list = { key: 'l', kind: 'list', label: 'L', item: { label: 'Folder' } } as F;
const map = { key: 'm', kind: 'map', label: 'M', keyLabel: 'Name', valueLabel: 'Value' } as F;
const records = { key: 'r', kind: 'records', label: 'R', title: 'name', fields: [{ key: 'name', kind: 'text', label: 'Name' }, { key: 'on', kind: 'switch', label: 'On' }, { key: 'note', kind: 'text', label: 'Note', optional: true }] } as F;
const group = { key: 'g', kind: 'group', label: 'G', fields: [whole, { key: 'c', kind: 'choice', label: 'C', options: [{ value: 'a', label: 'Ay' }, { value: 'b', label: 'Bee' }] }] } as F;

test('canon: what the server would keep, so a change is only a change', () => {
  assert.equal(canon(text, '  x  '), 'x');
  assert.equal(canon(text, '   '), null, 'empty, and nullable: null');
  assert.equal(canon(whole, 5), 5);
  assert.deepEqual(canon(list, [' a ', '', 'b']), ['a', 'b']);
  assert.deepEqual(canon(map, { ' k ': ' v ', ' ': 'x' }), { k: 'v' });
  assert.deepEqual(canon(records, [{ name: ' x ', on: 1, note: '' }]), [{ name: 'x', on: false }], 'an empty optional field is left out');
  assert.ok(same(list, ['a'], [' a ', '']));
  assert.ok(!same(whole, 5, 6));
});

test('words: a default as the form says it', () => {
  assert.equal(words(whole, 1), '1 minute');
  assert.equal(words(whole, 5), '5 minutes');
  assert.equal(words(text, null), 'empty', "a text's null is empty, as settings-panel.js says it");
  assert.equal(words({ ...list, nullable: 'Automatic' } as F, null), 'Automatic');
  assert.equal(words(list, ['a', 'b', 'c', 'd', 'e']), 'a, b, c and 2 more');
  assert.equal(words(records, [{ name: 'Porter' }]), 'Porter');
  assert.equal(words(map, { a: '1', b: '2' }), '2 entries');
  assert.equal(words(group.kind === 'group' ? group.fields[1] : group, 'b'), 'Bee');
});

test("blank and tidy: a new record's start, and what goes before saving", () => {
  assert.deepEqual(blank(group), { n: '', c: 'a' });
  assert.equal(blank(text), null);
  assert.deepEqual(tidy(list, ['a', ' ', 'b']), ['a', 'b']);
  assert.deepEqual(tidy(map, { a: '1', '': '' }), { a: '1' });
  assert.deepEqual(tidy(records, [{ name: 'x', on: true }, { name: '', on: true }]), [{ name: 'x', on: true }], 'a record with nothing but a switch set goes');
});

test('shownWhen: a field shows while its key holds one of the values, as text', () => {
  const stocks = { key: 'stocks', kind: 'list', label: 'Stocks', item: { label: 'Ticker' }, shownWhen: { key: 'variant', is: ['general', 'financial'] } } as F;
  assert.ok(shownNow(stocks, { variant: 'financial' }));
  assert.ok(!shownNow(stocks, { variant: 'gamer' }));
  assert.ok(shownNow({ ...stocks, shownWhen: { key: 'on', is: ['true'] } } as F, { on: true }), 'a switch is "true" or "false"');
  assert.ok(shownNow(whole, {}), 'without shownWhen, always');
});

test('onboarding: at most three settings, each in the schema and none advanced; every tour step named and saying something', () => {
  const schema = [{ key: 'a', kind: 'switch', label: 'A' }, { key: 'b', kind: 'switch', label: 'B', advanced: true }, { key: 'c', kind: 'switch', label: 'C' }, { key: 'd', kind: 'switch', label: 'D' }, { key: 'e', kind: 'switch', label: 'E' }] as never;
  const ok = { intro: { title: 'Hi', text: 'What it does.' }, settings: ['a'], tour: [{ tour: 'status', text: 'Its status.' }] };
  assert.equal(ONBOARDING_MAX_SETTINGS, 3);
  assert.deepEqual(onboardingProblems(ok, schema), []);
  assert.deepEqual(onboardingProblems({ ...ok, settings: [] }, schema), [], 'none is fine: the defaults just work');
  const bad = onboardingProblems({ intro: { title: '', text: '' }, settings: ['a', 'c', 'd', 'e', 'zz', 'b'], tour: [{ tour: 'Bad Name', text: '' }] }, schema);
  assert.equal(bad.length, 6, bad.join('\n'));
  assert.match(bad.join('\n'), /intro needs/);
  assert.match(bad.join('\n'), /asks for 6 settings; at most 3/);
  assert.match(bad.join('\n'), /"zz" isn't a setting/);
  assert.match(bad.join('\n'), /"b" is advanced/);
  assert.match(bad.join('\n'), /data-tour name/);
  assert.match(bad.join('\n'), /says nothing/);
});
