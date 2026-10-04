import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// "Back to <manor>" in every agent's title bar. Nothing here reads the real Manor's settings.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'kit-manor-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(tmp, 'agent');
process.env.REEVE_HOME = path.join(tmp, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(tmp, 'locks', 'npu');
process.env.MANOR_HOME = path.join(tmp, 'no-manor');

const { HOUSE_SVG, developerOptions, forgetManorIcon, manorIcon, manorLink, manorSettingsUrl, safeSvg } = await import('./fixture/src/kit/manor.ts');
const { developerOptionsNote, page } = await import('./fixture/src/kit/page.ts');

/** A Manor folder: settings.json, and an app folder (with its own art) when installed. */
function manorAt(name: string, settings: unknown, o: { installed?: boolean; art?: string } = {}): string {
  const home = path.join(tmp, name);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  if (o.installed !== false) mkdirSync(path.join(home, 'app', 'art'), { recursive: true });
  if (o.art) writeFileSync(path.join(home, 'app', 'art', 'manor-icon.svg'), o.art);
  return home;
}

test("Manor's name, page and theme from its settings; nothing without an installed Manor", () => {
  assert.deepEqual(manorLink(manorAt('named', { name: 'Weasel Manor', port: 18585, theme: 'onyx', developerOptions: true })), { name: 'Weasel Manor', port: 18585, url: 'http://manor.localhost:18585/', theme: 'onyx', developerOptions: true });
  assert.deepEqual(manorLink(manorAt('defaults', {})), { name: 'Manor', port: 18585, url: 'http://manor.localhost:18585/', theme: 'system', developerOptions: null }, 'Manor\'s own defaults');
  assert.deepEqual(manorLink(manorAt('odd', { name: '  ', port: 80, theme: 'paisley' })), { name: 'Manor', port: 18585, url: 'http://manor.localhost:18585/', theme: 'system', developerOptions: null });
  assert.equal(manorLink(manorAt('unreadable', '{nope'))!.name, 'Manor');
  assert.equal(manorLink(manorAt('not-an-object', 'null'))!.theme, 'system');
  assert.equal(manorLink(manorAt('bom', '﻿{"theme": "quest"}'))!.theme, 'quest');
  for (const theme of ['system', 'light', 'dark', 'arcade', 'onyx', 'carbon', 'tinsel', 'rosegold', 'quest']) assert.equal(manorLink(manorAt(`theme-${theme}`, { theme }))!.theme, theme);
  ([7, null, ['dark'], 'Dark', 'toString'] as unknown[]).forEach((theme, i) => assert.equal(manorLink(manorAt(`odd-theme-${i}`, { theme }))!.theme, 'system', String(theme)));
  assert.equal(manorLink(manorAt('leftover', { name: 'Old' }, { installed: false })), null, 'a settings.json without the app is no Manor');
  assert.equal(manorLink(path.join(tmp, 'nowhere')), null);
});

test('the title bar says Back to <manor> first, with its icon, only when Manor is installed', () => {
  process.env.MANOR_HOME = manorAt('for-page', { name: 'Weasel Manor', port: 18600 });
  try {
    const html = page({ token: 't', body: '<p>hi</p>' });
    assert.match(html, /<header class="titlebar[^"]*"[^>]*>\s*<a class="manor-back" href="http:\/\/manor\.localhost:18600\/" title="Back to Weasel Manor"><img src="\/manor-icon\.svg" alt="" width="22" height="22"><span>Back to Weasel Manor<\/span><\/a>/);
  } finally {
    process.env.MANOR_HOME = path.join(tmp, 'no-manor');
  }
  assert.doesNotMatch(page({ token: 't', body: '' }), /manor-back"/, 'no Manor, no link');
});

test("with Manor, the page wears the manor's theme from its first paint, and its Theme menu says it's Manor's", () => {
  process.env.MANOR_HOME = manorAt('themed', { name: 'Weasel "&" Manor', port: 18600, theme: 'arcade' });
  try {
    const html = page({ token: 't', body: '' });
    assert.match(html, /^<!doctype html>\n<html lang="en" data-theme="arcade" data-manor="Weasel &quot;&amp;&quot; Manor" data-manor-url="http:\/\/manor\.localhost:18600\/">/);
    assert.doesNotMatch(html, /localStorage\.getItem/, "the agent's own choice doesn't apply");
    // The menu: the manor's theme, not a button, and the way to Manor to change it.
    assert.match(html, /title="Theme \(Weasel &quot;&amp;&quot; Manor&#39;s\)"/);
    assert.equal((html.match(/class="theme-item"/g) ?? []).length, 1);
    assert.match(html, /<div class="theme-item" role="menuitemradio" aria-checked="true" aria-disabled="true" data-theme="arcade">.*<span class="ti-label">Arcade<\/span>/);
    assert.match(html, /<p class="menu-note">Weasel &quot;&amp;&quot; Manor chooses the theme, for every page in the manor\.<\/p>/);
    assert.match(html, /<a class="menu-link" role="menuitem" href="http:\/\/manor\.localhost:18600\/">Change it in Weasel &quot;&amp;&quot; Manor<\/a>/);
    assert.doesNotMatch(html, /<button type="button" class="theme-item"/);
  } finally {
    process.env.MANOR_HOME = path.join(tmp, 'no-manor');
  }
  process.env.MANOR_HOME = manorAt('windows', { name: 'Weasel Manor' });
  try {
    const html = page({ token: 't', body: '' });
    assert.match(html, /<html lang="en" data-manor="Weasel Manor" data-manor-url="http:\/\/manor\.localhost:18585\/">/, "Match Windows: no data-theme, and still Manor's");
    assert.match(html, /aria-disabled="true" data-theme="system">.*<span class="ti-label">Match Windows<\/span>/);
    assert.doesNotMatch(html, /localStorage\.getItem/);
  } finally {
    process.env.MANOR_HOME = path.join(tmp, 'no-manor');
  }
});

test("Manor's Developer options: true or false when its settings say; null when absent or anything else", () => {
  assert.equal(manorLink(manorAt('dev-on', { developerOptions: true }))!.developerOptions, true);
  assert.equal(manorLink(manorAt('dev-off', { developerOptions: false }))!.developerOptions, false);
  assert.equal(manorLink(manorAt('dev-absent', { name: 'Weasel Manor' }))!.developerOptions, null);
  (['true', 'false', 1, 0, null, [true], {}] as unknown[]).forEach((value, i) =>
    assert.equal(manorLink(manorAt(`dev-odd-${i}`, { developerOptions: value }))!.developerOptions, null, JSON.stringify(value)));
  assert.equal(manorLink(manorAt('dev-unreadable', '{"developerOptions": true'))!.developerOptions, null, 'unreadable: Manor hasn\'t said');
  assert.equal(manorLink(manorAt('dev-bom', '﻿{"developerOptions": false}'))!.developerOptions, false);
});

test("an agent's developer features: Manor's Developer options when it's installed and says, else the agent's own switch", () => {
  const on = manorAt('says-on', { name: 'Weasel Manor', port: 18600, developerOptions: true });
  const off = manorAt('says-off', { name: 'Weasel Manor', developerOptions: false });
  for (const own of [true, false]) {
    // Manor says: its value wins, whatever the agent's own switch is, and it's Manor that set it.
    let r = developerOptions(own, on);
    assert.equal(r.on, true, `own ${own}, Manor on`);
    assert.equal(r.setBy!.name, 'Weasel Manor');
    assert.equal(r.setBy!.url, 'http://manor.localhost:18600/');
    r = developerOptions(own, off);
    assert.equal(r.on, false, `own ${own}, Manor off`);
    assert.ok(r.setBy);
    // Manor hasn't said (absent, or not true or false), or isn't installed: the agent's own switch.
    for (const home of [manorAt('says-nothing', { name: 'Weasel Manor' }), manorAt('says-yes', { developerOptions: 'yes' }), manorAt('not-installed', { developerOptions: true }, { installed: false }), path.join(tmp, 'nowhere')]) {
      assert.deepEqual(developerOptions(own, home), { on: own, setBy: null }, `${home}, own ${own}`);
    }
  }
  // Read afresh: a change in Manor shows on the next call.
  const later = manorAt('changes', { developerOptions: true });
  assert.equal(developerOptions(false, later).on, true);
  writeFileSync(path.join(later, 'settings.json'), JSON.stringify({ developerOptions: false }));
  assert.equal(developerOptions(true, later).on, false);
  // MANOR_HOME, as Manor itself reads it, when no folder is given.
  process.env.MANOR_HOME = on;
  try {
    assert.equal(developerOptions(false).on, true);
  } finally {
    process.env.MANOR_HOME = path.join(tmp, 'no-manor');
  }
  assert.deepEqual(developerOptions(true), { on: true, setBy: null }, 'no Manor here');
});

test('in place of the agent\'s own switch: "<manor>\'s Developer options set this", and "Change it in <manor>", to its Settings', () => {
  const m = developerOptions(false, manorAt('note', { name: 'Weasel "&" Manor', port: 18600, developerOptions: true })).setBy;
  assert.equal(manorSettingsUrl(m!), 'http://manor.localhost:18600/#/settings', "Manor's Settings page");
  assert.equal(developerOptionsNote(m),
    '<p class="manor-decides"><span>Weasel &quot;&amp;&quot; Manor\'s Developer options set this.</span> <a href="http://manor.localhost:18600/#/settings">Change it in Weasel &quot;&amp;&quot; Manor</a></p>');
  assert.equal(developerOptionsNote(null), '', 'the agent\'s own switch stands');
  assert.match(page({ token: 't', body: '' }), /\.manor-decides \{/, 'its look is in every page');
});

test("Manor's icon: as its page serves it, else its app's own, else a house; never one that runs", async () => {
  const live = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>spotter</title></svg>';
  const server = http.createServer((req, res) => (req.url === '/favicon.svg' ? res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(live) : res.writeHead(404).end()));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    forgetManorIcon();
    assert.equal(await manorIcon(manorAt('up', { port }, { art: '<svg><title>own</title></svg>' })), live, 'the icon its page shows');
  } finally {
    await new Promise((r) => server.close(r));
  }
  forgetManorIcon();
  const closed = 1024 + Math.floor(Math.random() * 1000);
  assert.equal(await manorIcon(manorAt('down', { port: closed }, { art: '<svg><title>own</title></svg>' })), '<svg><title>own</title></svg>', 'Manor down: its own art');
  forgetManorIcon();
  assert.equal(await manorIcon(manorAt('no-art', { port: closed })), HOUSE_SVG);
  assert.equal(await manorIcon(path.join(tmp, 'nowhere')), HOUSE_SVG);
  assert.equal(safeSvg('<svg onload="alert(1)"/>'), false);
  assert.equal(safeSvg('<svg><script>x</script></svg>'), false);
  assert.equal(safeSvg('<html><svg/></html>'), false);
  assert.equal(safeSvg('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'), true);
});
