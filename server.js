'use strict';

/*
 * matcha/server.js — the entire backend, sadly.
 * ---------------------------------------------------------------------------
 * What this file does:
 *   1. Serves the static stuff in /public  (the site people actually see)
 *   2. Mounts /api/proxy                  (the site doing all the actual work)
 *   3. Serves 404.html for everything else (because people WILL type garbage)
 *
 * What this file does NOT do:
 *   - Rate limiting. If 300 sophomores DDoS you during third period, that is
 *     a conversation between you and your hosting provider.
 *   - HTTPS termination. We trust your reverse proxy to be an adult.
 *   - Clustering. One process, one core, one dream.
 *
 * Potential bugs we knowingly shipped:
 *   - No trust proxy setting, so any req.ip is load balancer soup.
 *   - The 404 handler catches /api/* typos too and returns HTML. Delightful
 *     for users, infuriating for anyone debugging with curl.
 */

const path = require('node:path');
const express = require('express');
const proxyHandler = require('./api/proxy');

const app = express();
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Stop announcing "I am Express 5" to everyone with curl -I. Security theater,
// but the good kind that takes 5 seconds.
app.disable('x-powered-by');

/*
 * The proxy gets mounted BEFORE static. Would it actually matter? Probably not,
 * since paths don't collide. But ordering things "correctly" makes the commit
 * look like we knew what we were doing, so here we are.
 */
app.use('/api/proxy', proxyHandler);

app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    // Cache assets for an hour. Aggressive enough to save bandwidth, weak enough
    // that when we fix a typo people see it before they retire.
    maxAge: '1h',
    setHeaders(res, filePath) {
      // HTML must never be cached, or users get yesterday's bugs.
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

/*
 * 404 for everything else. This also swallows /api/whatever typos and returns
 * HTML with a 200-ish vibe. Is that RESTful? No. Do we care? Also no.
 */
app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

const server = app.listen(PORT, () => {
  console.log(`🍵 matcha is brewing on http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // The classic "I left npm run dev running in another terminal" special.
    console.error(`Port ${PORT} is already in use. Close the other terminal, champ.`);
    process.exit(1);
  }
  throw err; // Anything else deserves to crash loudly at 2am.
});
