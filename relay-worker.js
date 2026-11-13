// Flickdeck relay
// 1. Passes the app's movie-database requests to TMDB and adds your secret token on the
//    server, so the token never reaches the browser. Secret name: TMDB_TOKEN
// 2. Fetches IMDb scores and awards from OMDb with your secret key. Secret name: OMDB_KEY
// 3. Runs "Together" rooms, where two people swipe the same cards and see their matches.
//    Needs a Cloudflare D1 database bound to this worker with the variable name DB.

const ALLOWED = ['https://huti7.github.io'];
const PATHS = /^(configuration|find\/|search\/(movie|tv)|discover\/(movie|tv)|trending\/(movie|tv)\/|(movie|tv)\/\d+\/(external_ids|videos)$|(movie|tv)\/\d+$)/;
const GENRES = new Set(['Ac', 'Ad', 'An', 'Co', 'Cr', 'Do', 'Dr', 'Fa', 'Fn', 'Hi', 'Ho', 'Mu', 'My', 'Ro', 'Sf', 'Th', 'Wa', 'We']);
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
let ready = false;

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const ok = ALLOWED.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': ok ? origin : ALLOWED[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!ok) return new Response('Forbidden', { status: 403, headers: cors });

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/+/, '');
    if (path.startsWith('together/')) return together(req, env, ctx, cors, path, url);
    if (path === 'omdb') return omdb(req, env, cors, url);

    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    if (!env.TMDB_TOKEN) return new Response('Relay has no TMDB_TOKEN secret', { status: 500, headers: cors });
    if (!PATHS.test(path)) return new Response('Not found', { status: 404, headers: cors });

    const params = new URLSearchParams(url.search);
    params.delete('api_key');
    const target = 'https://api.themoviedb.org/3/' + path + (params.toString() ? '?' + params : '');
    const r = await fetch(target, {
      headers: { Authorization: 'Bearer ' + env.TMDB_TOKEN, Accept: 'application/json' },
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
    return new Response(r.body, {
      status: r.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
    });
  }
};

/* ---------- IMDb scores and awards (OMDb) ---------- */
async function omdb(req, env, cors, url) {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
  if (!env.OMDB_KEY) return new Response(JSON.stringify({ error: 'no-key' }), { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } });
  const q = new URLSearchParams();
  for (const k of ['i', 't', 'y', 'type']) {
    const v = url.searchParams.get(k);
    if (v) q.set(k, v.slice(0, 120));
  }
  if (!q.has('i') && !q.has('t')) return new Response('Bad request', { status: 400, headers: cors });
  q.set('apikey', env.OMDB_KEY);
  const r = await fetch('https://www.omdbapi.com/?' + q, { cf: { cacheTtl: 86400, cacheEverything: true } });
  return new Response(r.body, {
    status: r.status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' }
  });
}

