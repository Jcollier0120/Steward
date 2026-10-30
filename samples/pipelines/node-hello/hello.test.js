import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hello } from './hello.js';

test('says hello', () => {
  assert.equal(hello(), 'Hello, world!');
  assert.equal(hello('Steward'), 'Hello, Steward!');
});
