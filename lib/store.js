'use strict';

const { isOffensive } = require('./moderation');

// Scoring
// -------
// Every item has two signals:
//   1. Direct votes: "overrated" / "underrated". Smoothed into a lean in (-1, 1).
//   2. Duels: "which is more overrated, A or B?". Each duel is recorded as a
//      win on the overrated axis for whichever item was judged more overrated
//      ("which is more underrated?" gives the win to the other one). Smoothed
//      into a duel lean in (-1, 1).
// The final score is the vote lean plus a small, bounded nudge from the duel
// lean, so duels mainly reorder items whose vote leans are close.
//
// Counts are aggregated from the vote/duel rows rather than stored as
// counters, so every write is a single idempotent statement.

const PRIOR = 4; // pseudo-votes pulling new items toward neutral
const DUEL_WEIGHT = 0.15; // max score shift duels can contribute
const MIN_VOTES_FOR_LIST = 3;

const NAME_MIN = 2;
const NAME_MAX = 60;
const NAME_RE = /^[A-Za-z0-9 '’&.,!?:()\-+#/"]+$/;

const SEED = [
  'Avocado toast', 'The Beatles', 'Pineapple on pizza', 'Sleep', 'Crocs', 'Tap water',
  'New York City', 'Marvel movies', 'Brunch', 'Walking', 'Sushi', 'Vinyl records',
  'Cold showers', 'Libraries', 'Electric scooters', 'Pumpkin spice latte', 'Public transit',
  'The Godfather', 'Bananas', 'Remote work', 'Paris', 'Board games', 'Crypto', 'Naps',
  'Tom Hanks', 'Dishwashers', 'Oat milk', 'Friends (TV show)', 'Rice cookers', 'Hot sauce',
];

function lean(over, under) {
  return (over - under) / (over + under + PRIOR);
}

function score(r) {
  const duelLean = (2 * r.duel_wins - r.duels) / (r.duels + PRIOR);
  return lean(r.o_votes, r.u_votes) + DUEL_WEIGHT * duelLean;
}

function cleanName(raw) {
  if (typeof raw !== 'string') return { error: 'Type something first.' };
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name.length < NAME_MIN) return { error: 'That is a bit short.' };
  if (name.length > NAME_MAX) return { error: `Keep it under ${NAME_MAX} characters.` };
  if (!NAME_RE.test(name)) return { error: 'English letters, numbers and basic punctuation only.' };
  if ((name.match(/[A-Za-z]/g) || []).length < 2) return { error: 'Use at least a couple of letters.' };
  return { name };
}

// Canonical key so "The Beatles", "beatles" and "Beatles!" are the same thing.
function slugOf(name) {
  return name
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/ /g, '-');
}

const STATS = `
  SELECT i.id, i.name,
         COALESCE(v.o_votes, 0)   AS o_votes,
         COALESCE(v.u_votes, 0)   AS u_votes,
         COALESCE(d.duel_wins, 0) AS duel_wins,
         COALESCE(d.duels, 0)     AS duels
  FROM items i
  LEFT JOIN (
    SELECT item_id,
           CAST(SUM(CASE WHEN dir = 1 THEN 1 ELSE 0 END) AS INTEGER)  AS o_votes,
           CAST(SUM(CASE WHEN dir = -1 THEN 1 ELSE 0 END) AS INTEGER) AS u_votes
    FROM votes GROUP BY item_id
  ) v ON v.item_id = i.id
  LEFT JOIN (
    SELECT id, CAST(SUM(w) AS INTEGER) AS duel_wins, CAST(COUNT(*) AS INTEGER) AS duels
    FROM (
      SELECT lo_id AS id, CASE WHEN winner_over = lo_id THEN 1 ELSE 0 END AS w FROM duels
      UNION ALL
      SELECT hi_id AS id, CASE WHEN winner_over = hi_id THEN 1 ELSE 0 END AS w FROM duels
    ) x GROUP BY id
  ) d ON d.id = i.id`;

function norm(r) {
  return {
    id: Number(r.id),
    name: r.name,
    o_votes: Number(r.o_votes),
    u_votes: Number(r.u_votes),
    duel_wins: Number(r.duel_wins),
    duels: Number(r.duels),
  };
}