/* ---------- Together rooms ---------- */
const json = (o, status, cors) => new Response(JSON.stringify(o), {
  status: status || 200,
  headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
async function readBody(req) {
  const t = await req.text();
  if (t.length > 150000) throw new Error('too big');
  return JSON.parse(t || '{}');
}
function cleanDeck(a) {
  if (!Array.isArray(a)) return [];
  const out = [], seen = new Set();
  for (const it of a.slice(0, 60)) {
    if (!it || typeof it !== 'object') continue;
    const id = str(it.id, 40), t = str(it.t, 120), p = str(it.p, 80);
    if (!/^[a-z0-9-]+$/i.test(id) || seen.has(id) || !t) continue;
    seen.add(id);
    out.push({
      id, t,
      y: Math.max(0, Math.min(2100, parseInt(it.y) || 0)),
      k: it.k === 's' ? 's' : 'm',
      g: (Array.isArray(it.g) ? it.g : []).filter(g => GENRES.has(g)).slice(0, 4),
      r: Math.max(0, Math.min(10, Number(it.r) || 0)),
      f: !!it.f, top: !!it.top,
      p: /^\/[\w.-]+$/.test(p) ? p : '',
      o: str(it.o, 400),
      x: Math.max(0, parseInt(it.x) || 0),
      tt: /^tt\d{1,10}$/.test(it.tt || '') ? it.tt : ''
    });
  }
  return out;
}
function newCode() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return [...b].map(v => CODE_CHARS[v % CODE_CHARS.length]).join('');
}
async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, deck TEXT NOT NULL, created INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS players (code TEXT NOT NULL, pid TEXT NOT NULL, name TEXT NOT NULL, joined INTEGER NOT NULL, PRIMARY KEY (code, pid))'),
    db.prepare('CREATE TABLE IF NOT EXISTS votes (code TEXT NOT NULL, pid TEXT NOT NULL, id TEXT NOT NULL, yes INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (code, pid, id))')
  ]);
  ready = true;
}
async function cleanup(db, now) {
  const old = now - 3 * 864e5;
  try {
    await db.batch([
      db.prepare('DELETE FROM votes WHERE code IN (SELECT code FROM rooms WHERE created < ?1)').bind(old),
      db.prepare('DELETE FROM players WHERE code IN (SELECT code FROM rooms WHERE created < ?1)').bind(old),
      db.prepare('DELETE FROM rooms WHERE created < ?1').bind(old)
    ]);
  } catch (e) {}
}
async function together(req, env, ctx, cors, path, url) {
  if (!env.DB) return json({ error: 'no-db' }, 503, cors);
  const db = env.DB, now = Date.now();
  try { await init(db); } catch (e) { return json({ error: 'db' }, 500, cors); }

  const m = path.match(/^together\/room(?:\/([A-Za-z0-9]{4,6}))?(?:\/(join|vote))?\/?$/);
  if (!m) return json({ error: 'not-found' }, 404, cors);
  const code = m[1] ? m[1].toUpperCase() : '', act = m[2] || '';
  let b = {};
  if (req.method === 'POST') {
    try { b = await readBody(req); } catch (e) { return json({ error: 'bad-body' }, 400, cors); }
  }

  // create a room
  if (!code) {
    if (req.method !== 'POST') return json({ error: 'method' }, 405, cors);
    const deck = cleanDeck(b.deck);
    if (deck.length < 2) return json({ error: 'deck' }, 400, cors);
    const name = str(b.name, 24) || 'Someone', pid = crypto.randomUUID();
    for (let i = 0; i < 4; i++) {
      const c = newCode();
      try {
        await db.batch([
          db.prepare('INSERT INTO rooms (code, deck, created) VALUES (?1, ?2, ?3)').bind(c, JSON.stringify(deck), now),
          db.prepare('INSERT INTO players (code, pid, name, joined) VALUES (?1, ?2, ?3, ?4)').bind(c, pid, name, now)
        ]);
        ctx.waitUntil(cleanup(db, now));
        return json({ code: c, pid }, 200, cors);
      } catch (e) { /* code taken, try another */ }
    }
    return json({ error: 'busy' }, 503, cors);
  }

  const room = await db.prepare('SELECT deck FROM rooms WHERE code = ?1').bind(code).first();
  if (!room) return json({ error: 'no-room' }, 404, cors);

  if (act === 'join') {
    if (req.method !== 'POST') return json({ error: 'method' }, 405, cors);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM players WHERE code = ?1').bind(code).first('n');
    if (n >= 6) return json({ error: 'full' }, 409, cors);
    const pid = crypto.randomUUID();
    await db.prepare('INSERT INTO players (code, pid, name, joined) VALUES (?1, ?2, ?3, ?4)').bind(code, pid, str(b.name, 24) || 'Someone', now).run();
    return json({ pid }, 200, cors);
  }

  if (act === 'vote') {
    if (req.method !== 'POST') return json({ error: 'method' }, 405, cors);
    const pid = str(b.pid, 40), id = str(b.id, 40);
    const player = await db.prepare('SELECT 1 AS ok FROM players WHERE code = ?1 AND pid = ?2').bind(code, pid).first();
    if (!player) return json({ error: 'not-player' }, 403, cors);
    if (b.yes === null || b.yes === undefined) {
      await db.prepare('DELETE FROM votes WHERE code = ?1 AND pid = ?2 AND id = ?3').bind(code, pid, id).run();
    } else {
      await db.prepare('INSERT OR REPLACE INTO votes (code, pid, id, yes, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(code, pid, id, b.yes ? 1 : 0, now).run();
    }
    return json({ ok: true }, 200, cors);
  }

  if (req.method !== 'GET') return json({ error: 'method' }, 405, cors);
  const pid = str(url.searchParams.get('pid') || '', 40);
  const [pl, mine] = await db.batch([
    db.prepare('SELECT p.pid, p.name, (SELECT COUNT(*) FROM votes v WHERE v.code = p.code AND v.pid = p.pid) AS n FROM players p WHERE p.code = ?1 ORDER BY p.joined').bind(code),
    db.prepare('SELECT id, yes FROM votes WHERE code = ?1 AND pid = ?2').bind(code, pid)
  ]);
  const players = pl.results || [];
  let matches = [];
  if (players.length >= 2) {
    const r = await db.prepare('SELECT id FROM votes WHERE code = ?1 AND yes = 1 GROUP BY id HAVING COUNT(DISTINCT pid) = ?2').bind(code, players.length).all();
    matches = (r.results || []).map(x => x.id);
  }
  const my = {};
  (mine.results || []).forEach(v => { my[v.id] = v.yes; });
  return json({
    deck: JSON.parse(room.deck),
    players: players.map(p => ({ name: p.name, n: p.n, me: p.pid === pid })),
    matches, mine: my
  }, 200, cors);
}
