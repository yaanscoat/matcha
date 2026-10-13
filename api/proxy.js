'use strict';

/*
 * matcha/api/proxy.js — the file that actually makes this a "games site".
 * ---------------------------------------------------------------------------
 * The entire unblocking trick, in plain English:
 *
 *   1. The browser asks us for /api/proxy/ckv/somegame.html
 *   2. We quietly fetch https://raw.githubusercontent.com/gmshelf/ckv/main/ckv/somegame.html
 *      server-side (GitHub raw has no CORS nonsense, no X-Frame-Options drama)
 *   3. We relabel it as text/html and hand it back
 *   4. Because we keep the path structure (/api/proxy/ckv/...), the game's
 *      own relative references (./foo.js, ../covers/bar.png) keep resolving
 *      back through us. That is the whole secret sauce. Please don't spill it.
 *
 * Modes:
 *   Path mode:  /api/proxy/<path>            -> CKV_RAW_BASE + <path>
 *   Bonus mode: /api/proxy/?url=<https-url>  -> that URL, IF the host is allowlisted
 *
 * Known bugs (we call them "trade-offs" in the README):
 *   - We forward the response body unmodified. Games with root-relative paths
 *     (/assets/foo.js) will 404 because those files are not at our root.
 *     Upstream has the same problem, so at least we're faithfully broken.
 *   - The allowlist in ?url= mode is a fence, not a wall. It exists mostly so
 *     we can say "we thought about SSRF" with a straight face.
 *   - No response-size cap. A game that streams 2GB will happily stream 2GB
 *     through your tiny VPS. Enjoy the bandwidth bill.
 */

const path = require('node:path');
const { Readable } = require('node:stream');

/* Where the games actually live. gmshelf/ckv on GitHub's raw CDN. */
const CKV_RAW_BASE = 'https://raw.githubusercontent.com/gmshelf/ckv/main/';

/* GitHub occasionally decides to take a nap. Don't wait forever for it. */
const FETCH_TIMEOUT_MS = 20_000;

/*
 * Hosts allowed in ?url= mode. Adding "*" here is one character of work and
 * zero characters of security, so don't.
 */
const ALLOWED_HOSTS = new Set([
  'raw.githubusercontent.com',
  'github.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
  'images.unsplash.com',
]);

/*
 * Content types. Games ship everything from .wasm to mystery .dat files, so the
 * fallback is application/octet-stream: the browser equivalent of "figure it out".
 * NOTE: .js must be text/javascript (not application/javascript) or Safari
 * gets opinions about modules.
 */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.swf': 'application/x-shockwave-flash', // RIP, but some of you are old
};

function guessContentType(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return CONTENT_TYPES[ext] ?? 'application/octet-stream';
  } catch {
    // If we can't even parse our own URL, the game is not the problem.
    return 'application/octet-stream';
  }
}

/*
 * Express strips the mount prefix (/api/proxy) from req.url but keeps it in
 * req.originalUrl. Vercel-style hosts hand us the whole thing. Rather than
 * argue with deployment platforms, we just look for our own prefix.
 */
function pathAfterPrefix(originalUrl) {
  const idx = originalUrl.indexOf('/api/proxy');
  const withoutPrefix = idx === -1 ? originalUrl : originalUrl.slice(idx + '/api/proxy'.length);
  return withoutPrefix || '/';
}

/*
 * Takes the raw subpath from the browser and makes it safe-ish to append to
 * CKV_RAW_BASE. Rejections here are "no" and not "why", because attackers do
 * not deserve an explanation (and neither do curious students with curl).
 */
function safeSubpath(rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null; // "%zz" and other crimes against RFC 3986
  }
  // Path traversal, null bytes, backslashes (Windows hosts exist, sadly).
  if (decoded.includes('..') || decoded.includes('\0') || decoded.includes('\\')) {
    return null;
  }
  // encodeURI handles spaces (several covers have them, e.g. "bfdia 5b.png"),
  // but it does NOT escape ? or #, which would silently truncate the upstream
  // URL. Yes this is double-encoding-adjacent. Yes it works. No I won't refactor.
  return encodeURI(decoded).replace(/[?#]/g, (c) => encodeURIComponent(c));
}

function allowedExternalUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!ALLOWED_HOSTS.has(url.hostname)) return null;
  return url;
}

async function proxyHandler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return void res.status(405).type('text').send('GET only. This proxy has standards, allegedly.');
  }

  // Parse the query string ourselves; req.query is Express baggage we don't need.
  const qIdx = req.originalUrl.indexOf('?');
  const params = new URLSearchParams(qIdx === -1 ? '' : req.originalUrl.slice(qIdx + 1));

  let target;
  const external = params.get('url');
  if (external) {
    target = allowedExternalUrl(external);
    if (!target) {
      return void res
        .status(400)
        .type('text')
        .send('No. (Bad url, or host not in ALLOWED_HOSTS. Take it up with management.)');
    }
  } else {
    const subpath = safeSubpath(pathAfterPrefix(req.originalUrl));
    if (!subpath || subpath === '/' || subpath.split('?')[0] === '/') {
      return void res
        .status(400)
        .type('text')
        .send('Specify a path, e.g. /api/proxy/ckv/flappybird.html');
    }
    // + replaces string concat because we are professionals (we are not).
    target = new URL(CKV_RAW_BASE + subpath.replace(/^\//, ''));
  }

  try {
    const upstream = await fetch(target, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow', // GitHub loves redirecting; let it feel something
      headers: {
        'user-agent': 'matcha/1.0 (+https://github.com/yaanscoat/matcha)',
        accept: '*/*',
      },
    });

    if (!upstream.ok) {
      // raw.githubusercontent returns 404 for missing files AND for files that
      // exist but live in a branch we aren't fetching. Fun guessing game!
      res.status(upstream.status === 404 ? 404 : 502);
      return void res
        .type('text')
        .send(
          upstream.status === 404
            ? 'Upstream 404. Even GitHub has never heard of this one.'
            : `Upstream returned ${upstream.status}. The proxy refuses to elaborate.`
        );
    }

    res.status(upstream.status);
    // We deliberately ignore upstream's Content-Type (GitHub serves .html as
    // text/plain with nosniff, which would make every game download instead of
    // run). We guess from the extension instead. Bold? Yes. Working? Also yes.
    res.setHeader('Content-Type', guessContentType(target.href));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Cache for 24h. If a game is broken today, it'll be broken tomorrow too,
    // and at least it'll load fast.
    res.setHeader('Cache-Control', 'public, max-age=86400');

    if (req.method === 'HEAD' || !upstream.body) {
      return void res.end();
    }

    // Stream it. Buffering a Unity WebGL build in memory is a memory leak with
    // extra steps, and this server already has enough personality.
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    // Timeout, DNS failure, GitHub having one of Its Days, or Node 18 users
    // forgetting their fetch is behind a flag from 2017.
    if (!res.headersSent) {
      res.status(502).type('text').send('The proxy tripped and fell. It does that sometimes.');
    } else {
      res.destroy(); // Mid-stream failure: close the socket, say nothing, feel everything.
    }
  }
}

module.exports = proxyHandler;
