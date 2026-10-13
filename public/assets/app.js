'use strict';

/*
 * matcha/public/assets/app.js — the entire frontend, in one uncivilized IIFE.
 * ---------------------------------------------------------------------------
 * Responsibilities:
 *   1. Render ~849 game cards from window.GAMES (see games.js)
 *   2. Filter them as you type (with a debounce, because we're not savages)
 *   3. Open/close the iframe player, driven by the URL hash so Back works
 *   4. Register the service worker so the site survives the school wifi
 *
 * Known bugs (kept for morale):
 *   - Cards are rebuilt from scratch on every keystroke. Fine for 849 games;
 *     catastrophic if the list ever hits six digits. It won't. Probably.
 *   - Closing a game sets the iframe to about:blank to kill audio. If a game
 *     ever opens popups, congratulations: you now own a support queue.
 */
(() => {
  const GAMES = Array.isArray(window.GAMES) ? window.GAMES : [];
  // If this is empty, games.js failed to load or was reordered in index.html.
  // The site will render a beautiful, profound emptiness. Check the network tab.

  const els = {
    grid: document.getElementById('grid'),
    empty: document.getElementById('empty'),
    count: document.getElementById('count'),
    search: document.getElementById('search'),
    player: document.getElementById('player'),
    frame: document.getElementById('gameFrame'),
    title: document.getElementById('playerTitle'),
    back: document.getElementById('backBtn'),
    fs: document.getElementById('fsBtn'),
    random: document.getElementById('randomBtn'),
    newTab: document.getElementById('newTabBtn'),
  };

  const byName = new Map(GAMES.map((g) => [g.name, g]));

  /*
   * "10minutestilldawn" becomes "10minutestilldawn", with enthusiasm.
   * Real title-casing would need a dictionary; upstream's own wrapper pages all
   * say <title>University of Adelaide</title> (a copy-paste crime of historic
   * proportions), so the slug is genuinely the best data we have.
   */
  const pretty = (name) => name.charAt(0).toUpperCase() + name.slice(1);

  function coverFor(game) {
    const img = document.createElement('img');
    img.className = 'card-cover';
    img.loading = 'lazy'; // 849 eager images is how you weaponize a school network
    img.decoding = 'async';
    img.alt = '';
    if (game.img) img.src = game.img;

    img.addEventListener('error', () => {
      // Upstream has null covers and covers with spaces in filenames. We do our best.
      const fallback = document.createElement('div');
      fallback.className = 'card-cover card-cover--fallback';
      fallback.textContent = pretty(game.name).charAt(0) || '?';
      img.replaceWith(fallback);
    });

    return img;
  }

  function cardFor(game) {
    const card = document.createElement('a');
    card.className = 'card';
    // Hash routing: #/play/<name>. Means Back works, means links are shareable,
    // means we didn't need a router library. Notice a pattern.
    card.href = `#/play/${encodeURIComponent(game.name)}`;

    const label = document.createElement('span');
    label.className = 'card-name';
    label.textContent = pretty(game.name);

    card.append(coverFor(game), label);
    return card;
  }

  function render(games) {
    const frag = document.createDocumentFragment(); // one reflow to rule them all
    for (const game of games) frag.append(cardFor(game));
    els.grid.replaceChildren(frag);
    els.empty.hidden = games.length > 0;
    els.count.textContent = `${games.length} game${games.length === 1 ? '' : 's'}`;
  }

  /*
   * Matching strips everything non-alphanumeric from the query first, so
   * "1v1 lol" still finds "1v1lol". Users refuse to type slugs the way slug
   * authors intended. This is the compromise.
   */
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  function filter(query) {
    const q = normalize(query);
    if (!q) return GAMES;
    return GAMES.filter((g) => g.name.includes(q));
  }

  let debounceTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    // 120ms: long enough to skip most keystrokes, short enough to feel instant.
    debounceTimer = setTimeout(() => {
      render(filter(els.search.value));
      // If a game is open while you search, close it — you're clearly lost.
      if (location.hash.startsWith('#/play/')) location.hash = '';
    }, 120);
  });

  document.addEventListener('keydown', (e) => {
    // "/" focuses search, like every site that expects keyboard users.
    // Only when the player is closed — hijacking "/" mid-game is how you get bug reports.
    if (e.key === '/' && document.activeElement !== els.search && els.player.hidden) {
      e.preventDefault();
      els.search.focus();
    }
    // Escape backs out of a game. The browser's Back also works; redundancy is kindness.
    if (e.key === 'Escape' && !els.player.hidden) location.hash = '';
  });

  function openGame(name) {
    const game = byName.get(name);
    if (!game) {
      // Hand-crafted hash, typo, or someone's cat sat on the keyboard.
      location.hash = '';
      return;
    }

    els.title.textContent = pretty(game.name);
    els.newTab.href = game.url;

    // Don't reload the frame if it's already showing this exact game — otherwise
    // hash flickers restart the game, and rage is the only emotion games create.
    if (els.frame.dataset.game !== game.url) {
      els.frame.src = game.url;
      els.frame.dataset.game = game.url;
    }

    els.player.hidden = false;
    document.body.classList.add('is-playing');
    els.back.focus();
  }

  function closeGame() {
    if (els.player.hidden) return;
    els.player.hidden = true;
    document.body.classList.remove('is-playing');
    /*
     * about:blank is mandatory, not decoration: without it the game keeps
     * playing music from beyond the veil while you stare at the grid. Every
     * unblocked games site ships this bug. Not us. We are better than them.
     */
    els.frame.src = 'about:blank';
    els.frame.dataset.game = '';
  }

  function route() {
    const match = location.hash.match(/^#\/play\/(.+)$/);
    if (match) openGame(decodeURIComponent(match[1]));
    else closeGame();
  }

  window.addEventListener('hashchange', route);

  els.back.addEventListener('click', () => {
    location.hash = '';
  });

  els.fs.addEventListener('click', () => {
    // Fullscreen the player container, not the iframe: cross-origin frames
    // refuse direct fullscreen requests and throw DOMExceptions for sport.
    if (document.fullscreenElement) document.exitFullscreen();
    else els.player.requestFullscreen?.();
  });

  els.random.addEventListener('click', () => {
    const game = GAMES[Math.floor(Math.random() * GAMES.length)];
    if (game) location.hash = `#/play/${encodeURIComponent(game.name)}`;
  });

  /*
   * Service worker: only over https or localhost. Registering on http:// throws
   * a DOMException that would otherwise surface in the console like a small crime.
   */
  const swOk =
    location.protocol === 'https:' ||
    ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && swOk) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // A failed SW registration is survivable. The ego, less so.
    });
  }

  // Boot. Note the order: render first, route second, so a #/play/ deep link
  // opens over an already-populated grid instead of a sad empty one.
  els.count.textContent = `${GAMES.length} games`;
  render(GAMES);
  route();
})();
