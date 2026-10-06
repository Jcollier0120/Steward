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
process.env.STEWARD_HOME = path.join(tmp, 'no-steward');

const { HOUSE_SVG, agentUrl, developerOptions, forgetGithubOwner, forgetManorIcon, githubOwner, githubRepo, mayNotify, notifyAllowed, notifyFrom, notifyPrefs, gpuWithNpu, manorIcon, manorLink, manorOwn, manorProjects, manorSettingsUrl, originRepo, projectsFrom, safeSvg } = await import('./fixture/src/kit/manor.ts');
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
  assert.deepEqual(manorLink(manorAt('named', { name: 'Weasel Manor', port: 18585, theme: 'onyx', developerOptions: true })), { name: 'Weasel Manor', port: 18585, url: 'http://manor.localhost:18585/', theme: 'onyx', developerOptions: true, gpuWithNpu: true });
  assert.deepEqual(manorLink(manorAt('defaults', {})), { name: 'Manor', port: 18585, url: 'http://manor.localhost:18585/', theme: 'system', developerOptions: null, gpuWithNpu: true }, 'Manor\'s own defaults');
  assert.deepEqual(manorLink(manorAt('odd', { name: '  ', port: 80, theme: 'paisley' })), { name: 'Manor', port: 18585, url: 'http://manor.localhost:18585/', theme: 'system', developerOptions: null, gpuWithNpu: true });
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

