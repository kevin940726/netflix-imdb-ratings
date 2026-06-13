// ==UserScript==
// @name         Netflix IMDb Ratings
// @namespace    https://github.com/netflix-imdb-ratings
// @version      5.2.0
// @description  Show IMDb ratings on Netflix titles with local caching
// @author       You
// @match        https://www.netflix.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    get apiKey() { return GM_getValue('omdb_api_key', ''); },
    set apiKey(v) { GM_setValue('omdb_api_key', v); },
    get tmdbApiKey() { return GM_getValue('tmdb_api_key', ''); },
    set tmdbApiKey(v) { GM_setValue('tmdb_api_key', v); },
    get forceRefresh() { return GM_getValue('force_refresh', false); },
    set forceRefresh(v) { GM_setValue('force_refresh', v); },
    dailyRequestLimit: 950,
    dbVersion: 3,
    dbName: 'NetflixIMDbRatings',
    storeName: 'ratings',
    cacheTTL: { recent: { maxAge: 3, ttlDays: 7 }, mid: { maxAge: 5, ttlDays: 30 }, old: { maxAge: Infinity, ttlDays: 90 } },
    colors: { high: '#2e7d32', medium: '#f9a825', low: '#e65100', veryLow: '#b71c1c', na: '#455a64' },
  };

  // ─── NETFLIX ID EXTRACTOR ─────────────────────────────────────────────────

  const NetflixIdExtractor = {
    fromUrl(url) {
      if (!url) return null;
      const m = url.match(/\/(?:title|watch)\/(\d+)/);
      return m ? m[1] : null;
    },
    fromCurrentUrl() { return this.fromUrl(window.location.href); },
    fromCard(card) {
      const link = card.querySelector('a[href*="/title/"], a[href*="/watch/"]');
      if (link) { const id = this.fromUrl(link.getAttribute('href')); if (id) return id; }
      const anyLink = card.closest('a[href*="/title/"], a[href*="/watch/"]');
      if (anyLink) { const id = this.fromUrl(anyLink.getAttribute('href')); if (id) return id; }
      const dataEl = card.closest('[data-id]') || card.closest('[data-titleid]') ||
                     card.querySelector('[data-id]') || card.querySelector('[data-titleid]');
      if (dataEl) {
        const raw = dataEl.getAttribute('data-id') || dataEl.getAttribute('data-titleid');
        if (raw) { const id = this.fromUrl(raw) || raw; if (/^\d+$/.test(id)) return id; }
      }
      for (const el of card.querySelectorAll('*')) {
        for (const attr of el.attributes) {
          if (attr.value && /\/(?:title|watch)\/\d+/.test(attr.value)) {
            const id = this.fromUrl(attr.value); if (id) return id;
          }
        }
      }
      const sliderItem = card.closest('.slider-item');
      if (sliderItem) {
        for (const attr of sliderItem.attributes) {
          if (/\/title\/\d+/.test(attr.value) || /^\d{5,}$/.test(attr.value)) {
            const id = this.fromUrl(attr.value) || attr.value; if (/^\d+$/.test(id)) return id;
          }
        }
      }
      console.warn('[Netflix IMDb] No Netflix ID found in card:', card.className, card.innerHTML?.substring(0, 200));
      return null;
    },
  };

  // ─── INDEXED DB ───────────────────────────────────────────────────────────

  const IMDbDB = {
    _db: null,
    _ready: null,

    async init() {
      this._ready = new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);
        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (db.objectStoreNames.contains(CONFIG.storeName)) db.deleteObjectStore(CONFIG.storeName);
          const store = db.createObjectStore(CONFIG.storeName, { keyPath: 'key' });
          store.createIndex('byImdbId', 'imdbId', { unique: false });
          store.createIndex('byCachedAt', 'cachedAt', { unique: false });
        };
        request.onsuccess = (e) => { this._db = e.target.result; resolve(); };
        request.onerror = (e) => { console.error('[Netflix IMDb] IndexedDB open error:', e.target.error); reject(e.target.error); };
      });
      await this._ready;
    },

    _ensureReady() { return this._ready || this.init(); },

    _ttlForYear(titleYear) {
      if (!titleYear) return CONFIG.cacheTTL.recent.ttlDays;
      const age = new Date().getFullYear() - parseInt(titleYear, 10);
      if (age < CONFIG.cacheTTL.recent.maxAge) return CONFIG.cacheTTL.recent.ttlDays;
      if (age < CONFIG.cacheTTL.mid.maxAge) return CONFIG.cacheTTL.mid.ttlDays;
      return CONFIG.cacheTTL.old.ttlDays;
    },

    async get(netflixId) {
      await this._ensureReady();
      return new Promise((resolve, reject) => {
        const tx = this._db.transaction(CONFIG.storeName, 'readonly');
        const request = tx.objectStore(CONFIG.storeName).get(netflixId);
        request.onsuccess = () => {
          const entry = request.result;
          if (!entry) return resolve(null);
          const stale = (Date.now() - entry.cachedAt) > (entry.ttlDays || 7) * 864e5;
          resolve(stale ? { ...entry, _stale: true } : entry);
        };
        request.onerror = () => reject(request.error);
      });
    },

    async set(netflixId, data) {
      await this._ensureReady();
      const year = data.year || 'unknown';
      const source = data.source || 'imdb';
      const entry = {
        key: netflixId, imdbId: data.imdbId || null, title: data.title || null, year,
        imdbRating: data.imdbRating || null, tmdbRating: data.tmdbRating || null,
        imdbVotes: data.imdbVotes || '0',         tmdbVotes: data.tmdbVotes || '0',
        source, ttlDays: source === 'tmdb' ? 7 : this._ttlForYear(year), cachedAt: Date.now(),
      };
      return new Promise((resolve, reject) => {
        const tx = this._db.transaction(CONFIG.storeName, 'readwrite');
        const request = tx.objectStore(CONFIG.storeName).put(entry);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },

    async stats() {
      await this._ensureReady();
      return new Promise((resolve, reject) => {
        const request = this._db.transaction(CONFIG.storeName, 'readonly').objectStore(CONFIG.storeName).count();
        request.onsuccess = () => resolve({ entries: request.result });
        request.onerror = () => reject(request.error);
      });
    },

    async clear() {
      await this._ensureReady();
      return new Promise((resolve, reject) => {
        const request = this._db.transaction(CONFIG.storeName, 'readwrite').objectStore(CONFIG.storeName).clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },
  };

  // ─── RATE LIMITER ─────────────────────────────────────────────────────────

  const RateLimiter = {
    _dayKey() { const d = new Date(); return `ratelimit_${d.getFullYear()}_${d.getMonth()}_${d.getDate()}`; },
    getCount() { return GM_getValue(this._dayKey(), 0); },
    increment() { const k = this._dayKey(); const c = GM_getValue(k, 0) + 1; GM_setValue(k, c); return c; },
    canMakeRequest() { return this.getCount() < CONFIG.dailyRequestLimit; },
    remaining() { return Math.max(0, CONFIG.dailyRequestLimit - this.getCount()); },
  };

  // ─── OMDb API ─────────────────────────────────────────────────────────────

  const OMDb = {
    BASE: 'https://www.omdbapi.com/',
    async fetchById(imdbId) {
      if (!CONFIG.apiKey) return null;
      if (!RateLimiter.canMakeRequest()) {
        if (window._nimdbDebug) console.warn('[Netflix IMDb] OMDb: rate limited');
        return null;
      }
      try {
        RateLimiter.increment();
        const resp = await fetch(`${this.BASE}?apikey=${CONFIG.apiKey}&i=${imdbId}`);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data.Response === 'False') return null;
        return { imdbId: data.imdbID, title: data.Title, year: data.Year, imdbRating: data.imdbRating, imdbVotes: data.imdbVotes || '0', type: data.Type };
      } catch (err) { console.error('[Netflix IMDb] OMDb error:', imdbId, err); return null; }
    },
    async search(title, year) {
      if (!CONFIG.apiKey || !RateLimiter.canMakeRequest()) return null;
      try {
        RateLimiter.increment();
        let q = title;
        if (year) q += `&y=${year}`;
        const resp = await fetch(`${this.BASE}?apikey=${CONFIG.apiKey}&s=${encodeURIComponent(title)}${year ? `&y=${year}` : ''}&type=movie,series`);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data.Response === 'False' || !data.Search?.length) return null;
        const best = data.Search.find((r) => {
          if (year && r.Year !== year) return false;
          return r.Title?.toLowerCase() === title.toLowerCase();
        }) || data.Search[0];
        return best?.imdbID || null;
      } catch (err) { console.error('[Netflix IMDb] OMDb search error:', err); return null; }
    },
  };

  // ─── IMDb SCRAPER ─────────────────────────────────────────────────────────

  const IMDbScraper = {
    _ua: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',

    async fetchRating(imdbId) {
      if (!imdbId) return null;
      const url = `https://www.imdb.com/title/${imdbId}/`;
      return new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: 'GET', url,
          headers: { 'User-Agent': this._ua, 'Accept': 'text/html' },
          timeout: 10000,
          onload: (resp) => {
            if (resp.status !== 200) { if (window._nimdbDebug) console.warn('[Netflix IMDb] Scraper HTTP', resp.status); return resolve(null); }
            const html = resp.responseText;
            // og:title meta tag
            const meta = html.match(/<meta\s+(?:content="([^"]+)"\s+property="og:title"|property="og:title"\s+content="([^"]+)")/i);
            const content = meta && (meta[1] || meta[2]);
            if (content) {
              const r = content.match(/(\d+\.\d+)/);
              if (r) { if (window._nimdbDebug) console.log('[Netflix IMDb] Scraper og:title:', content); return resolve({ imdbRating: r[1], imdbVotes: '0' }); }
            }
            // JSON-LD aggregateRating
            const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
            if (jsonLd) { try { const agg = JSON.parse(jsonLd[1]).aggregateRating; if (agg?.ratingValue) return resolve({ imdbRating: String(agg.ratingValue), imdbVotes: String(agg.ratingCount || '0') }); } catch (_) {} }
            // Raw HTML ratingValue
            const raw = html.match(/"ratingValue"\s*:\s*"?(\d+\.?\d*)/);
            if (raw) return resolve({ imdbRating: raw[1], imdbVotes: '0' });
            resolve(null);
          },
          onerror: () => { if (window._nimdbDebug) console.warn('[Netflix IMDb] Scraper error for', imdbId); resolve(null); },
          ontimeout: () => { if (window._nimdbDebug) console.warn('[Netflix IMDb] Scraper timeout for', imdbId); resolve(null); },
        });
      });
    },
  };

  // ─── TMDb API ─────────────────────────────────────────────────────────────

  const TMDb = {
    BASE: 'https://api.themoviedb.org/3',

    async search(title, year) {
      if (!CONFIG.tmdbApiKey) return null;
      try {
        const resp = await fetch(`${this.BASE}/search/multi?api_key=${CONFIG.tmdbApiKey}&query=${encodeURIComponent(title)}&include_adult=false`);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data.results?.length) return null;
        const mediaResults = data.results.filter((r) => r.media_type === 'movie' || r.media_type === 'tv');
        if (!mediaResults.length) return null;
        const best = this._pickBest(mediaResults, title, year);
        if (!best) return null;
        const imdbId = await this._getExternalIds(best.id, best.media_type);
        if (!imdbId) return null;
        const releaseYear = best.media_type === 'movie' ? (best.release_date || '').slice(0, 4) : (best.first_air_date || '').slice(0, 4);
        return { tmdbId: best.id, imdbId, title: best.title || best.name, year: releaseYear || year, mediaType: best.media_type, tmdbRating: best.vote_average, tmdbVotes: best.vote_count };
      } catch (err) { console.error('[Netflix IMDb] TMDb error:', err); return null; }
    },

    _pickBest(results, title, year) {
      const norm = title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (year) {
        const exact = results.find((r) => {
          const t = (r.title || r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          return t === norm && (r.release_date || r.first_air_date || '').slice(0, 4) === year;
        });
        if (exact) return exact;
      }
      let best = results[0], bestScore = this._similarity(norm, (best.title || best.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
      for (let i = 1; i < results.length; i++) {
        const score = this._similarity(norm, (results[i].title || results[i].name || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
        if (score > bestScore) { best = results[i]; bestScore = score; }
      }
      return best;
    },

    _similarity(a, b) {
      if (a === b) return 1;
      if (a.includes(b) || b.includes(a)) return 0.9;
      const bigrams = (s) => { const set = new Set(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; };
      const aBi = bigrams(a), bBi = bigrams(b);
      let intersection = 0; for (const bg of aBi) if (bBi.has(bg)) intersection++;
      return (2 * intersection) / (aBi.size + bBi.size);
    },

    async _getExternalIds(tmdbId, mediaType) {
      try {
        const resp = await fetch(`${this.BASE}/${mediaType}/${tmdbId}/external_ids?api_key=${CONFIG.tmdbApiKey}`);
        if (!resp.ok) return null;
        return (await resp.json()).imdb_id || null;
      } catch (_) { return null; }
    },
  };

  // ─── TITLE RESOLVER ───────────────────────────────────────────────────────

  const TitleResolver = {
    fromModal(root) {
      const titleEl = root.querySelector('[data-uia="preview-modal-title"]') ||
        root.querySelector('.previewModal--player-titleTreatmentWrapper img') ||
        root.querySelector('.previewModal--player-titleTreatment-logo') ||
        root.querySelector('.about-header')?.children?.[0];
      let title = titleEl?.getAttribute('alt')?.trim() || titleEl?.getAttribute('aria-label')?.trim() || titleEl?.textContent?.trim() || null;
      if (!title) { for (const img of root.querySelectorAll('img[alt]')) { const alt = img.getAttribute('alt')?.trim(); if (alt?.length > 1) { title = alt; break; } } }
      if (!title) return null;
      const yearEl = root.querySelector('[data-uia="preview-modal-year"]') || root.querySelector('.previewModal--detailsMetadata-left .year') || root.querySelector('.year');
      const year = yearEl?.innerText?.trim()?.match(/(\d{4})/)?.[1] || null;
      return { title, year };
    },

    fromCard(card) {
      let title = card.querySelector('a[aria-label]')?.getAttribute('aria-label')?.trim() || null;
      if (!title) title = card.querySelector('.boxart img, .boxart-container img, img[alt]')?.getAttribute('alt')?.trim() || null;
      if (!title) title = card.querySelector('.fallback-text, p.fallback-text')?.textContent?.trim() || null;
      if (!title) return null;
      const year = (card.closest('.slider-item') || card).querySelector('.meta, .metadata, .supplemental')?.innerText?.match(/(\d{4})/)?.[1] || null;
      const container = card.querySelector('.boxart-container') || card.querySelector('.title-card') || card;
      return { title, year, container };
    },
  };

  // ─── BADGE RENDERER ───────────────────────────────────────────────────────

  const BadgeRenderer = {
    _styleInjected: false,

    injectStyles() {
      if (this._styleInjected) return; this._styleInjected = true;
      GM_addStyle(`
        .nimdb-badge{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:5px;font-family:Netflix Sans,Helvetica Neue,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#fff;line-height:1;white-space:nowrap;z-index:100;box-shadow:0 2px 6px rgba(0,0,0,.8);min-width:52px;justify-content:center;cursor:pointer;text-decoration:none;text-shadow:0 1px 2px rgba(0,0,0,.6);letter-spacing:.3px}
        .nimdb-badge:hover{filter:brightness(1.2);transform:scale(1.08);transition:all .15s ease}
        .nimdb-badge--card{position:absolute;top:10px;right:10px;pointer-events:none}
        .nimdb-badge--hover{position:absolute;top:10px;right:10px}
        .nimdb-badge--modal{margin-top:10px}
        .nimdb-badge--billboard{margin-top:10px;pointer-events:none}
        .nimdb-badge__star{font-size:11px}
        .nimdb-badge__rating{font-weight:700}
        .nimdb-badge--loading{position:absolute;top:10px;right:10px;background:rgba(50,50,50,.92);animation:nimdb-pulse 1.5s ease-in-out infinite;pointer-events:none}
        .nimdb-badge--error{position:absolute;top:10px;right:10px;background:rgba(50,50,50,.7);opacity:.7;pointer-events:none}
        @keyframes nimdb-pulse{0%,100%{opacity:1}50%{opacity:.5}}
      `);
    },

    _colorForRating(rating, votes) {
      if (rating === null || rating === undefined || rating === 'N/A') return CONFIG.colors.na;
      const v = parseInt(String(votes).replace(/,/g, ''), 10) || 0;
      return v >= 10000 ? CONFIG.colors.high : v >= 1000 ? CONFIG.colors.medium : v >= 100 ? CONFIG.colors.low : CONFIG.colors.veryLow;
    },

    _confidenceLabel(votes) {
      const v = parseInt(String(votes).replace(/,/g, ''), 10) || 0;
      return v >= 10000 ? 'High' : v >= 1000 ? 'Med' : v >= 100 ? 'Low' : 'V.Low';
    },

    _bestRating(entry) {
      if (entry.imdbRating && entry.imdbRating !== 'N/A') return { rating: entry.imdbRating, votes: entry.imdbVotes, source: 'imdb' };
      if (entry.tmdbRating && entry.tmdbRating !== 'N/A' && parseFloat(entry.tmdbRating) > 0) return { rating: entry.tmdbRating, votes: entry.tmdbVotes, source: 'tmdb' };
      return { rating: null, votes: '0', source: null };
    },

    createLoading() {
      const el = document.createElement('span');
      el.className = 'nimdb-badge nimdb-badge--loading';
      el.innerHTML = '<span class="nimdb-badge__star">&#11088;</span> ...';
      return el;
    },

    createRating(entry) {
      const { rating, votes, source } = this._bestRating(entry);
      if (!rating) return this.createError();
      const el = document.createElement('a');
      el.className = 'nimdb-badge';
      el.style.background = this._colorForRating(rating, votes);
      el.target = '_blank'; el.rel = 'noopener noreferrer';
      if (entry.imdbId) { el.href = `https://www.imdb.com/title/${entry.imdbId}`; el.title = `${this._confidenceLabel(votes)} confidence · ${source === 'tmdb' ? 'TMDb rating' : 'IMDb rating'}`; }
      el.innerHTML = `<span class="nimdb-badge__star">&#11088;</span><span class="nimdb-badge__rating">${rating}</span>`;
      return el;
    },

    createError() {
      const el = document.createElement('span');
      el.className = 'nimdb-badge nimdb-badge--error';
      el.textContent = '\u2014'; el.title = 'Rating unavailable';
      return el;
    },

    initClickHandler() {
      const stop = (e) => { const b = e.target.closest('.nimdb-badge'); if (b) e.stopPropagation(); };
      document.addEventListener('click', stop, true);
      document.addEventListener('mousedown', stop, true);
    },
  };

  // ─── LOOKUP MANAGER ───────────────────────────────────────────────────────

  const LookupManager = {
    async resolve(container, position, title, year, netflixId) {
      if (!netflixId) { console.warn('[Netflix IMDb] No Netflix ID for:', title, year, position); return; }
      const existing = container.querySelector('.nimdb-badge');
      if (existing) existing.remove();

      // Cache check: Netflix ID primary
      if (!CONFIG.forceRefresh) {
        try {
          const cached = await IMDbDB.get(netflixId);
          if (cached && !cached._stale) { this._insertBadge(container, position, cached, netflixId); return; }
          if (cached?._stale) { this._insertBadge(container, position, cached, netflixId); this._backgroundRefresh(netflixId, title, year); return; }
        } catch (err) { console.error('[Netflix IMDb] DB read error:', err); }
      }

      // Show loading
      const loadingBadge = BadgeRenderer.createLoading();
      loadingBadge.classList.add(`nimdb-badge--${position}`);
      container.appendChild(loadingBadge);

      // Fetch: TMDb → OMDb search fallback → Scraper
      let entry = null;
      if (CONFIG.tmdbApiKey) {
        try {
          const tmdbResult = await TMDb.search(title, year);
          if (tmdbResult?.imdbId) {
            entry = { imdbId: tmdbResult.imdbId, title: tmdbResult.title, year: tmdbResult.year, source: null };
            const omdbResult = await OMDb.fetchById(tmdbResult.imdbId);
            if (omdbResult?.imdbRating && omdbResult.imdbRating !== 'N/A') {
              entry.imdbRating = omdbResult.imdbRating; entry.imdbVotes = omdbResult.imdbVotes; entry.source = 'imdb';
            } else {
              const scraped = await IMDbScraper.fetchRating(tmdbResult.imdbId);
              if (scraped?.imdbRating && scraped.imdbRating !== 'N/A') {
                entry.imdbRating = scraped.imdbRating; entry.imdbVotes = scraped.imdbVotes; entry.source = 'imdb';
              }
            }
            if (tmdbResult.tmdbRating > 0) {
              entry.tmdbRating = String(tmdbResult.tmdbRating); entry.tmdbVotes = String(tmdbResult.tmdbVotes);
              if (!entry.source) entry.source = 'tmdb';
            }
          }
        } catch (err) { console.error('[Netflix IMDb] Lookup error:', err); }
      } else if (CONFIG.apiKey) {
        try {
          const imdbId = await OMDb.search(title, year);
          if (imdbId) {
            entry = { imdbId, title, year, source: null };
            const omdbResult = await OMDb.fetchById(imdbId);
            if (omdbResult?.imdbRating && omdbResult.imdbRating !== 'N/A') {
              entry.imdbRating = omdbResult.imdbRating; entry.imdbVotes = omdbResult.imdbVotes; entry.source = 'imdb';
            } else {
              const scraped = await IMDbScraper.fetchRating(imdbId);
              if (scraped?.imdbRating && scraped.imdbRating !== 'N/A') {
                entry.imdbRating = scraped.imdbRating; entry.imdbVotes = scraped.imdbVotes; entry.source = 'imdb';
              }
            }
          }
        } catch (err) { console.error('[Netflix IMDb] OMDb fallback error:', err); }
      }

      loadingBadge.remove();

      const best = entry ? BadgeRenderer._bestRating(entry) : { rating: null };
      if (best.rating) {
        if (netflixId) { try { await IMDbDB.set(netflixId, entry); } catch (err) { console.error('[Netflix IMDb] DB write error:', err); } }
        this._insertBadge(container, position, entry, netflixId);
      } else {
        container.appendChild(BadgeRenderer.createError());
      }
    },

    async _backgroundRefresh(netflixId, title, year) {
      try {
        const tmdbResult = await TMDb.search(title, year);
        if (!tmdbResult?.imdbId) return;
        const entry = { imdbId: tmdbResult.imdbId, title: tmdbResult.title, year: tmdbResult.year, source: null };
        const omdbResult = await OMDb.fetchById(tmdbResult.imdbId);
        if (omdbResult?.imdbRating && omdbResult.imdbRating !== 'N/A') {
          entry.imdbRating = omdbResult.imdbRating; entry.imdbVotes = omdbResult.imdbVotes; entry.source = 'imdb';
        } else {
          const scraped = await IMDbScraper.fetchRating(tmdbResult.imdbId);
          if (scraped?.imdbRating && scraped.imdbRating !== 'N/A') {
            entry.imdbRating = scraped.imdbRating; entry.imdbVotes = scraped.imdbVotes; entry.source = 'imdb';
          }
        }
        if (tmdbResult.tmdbRating > 0) {
          entry.tmdbRating = String(tmdbResult.tmdbRating); entry.tmdbVotes = String(tmdbResult.tmdbVotes);
          if (!entry.source) entry.source = 'tmdb';
        }
        const best = BadgeRenderer._bestRating(entry);
        if (!best.rating) return;
        if (netflixId) await IMDbDB.set(netflixId, entry);
        document.querySelectorAll('.nimdb-badge').forEach((badge) => {
          if (badge.dataset.nimdbNetflixId === netflixId) {
            badge.style.background = BadgeRenderer._colorForRating(best.rating, best.votes);
            badge.querySelector('.nimdb-badge__rating').textContent = best.rating;
            badge.title = `${BadgeRenderer._confidenceLabel(best.votes)} confidence · ${entry.source === 'tmdb' ? 'TMDb rating' : 'IMDb rating'}`;
          }
        });
      } catch (_) {}
    },

    _insertBadge(container, position, entry, netflixId) {
      const badge = BadgeRenderer.createRating(entry);
      badge.classList.add(`nimdb-badge--${position}`);
      const id = netflixId || entry.key;
      if (id) badge.dataset.nimdbNetflixId = id;
      container.appendChild(badge);
    },
  };

  // ─── DOM OBSERVER ─────────────────────────────────────────────────────────

  const DOMObserver = {
    _observer: null,
    _processed: new WeakMap(),
    _intersectionObserver: null,
    _pendingCards: new Set(),

    init() {
      this._observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            this._inspect(node);
          }
        }
      });
      this._observer.observe(document.body, { childList: true, subtree: true });
      this._intersectionObserver = new IntersectionObserver(
        (entries) => { for (const entry of entries) { if (entry.isIntersecting) { this._intersectionObserver.unobserve(entry.target); this._pendingCards.delete(entry.target); this._handleCard(entry.target); } } },
        { rootMargin: '200px', threshold: 0 }
      );
      this._scanAll();
    },

    _scanAll() {
      document.querySelectorAll('.previewModal--container, [role="dialog"], .previewModal--wrapper').forEach((el) => this._handleModal(el));
      const billboard = document.querySelector('.billboard-row');
      if (billboard) this._handleBillboard(billboard);
      document.querySelectorAll('.jawBone, .bob-card, [data-uia="jawbone"], [data-uia="jawbone-title"], .previewModal--jawbone').forEach((el) => this._handleHoverPreview(el));
      document.querySelectorAll('.slider-item, .title-card').forEach((el) => this._observeCard(el));
    },

    _observeCard(el) {
      if (this._processed.has(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) this._handleCard(el);
      else { this._pendingCards.add(el); this._intersectionObserver.observe(el); }
    },

    _inspect(node) {
      if (node.matches?.('.previewModal--container, [role="dialog"], .previewModal--wrapper')) this._handleModal(node);
      if (node.matches?.('.billboard-row')) this._handleBillboard(node);
      if (node.matches?.('.jawBone, .bob-card, [data-uia="jawbone"], [data-uia="jawbone-title"], .previewModal--jawbone')) this._handleHoverPreview(node);
      if (node.matches?.('.slider-item, .title-card')) this._observeCard(node);
      node.querySelectorAll?.('.previewModal--container, [role="dialog"], .previewModal--wrapper')?.forEach((el) => this._handleModal(el));
      node.querySelectorAll?.('.billboard-row')?.forEach((el) => this._handleBillboard(el));
      node.querySelectorAll?.('.jawBone, .bob-card, [data-uia="jawbone"], [data-uia="jawbone-title"], .previewModal--jawbone')?.forEach((el) => this._handleHoverPreview(el));
      node.querySelectorAll?.('.slider-item, .title-card')?.forEach((el) => this._observeCard(el));
    },

    _handleModal(modal) {
      const info = TitleResolver.fromModal(modal);
      const titleKey = info ? `${info.title}||${info.year || ''}` : null;
      const prevKey = this._processed.get(modal);
      if (prevKey && prevKey === titleKey) return;
      if (prevKey && prevKey !== titleKey) {
        const old = modal.querySelector('.nimdb-badge--modal');
        if (old) old.remove();
      }
      this._processed.set(modal, titleKey);
      setTimeout(() => {
        const info = TitleResolver.fromModal(modal);
        if (!info) return;
        const id = NetflixIdExtractor.fromUrl(modal.querySelector('a[href*="/title/"], a[href*="/watch/"]')?.getAttribute('href')) || NetflixIdExtractor.fromCurrentUrl();
        const insertTarget = modal.querySelector('[data-uia="preview-modal-title"]')?.closest('.previewModal--info')
          || modal.querySelector('.previewModal--metadatAndControls-info')
          || modal.querySelector('.previewModal--detailsMetadata-info')
          || modal.querySelector('.previewModal--metadatAndControls');
        if (insertTarget) LookupManager.resolve(insertTarget, 'modal', info.title, info.year, id);
      }, 400);
    },

    _handleBillboard(billboard) {
      const logo = billboard.querySelector('.title-logo');
      const title = logo?.getAttribute('alt')?.trim();
      if (!title) return;
      const titleKey = title;
      const prevKey = this._processed.get(billboard);
      if (prevKey && prevKey === titleKey) return;
      this._processed.set(billboard, titleKey);
      setTimeout(() => {
        const parent = logo.parentElement;
        if (parent) parent.style.position = 'relative';
        LookupManager.resolve(parent || billboard, 'billboard', title, null, NetflixIdExtractor.fromCurrentUrl());
      }, 500);
    },

    _handleHoverPreview(preview) {
      const titleEl = preview.querySelector('[data-uia="jawbone-title"]') ||
        preview.querySelector('[data-uia="title"]') ||
        preview.querySelector('.logo img') ||
        preview.querySelector('.jawBone-title img') ||
        preview.querySelector('img[alt]');
      let title = titleEl?.getAttribute('alt')?.trim() || titleEl?.getAttribute('aria-label')?.trim() || null;
      if (!title) title = preview.querySelector('.video-title, .about-header, h3, h4')?.textContent?.trim() || null;
      const year = preview.querySelector('.year, .meta .year, [data-uia="year"]')?.innerText?.trim()?.match(/(\d{4})/)?.[1] || null;
      const titleKey = title ? `${title}||${year || ''}` : null;
      const prevKey = this._processed.get(preview);
      if (prevKey && prevKey === titleKey) return;
      if (prevKey && prevKey !== titleKey) {
        const old = preview.querySelector('.nimdb-badge--hover');
        if (old) old.remove();
      }
      this._processed.set(preview, titleKey);
      setTimeout(() => {
        const insertTarget = preview.querySelector('[data-uia="jawbone-info"]') ||
          preview.querySelector('.video-title') ||
          preview.querySelector('.meta') ||
          preview.querySelector('.about-header') ||
          preview;
        if (insertTarget) { insertTarget.style.position = 'relative'; LookupManager.resolve(insertTarget, 'hover', title, year, NetflixIdExtractor.fromCurrentUrl()); }
      }, 400);
    },

    _handleCard(card) {
      const info = TitleResolver.fromCard(card);
      if (!info) return;
      const titleKey = `${info.title}||${info.year || ''}`;
      const prevKey = this._processed.get(card);
      if (prevKey && prevKey === titleKey) return;
      this._processed.set(card, titleKey);
      const target = info.container || card;
      target.style.position = 'relative';
      LookupManager.resolve(target, 'card', info.title, info.year, NetflixIdExtractor.fromCard(card));
    },

    destroy() {
      this._observer?.disconnect(); this._observer = null;
      this._intersectionObserver?.disconnect(); this._intersectionObserver = null;
    },
  };

  // ─── ROUTE DETECTOR ───────────────────────────────────────────────────────

  const RouteDetector = {
    _lastUrl: '',
    init() {
      const origPush = history.pushState;
      history.pushState = (...args) => { origPush.apply(this, args); this._onNavigate(); };
      const origReplace = history.replaceState;
      history.replaceState = (...args) => { origReplace.apply(this, args); this._onNavigate(); };
      window.addEventListener('popstate', () => this._onNavigate());
    },
    _onNavigate() {
      const url = window.location.href;
      if (url === this._lastUrl) return;
      this._lastUrl = url;
      setTimeout(() => DOMObserver._scanAll(), 600);
    },
  };

  // ─── SETTINGS UI ──────────────────────────────────────────────────────────

  const Settings = {
    async show() {
      const currentKey = CONFIG.apiKey, currentTmdbKey = CONFIG.tmdbApiKey;
      let statsText = '(loading...)';
      try { const stats = await IMDbDB.stats(); statsText = `${stats.entries} entries`; } catch (_) {}
      const todayUsed = RateLimiter.getCount();
      const msg = [
        'Netflix IMDb Ratings — Settings',
        '', `TMDb API Key: ${currentTmdbKey ? '***' + currentTmdbKey.slice(-4) : '(not set)'}`,
        `  Get free at: https://www.themoviedb.org/settings/api`, '',
        `OMDb API Key: ${currentKey ? '***' + currentKey.slice(-4) : '(not set)'}`,
        `  Get free at: https://www.omdbapi.com/apikey.aspx`, '',
        `OMDb calls: ${todayUsed} / ${CONFIG.dailyRequestLimit} (${RateLimiter.remaining()} remaining)`,
        `Local DB: ${statsText}`, '',
        'Badge colors = confidence (vote count):',
        '  Green=10K+  Yellow=1K-10K  Orange=100-999  Red=<100', '',
        'Enter TMDb API key (or leave empty):',
      ].join('\n');
      const newTmdbKey = prompt(msg, currentTmdbKey);
      if (newTmdbKey !== null && newTmdbKey !== currentTmdbKey) CONFIG.tmdbApiKey = newTmdbKey;
      const newKey = prompt('Enter OMDb API key (or leave empty):', currentKey);
      if (newKey !== null && newKey !== currentKey) CONFIG.apiKey = newKey;
      alert(`TMDb: ${CONFIG.tmdbApiKey ? '***' + CONFIG.tmdbApiKey.slice(-4) : '(not set)'}\nOMDb: ${CONFIG.apiKey ? '***' + CONFIG.apiKey.slice(-4) : '(not set)'}`);
    },
  };

  // ─── INIT ─────────────────────────────────────────────────────────────────

  async function init() {
    try { await IMDbDB.init(); } catch (err) { console.error('[Netflix IMDb] IndexedDB init failed:', err); }

    if (!CONFIG.apiKey) {
      const key = prompt('Netflix IMDb Ratings\n\nOMDb API Key (required)\nGet free at: https://www.omdbapi.com/apikey.aspx\n\n1000 req/day on free tier.\n\nOMDb API Key:');
      if (key) CONFIG.apiKey = key;
      else { alert('OMDb key required. Set later via Tampermonkey menu.'); return; }
    }
    if (!CONFIG.tmdbApiKey) {
      const key = prompt('TMDb API Key (recommended, unlimited search)\nGet free at: https://www.themoviedb.org/settings/api\n\nTMDb API Key (or leave empty):');
      if (key) CONFIG.tmdbApiKey = key;
    }

    BadgeRenderer.injectStyles();
    BadgeRenderer.initClickHandler();
    RouteDetector.init();
    DOMObserver.init();

    GM_registerMenuCommand('Settings', Settings.show);
    GM_registerMenuCommand('Toggle Force Refresh', () => { CONFIG.forceRefresh = !CONFIG.forceRefresh; alert(`Force Refresh: ${CONFIG.forceRefresh ? 'ON' : 'OFF'}`); });
    GM_registerMenuCommand('Toggle Debug Mode', () => { window._nimdbDebug = !window._nimdbDebug; alert(`Debug: ${window._nimdbDebug ? 'ON' : 'OFF'}\nCheck F12 console.`); });
    GM_registerMenuCommand('Clear Local DB', async () => { if (confirm('Clear all cached ratings?')) { await IMDbDB.clear(); alert('Cleared.'); } });
    GM_registerMenuCommand('Show Stats', async () => {
      let t = '(error)'; try { t = `${(await IMDbDB.stats()).entries} entries`; } catch (_) {}
      alert(`${t}\nTMDb: ${CONFIG.tmdbApiKey ? '***' + CONFIG.tmdbApiKey.slice(-4) : 'none'}\nForceRefresh: ${CONFIG.forceRefresh}\nOMDb: ${RateLimiter.getCount()}/${CONFIG.dailyRequestLimit}`);
    });

    console.log(`[Netflix IMDb] v5.2.0 | TMDb: ${CONFIG.tmdbApiKey ? '***' + CONFIG.tmdbApiKey.slice(-4) : 'none'} | OMDb: ***${CONFIG.apiKey.slice(-4)}`);
  }

  document.readyState === 'complete' ? init() : window.addEventListener('load', init);
})();
