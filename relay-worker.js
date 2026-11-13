// Flickdeck relay: passes the app's movie-database requests to TMDB
// and adds your secret token on the server, so the token never reaches the browser.
// Set the token in Cloudflare as a Secret named TMDB_TOKEN.

const ALLOWED = ['https://huti7.github.io'];
const PATHS = /^(configuration|find\/|search\/(movie|tv)|discover\/(movie|tv)|trending\/(movie|tv)\/|(movie|tv)\/\d+\/(external_ids|videos))/;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const ok = ALLOWED.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': ok ? origin : ALLOWED[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    if (!ok) return new Response('Forbidden', { status: 403, headers: cors });
    if (!env.TMDB_TOKEN) return new Response('Relay has no TMDB_TOKEN secret', { status: 500, headers: cors });

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/+/, '');
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