test("the graphics card beside the NPU: Manor's gpuWithNpu when it says; else the agent's own switch, true without one", () => {
  // ManorLink: false only when Manor says false; an older Manor (no key), or anything else, is true.
  assert.equal(manorLink(manorAt('gpu-off', { gpuWithNpu: false }))!.gpuWithNpu, false);
  assert.equal(manorLink(manorAt('gpu-on', { gpuWithNpu: true }))!.gpuWithNpu, true);
  assert.equal(manorLink(manorAt('gpu-old', { name: 'Weasel Manor', developerOptions: true }))!.gpuWithNpu, true, 'an older Manor never set it aside');
  for (const [i, value] of ['false', 0, null, {}].entries()) assert.equal(manorLink(manorAt(`gpu-odd-${i}`, { gpuWithNpu: value }))!.gpuWithNpu, true, JSON.stringify(value));
  // gpuWithNpu(): Manor's value wins when it says, and it's Manor that set it.
  const off = manorAt('gpu-says-off', { name: 'Weasel Manor', port: 18600, gpuWithNpu: false });
  const on = manorAt('gpu-says-on', { gpuWithNpu: true });
  for (const own of [true, false]) {
    const r = gpuWithNpu(own, off);
    assert.equal(r.on, false, `own ${own}, Manor off`);
    assert.equal(r.setBy!.url, 'http://manor.localhost:18600/');
    assert.equal(gpuWithNpu(own, on).on, true, `own ${own}, Manor on`);
    // An older Manor without the key, one that says something else, or none: the agent's own switch.
    for (const home of [manorAt('gpu-says-nothing', { name: 'Weasel Manor' }), manorAt('gpu-says-no', { gpuWithNpu: 'no' }), manorAt('gpu-not-installed', { gpuWithNpu: false }, { installed: false }), path.join(tmp, 'nowhere')]) {
      assert.deepEqual(gpuWithNpu(own, home), { on: own, setBy: null }, `${home}, own ${own}`);
    }
  }
  // An agent without a switch of its own: true, unless Manor says false.
  assert.deepEqual(gpuWithNpu(undefined, manorAt('gpu-old-2', {})), { on: true, setBy: null });
  assert.deepEqual(gpuWithNpu(), { on: true, setBy: null }, 'no Manor here');
  // Read afresh.
  const later = manorAt('gpu-changes', { gpuWithNpu: true });
  assert.equal(gpuWithNpu(true, later).on, true);
  writeFileSync(path.join(later, 'settings.json'), JSON.stringify({ gpuWithNpu: false }));
  assert.equal(gpuWithNpu(true, later).on, false);
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

// Non-employee projects: repositories that ride along with the manor, never staff.
const NO_OWN = { repos: [], checkouts: [] };

/** A folder that is a clone of `url` (a .git folder with its config), or a worktree of one when `worktreeOf` is given. */
function cloneAt(name: string, url: string | null, o: { worktreeOf?: string } = {}): string {
  const dir = path.join(tmp, 'clones', name);
  mkdirSync(dir, { recursive: true });
  if (o.worktreeOf) {
    const gitdir = path.join(o.worktreeOf, '.git', 'worktrees', name);
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    writeFileSync(path.join(dir, '.git'), `gitdir: ${gitdir}\n`);
  } else {
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    const origin = url ? `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : '';
    writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n${origin}[branch "main"]\n\tremote = origin\n`);
  }
  return dir;
}

test('a project: its name, checkout, repo, branch, test, version files and branch cleaning, with their defaults', () => {
  const problems: string[] = [];
  const projects = projectsFrom([
    { name: ' Side Car ', checkout: 'C:\\Projects\\SideCar' },
    { name: 'Full', checkout: 'D:\\code\\full\\', repo: 'someone/full.js', branch: 'release/2.x', test: 'npm test', versionFiles: ['package.json', ' package-lock.json ', 'PACKAGE.JSON'], cleanBranches: false, extra: 'kept out' },
    { name: 'Share', checkout: '\\\\nas\\code\\share', repo: '', branch: '', test: null, versionFiles: [], cleanBranches: null },
  ], NO_OWN, problems);
  assert.deepEqual(problems, []);
  assert.deepEqual(projects, [
    { name: 'Side Car', checkout: 'C:\\Projects\\SideCar', repo: null, branch: 'main', test: null, versionFiles: [], cleanBranches: true },
    { name: 'Full', checkout: 'D:\\code\\full\\', repo: 'someone/full.js', branch: 'release/2.x', test: 'npm test', versionFiles: ['package.json', 'package-lock.json'], cleanBranches: false },
    { name: 'Share', checkout: '\\\\nas\\code\\share', repo: null, branch: 'main', test: null, versionFiles: [], cleanBranches: true },
  ]);
  assert.deepEqual(projectsFrom(undefined, NO_OWN), [], 'none listed');
  assert.deepEqual(projectsFrom(null, NO_OWN), []);
});

test('a wrong project is left out and said; the rest stand', () => {
  const cases: [unknown, RegExp][] = [
    [{ checkout: 'C:\\x' }, /entry 1 should have a "name" of 1 to 60 characters; it's left out\./],
    [{ name: 'x'.repeat(61), checkout: 'C:\\x' }, /"name"/],
    [{ name: 'A', checkout: 'relative\\path' }, /entry 1 \("A"\) should have a "checkout": the full path of its clone/],
    [{ name: 'A', checkout: 'C:\\bad|name' }, /"checkout"/],
    [{ name: 'A', checkout: 7 }, /"checkout"/],
    [{ name: 'A', checkout: 'C:\\x', repo: 'no-slash' }, /"repo" as owner\/name/],
    [{ name: 'A', checkout: 'C:\\x', repo: 'https://github.com/a/b' }, /"repo"/],
    [{ name: 'A', checkout: 'C:\\x', branch: 'two words' }, /"branch"/],
    [{ name: 'A', checkout: 'C:\\x', branch: '-x' }, /"branch"/],
    [{ name: 'A', checkout: 'C:\\x', branch: 'a..b' }, /"branch"/],
    [{ name: 'A', checkout: 'C:\\x', test: 'line one\nline two' }, /"test"/],
    [{ name: 'A', checkout: 'C:\\x', test: 'x'.repeat(301) }, /"test"/],
    [{ name: 'A', checkout: 'C:\\x', versionFiles: 'package.json' }, /"versionFiles" as a list/],
    [{ name: 'A', checkout: 'C:\\x', versionFiles: ['..\\outside.json'] }, /"versionFiles"/],
    [{ name: 'A', checkout: 'C:\\x', versionFiles: ['C:\\abs.json'] }, /"versionFiles"/],
    [{ name: 'A', checkout: 'C:\\x', versionFiles: ['\\rooted.json'] }, /"versionFiles"/],
    [{ name: 'A', checkout: 'C:\\x', versionFiles: [7] }, /"versionFiles"/],
    [{ name: 'A', checkout: 'C:\\x', versionFiles: Array.from({ length: 21 }, (_, i) => `f${i}.json`) }, /up to 20 files/],
    [{ name: 'A', checkout: 'C:\\x', cleanBranches: 'yes' }, /"cleanBranches" as true or false/],
    ['a string', /entry 1 should have a "name"/],
  ];
  for (const [entry, said] of cases) {
    const problems: string[] = [];
    assert.deepEqual(projectsFrom([entry, { name: 'Fine', checkout: 'C:\\fine' }], NO_OWN, problems).map((p) => p.name), ['Fine'], JSON.stringify(entry));
    assert.equal(problems.length, 1, JSON.stringify(entry));
    assert.match(problems[0], said);
  }
  const problems: string[] = [];
  assert.deepEqual(projectsFrom({ name: 'A' }, NO_OWN, problems), []);
  assert.match(problems[0], /"projects" should be a list/);
  // One name and one clone to a project, whatever their case or a separator at the end; the first stands.
  problems.length = 0;
  const twice = projectsFrom([
    { name: 'One', checkout: 'C:\\Projects\\One' },
    { name: 'ONE', checkout: 'C:\\Projects\\Other' },
    { name: 'Two', checkout: 'c:\\projects\\one\\' },
  ], NO_OWN, problems);
  assert.deepEqual(twice.map((p) => p.name), ['One']);
  assert.match(problems[0], /entry 2 \("ONE"\) has the name of one listed before it/);
  assert.match(problems[1], /entry 3 \("Two"\) has the checkout of one listed before it/);
  // At most 50.
  problems.length = 0;
  assert.equal(projectsFrom(Array.from({ length: 52 }, (_, i) => ({ name: `P${i}`, checkout: `C:\\p\\${i}` })), NO_OWN, problems).length, 50);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /entry 51 \("P50"\) is one more than the 50/);
});

test("a project is never one of the manor's own: its repository, its clone's origin, or a checkout of the Steward's", () => {
  const own = { repos: ['Jcollier0120/Manor', 'Jcollier0120/Porter'], checkouts: ['C:\\Projects\\Porter', 'C:\\Projects\\Steward'] };
  const problems: string[] = [];
  const porterClone = cloneAt('porter-elsewhere', 'https://github.com/Jcollier0120/Porter.git');
  const sideCar = cloneAt('side-car', 'git@github.com:someone/side-car.git');
  const projects = projectsFrom([
    { name: 'By repo', checkout: 'D:\\x', repo: 'jcollier0120/porter' },
    { name: 'Manor', checkout: 'D:\\manor', repo: 'Jcollier0120/Manor' },
    { name: 'By origin', checkout: porterClone },
    { name: 'Its checkout', checkout: 'c:\\projects\\porter\\' },
    { name: 'Inside one', checkout: 'C:\\Projects\\Steward\\.claude\\worktrees\\x' },
    { name: 'Holding them', checkout: 'C:\\Projects' },
    { name: 'Next door', checkout: 'C:\\Projects\\Porterhouse' },
    { name: 'Side car', checkout: sideCar, repo: 'someone/side-car' },
  ], own, problems);
  assert.deepEqual(projects.map((p) => p.name), ['Next door', 'Side car']);
  assert.match(problems[0], /"By repo"\) is jcollier0120\/porter, one of the manor's own: an employee is looked after as staff, never as a project; it's left out\./);
  assert.match(problems[1], /"Manor"\) is Jcollier0120\/Manor, one of the manor's own/);
  assert.match(problems[2], /"By origin"\) is Jcollier0120\/Porter, one of the manor's own/);
  assert.match(problems[3], /"Its checkout"\) is one of the Steward's employees' checkouts/);
  assert.match(problems[4], /"Inside one"\) is inside one of the Steward's employees' checkouts/);
  assert.match(problems[5], /"Holding them"\) is a folder holding one of the Steward's employees' checkouts/);
  assert.equal(problems.length, 6);
});

