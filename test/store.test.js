'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, cleanName, slugOf } = require('../store');

test('cleanName validates input', () => {
  assert.equal(cleanName('  Pizza   rolls ').name, 'Pizza rolls');
  assert.ok(cleanName('x').error);
  assert.ok(cleanName('a'.repeat(61)).error);
  assert.ok(cleanName('寿司').error);
  assert.ok(cleanName('<script>').error);
  assert.ok(cleanName('123').error);
});

test('slugOf merges near-duplicates', () => {
  assert.equal(slugOf('The Beatles'), slugOf('beatles!'));
  assert.equal(slugOf('Rock & Roll'), slugOf('rock and roll'));
});

test('add dedupes', () => {
  const s = createStore();
  const a = s.add('The Beatles', 'u1');
  const b = s.add('beatles', 'u2');
  assert.equal(a.existed, false);
  assert.equal(b.existed, true);
  assert.equal(a.item.id, b.item.id);
});

test('one vote per voter per item, changeable', () => {
  const s = createStore();
  const { item } = s.add('Sushi');
  s.vote('v1', item.id, 1);
  s.vote('v1', item.id, 1);
  let r = s.vote('v2', item.id, 1);
  assert.equal(r.item.over, 2);
  r = s.vote('v1', item.id, -1);
  assert.equal(r.item.over, 1);
  assert.equal(r.item.under, 1);
  assert.ok(s.vote('v1', item.id, 5).error);
});

test('next prefers unvoted items', () => {
  const s = createStore();
  const a = s.add('Alpha').item;
  const b = s.add('Bravo').item;
  s.vote('v', a.id, 1);
  assert.equal(s.next('v').item.id, b.id);
  s.vote('v', b.id, 1);
  assert.equal(s.next('v').fresh, false);
});

test('toplists split by lean', () => {
  const s = createStore();
  const hot = s.add('Hot').item;
  const cold = s.add('Cold').item;
  for (let i = 0; i < 5; i++) {
    s.vote('o' + i, hot.id, 1);
    s.vote('o' + i, cold.id, -1);
  }
  const t = s.top();
  assert.equal(t.overrated[0].id, hot.id);
  assert.equal(t.underrated[0].id, cold.id);
});

test('duels fine-tune items with equal votes', () => {
  const s = createStore();
  const a = s.add('Apple').item;
  const b = s.add('Banana').item;
  for (let i = 0; i < 4; i++) {
    s.vote('p' + i, a.id, 1);
    s.vote('p' + i, b.id, 1);
  }
  // Voters say A is more overrated, and B is more underrated.
  for (let i = 0; i < 3; i++) s.duel('d' + i, a.id, b.id, a.id, 'over');
  for (let i = 3; i < 6; i++) s.duel('d' + i, a.id, b.id, b.id, 'under');
  // Repeat duels by the same voter do not count.
  assert.equal(s.duel('d0', a.id, b.id, a.id, 'over').repeat, true);
  const t = s.top();
  assert.deepEqual(t.overrated.map((x) => x.id), [a.id, b.id]);
  assert.ok(t.overrated[0].score > t.overrated[1].score);
  assert.ok(s.duel('x', a.id, a.id, a.id, 'over').error);
});

test('duelPair returns two distinct items', () => {
  const s = createStore();
  ['One', 'Two', 'Three', 'Four'].forEach((n) => s.add(n));
  const p = s.duelPair('v');
  assert.notEqual(p.a.id, p.b.id);
  assert.ok(['over', 'under'].includes(p.mode));
});
