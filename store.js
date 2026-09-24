'use strict';

const { DatabaseSync } = require('node:sqlite');

// Scoring
// -------
// Every item has two signals:
//   1. Direct votes: "overrated" / "underrated". Smoothed into a lean in (-1, 1).
//   2. Duels: "which is more overrated, A or B?". Tracked as an Elo rating on a
//      single axis where higher = more overrated. Asking "which is more
//      underrated?" just moves the same axis the other way.
// The final score is the vote lean plus a small, bounded nudge from the duel
// rating, so duels mainly reorder items whose vote leans are close.

const PRIOR = 4; // pseudo-votes pulling new items toward neutral
const ELO_START = 1500;
const ELO_K = 24;
const DUEL_WEIGHT = 0.15; // max score shift a duel rating can contribute
const MIN_VOTES_FOR_LIST = 3;

const NAME_MIN = 2;
const NAME_MAX = 60;
const NAME_RE = /^[A-Za-z0-9 '’&.,!?:()\-+#/"]+$/;

function lean(over, under) {
  return (over - under) / (over + under + PRIOR);
}

function score(item) {
  const nudge = DUEL_WEIGHT * Math.tanh((item.elo - ELO_START) / 200);
  return lean(item.over_votes, item.under_votes) + nudge;
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

function present(row) {
  if (!row) return null;
  const total = row.over_votes + row.under_votes;
  return {
    id: row.id,
    name: row.name,
    over: row.over_votes,
    under: row.under_votes,
    votes: total,
    duels: row.duels,
    overPct: total ? Math.round((row.over_votes / total) * 100) : 50,
    score: Math.round(score(row) * 1000) / 1000,
  };
}

function createStore(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS items (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL UNIQUE,
      over_votes  INTEGER NOT NULL DEFAULT 0,
      under_votes INTEGER NOT NULL DEFAULT 0,
      elo         REAL    NOT NULL DEFAULT ${ELO_START},
      duels       INTEGER NOT NULL DEFAULT 0,
      created_by  TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS votes (
      voter   TEXT    NOT NULL,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      dir     INTEGER NOT NULL, -- 1 = overrated, -1 = underrated
      at      INTEGER NOT NULL,
      PRIMARY KEY (voter, item_id)
    );
    CREATE TABLE IF NOT EXISTS duels (
      voter  TEXT    NOT NULL,
      lo_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      hi_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      at     INTEGER NOT NULL,
      PRIMARY KEY (voter, lo_id, hi_id)
    );
  `);

  const q = {
    item: db.prepare('SELECT * FROM items WHERE id = ?'),
    bySlug: db.prepare('SELECT * FROM items WHERE slug = ?'),
    insert: db.prepare('INSERT INTO items (name, slug, created_by, created_at) VALUES (?, ?, ?, ?)'),
    all: db.prepare('SELECT * FROM items'),
    count: db.prepare('SELECT COUNT(*) AS n FROM items'),
    getVote: db.prepare('SELECT dir FROM votes WHERE voter = ? AND item_id = ?'),
    putVote: db.prepare(`INSERT INTO votes (voter, item_id, dir, at) VALUES (?, ?, ?, ?)
                         ON CONFLICT (voter, item_id) DO UPDATE SET dir = excluded.dir, at = excluded.at`),
    bump: db.prepare('UPDATE items SET over_votes = over_votes + ?, under_votes = under_votes + ? WHERE id = ?'),
    unvoted: db.prepare(`SELECT * FROM items WHERE id NOT IN (SELECT item_id FROM votes WHERE voter = ?)
                         ORDER BY (over_votes + under_votes) ASC, RANDOM() LIMIT 12`),
    anyRandom: db.prepare('SELECT * FROM items ORDER BY RANDOM() LIMIT 1'),
    hasDuel: db.prepare('SELECT 1 FROM duels WHERE voter = ? AND lo_id = ? AND hi_id = ?'),
    putDuel: db.prepare('INSERT INTO duels (voter, lo_id, hi_id, at) VALUES (?, ?, ?, ?)'),
    setElo: db.prepare('UPDATE items SET elo = ?, duels = duels + 1 WHERE id = ?'),
    voterStats: db.prepare('SELECT COUNT(*) AS n FROM votes WHERE voter = ?'),
    voterDuels: db.prepare('SELECT COUNT(*) AS n FROM duels WHERE voter = ?'),
  };

  function tx(fn) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function add(rawName, voter) {
    const { name, error } = cleanName(rawName);
    if (error) return { error };
    const slug = slugOf(name);
    if (!slug) return { error: 'Use at least a couple of letters.' };
    const existing = q.bySlug.get(slug);
    if (existing) return { item: present(existing), existed: true };
    const { lastInsertRowid } = q.insert.run(name, slug, voter || null, Date.now());
    return { item: present(q.item.get(lastInsertRowid)), existed: false };
  }

  function vote(voter, itemId, dir) {
    if (dir !== 1 && dir !== -1) return { error: 'Bad vote.' };
    return tx(() => {
      const row = q.item.get(itemId);
      if (!row) return { error: 'No such thing.' };
      const prev = q.getVote.get(voter, itemId);
      if (prev && prev.dir === dir) return { item: present(row) };
      let dOver = dir === 1 ? 1 : 0;
      let dUnder = dir === -1 ? 1 : 0;
      if (prev) {
        if (prev.dir === 1) dOver -= 1;
        else dUnder -= 1;
      }
      q.putVote.run(voter, itemId, dir, Date.now());
      q.bump.run(dOver, dUnder, itemId);
      return { item: present(q.item.get(itemId)) };
    });
  }

  function next(voter, excludeId) {
    const rows = q.unvoted.all(voter).filter((r) => r.id !== excludeId);
    // Mostly the least-voted things so new additions get seen, with some variety.
    const pool = rows.slice(0, Math.max(1, Math.ceil(rows.length / 2)));
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick) return { item: present(pick), fresh: true };
    const any = q.anyRandom.get();
    return { item: present(any), fresh: false };
  }

  function ranked() {
    return q.all.all().map((r) => ({ row: r, s: score(r) })).sort((a, b) => b.s - a.s);
  }

  // Pick two things that sit close together in the ranking and ask the
  // question that fits where they sit: both leaning over -> "more overrated?",
  // both leaning under -> "more underrated?".
  function duelPair(voter) {
    const list = ranked();
    if (list.length < 2) return { error: 'Need at least two things to duel.' };
    const rated = list.filter((x) => x.row.over_votes + x.row.under_votes >= 1);
    const pool = rated.length >= 2 ? rated : list;
    for (let attempt = 0; attempt < 20; attempt++) {
      const i = Math.floor(Math.random() * pool.length);
      const span = 1 + Math.floor(Math.random() * 3);
      const j = Math.min(pool.length - 1, Math.max(0, i + (Math.random() < 0.5 ? -span : span)));
      if (i === j) continue;
      const [a, b] = Math.random() < 0.5 ? [pool[i], pool[j]] : [pool[j], pool[i]];
      const lo = Math.min(a.row.id, b.row.id);
      const hi = Math.max(a.row.id, b.row.id);
      if (attempt < 15 && q.hasDuel.get(voter, lo, hi)) continue;
      const mid = (a.s + b.s) / 2;
      const mode = mid > 0.02 ? 'over' : mid < -0.02 ? 'under' : Math.random() < 0.5 ? 'over' : 'under';
      return { mode, a: present(a.row), b: present(b.row) };
    }
    return { error: 'You have duelled everything nearby. Rate some more first!' };
  }

  function duel(voter, aId, bId, winnerId, mode) {
    if (mode !== 'over' && mode !== 'under') return { error: 'Bad duel.' };
    if (aId === bId || (winnerId !== aId && winnerId !== bId)) return { error: 'Bad duel.' };
    return tx(() => {
      const a = q.item.get(aId);
      const b = q.item.get(bId);
      if (!a || !b) return { error: 'No such thing.' };
      const lo = Math.min(aId, bId);
      const hi = Math.max(aId, bId);
      if (q.hasDuel.get(voter, lo, hi)) {
        return { a: present(a), b: present(b), repeat: true };
      }
      // On the overrated axis, the "more overrated" pick wins; for the
      // "more underrated" question the other one does.
      const pickedA = winnerId === aId;
      const aWins = mode === 'over' ? pickedA : !pickedA;
      const expA = 1 / (1 + 10 ** ((b.elo - a.elo) / 400));
      const sA = aWins ? 1 : 0;
      const delta = ELO_K * (sA - expA);
      q.setElo.run(a.elo + delta, aId);
      q.setElo.run(b.elo - delta, bId);
      q.putDuel.run(voter, lo, hi, Date.now());
      return { a: present(q.item.get(aId)), b: present(q.item.get(bId)) };
    });
  }

  function top(limit = 25) {
    const list = ranked();
    let qualified = list.filter((x) => x.row.over_votes + x.row.under_votes >= MIN_VOTES_FOR_LIST);
    if (qualified.length < 6) qualified = list.filter((x) => x.row.over_votes + x.row.under_votes >= 1);
    const overrated = qualified.filter((x) => x.s > 0).slice(0, limit).map((x) => present(x.row));
    const underrated = qualified
      .filter((x) => x.s < 0)
      .reverse()
      .slice(0, limit)
      .map((x) => present(x.row));
    return { overrated, underrated, total: q.count.get().n };
  }

  function stats(voter) {
    return {
      items: q.count.get().n,
      yourVotes: q.voterStats.get(voter).n,
      yourDuels: q.voterDuels.get(voter).n,
    };
  }

  return { add, vote, next, duelPair, duel, top, stats, db, close: () => db.close() };
}

module.exports = { createStore, cleanName, slugOf, lean };
