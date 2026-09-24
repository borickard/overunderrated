'use strict';

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

function createStore(db) {
  let ready = null;

  function init() {
    ready ??= (async () => {
      for (const stmt of db.schema) await db.query(stmt);
      const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM items');
      if (Number(n) === 0) {
        for (const name of SEED) {
          await db.query(
            'INSERT INTO items (name, slug, created_by, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING',
            [name, slugOf(name), 'seed', Date.now()],
          );
        }
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

  async function itemById(id) {
    if (!Number.isInteger(id) || id <= 0) return null;
    const [row] = await q(`SELECT * FROM (${STATS}) s WHERE id = $1`, [id]);
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
    const inserted = await q(
      'INSERT INTO items (name, slug, created_by, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING RETURNING id',
      [name, slug, voter || null, Date.now()],
    );
    const [{ id }] = inserted.length ? inserted : await q('SELECT id FROM items WHERE slug = $1', [slug]);
    return { item: present(await itemById(Number(id))), existed: inserted.length === 0 };
  }

  async function vote(voter, itemId, dir) {
    if (dir !== 1 && dir !== -1) return { error: 'Bad vote.' };
    if (!(await itemById(itemId))) return { error: 'No such thing.' };
    await q(
      `INSERT INTO votes (voter, item_id, dir, at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (voter, item_id) DO UPDATE SET dir = excluded.dir, at = excluded.at`,
      [voter, itemId, dir, Date.now()],
    );
    return { item: present(await itemById(itemId)) };
  }

  async function next(voter, exclude = []) {
    const skip = new Set(exclude);
    const rows = (await q(
      `SELECT * FROM (${STATS}) s
       WHERE id NOT IN (SELECT item_id FROM votes WHERE voter = $1)
       ORDER BY (o_votes + u_votes) ASC, RANDOM() LIMIT 12`,
      [voter],
    )).map(norm).filter((r) => !skip.has(r.id));
    // Mostly the least-voted things so new additions get seen, with some variety.
    const pool = rows.slice(0, Math.max(1, Math.ceil(rows.length / 2)));
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick) return { item: present(pick), fresh: true };
    const [any] = await q(`SELECT * FROM (${STATS}) s ORDER BY RANDOM() LIMIT 1`);
    return { item: any ? present(norm(any)) : null, fresh: false };
  }

  // Pick two things that sit close together in the ranking, from the side the
  // question is about: "more overrated?" draws from things leaning overrated,
  // "more underrated?" from things leaning underrated.
  async function duelPair(voter, mode = 'over') {
    if (mode !== 'over' && mode !== 'under') return { error: 'Bad duel.' };
    const list = await ranked();
    if (list.length < 2) return { error: 'Need at least two things to duel.' };
    const done = new Set(
      (await q('SELECT lo_id, hi_id FROM duels WHERE voter = $1', [voter])).map((r) => `${r.lo_id}:${r.hi_id}`),
    );
    const rated = list.filter((x) => x.row.o_votes + x.row.u_votes >= 1);
    const side = rated.filter((x) => (mode === 'over' ? x.s > 0 : x.s < 0));
    const pool = side.length >= 2 ? side : rated.length >= 2 ? rated : list;
    for (let attempt = 0; attempt < 20; attempt++) {
      const i = Math.floor(Math.random() * pool.length);
      const span = 1 + Math.floor(Math.random() * 3);
      const j = Math.min(pool.length - 1, Math.max(0, i + (Math.random() < 0.5 ? -span : span)));
      if (i === j) continue;
      const [a, b] = Math.random() < 0.5 ? [pool[i], pool[j]] : [pool[j], pool[i]];
      const lo = Math.min(a.row.id, b.row.id);
      const hi = Math.max(a.row.id, b.row.id);
      if (attempt < 15 && done.has(`${lo}:${hi}`)) continue;
      return { mode, a: present(a.row), b: present(b.row) };
    }
    return { error: 'You have duelled everything nearby. Rate some more first!' };
  }

  async function duel(voter, aId, bId, winnerId, mode) {
    if (mode !== 'over' && mode !== 'under') return { error: 'Bad duel.' };
    if (aId === bId || (winnerId !== aId && winnerId !== bId)) return { error: 'Bad duel.' };
    if (!(await itemById(aId)) || !(await itemById(bId))) return { error: 'No such thing.' };
    // For "more underrated?" the other one is the more overrated of the two.
    const winnerOver = mode === 'over' ? winnerId : winnerId === aId ? bId : aId;
    const inserted = await q(
      `INSERT INTO duels (voter, lo_id, hi_id, winner_over, at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (voter, lo_id, hi_id) DO NOTHING RETURNING voter`,
      [voter, Math.min(aId, bId), Math.max(aId, bId), winnerOver, Date.now()],
    );
    const out = { a: present(await itemById(aId)), b: present(await itemById(bId)) };
    if (!inserted.length) out.repeat = true;
    return out;
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
    const [a] = await q('SELECT COUNT(*) AS n FROM items');
    const [b] = await q('SELECT COUNT(*) AS n FROM votes WHERE voter = $1', [voter]);
    const [c] = await q('SELECT COUNT(*) AS n FROM duels WHERE voter = $1', [voter]);
    return { items: Number(a.n), yourVotes: Number(b.n), yourDuels: Number(c.n) };
  }

  return { init, add, vote, next, duelPair, duel, top, stats };
}

module.exports = { createStore, cleanName, slugOf, lean };