function present(r) {
  if (!r) return null;
  const total = r.o_votes + r.u_votes;
  return {
    id: r.id,
    name: r.name,
    over: r.o_votes,
    under: r.u_votes,
    votes: total,
    duels: r.duels,
    overPct: total ? Math.round((r.o_votes / total) * 100) : 50,
    score: Math.round(score(r) * 1000) / 1000,
  };
}

// Stats for a handful of items, via indexed per-item counts (no full scans).
const ITEM_STATS = (where) => `
  SELECT i.id, i.name,
         (SELECT COUNT(*) FROM votes v WHERE v.item_id = i.id AND v.dir = 1)  AS o_votes,
         (SELECT COUNT(*) FROM votes v WHERE v.item_id = i.id AND v.dir = -1) AS u_votes,
         (SELECT COUNT(*) FROM duels d WHERE d.winner_over = i.id)            AS duel_wins,
         ((SELECT COUNT(*) FROM duels d WHERE d.lo_id = i.id) +
          (SELECT COUNT(*) FROM duels d WHERE d.hi_id = i.id))                AS duels
  FROM items i WHERE ${where}`;

const MAX_BATCH = 20;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createStore(db) {
  let ready = null;

  // One round trip on a cold start: ensure the schema, then count items.
  function init() {
    ready ??= (async () => {
      const results = await db.batch([...db.schema.map((t) => [t]), ['SELECT COUNT(*) AS n FROM items']]);
      if (Number(results.at(-1)[0].n) === 0) {
        await db.batch(SEED.map((name) => [
          'INSERT INTO items (name, slug, created_by, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING',
          [name, slugOf(name), 'seed', Date.now()],
        ]));
      }
    })().catch((e) => {
      ready = null; // retry on the next request
      throw e;
    });
    return ready;
  }

  async function q(text, params) {
    await init();
    return db.query(text, params);
  }

  async function batch(list) {
    await init();
    return db.batch(list);
  }

  async function itemById(id) {
    if (!Number.isInteger(id) || id <= 0) return null;
    const [row] = await q(ITEM_STATS('i.id = $1'), [id]);
    return row ? norm(row) : null;
  }

  async function ranked() {
    const rows = (await q(STATS)).map(norm);
    return rows.map((row) => ({ row, s: score(row) })).sort((a, b) => b.s - a.s);
  }

  async function add(rawName, voter) {
    const { name, error } = cleanName(rawName);
    if (error) return { error };
    const slug = slugOf(name);
    if (!slug) return { error: 'Use at least a couple of letters.' };
    if (isOffensive(name)) return { error: 'Let’s keep it friendly. Try something else.' };
    if (voter && (await q('SELECT 1 FROM blocked WHERE voter = $1', [voter])).length) {
      return { error: 'You can’t add things right now.' };
    }
    const inserted = await q(
      'INSERT INTO items (name, slug, created_by, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING RETURNING id',
      [name, slug, voter || null, Date.now()],
    );
    const [{ id }] = inserted.length ? inserted : await q('SELECT id FROM items WHERE slug = $1', [slug]);
    return { item: present(await itemById(Number(id))), existed: inserted.length === 0 };
  }

  // Record the vote and read back the item's totals in one round trip.
  async function vote(voter, itemId, dir) {
    if (dir !== 1 && dir !== -1) return { error: 'Bad vote.' };
    if (!Number.isInteger(itemId) || itemId <= 0) return { error: 'No such thing.' };
    const [, rows] = await batch([
      [`INSERT INTO votes (voter, item_id, dir, at)
        SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM items WHERE id = $2)
        ON CONFLICT (voter, item_id) DO UPDATE SET dir = excluded.dir, at = excluded.at`,
       [voter, itemId, dir, Date.now()]],
      [ITEM_STATS('i.id = $1'), [itemId]],
    ]);
    if (!rows.length) return { error: 'No such thing.' };
    return { item: present(norm(rows[0])) };
  }

  // Up to `count` things this voter hasn't rated yet, favouring the least
  // voted so new additions get seen. Once everything is rated, returns
  // random things to reconsider, with fresh: false.
  async function next(voter, exclude = [], count = 1) {
    const skip = new Set(exclude);
    const n = Math.max(1, Math.min(MAX_BATCH, count));
    const rows = (await q(
      `SELECT i.id, i.name, (SELECT COUNT(*) FROM votes v WHERE v.item_id = i.id) AS n
       FROM items i
       WHERE NOT EXISTS (SELECT 1 FROM votes w WHERE w.voter = $1 AND w.item_id = i.id)
       ORDER BY n ASC, RANDOM() LIMIT ${n * 3 + skip.size}`,
      [voter],
    )).filter((r) => !skip.has(Number(r.id)));
    const pick = (list) => list.map((r) => ({ id: Number(r.id), name: r.name }));
    if (rows.length) return { items: pick(shuffle(rows.slice(0, n * 2)).slice(0, n)), fresh: true };
    const any = (await q(`SELECT id, name FROM items ORDER BY RANDOM() LIMIT ${n + skip.size}`))
      .filter((r) => !skip.has(Number(r.id)));
    return { items: pick(any.slice(0, n)), fresh: false };
  }

  // Pick two things that sit close together in the ranking, from the side the
  // question is about: "more overrated?" draws from things leaning overrated,
  // "more underrated?" from things leaning underrated. `avoid` is a pair
  // ("lo:hi") not to return, e.g. the one currently on screen.
  async function duelPair(voter, mode = 'over', avoid = '') {
    if (mode !== 'over' && mode !== 'under') return { error: 'Bad duel.' };
    const [statRows, doneRows] = await batch([
      [STATS],
      ['SELECT lo_id, hi_id FROM duels WHERE voter = $1', [voter]],
    ]);
    const list = statRows.map(norm).map((row) => ({ row, s: score(row) })).sort((a, b) => b.s - a.s);
    if (list.length < 2) return { error: 'Need at least two things to duel.' };
    const done = new Set(doneRows.map((r) => `${r.lo_id}:${r.hi_id}`));
    const rated = list.filter((x) => x.row.o_votes + x.row.u_votes >= 1);
    const side = rated.filter((x) => (mode === 'over' ? x.s > 0 : x.s < 0));
    const pool = side.length >= 2 ? side : rated.length >= 2 ? rated : list;
    for (let attempt = 0; attempt < 30; attempt++) {
      const i = Math.floor(Math.random() * pool.length);
      const span = 1 + Math.floor(Math.random() * 3);
      const j = Math.min(pool.length - 1, Math.max(0, i + (Math.random() < 0.5 ? -span : span)));
      if (i === j) continue;
      const [a, b] = Math.random() < 0.5 ? [pool[i], pool[j]] : [pool[j], pool[i]];
      const key = `${Math.min(a.row.id, b.row.id)}:${Math.max(a.row.id, b.row.id)}`;
      if (key === avoid && pool.length > 2) continue;
      if (attempt < 20 && done.has(key)) continue;
      return { mode, a: present(a.row), b: present(b.row) };
    }
    return { error: 'You have duelled everything nearby. Rate some more first!' };
  }

  async function duel(voter, aId, bId, winnerId, mode) {
    if (mode !== 'over' && mode !== 'under') return { error: 'Bad duel.' };
    if (!Number.isInteger(aId) || !Number.isInteger(bId)) return { error: 'Bad duel.' };
    if (aId === bId || (winnerId !== aId && winnerId !== bId)) return { error: 'Bad duel.' };
    // For "more underrated?" the other one is the more overrated of the two.
    const winnerOver = mode === 'over' ? winnerId : winnerId === aId ? bId : aId;
    const lo = Math.min(aId, bId);
    const hi = Math.max(aId, bId);
    const inserted = await q(
      `INSERT INTO duels (voter, lo_id, hi_id, winner_over, at)
       SELECT $1, $2, $3, $4, $5
       WHERE (SELECT COUNT(*) FROM items WHERE id = $2 OR id = $3) = 2
       ON CONFLICT (voter, lo_id, hi_id) DO NOTHING RETURNING voter`,
      [voter, lo, hi, winnerOver, Date.now()],
    );
    if (inserted.length) return { ok: true };
    const [{ n }] = await q('SELECT COUNT(*) AS n FROM items WHERE id = $1 OR id = $2', [lo, hi]);
    return Number(n) === 2 ? { ok: true, repeat: true } : { error: 'No such thing.' };
  }

  async function top(limit = 25) {
    const list = await ranked();
    let qualified = list.filter((x) => x.row.o_votes + x.row.u_votes >= MIN_VOTES_FOR_LIST);
    if (qualified.length < 6) qualified = list.filter((x) => x.row.o_votes + x.row.u_votes >= 1);
    const overrated = qualified.filter((x) => x.s > 0).slice(0, limit).map((x) => present(x.row));
    const underrated = qualified
      .filter((x) => x.s < 0)
      .reverse()
      .slice(0, limit)
      .map((x) => present(x.row));
    return { overrated, underrated, total: list.length };
  }

  async function stats(voter) {
    const [[a], [b], [c]] = await batch([
      ['SELECT COUNT(*) AS n FROM items'],
      ['SELECT COUNT(*) AS n FROM votes WHERE voter = $1', [voter]],
      ['SELECT COUNT(*) AS n FROM duels WHERE voter = $1', [voter]],
    ]);
    return { items: Number(a.n), yourVotes: Number(b.n), yourDuels: Number(c.n) };
  }

  // ----- Admin -----

  // Newest first, with totals and who added it, optionally filtered by name.
  async function adminList({ search = '', limit = 50, offset = 0 } = {}) {
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const skip = Math.max(0, Number(offset) || 0);
    const like = `%${String(search).toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const [rows, [{ total }], blockedRows] = await batch([
      [`SELECT s.*, i.created_by, i.created_at FROM (${ITEM_STATS("LOWER(i.name) LIKE $1 ESCAPE '\\'")}) s
        JOIN items i ON i.id = s.id
        ORDER BY i.created_at DESC, i.id DESC LIMIT ${n} OFFSET ${skip}`, [like]],
      [`SELECT COUNT(*) AS total FROM items WHERE LOWER(name) LIKE $1 ESCAPE '\\'`, [like]],
      ['SELECT voter FROM blocked'],
    ]);
    const blockedSet = new Set(blockedRows.map((r) => r.voter));
    return {
      total: Number(total),
      items: rows.map((r) => ({
        ...present(norm(r)),
        createdBy: r.created_by,
        createdAt: Number(r.created_at),
        blocked: blockedSet.has(r.created_by),
        flagged: isOffensive(r.name),
      })),
    };
  }

  async function adminDelete(id) {
    const rows = await q('DELETE FROM items WHERE id = $1 RETURNING id', [Number(id)]);
    return rows.length ? { ok: true } : { error: 'No such thing.' };
  }

  async function adminRename(id, rawName) {
    const { name, error } = cleanName(rawName);
    if (error) return { error };
    const slug = slugOf(name);
    const clash = await q('SELECT id FROM items WHERE slug = $1 AND id <> $2', [slug, Number(id)]);
    if (clash.length) return { error: 'Another thing already has that name.' };
    const rows = await q('UPDATE items SET name = $1, slug = $2 WHERE id = $3 RETURNING id', [name, slug, Number(id)]);
    return rows.length ? { ok: true } : { error: 'No such thing.' };
  }

  // Block a submitter; optionally delete everything they added.
  async function adminBlock(voter, { purge = false } = {}) {
    if (!voter || voter === 'seed') return { error: 'Nothing to block.' };
    const [, removed] = await batch([
      ['INSERT INTO blocked (voter, at) VALUES ($1, $2) ON CONFLICT (voter) DO NOTHING', [voter, Date.now()]],
      purge ? ['DELETE FROM items WHERE created_by = $1 RETURNING id', [voter]] : ['SELECT 1 WHERE 1 = 0'],
    ]);
    return { ok: true, removed: removed.length };
  }

  async function adminUnblock(voter) {
    await q('DELETE FROM blocked WHERE voter = $1', [voter]);
    return { ok: true };
  }

  async function adminBlocked() {
    const rows = await q(
      `SELECT b.voter, b.at, (SELECT COUNT(*) FROM items i WHERE i.created_by = b.voter) AS items
       FROM blocked b ORDER BY b.at DESC`,
    );
    return { blocked: rows.map((r) => ({ voter: r.voter, at: Number(r.at), items: Number(r.items) })) };
  }

  return {
    init, add, vote, next, duelPair, duel, top, stats,
    adminList, adminDelete, adminRename, adminBlock, adminUnblock, adminBlocked,
  };
}

module.exports = { createStore, cleanName, slugOf, lean };