test("a clone's origin: from its git config, a worktree's too; GitHub's alone", () => {
  const main = cloneAt('origin-main', 'https://github.com/someone/thing.git');
  assert.equal(originRepo(main), 'someone/thing');
  assert.equal(originRepo(cloneAt('origin-worktree', null, { worktreeOf: main })), 'someone/thing', "a worktree shares its clone's config");
  assert.equal(originRepo(cloneAt('origin-none', null)), null, 'no origin');
  assert.equal(originRepo(cloneAt('origin-elsewhere', 'https://gitlab.com/someone/thing.git')), null);
  assert.equal(originRepo(path.join(tmp, 'nowhere')), null);
  assert.equal(githubRepo('git@github.com:a-b/c.d.git'), 'a-b/c.d');
  assert.equal(githubRepo('https://github.com/a/b/'), 'a/b');
  assert.equal(githubRepo('ssh://git@github.com/a/b'), 'a/b');
});

test("the manor's own: Manor's repository, its staff's and announced agents', the Steward's employees and its own checkout", () => {
  const home = manorAt('own-home', {});
  writeFileSync(path.join(home, 'app', 'staff.json'), JSON.stringify({ agents: [{ id: 'porter', release: { repo: 'Jcollier0120/Porter' } }, { id: 'odd' }, null] }));
  writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'chamberlain', release: { repo: 'Jcollier0120/Chamberlain' } }] }));
  const steward = path.join(tmp, 'own-steward');
  mkdirSync(steward, { recursive: true });
  // The staff table the Steward keeps, when its settings name no employees.
  writeFileSync(path.join(steward, 'staff.json'), JSON.stringify({ rows: [{ id: 'miller', repo: 'Jcollier0120/Miller', checkout: { path: 'C:\\Projects\\Miller', exists: true } }] }));
  assert.deepEqual(manorOwn({ home, stewardHome: steward }), {
    repos: ['Jcollier0120/Manor', 'Jcollier0120/Porter', 'Jcollier0120/Chamberlain', 'Jcollier0120/Miller'],
    checkouts: ['C:\\Projects\\Miller', 'C:\\Projects\\Steward'],
  });
  // Its settings' employees, and its own checkout, when they say.
  writeFileSync(path.join(steward, 'settings.json'), JSON.stringify({ employees: [{ id: 'clerk', repo: 'me/Clerk', checkout: 'E:\\src\\Clerk' }], stewardCheckout: 'E:\\src\\Steward' }));
  assert.deepEqual(manorOwn({ home, stewardHome: steward, staffFile: path.join(tmp, 'no-staff.json') }), {
    repos: ['Jcollier0120/Manor', 'Jcollier0120/Chamberlain', 'me/Clerk'],
    checkouts: ['E:\\src\\Clerk', 'E:\\src\\Steward'],
  });
  // Nothing installed: Manor's repository and the Steward's usual checkout.
  assert.deepEqual(manorOwn({ home: path.join(tmp, 'nowhere') }), { repos: ['Jcollier0120/Manor'], checkouts: ['C:\\Projects\\Steward'] });
});

