import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the build says hello', () => {
  execFileSync(process.execPath, ['build.js']);
  assert.match(readFileSync('dist/hello.txt', 'utf8'), /^Hello, world!/);
});
