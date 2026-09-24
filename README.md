# Overrated / Underrated

A crowd game: anyone adds a thing, everyone else votes whether it's **overrated** or **underrated**, and the results become two toplists.

- **Rate** — one thing at a time, huge. Hit *Overrated* (← / `o`) or *Underrated* (→ / `u`), the next thing drops in instantly and the crowd split for the one you just rated shows underneath. `space` skips.
- **Duel** — pick the question, *"Which is more overrated?"* or *"Which is more underrated?"* (`o` / `u`), then choose between two things that sit close together on that side of the ranking. This fine-tunes the order when the votes are close.
- **Top** — most overrated and most underrated, ranked.
- **Add** — anything in English, up to 60 characters. Near-duplicates (`The Beatles` / `beatles!`) are merged.

## Deploy on Vercel

The site is static files in `public/` plus serverless functions in `api/`. Votes are stored in Postgres, because Vercel functions have no persistent disk.

1. In the Vercel project, open **Storage → Create Database → Neon (Postgres)** and connect it to the project. This sets `DATABASE_URL` for every environment.
2. Redeploy. Tables are created and 30 starter things are seeded on the first request.

Without a database the API answers `503` with a message saying so, and the page shows it.

## Run locally

Requires Node.js 22.5+. Locally it uses SQLite (the built-in `node:sqlite`) in `data/`, so no database setup is needed. Set `DATABASE_URL` to use Postgres instead.

```sh
npm install
npm run dev          # http://localhost:3000
npm test             # runs every store test against SQLite and Postgres (PGlite)
```

## How scoring works

Each thing has two signals:

1. **Votes.** `lean = (over − under) / (over + under + 4)`. The `+4` pulls things with few votes toward neutral so one vote can't top the chart.
2. **Duels.** Each duel is a win on the overrated axis for whichever thing was judged more overrated (in "which is more underrated?", the one *not* picked). `duelLean = (wins − losses) / (duels + 4)`.

`score = lean + 0.15 · duelLean` — duels can shift a score by at most ±0.15, so they reorder close neighbours without overriding a clear vote majority. Things need 3 votes to appear on the toplists (relaxed while the site is new).

Each browser gets an anonymous cookie; one vote per thing per browser (you can change it), one duel per pair per browser. Writes are rate-limited per IP.

## Layout

```
api/             Vercel serverless entry points (one per route, all share lib/api.js)
lib/api.js       Request handling, anonymous voter cookie, rate limiting
lib/store.js     Validation, scoring, matchmaking, SQL
lib/db.js        Postgres (Neon serverless driver) / SQLite adapter and schema
local-server.js  Local dev server: static files + the same API handler
public/          Single-page frontend (vanilla JS/CSS), self-hosted Bricolage Grotesque (OFL)
test/            node:test tests for the store, run on both databases
```

### API

| Method | Path          | Body                              |
| ------ | ------------- | --------------------------------- |
| GET    | `/api/next`   | `?exclude=id` — next thing to rate |
| POST   | `/api/vote`   | `{ id, dir: 1 \| -1 }`            |
| GET    | `/api/duel`   | — a close pair and a mode         |
| POST   | `/api/duel`   | `{ a, b, winner, mode: "over" \| "under" }` |
| GET    | `/api/top`    | `?limit=25`                       |
| POST   | `/api/items`  | `{ name }`                        |
| GET    | `/api/stats`  | —                                 |
