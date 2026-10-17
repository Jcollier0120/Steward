import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askedWords } from '../src/web/asked.ts';

// The page's Last stage says what the stage was asked in words: the owner's Build now read "full true; buildNow
// [object Object]" (2026-10-17).
test("a stage's asking in words: Build now and a full look, never an object's [object Object]", () => {
  assert.equal(askedWords({ full: true, buildNow: { toCustomers: false } }), 'every employee looked at; Build now');
  assert.equal(askedWords({ buildNow: { toCustomers: true }, employees: ['reeve', 'smith'] }), 'Build now, to customers; for reeve, smith');
  assert.equal(askedWords({ employees: [], kit: null, yes: false, full: undefined }), '');
  assert.equal(askedWords({ kit: '2.78.12', yes: true, team: true }), "kit 2.78.12; merging; the team's PRs too");
  // A field the page has no words for yet: plain, an object by its fields that are set.
  assert.equal(askedWords({ later: { a: true, b: false, c: 'x' }, many: ['p', 'q'] }), 'later (a, c x); many p, q');
  assert.doesNotMatch(askedWords({ later: { deep: { on: true } } }), /\[object Object\]/);
});
