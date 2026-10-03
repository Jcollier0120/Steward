import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The manor's themes (web/themes.json and web/themes.css): one list, every theme's colours, every pair readable.
const list = JSON.parse(readFileSync(new URL('../web/themes.json', import.meta.url), 'utf8'));
const css = readFileSync(new URL('../web/themes.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const { groupLabel, themeNamed, themes, themesCss } = await import('./fixture/src/kit/themes.ts');

const HEX = /^#[0-9a-f]{6}$/;
const NAMES = ['system', 'light', 'dark', 'arcade', 'onyx', 'carbon', 'tinsel', 'rosegold', 'quest'];

/** A block's declarations, by the selector that opens it. */
function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `themes.css has ${selector}`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+|color-scheme):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const blockOf = (name: string) => (name === 'light' ? block(':root') : block(`:root[data-theme="${name}"]`));

const lum = (h: string) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test('the nine themes, in the menu order, each with its words, swatch, group and scheme', () => {
  assert.deepEqual(list.themes.map((t: { name: string }) => t.name), NAMES);
  assert.deepEqual(themes().map((t) => t.name), NAMES, 'themes.ts reads the same list');
  for (const t of list.themes) {
    assert.ok(t.label && t.description, t.name);
    assert.equal(t.swatch.length, 3, t.name);
    for (const c of t.swatch) assert.match(c, HEX, t.name);
    assert.ok(['windows', 'colour'].includes(t.group), t.name);
    assert.equal(t.scheme, t.name === 'system' ? null : blockOf(t.name)['color-scheme'], `${t.name}: its scheme is its colours'`);
  }
  assert.equal(groupLabel('windows'), 'Windows');
  assert.equal(groupLabel('colour'), 'Colour themes');
  assert.equal(themeNamed('quest')?.label, 'Quest');
  assert.equal(themeNamed('nope'), null);
  assert.equal(themeNamed(undefined), null);
  assert.equal(themesCss(), readFileSync(new URL('./fixture/src/kit/web/themes.css', import.meta.url), 'utf8'));
});

test('every theme sets every token, and the dark one is the same whether Windows or the menu chooses it', () => {
  const tokens = Object.keys(block(':root')).sort();
  assert.ok(tokens.length > 25);
  for (const name of NAMES.slice(1)) assert.deepEqual(Object.keys(blockOf(name)).sort(), tokens, name);
  const night = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  assert.match(night, /^@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-theme\]\) \{/);
  assert.deepEqual(block(':root:not([data-theme])'), blockOf('dark'));
});

test('a swatch is its theme: the page, the accent, the text', () => {
  for (const t of list.themes.slice(1)) {
    const b = blockOf(t.name);
    assert.ok([b['--bg'], b['--surface']].includes(t.swatch[0]), `${t.name}: its page`);
    assert.equal(t.swatch[1], b['--accent'], `${t.name}: its accent`);
    assert.ok([b['--fg'], b['--accent-text']].includes(t.swatch[2]), `${t.name}: its text`);
  }
});

test('every text pair reads, 4.5:1 or more, in every theme', () => {
  const pairs: [string, string][] = [
    ['--fg', '--bg'], ['--fg', '--surface'], ['--fg', '--surface-2'], ['--fg', '--quiet-bg'],
    ['--muted', '--surface'], ['--muted', '--surface-2'], ['--muted', '--quiet-bg'],
    ['--accent-text', '--surface'], ['--accent-fg', '--accent'],
    ['--ok', '--ok-bg'], ['--warn', '--warn-bg'], ['--alert', '--alert-bg'], ['--npu', '--npu-bg'],
  ];
  for (const name of NAMES.slice(1)) {
    const b = blockOf(name);
    for (const [fg, bg] of pairs) {
      assert.match(b[fg], HEX, `${name} ${fg}`);
      const c = contrast(b[fg], b[bg]);
      assert.ok(c >= 4.5, `${name}: ${fg} on ${bg} is ${c.toFixed(2)}:1`);
    }
  }
});

test("every colour the kit's page and Settings panel use is a theme's token, or the kit's own", () => {
  const page = readFileSync(new URL('../node/page.ts', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../web/settings-panel.css', import.meta.url), 'utf8');
  const defined = new Set([...Object.keys(block(':root')), '--card', '--soft', '--role', '--role-soft', '--phase']);
  for (const [file, text] of [['page.ts', page], ['settings-panel.css', panel]]) {
    for (const m of text.matchAll(/var\((--[\w-]+)/g)) assert.ok(defined.has(m[1]), `${file} uses ${m[1]}`);
  }
});
