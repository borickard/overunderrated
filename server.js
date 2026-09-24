'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = createStore(path.join(DATA_DIR, 'overunderrated.db'));

const SEED = [
  'Avocado toast', 'The Beatles', 'Pineapple on pizza', 'Sleep', 'Crocs', 'Tap water',
  'New York City', 'Marvel movies', 'Brunch', 'Walking', 'Sushi', 'Vinyl records',
  'Cold showers', 'Libraries', 'Electric scooters', 'Pumpkin spice latte', 'Public transit',
  'The Godfather', 'Bananas', 'Remote work', 'Paris', 'Board games', 'Crypto', 'Naps',
  'Tom Hanks', 'Dishwashers', 'Oat milk', 'Friends (TV show)', 'Rice cookers', 'Hot sauce',
];
if (store.stats('').items === 0) SEED.forEach((name) => store.add(name, 'seed'));

// Tiny in-memory rate limiter: `limit` hits per `windowMs` per key.
const buckets = new Map();
function limited(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  b.n += 1;
  return b.n > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function voterOf(req, res) {
  const m = /(?:^|;\s*)ou_voter=([A-Za-z0-9_-]{16,64})/.exec(req.headers.cookie || '');
  if (m) return m[1];
  const id = crypto.randomBytes(18).toString('base64url');
  res.setHeader('Set-Cookie', `ou_voter=${id}; Path=/; Max-Age=63072000; SameSite=Lax; HttpOnly`);
  return id;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function ipOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress || '').trim();
}

async function api(req, res, url) {
  const voter = voterOf(req, res);
  const ip = ipOf(req);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'POST' && limited(`w:${ip}`, 900, 3_600_000)) {
    return send(res, 429, { error: 'Slow down a little.' });
  }

  switch (route) {
    case 'GET /api/next': {
      const exclude = Number(url.searchParams.get('exclude')) || 0;
      return send(res, 200, store.next(voter, exclude));
    }
    case 'GET /api/duel':
      return send(res, 200, store.duelPair(voter));
    case 'GET /api/top':
      return send(res, 200, store.top(Math.min(50, Number(url.searchParams.get('limit')) || 25)));
    case 'GET /api/stats':
      return send(res, 200, store.stats(voter));
    case 'POST /api/items': {
      if (limited(`add:${ip}`, 20, 3_600_000)) return send(res, 429, { error: 'That is a lot of new things. Try again later.' });
      const body = await readJson(req);
      const out = store.add(body.name, voter);
      return send(res, out.error ? 400 : out.existed ? 200 : 201, out);
    }
    case 'POST /api/vote': {
      const body = await readJson(req);
      const out = store.vote(voter, Number(body.id), Number(body.dir));
      return send(res, out.error ? 400 : 200, out);
    }
    case 'POST /api/duel': {
      const body = await readJson(req);
      const out = store.duel(voter, Number(body.a), Number(body.b), Number(body.winner), body.mode);
      return send(res, out.error ? 400 : 200, out);
    }
    default:
      return send(res, 404, { error: 'Not found' });
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA routes
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, 400, { error: 'Bad request' });
  }
});

server.listen(PORT, () => console.log(`Overrated / Underrated on http://localhost:${PORT}`));

module.exports = server;
