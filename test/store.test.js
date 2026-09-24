'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, cleanName, slugOf } = require('../lib/store');
const db = require('../lib/db');

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

// Postgres (production dialect) runs in-process via PGlite.
async function pglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  return {
    kind: 'postgres',
    schema: db.PG_SCHEMA,
    query: async (text, params = []) => (await pg.query(text, params)).rows,
  };
}

const backends = {
  sqlite: async () => db.sqlite(':memory:'),
  postgres: pglite,
};

for (const [kind, make] of Object.entries(backends)) {
  // Fresh store with the seed data removed, so tests control the contents.
  async function fresh() {
    const adapter = await make();
    const s = createStore(adapter);
    await s.init();
    await adapter.query('DELETE FROM items');
    return s;
  }

  test(`${kind}: seeds an empty database`, async () => {
    const s = createStore(await make());
    assert.equal((await s.stats('v')).items, 30);
  });

  test(`${kind}: add dedupes`, async () => {
    const s = await fresh();
    const a = await s.add('The Beatles', 'u1');
    const b = await s.add('beatles', 'u2');
    assert.equal(a.existed, false);
    assert.equal(b.existed, true);
    assert.equal(a.item.id, b.item.id);
    assert.ok((await s.add('x')).error);
  });

  test(`${kind}: one vote per voter per item, changeable`, async () => {
    const s = await fresh();
    const { item } = await s.add('Sushi');
    await s.vote('v1', item.id, 1);
    await s.vote('v1', item.id, 1);
    let r = await s.vote('v2', item.id, 1);
    assert.equal(r.item.over, 2);
    r = await s.vote('v1', item.id, -1);
    assert.equal(r.item.over, 1);
    assert.equal(r.item.under, 1);
    assert.ok((await s.vote('v1', item.id, 5)).error);
    assert.ok((await s.vote('v1', 99999, 1)).error);
  });

  test(`${kind}: next prefers unvoted items`, async () => {
    const s = await fresh();
    const a = (await s.add('Alpha')).item;
    const b = (await s.add('Bravo')).item;
    await s.vote('v', a.id, 1);
    assert.equal((await s.next('v')).item.id, b.id);
    await s.vote('v', b.id, 1);
    assert.equal((await s.next('v')).fresh, false);
  });

  test(`${kind}: toplists split by lean`, async () => {
    const s = await fresh();
    const hot = (await s.add('Hot')).item;
    const cold = (await s.add('Cold')).item;
    for (let i = 0; i < 5; i++) {
      await s.vote('o' + i, hot.id, 1);
      await s.vote('o' + i, cold.id, -1);
    }
    const t = await s.top();
    assert.equal(t.overrated[0].id, hot.id);
    assert.equal(t.underrated[0].id, cold.id);
    assert.equal(t.total, 2);
  });

  test(`${kind}: duels fine-tune items with equal votes`, async () => {
    const s = await fresh();
    // Add in an order where the loser gets the lower id, to catch id-order bias.
    const b = (await s.add('Banana')).item;
    const a = (await s.add('Apple')).item;
    for (let i = 0; i < 4; i++) {
      await s.vote('p' + i, a.id, 1);
      await s.vote('p' + i, b.id, 1);
    }
    // Voters say A is more overrated, and B is more underrated.
    for (let i = 0; i < 3; i++) await s.duel('d' + i, a.id, b.id, a.id, 'over');
    for (let i = 3; i < 6; i++) await s.duel('d' + i, b.id, a.id, b.id, 'under');
    // Repeat duels by the same voter do not count.
    assert.equal((await s.duel('d0', a.id, b.id, b.id, 'over')).repeat, true);
    const t = await s.top();
    assert.deepEqual(t.overrated.map((x) => x.id), [a.id, b.id]);
    assert.ok(t.overrated[0].score > t.overrated[1].score);
    assert.equal(t.overrated[0].duels, 6);
    assert.ok((await s.duel('x', a.id, a.id, a.id, 'over')).error);
  });

  test(`${kind}: duelPair returns two distinct items`, async () => {
    const s = await fresh();
    for (const n of ['One', 'Two', 'Three', 'Four']) await s.add(n);
    const p = await s.duelPair('v');
    assert.notEqual(p.a.id, p.b.id);
    assert.ok(['over', 'under'].includes(p.mode));
  });
}
