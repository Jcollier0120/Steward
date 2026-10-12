import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interrupted, interruptedExit, missingProgram, networkFailure, networkLine, networkNote, passingFailure, programFound, waitForProgram } from '../src/stages/common.ts';

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

test("Windows ending a program (the PC shutting down) isn't the program failing: it passes, and the next round tries again", async () => {
  // 2026-10-12: a restart killed a train's npm test, and every git the round started while Windows shut down failed.
  for (const m of [
    'npm test failed (exit 1073807364): "the keeper asks again at once when hardware.json has an NPU but not its name"',
    'git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main failed (3221225794): no output',
    'npm test failed (exit -1073741510)',
  ]) {
    assert.equal(interrupted(m), true, m);
    assert.equal(await networkFailure({ online: async () => true }, m), true, m);
  }
  for (const m of ['npm test failed (exit 1)', 'npm test failed (exit 1073807364000)', 'not ok 1073807364 - a test numbered so', 'tests 3221225794 passed (exit 1)']) assert.equal(interrupted(m), false, m);
  assert.deepEqual([0x40010004, 0xc0000142, 0xc000013a, -1073741510, 1, null].map(interruptedExit), [true, true, true, true, false, false]);
});

test("a program missing for a moment (Git updating itself) isn't the commit failing: it passes once the program is back", async () => {
  // 2026-10-12: Git for Windows replaced git.exe while a round ran, and nine kit pushes were held, an alarm each.
  const said = (program: string) => `git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main failed (1): spawn ${program} ENOENT`;
  assert.equal(missingProgram(said('git')), 'git');
  assert.equal(missingProgram(said('C:\\Program Files\\Git\\cmd\\git.exe')), 'C:\\Program Files\\Git\\cmd\\git.exe', 'a path with spaces');
  assert.equal(missingProgram('npm test failed (exit 1): ENOENT: no such file or directory, open \'x.pid\''), null, "a test's own ENOENT isn't a program missing");
  // Found again (node runs these tests): a hold kept for it goes by itself, as rollout.ts lets go of passing ones.
  assert.equal(programFound('node'), true);
  assert.equal(passingFailure(said('node')), true);
  assert.equal(passingFailure(said(process.execPath)), true, 'a path that is there');
  // Still missing: the failure stands, an alarm that says so.
  assert.equal(programFound('no-such-program-anywhere'), false);
  assert.equal(passingFailure(said('no-such-program-anywhere')), false);
  // A round that meets it waits for it, and holds nothing if it comes back.
  const online = { online: async () => true };
  assert.equal(await networkFailure(online, said('git-being-replaced'), async () => true), true);
  assert.equal(await networkFailure(online, said('git-being-replaced'), async () => false), false, 'gone for good: held');
  assert.equal(await networkFailure(online, 'npm test failed (exit 1)', async () => assert.fail('only for a program missing')), false);
});

test('a wait for a program looks until it is back, up to its limit; after a wait in vain, one look only for a while', async () => {
  let looks = 0;
  assert.equal(await waitForProgram('git-back-soon', 5_000, () => ++looks >= 3, 1), true);
  assert.equal(looks, 3, 'it looked until the program was back');
  looks = 0;
  assert.equal(await waitForProgram('git-gone', 30, () => (looks++, false), 1), false);
  assert.ok(looks >= 2, 'it looked more than once before giving up');
  looks = 0;
  assert.equal(await waitForProgram('git-gone', 5_000, () => (looks++, false), 1), false);
  assert.equal(looks, 1, 'the next failure for it looks once: a round of many failures is not held up');
  assert.equal(await waitForProgram('git-gone', 5_000, () => true, 1), true, 'and finds it once it is back');
});
