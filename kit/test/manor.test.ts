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

test("Manor's name and page from its settings; nothing without an installed Manor", () => {
  assert.deepEqual(manorLink(manorAt('named', { name: 'Weasel Manor', port: 18585 })), { name: 'Weasel Manor', port: 18585, url: 'http://manor.localhost:18585/' });
  assert.deepEqual(manorLink(manorAt('defaults', {})), { name: 'Manor', port: 18585, url: 'http://manor.localhost:18585/' }, 'Manor\'s own defaults');
  assert.deepEqual(manorLink(manorAt('odd', { name: '  ', port: 80 })), { name: 'Manor', port: 18585, url: 'http://manor.localhost:18585/' });
  assert.equal(manorLink(manorAt('unreadable', '{nope'))!.name, 'Manor');
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
