'use strict';

// A tiny async SQL adapter so the same queries run on Postgres (production,
// via Neon's serverless driver) and SQLite (local dev and tests).
// Queries use Postgres-style $1, $2 placeholders; SQLite gets ?1, ?2.

const PG_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (
     id         SERIAL PRIMARY KEY,
     name       TEXT   NOT NULL,
     slug       TEXT   NOT NULL UNIQUE,
     created_by TEXT,
     created_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS votes (
     voter   TEXT     NOT NULL,
     item_id INTEGER  NOT NULL REFERENCES items(id) ON DELETE CASCADE,
     dir     SMALLINT NOT NULL,
     at      BIGINT   NOT NULL,
     PRIMARY KEY (voter, item_id)
   )`,
  `CREATE TABLE IF NOT EXISTS duels (
     voter       TEXT    NOT NULL,
     lo_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
     hi_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
     winner_over INTEGER NOT NULL,
     at          BIGINT  NOT NULL,
     PRIMARY KEY (voter, lo_id, hi_id)
   )`,
  `CREATE TABLE IF NOT EXISTS blocked (
     voter TEXT   PRIMARY KEY,
     at    BIGINT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS votes_item ON votes (item_id)',
  'CREATE INDEX IF NOT EXISTS items_created_by ON items (created_by)',
  'CREATE INDEX IF NOT EXISTS duels_lo ON duels (lo_id)',
  'CREATE INDEX IF NOT EXISTS duels_hi ON duels (hi_id)',
  'CREATE INDEX IF NOT EXISTS duels_winner ON duels (winner_over)',
];

const SQLITE_SCHEMA = PG_SCHEMA.map((s) =>
  s.replace('id         SERIAL PRIMARY KEY', 'id         INTEGER PRIMARY KEY'),
);

function postgres(url) {
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url);
  return {
    kind: 'postgres',
    query: (text, params = []) => sql.query(text, params),
    // Several statements in one HTTP round trip (and one transaction).
    batch: (list) => sql.transaction(list.map(([text, params = []]) => sql.query(text, params))),
    schema: PG_SCHEMA,
  };
}

function sqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const cache = new Map();
  return {
    kind: 'sqlite',
    async query(text, params = []) {
      let stmt = cache.get(text);
      if (!stmt) {
        stmt = db.prepare(text.replace(/\$(\d+)/g, '?$1'));
        cache.set(text, stmt);
      }
      return stmt.all(...params);
    },
    async batch(list) {
      const out = [];
      for (const [text, params] of list) out.push(await this.query(text, params));
      return out;
    },
    schema: SQLITE_SCHEMA,
    close: () => db.close(),
  };
}

module.exports = { postgres, sqlite, PG_SCHEMA };
