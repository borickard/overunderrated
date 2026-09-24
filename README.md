# Overrated / Underrated

A crowd game: anyone adds a thing, everyone else votes whether it's **overrated** or **underrated**, and the results become two toplists.

- **Rate** — one thing at a time, huge. Hit *Overrated* (← / `o`) or *Underrated* (→ / `u`), see how the crowd split, move on. `space` skips.
- **Duel** — two things that sit close together in the ranking go head to head: *"Which is more overrated?"* (or underrated, depending on which side of the scale they're on). This fine-tunes the order when the votes are close.
- **Top** — most overrated and most underrated, ranked.
- **Add** — anything in English, up to 60 characters. Near-duplicates (`The Beatles` / `beatles!`) are merged.

## Run it

Requires Node.js 22.5+ (uses the built-in `node:sqlite`, no npm dependencies).

```sh
npm start            # http://localhost:3000
PORT=8080 DATA_DIR=/var/lib/overunderrated npm start
npm test
```

Data lives in `data/overunderrated.db` (SQLite) unless `DATA_DIR` is set. An empty database is seeded with 30 starter things.

## How scoring works

Each thing has two signals:

1. **Votes.** `lean = (over − under) / (over + under + 4)`. The `+4` pulls things with few votes toward neutral so one vote can't top the chart.
2. **Duels.** An Elo rating on one axis, higher = more overrated. Picking A in "which is more overrated?" moves A up; picking A in "which is more underrated?" moves A down.

`score = lean + 0.15 · tanh((elo − 1500) / 200)` — duels can shift a score by at most ±0.15, so they reorder close neighbours without overriding a clear vote majority. Things need 3 votes to appear on the toplists (relaxed while the site is new).

Each browser gets an anonymous cookie; one vote per thing per browser (you can change it), one duel per pair per browser. Writes are rate-limited per IP.

## Layout

```
server.js        HTTP server, JSON API, static files, rate limiting
store.js         SQLite schema, validation, scoring, matchmaking
public/          Single-page frontend (vanilla JS/CSS), self-hosted Bricolage Grotesque (OFL)
test/            node:test unit tests for the store
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
