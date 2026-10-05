import assert from 'node:assert/strict';
import { test } from 'node:test';
import { networkFailure, networkLine, networkNote } from '../src/stages/common.ts';

// The Developer Herald's 0.5.6: built, then gh's publish timed out. The message said only "failed (exit 1)", the PC
// was online again when the round asked, so the commit was held for a person to release.
const RELEASE_OUTPUT = [
  'Developer Herald 0.5.6 (959e52a, kit 2.15.0): artifacts\\developer-herald\\DeveloperHerald-0.5.6.zip, 73 files, 271 KB',
  '  sha256 96de2e7683616ba73d36e9f3b27fcf2575fbc371b8654534243d9ae7de26fa57 (artifacts\\developer-herald\\SHA256SUMS.txt)',
  '',
  'error checking for existing release: Head "https://api.github.com/repos/Jcollier0120/DeveloperHerald/releases/tags/v0.5.6": net/http: TLS handshake timeout',
].join('\r\n');

test("a command's output that says the network failed: its line, carried into the failure's message", () => {
  assert.match(networkLine(RELEASE_OUTPUT) ?? '', /TLS handshake timeout$/);
  assert.equal(networkNote(RELEASE_OUTPUT).startsWith('; the network: error checking for existing release'), true);
  for (const line of [
    "fatal: unable to access 'https://github.com/Jcollier0120/Heiward.git/': Could not resolve host: github.com",
    'dial tcp 192.168.1.254:443: connectex: A connection attempt failed because the connected party did not properly respond',
    'error connecting to api.github.com',
  ]) assert.ok(networkLine(line), line);
  assert.equal(networkLine('not ok 4 - auto order\nnpm ERR! Test failed.'), null, "a test that fails isn't the network");
  assert.equal(networkNote('Error: Cannot find module typescript'), '');
});

test('a release that failed on the network, online again by the time the round asks, holds nothing against its commit', async () => {
  const online = { online: async () => true };
  assert.equal(await networkFailure(online, `npm run release -- --publish failed (exit 1)${networkNote(RELEASE_OUTPUT)}`), true);
  assert.equal(await networkFailure(online, 'npm run release -- --publish failed (exit 1)'), false, 'its exit code alone: held, as before');
});
