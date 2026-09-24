'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('./store');
const db = require('./db');

// Postgres when a connection string is configured (Vercel + Neon sets
// DATABASE_URL), otherwise a local SQLite file for development.
function defaultStore() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) return createStore(db.postgres(url));
  if (process.env.VERCEL) return null; // no writable, persistent disk there
  const fs = require('node:fs');
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  return createStore(db.sqlite(path.join(dir, 'overunderrated.db')));
}

// Best-effort in-memory rate limiter: `limit` hits per `windowMs` per key.
// On serverless this is per instance, which still blunts simple floods.
const buckets = new Map();
function limited(key, limit, windowMs) {
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  b.n += 1;
  return b.n > limit;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function voterOf(req, res) {
  const m = /(?:^|;\s*)ou_voter=([A-Za-z0-9_-]{16,64})/.exec(req.headers.cookie || '');
  if (m) return m[1];
  const id = crypto.randomBytes(18).toString('base64url');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ou_voter=${id}; Path=/; Max-Age=63072000; SameSite=Lax; HttpOnly${secure}`);
  return id;
}

async function readJson(req) {
  // Vercel's Node runtime may have parsed the body already.
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString()) : {};
    return req.body || {};
  }
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 4096) throw new Error('too large');
  }
  return data ? JSON.parse(data) : {};
}

function ipOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket?.remoteAddress || '').trim();
}

function createHandler(store = defaultStore()) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!store) {
        return send(res, 503, { error: 'The database is not set up yet. Add a Postgres database (DATABASE_URL) to this deployment.' });
      }
      const voter = voterOf(req, res);
      const ip = ipOf(req);
      const route = `${req.method} ${url.pathname.replace(/\/+$/, '')}`;

      if (req.method === 'POST' && limited(`w:${ip}`, 900, 3_600_000)) {
        return send(res, 429, { error: 'Slow down a little.' });
      }

      switch (route) {
        case 'GET /api/next': {
          const exclude = Number(url.searchParams.get('exclude')) || 0;
          return send(res, 200, await store.next(voter, exclude));
        }
        case 'GET /api/duel':
          return send(res, 200, await store.duelPair(voter));
        case 'GET /api/top':
          return send(res, 200, await store.top(Math.min(50, Number(url.searchParams.get('limit')) || 25)));
        case 'GET /api/stats':
          return send(res, 200, await store.stats(voter));
        case 'POST /api/items': {
          if (limited(`add:${ip}`, 20, 3_600_000)) return send(res, 429, { error: 'That is a lot of new things. Try again later.' });
          const body = await readJson(req);
          const out = await store.add(body.name, voter);
          return send(res, out.error ? 400 : out.existed ? 200 : 201, out);
        }
        case 'POST /api/vote': {
          const body = await readJson(req);
          const out = await store.vote(voter, Number(body.id), Number(body.dir));
          return send(res, out.error ? 400 : 200, out);
        }
        case 'POST /api/duel': {
          const body = await readJson(req);
          const out = await store.duel(voter, Number(body.a), Number(body.b), Number(body.winner), body.mode);
          return send(res, out.error ? 400 : 200, out);
        }
        default:
          return send(res, 404, { error: 'Not found' });
      }
    } catch (e) {
      if (e instanceof SyntaxError || e.message === 'too large') return send(res, 400, { error: 'Bad request' });
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong on our side.' });
    }
  };
}

module.exports = { createHandler };
