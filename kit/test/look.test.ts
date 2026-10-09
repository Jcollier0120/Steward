import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The page's look: Heiward's title bar and a scene per role (look.ts). Nothing here reads the real Reeve's config.
const home = mkdtempSync(path.join(os.tmpdir(), 'kit-look-test-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(home, 'agent');
process.env.REEVE_HOME = path.join(home, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(home, 'locks', 'npu');
process.env.MANOR_HOME = path.join(home, 'no-manor'); // the title bar's Back to Manor: never the real Manor's settings
after(() => rmSync(home, { recursive: true, force: true }));

const { APP } = await import('./fixture/src/app.ts');
const { DEFAULT_LOOK, LOOK, lookFor, sceneSvg } = await import('./fixture/src/kit/look.ts');
const { WORK } = await import('./fixture/src/kit/work.ts');
const { page, statusPill, until } = await import('./fixture/src/kit/page.ts');
const { setDuty } = await import('./fixture/src/kit/duty.ts');
type Look = import('./fixture/src/kit/look.ts').Look;

const KIT_AGENTS = ['porter', 'auditor', 'clerk', 'herald', 'developer-herald', 'warrener', 'aletaster', 'miller', 'pinder', 'steward', 'surveyor', 'lamplighter', 'smith', 'thatcher', 'reckoner', 'weigher', 'shepherd', 'reeve', 'chamberlain', 'heiward', 'toller', 'assayer'];
const HEX = /^#[0-9a-f]{6}$/;

/** A scene's motion without its @keyframes blocks: the rules left, as [selector, declarations]. */
function rules(css: string): [string, string][] {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith('@keyframes', i)) {
      let depth = 0;
      for (i = css.indexOf('{', i); i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}' && --depth === 0) break;
      }
      continue;
    }
    out += css[i];
  }
  return [...out.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2].trim()]);
}

test('every kit agent has its look: a colour for Light and Dark, its words while busy, a scene and its motion', () => {
  for (const id of KIT_AGENTS) {
    const l: Look = LOOK[id];
    assert.ok(l, `${id} has a look`);
    assert.match(l.accent.light, HEX, `${id}: its Light colour`);
    assert.match(l.accent.dark, HEX, `${id}: its Dark colour`);
    assert.ok(l.busy.trim() && l.busy.length <= 24, `${id}: a word or three for the pill`);
    assert.doesNotMatch(l.busy, /NPU/, `${id}: the pill says what it does, not where`);
    assert.match(l.scene, /<(path|rect|circle|ellipse|g)\b/, `${id}: a scene`);
    assert.match(l.motion, /@keyframes /, `${id}: its motion`);
  }
  assert.deepEqual(Object.keys(LOOK).sort(), [...KIT_AGENTS].sort(), 'a look for each of these agents, and no other');
  for (const id of Object.keys(WORK)) assert.ok(LOOK[id], `${id}, which has its work in work.ts, has a look`);
  const colours = KIT_AGENTS.map((id) => LOOK[id].accent.light);
  assert.equal(new Set(colours).size, colours.length, 'each role its own colour');
});

test('an agent not listed gets the quiet default, and so does a name that is not an agent', () => {
  assert.equal(lookFor('someone-new'), DEFAULT_LOOK);
  assert.equal(lookFor('toString'), DEFAULT_LOOK);
  assert.equal(lookFor('constructor'), DEFAULT_LOOK);
  assert.equal(lookFor('aletaster'), LOOK.aletaster);
  assert.equal(DEFAULT_LOOK.busy, 'Working');
  assert.match(DEFAULT_LOOK.accent.light, HEX);
  assert.match(DEFAULT_LOOK.accent.dark, HEX);
});

