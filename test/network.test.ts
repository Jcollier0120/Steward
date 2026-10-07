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

test("GitHub's own failing (a 5xx, a dropped connection) passes like the network's: the next round pushes again, no alarm", async () => {
  const online = { online: async () => true };
  for (const said of [
    "git push refused (never forced): ! [remote rejected] steward/kit-2.32.1 -> steward/kit-2.32.1 (Internal Server Error) error: failed to push some refs to 'https://github.com/Jcollier0120/Heiward.git'",
    'error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502',
    "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 503",
    'fatal: the remote end hung up unexpectedly',
    'gh pr create failed: HTTP 504: Gateway Timeout (https://api.github.com/graphql)',
    'HTTP 500: Something went wrong',
  ]) assert.equal(await networkFailure(online, said), true, said);
  assert.ok(networkLine('npm run release -- --publish failed\nHTTP 503: Service Unavailable'), "a release's output carries the line");
  for (const said of [
    "git push refused (never forced): ! [rejected] steward/kit-2.32.1 -> steward/kit-2.32.1 (non-fast-forward)",
    'remote: Permission to Jcollier0120/Heiward.git denied to someone. fatal: ... returned error: 403',
    'HTTP 422: Validation Failed',
    'npm test failed (exit 1): 5003 tests',
  ]) assert.equal(await networkFailure(online, said), false, `still held: ${said}`);
});