test("manorProjects: Manor's projects, checked, read afresh; none without an installed Manor", () => {
  const home = manorAt('projects', { projects: [{ name: 'Side car', checkout: 'D:\\side-car', versionFiles: ['package.json'] }, { name: 'Bad' }] });
  writeFileSync(path.join(home, 'app', 'staff.json'), JSON.stringify({ agents: [{ id: 'porter', release: { repo: 'Jcollier0120/Porter' } }] }));
  assert.deepEqual(manorProjects(home), [{ name: 'Side car', checkout: 'D:\\side-car', repo: null, branch: 'main', test: null, versionFiles: ['package.json'], cleanBranches: true }]);
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ projects: [{ name: 'Porter', checkout: 'D:\\porter', repo: 'Jcollier0120/Porter' }, { name: 'Other', checkout: 'D:\\other', cleanBranches: false }] }));
  assert.deepEqual(manorProjects(home).map((p) => [p.name, p.cleanBranches]), [['Other', false]], "Manor's staff, from its app's staff.json, is never a project");
  assert.deepEqual(manorProjects(manorAt('projects-none', {})), []);
  assert.deepEqual(manorProjects(manorAt('projects-unreadable', '{"projects": [')), []);
  assert.deepEqual(manorProjects(manorAt('projects-not-installed', { projects: [{ name: 'A', checkout: 'D:\\a' }] }, { installed: false })), []);
  assert.deepEqual(manorProjects(path.join(tmp, 'nowhere')), []);
  process.env.MANOR_HOME = home;
  try {
    assert.equal(manorProjects().length, 1, 'MANOR_HOME, as Manor reads it');
  } finally {
    process.env.MANOR_HOME = path.join(tmp, 'no-manor');
  }
});

test("the manor's notify preferences: Manor's when it says, each wrong field its default; none without Manor's say", () => {
  assert.deepEqual(notifyPrefs(manorAt('notify', { notify: { on: true, quietFrom: '21:30', quietTo: '06:45' } })), { on: true, quietFrom: '21:30', quietTo: '06:45' });
  assert.deepEqual(notifyFrom({ on: false, quietFrom: '25:00', quietTo: '7:00' }), { on: false, quietFrom: '22:00', quietTo: '07:00' }, 'a bad time: its default');
  assert.deepEqual(notifyFrom({ on: 'yes', quietFrom: '08:00', quietTo: '08:00' }), { on: true, quietFrom: null, quietTo: null }, 'equal times: no quiet hours');
  assert.deepEqual(notifyFrom(null), { on: true, quietFrom: '22:00', quietTo: '07:00' });
  assert.deepEqual(notifyFrom({ quietFrom: ' 23:00', quietTo: '06:00 ' }), { on: true, quietFrom: '22:00', quietTo: '07:00' }, 'spaces are not trimmed: as Manor reads it');
  assert.equal(notifyPrefs(manorAt('notify-unsaid', {})), null, 'an older Manor, which says nothing');
  assert.equal(notifyPrefs(manorAt('notify-not-installed', { notify: { on: false } }, { installed: false })), null);
  assert.equal(notifyPrefs(path.join(tmp, 'nowhere')), null);
});

