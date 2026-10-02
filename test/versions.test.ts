import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agreedVersion, bumpPatch, readVersion, setVersion } from '../src/versions.ts';
import { splitCommand } from '../src/run.ts';

// An employee's version, in every file that carries it, changed in place and nowhere else.

const PKG = '{\n  "name": "porter",\n  "version": "0.4.0",\n  "private": true,\n  "devDependencies": {\n    "typescript": "^7.0.2"\n  }\n}\n';
const LOCK =
  '{\r\n  "name": "porter",\r\n  "version": "0.4.0",\r\n  "lockfileVersion": 3,\r\n  "packages": {\r\n    "": {\r\n      "name": "porter",\r\n      "version": "0.4.0",\r\n      "devDependencies": {}\r\n    },\r\n    "node_modules/x": {\r\n      "version": "0.4.0"\r\n    }\r\n  }\r\n}\r\n';
const APP = "export const APP = {\n  id: 'porter',\n  name: \"Porter\",\n  version: '0.4.0',\n};\n";
const MCP = "const server = new McpServer({ name: 'reeve', version: '0.2.2' }, { instructions });\n";
const CSPROJ = '<Project>\n  <PropertyGroup>\n    <VersionPrefix>1.6.0</VersionPrefix>\n  </PropertyGroup>\n</Project>\n';

test('the patch goes up by one', () => {
  assert.equal(bumpPatch('0.4.0'), '0.4.1');
  assert.equal(bumpPatch('1.9.19'), '1.9.20');
  assert.throws(() => bumpPatch('1.0'), /x\.y\.z/);
});

test('package.json: its own version only', () => {
  const out = setVersion('package.json', PKG, '0.4.0', '0.4.1');
  assert.equal(out, PKG.replace('"version": "0.4.0"', '"version": "0.4.1"'));
  assert.throws(() => setVersion('package.json', PKG, '0.3.9', '0.4.1'), /says 0\.4\.0/);
});

test("package-lock.json: its top and its own package's, not a dependency's, line endings kept", () => {
  const out = setVersion('package-lock.json', LOCK, '0.4.0', '0.4.1');
  const j = JSON.parse(out);
  assert.equal(j.version, '0.4.1');
  assert.equal(j.packages[''].version, '0.4.1');
  assert.equal(j.packages['node_modules/x'].version, '0.4.0', "a dependency that happens to share the version isn't touched");
  assert.equal(out.split('\r\n').length, LOCK.split('\r\n').length);
});

test("src/app.ts's version: 'x', Reeve's src/mcp.ts, and a .csproj's <VersionPrefix>", () => {
  assert.equal(setVersion('src/app.ts', APP, '0.4.0', '0.4.1'), APP.replace("'0.4.0'", "'0.4.1'"));
  assert.equal(setVersion('src/mcp.ts', MCP, '0.2.2', '0.2.3'), MCP.replace("'0.2.2'", "'0.2.3'"));
  assert.equal(setVersion('HEI.Agent/HEI.Agent.csproj', CSPROJ, '1.6.0', '1.6.1'), CSPROJ.replace('1.6.0', '1.6.1'));
  assert.equal(readVersion('HEI.Agent\\HEI.Agent.csproj', CSPROJ), '1.6.0');
  assert.throws(() => setVersion('src/app.ts', 'export const x = 1;', '0.4.0', '0.4.1'), /has no version/);
});

test('the version files must agree, and each must have one', () => {
  assert.deepEqual(agreedVersion([['package.json', PKG], ['package-lock.json', LOCK], ['src/app.ts', APP]]), { version: '0.4.0' });
  assert.match((agreedVersion([['package.json', PKG], ['src/app.ts', APP.replace('0.4.0', '0.3.9')]]) as { error: string }).error, /disagree: package\.json 0\.4\.0, src\/app\.ts 0\.3\.9/);
  assert.match((agreedVersion([['package.json', PKG], ['src/app.ts', null]]) as { error: string }).error, /no version found in src\/app\.ts/);
});

test("an employee's command line splits like a shell's, quotes keeping a word whole", () => {
  assert.deepEqual(splitCommand('npx tsc -p . --noEmit'), ['npx', 'tsc', '-p', '.', '--noEmit']);
  assert.deepEqual(splitCommand('powershell -NoProfile -File "HEI Agent\\release.ps1" -Publish'), ['powershell', '-NoProfile', '-File', 'HEI Agent\\release.ps1', '-Publish']);
  assert.deepEqual(splitCommand('  npm   run release -- --publish '), ['npm', 'run', 'release', '--', '--publish']);
  assert.deepEqual(splitCommand('node -e ""'), ['node', '-e', '']);
});