test('a scene moves only while busy, and keeps time across reloads', () => {
  for (const [id, l] of [...Object.entries(LOOK), ['default', DEFAULT_LOOK]] as [string, Look][]) {
    const rs = rules(l.motion);
    assert.ok(rs.length, `${id}: its motion has rules`);
    for (const [sel] of rs) for (const one of sel.split(',')) assert.match(one.trim(), /^\.titlebar\.busy \.scene /, `${id}: "${one.trim()}" applies only while busy`);
    for (const m of l.motion.matchAll(/animation: [\w-]+ ([\d.]+)s/g)) {
      const s = Number(m[1]);
      assert.ok(Number.isInteger(Math.round((12 / s) * 1000) / 1000), `${id}: a ${s} s animation divides the 12 s clock`);
    }
    assert.ok(l.motion.includes('var(--phase'), `${id}: its animations start from the clock`);
    const ids = [...l.scene.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    for (const x of ids) assert.match(x, /^kit-sc-/, `${id}: the scene's id "${x}" can't meet an agent's own`);
  }
  const svg = sceneSvg(LOOK.miller);
  assert.match(svg, /^<svg class="scene" viewBox="0 0 64 40" width="64" height="40" aria-hidden="true" focusable="false">/);
});

test('the title bar: icon, name, role, scene, the status pill, Settings, Theme, and a place for Run now', () => {
  setDuty(true);
  const html = page({ token: 'tok', body: '<button data-post="/api/run">Run now</button>' });
  assert.match(html, /<header class="titlebar" data-agent="fixture">/);
  assert.match(html, new RegExp(`<h1>${APP.name}</h1><p class="role">`));
  assert.match(html, /<img class="brand-mark" src="\/favicon\.svg" alt=""/);
  assert.ok(html.includes(sceneSvg(DEFAULT_LOOK)), 'the fixture is not a listed agent: the default scene');
  assert.match(html, /<span class="status-pill on"[^>]*>On duty<\/span>/);
  assert.match(html, /<span class="titlebar-action" id="titlebar-action"><\/span>/);
  assert.ok(html.includes(`button[data-post="/api/run"]:not([data-form]):not([data-body])`), 'the script lifts a plain Run now');
  assert.ok(html.includes('button[data-titlebar]'), 'or a button the agent marks');
  // The theme, without Manor: the nine, under Windows and Colour themes, read before the page paints and kept per
  // agent, storage or not.
  const names = ['system', 'light', 'dark', 'arcade', 'onyx', 'carbon', 'tinsel', 'rosegold', 'quest'];
  assert.match(html, /<html lang="en">/, 'no theme stamped: the saved one, or Windows');
  assert.equal((html.match(/<button type="button" class="theme-item" role="menuitemradio"/g) ?? []).length, 9);
  for (const t of names) assert.ok(html.includes(`data-theme="${t}">`), t);
  assert.ok(html.indexOf('<div class="menu-label">Windows</div>') < html.indexOf('data-theme="system">'));
  assert.ok(html.indexOf('data-theme="dark">') < html.indexOf('<div class="menu-label">Colour themes</div>'));
  assert.ok(html.indexOf('<div class="menu-label">Colour themes</div>') < html.indexOf('data-theme="arcade">'));
  assert.ok(html.includes(`localStorage.getItem("${APP.id}:theme")`), 'its own key');
  assert.ok(html.includes(`${JSON.stringify(names)}.indexOf(t) >= 0`), 'only a theme there is');
  assert.match(html, /try \{ var t = localStorage\.getItem/);
  assert.match(html, /try \{ localStorage\.setItem/);
  assert.doesNotMatch(html, /<p class="menu-note"|data-manor=/);
  // Every theme's colours, the manor's (web/themes.css). Light is :root's own: any data-theme keeps Windows' dark away.
  for (const t of names.slice(2)) assert.match(html, new RegExp(`:root\\[data-theme="${t}"\\] \\{`), t);
  assert.match(html, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\)/);
  // Its colour and motion, and none for someone who asks for less: its Dark colour on every dark theme.
  assert.ok(html.includes(`:root { --role: ${DEFAULT_LOOK.accent.light}; }`));
  assert.ok(html.includes(`:root[data-theme="dark"], :root[data-theme="arcade"], :root[data-theme="onyx"], :root[data-theme="carbon"] { --role: ${DEFAULT_LOOK.accent.dark}; }`));
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{ \.scene, \.scene \*, \.status-pill::before \{ animation: none !important; \} \.titlebar \{ transition: none; \} \}/);
  assert.match(html, /setProperty\('--phase'/);
  // No external fonts or scripts: the page's CSP allows its own origin only.
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/);
});

test('the title bar stays at the top as the page scrolls, and a jump to a #section lands below it', () => {
  const html = page({ token: 'tok', body: '' });
  const rule = (sel: string) => html.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
  const bar = rule('.titlebar');
  assert.match(bar, /position: sticky; top: 0; z-index: \d+;/);
  assert.match(bar, /background: var\(--bg\);/, "opaque, on the theme's own colour");
  assert.match(rule('.titlebar.stuck'), /border-bottom-color: var\(--line\); box-shadow: var\(--shadow\);/);
  assert.match(rule('html'), /scroll-padding-top: calc\(var\(--titlebar-h\) \+ 8px\);/);
  assert.match(html, /--titlebar-h: 57px;/);
  assert.match(html, /:root \{ --titlebar-h: 97px; \}/, 'two rows in a narrow window');
  assert.match(html, /max-height: calc\(100vh - var\(--titlebar-h\) - 16px\)/, 'the Theme menu fits below it');
  assert.ok(html.includes(`root.style.setProperty('--titlebar-h'`), 'the script keeps it to the bar');
  assert.ok(html.includes(`bar.classList.toggle('stuck', window.scrollY > 0)`));
  // Nothing else of the kit's sticks to the top, where it would meet the bar.
  assert.equal((html.match(/position: sticky/g) ?? []).length, 1);
  assert.equal((html.match(/position: fixed/g) ?? []).length, 0);
});

test('the page uses the width of the window: no column for text, panels or Settings, and the role whole when it fits', () => {
  const html = page({ token: 'tok', body: '' });
  const rule = (sel: string) => html.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
  assert.match(rule('main.view'), /margin: 0 12px 12px; padding: 14px 24px 28px;/, 'its side padding stays');
  assert.doesNotMatch(rule('main.view'), /max-width/);
  assert.doesNotMatch(html, /main(\.view)? > \*/, 'nothing caps what the panel holds');
  // The only widths left cap a control, never a run of text: a text box, the Theme menu, and the 100% guards.
  const caps = [...html.matchAll(/([^{}\n]+)\{[^{}]*?max-width: ([^;]+);/g)].map((m) => `${m[1].trim()} ${m[2]}`);
  assert.deepEqual(caps.filter((c) => !/^@media/.test(c)), [
    '.brand max-content',
    '.theme-menu calc(100vw - 24px)',
    ':where(input:not([type=checkbox], [type=radio], [type=range]), select, textarea) 100%',
    // On a phone: a long status pill is cut, and a wide table scrolls inside itself.
    '.status-pill 100%',
    'main.view table 100%',
  ]);
  assert.doesNotMatch(html, /max-width: [\d.]+(ch|em|rem)\b/, 'no measure in characters');
  // The role: one line, up to its own width, cut with an ellipsis only when the bar has no room for it.
  assert.match(rule('.brand'), /flex: 1 1 220px; min-width: 0; max-width: max-content;/);
  assert.match(rule('.brand .role'), /overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/);
  // The Settings panel's sheet: a text box is the one thing it holds to a width.
  const sheet = readFileSync(new URL('../web/settings-panel.css', import.meta.url), 'utf8');
  const sheetCaps = [...sheet.matchAll(/([^{}\n]+)\{[^{}]*?(?<![-\w])(max-width|width): ([^;]+);/g)].map((m) => `${m[1].trim()} ${m[2]}: ${m[3]}`);
  for (const c of sheetCaps) assert.match(c, /input\[type=(text|number|checkbox)\]|100%|^\.sf-table, /, `only a control or a guard: ${c}`);
  assert.doesNotMatch(sheet, /[\d.]+ch\b/, 'no measure in characters');
});

test('busy: the title bar moves, the pill says what it is doing, the page refreshes', () => {
  const html = page({ token: 'tok', body: '', busy: true });
  assert.match(html, /<header class="titlebar busy" data-agent="fixture">/);
  assert.match(html, /<span class="status-pill busy"[^>]*>Working<\/span>/);
  assert.match(html, /const REFRESH = 3;/);
});

test('off duty: the pill and a notice under the title bar, with its button back', () => {
  setDuty(false);
  try {
    const html = page({ token: 'tok', body: '' });
    assert.match(html, /<span class="status-pill off" title="Off duty since just now[^"]*">Off duty<\/span>/);
    assert.match(html, /<div class="banners"><div class="banner-note offduty" role="status"><span><strong>Off duty<\/strong> since just now/);
    assert.match(html, /<button class="quiet" data-post="\/api\/duty" data-body='\{"onDuty":true\}'>Back on duty<\/button>/);
    assert.ok(html.indexOf('class="banners"') < html.indexOf('<main'), 'above the page, so Settings shows it too');
  } finally {
    setDuty(true);
  }
});

test('the pill: busy first, then off duty, then on duty with its next round when the agent says', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const on = { onDuty: true, since: null };
  const off = { onDuty: false, since: '2026-10-02T09:00:00Z' };
  assert.match(statusPill({ look: LOOK.aletaster, busy: true, duty: off, now }), />Tasting<\/span>$/);
  assert.match(statusPill({ look: LOOK.aletaster, duty: off, now }), /title="Off duty since 3 hours ago: [^"]+">Off duty</);
  assert.match(statusPill({ look: LOOK.aletaster, duty: on, now }), />On duty<\/span>$/);
  assert.match(statusPill({ look: LOOK.aletaster, duty: on, nextAt: now + 25 * 60_000, now }), />On duty · next round in 25 min<\/span>$/);
  assert.match(statusPill({ look: LOOK.aletaster, duty: on, nextAt: '2026-10-02T18:00:00Z', now }), />On duty · next round in 6 hours<\/span>$/);
  assert.equal(until(null, now), null);
  assert.equal(until('not a time', now), null);
  assert.equal(until(now - 5000, now), 'within a minute');
  assert.equal(until(now + 3 * 86400_000, now), 'in 3 days');
});