test('may an agent notify now: on, and outside the quiet hours, which may span midnight; always without Manor', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 5, h, m);
  const night = { on: true, quietFrom: '22:00', quietTo: '07:00' };
  assert.equal(notifyAllowed(night, at(21, 59)), true);
  assert.equal(notifyAllowed(night, at(22)), false);
  assert.equal(notifyAllowed(night, at(3)), false);
  assert.equal(notifyAllowed(night, at(6, 59)), false);
  assert.equal(notifyAllowed(night, at(7)), true);
  const lunch = { on: true, quietFrom: '12:00', quietTo: '13:30' };
  assert.equal(notifyAllowed(lunch, at(12, 30)), false);
  assert.equal(notifyAllowed(lunch, at(13, 30)), true);
  assert.equal(notifyAllowed(lunch, at(23)), true);
  assert.equal(notifyAllowed({ on: true, quietFrom: null, quietTo: null }, at(3)), true);
  assert.equal(notifyAllowed({ on: false, quietFrom: null, quietTo: null }, at(12)), false, 'off: never');
  assert.equal(notifyAllowed(null, at(3)), true, "no say from Manor: nothing holds it back");
  assert.equal(mayNotify(at(3), manorAt('notify-may', { notify: night })), false);
  assert.equal(mayNotify(at(3), path.join(tmp, 'nowhere')), true);
});

test("another agent's page: its home in Manor's agents.json, else its staff.json; a checkout's 10000 above", () => {
  const home = manorAt('agents', {});
  writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ agents: [{ id: 'reeve', home: 'http://reeve.localhost:18383/' }, { id: 'odd', home: 'javascript:alert(1)' }, { id: 'none' }] }));
  writeFileSync(path.join(home, 'app', 'staff.json'), JSON.stringify({ agents: [{ id: 'reeve', home: 'http://reeve.localhost:1/' }, { id: 'porter', home: 'http://porter.localhost:18686/' }] }));
  assert.equal(agentUrl('reeve', { home }), 'http://reeve.localhost:18383/', 'announced first');
  assert.equal(agentUrl('porter', { home }), 'http://porter.localhost:18686/', 'else its staff');
  assert.equal(agentUrl('reeve', { home, dev: true }), 'http://reeve.localhost:28383/');
  assert.equal(agentUrl('odd', { home }), null, 'only http(s)');
  assert.equal(agentUrl('none', { home }), null);
  assert.equal(agentUrl('smith', { home }), null);
  assert.equal(agentUrl('reeve', { home: path.join(tmp, 'nowhere') }), null);
});

test("the GitHub owner: gh's signed-in login, from its config, else GitHub; kept once known, asked again later when not", () => {
  forgetGithubOwner();
  const asked: string[][] = [];
  const gh = (said: Record<string, string>) => (args: string[]) => (asked.push(args), said[args[0]] ?? '');
  assert.equal(githubOwner({ run: gh({ config: 'Jcollier0120\n' }), now: 0 }), 'Jcollier0120');
  assert.equal(githubOwner({ run: gh({ config: 'someone-else' }), now: 1 }), 'Jcollier0120', 'kept');
  assert.equal(asked.length, 1);
  forgetGithubOwner();
  assert.equal(githubOwner({ run: gh({ config: '', api: 'octo-cat' }), now: 0 }), 'octo-cat', "gh's config empty: GitHub");
  forgetGithubOwner();
  assert.equal(githubOwner({ run: gh({ config: 'not a login!' }), now: 0 }), null);
  assert.equal(githubOwner({ run: gh({ config: 'late' }), now: 60_000 }), null, 'not known: not asked again at once');
  assert.equal(githubOwner({ run: gh({ config: 'late' }), now: 10 * 60_000 }), 'late', 'but after ten minutes');
  forgetGithubOwner();
});
