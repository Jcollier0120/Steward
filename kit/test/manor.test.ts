import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// "Back to <manor>" in every agent's title bar. Nothing here reads the real Manor's settings.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'kit-manor-test-'));
const pkg = JSON.parse(readFileSync(new URL('./fixture/package.json', import.meta.url), 'utf8'));
process.env[`${String(pkg.name).toUpperCase().replace(/-/g, '_')}_HOME`] = path.join(tmp, 'agent');
process.env.REEVE_HOME = path.join(tmp, 'reeve');
process.env.NPU_AGENT_NPU_LOCK = path.join(tmp, 'locks', 'npu');
process.env.MANOR_HOME = path.join(tmp, 'no-manor');

const { HOUSE_SVG, forgetManorIcon, manorIcon, manorLink, safeSvg } = await import('./fixture/src/kit/manor.ts');
const { page } = await import('./fixture/src/kit/page.ts');

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
  assert.deepEqual(manorLink(manorAt('named', { name: 'Weasel Manor', port: 18585, theme: 'onyx' })), { name: 'Weasel Manor', port: 18585, url: 'http://manor.localhost:18585/', theme: 'onyx' });
  assert.deepEqual(manorLink(manorAt('defaults', {})), { name: 'Manor', port: 18585, url: 'http://manor.localhost:18585/', theme: 'system' }, 'Manor\'s own defaults');
  assert.deepEqual(manorLink(manorAt('odd', { name: '  ', port: 80, theme: 'paisley' })), { name: 'Manor', port: 18585, url: 'http://manor.localhost:18585/', theme: 'system' });
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
