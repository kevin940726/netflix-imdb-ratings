// ==UserScript==
// @name         Netflix IMDb Ratings
// @namespace    https://github.com/netflix-imdb-ratings
// @version      4.1.0
// @description  Show IMDb ratings on Netflix titles with local caching
// @author       You
// @match        https://www.netflix.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // =============================================================================
  // CONFIG
  // =============================================================================

  const CONFIG = {
    get apiKey() { return GM_getValue('omdb_api_key', ''); },
    set apiKey(v) { GM_setValue('omdb_api_key', v); },

    get tmdbApiKey() { return GM_getValue('tmdb_api_key', ''); },
    set tmdbApiKey(v) { GM_setValue('tmdb_api_key', v); },

    get forceRefresh() { return GM_getValue('force_refresh', false); },
    set forceRefresh(v) { GM_setValue('force_refresh', v); },

    dailyRequestLimit: 950,
    dbVersion: 2,
    dbName: 'NetflixIMDbRatings',
    storeName: 'ratings',

    // Tiered cache TTL based on title age (years from release)
    cacheTTL: {
      recent: { maxAge: 3, ttlDays: 7 },       // within 3 years → 7 days
      mid:    { maxAge: 5, ttlDays: 30 },      // 3-5 years → 30 days
      old:    { maxAge: Infinity, ttlDays: 90 } // 5+ years → 90 days
    },

    colors: {
      high: '#2e7d32',     // >= 10K votes — high confidence
      medium: '#f9a825',   // 1K-10K votes — medium confidence
      low: '#e65100',      // 100-999 votes — low confidence
      veryLow: '#b71c1c',  // <100 votes — very low confidence
      na: '#455a64',       // no rating available
    },
  };

  // =============================================================================
  // INDEXED DB MODULE — Primary persistent storage
  // =============================================================================

  const IMDbDB = {
    _db: null,
    _ready: null,

    async init() {
      this._ready = new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);

        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          // Delete old store if exists (schema change v1→v2)
          if (db.objectStoreNames.contains(CONFIG.storeName)) {
            db.deleteObjectStore(CONFIG.storeName);
          }
          const store = db.createObjectStore(CONFIG.storeName, { keyPath: 'key' });
          store.createIndex('byTitle', 'normalizedTitle', { unique: false });
          store.createIndex('byCachedAt', 'cachedAt', { unique: false });
        };

        request.onsuccess = (e) => {
          this._db = e.target.result;
          resolve();
        };

        request.onerror = (e) => {
          console.error('[Netflix IMDb] IndexedDB open error:', e.target.error);
          reject(e.target.error);
        };
      });

      await this._ready;
    },

    _ensureReady() {
      if (!this._ready) return this.init();
      return this._ready;
    },

    /**
     * Calculate tiered TTL in days based on title year.
     */
    _ttlForYear(titleYear) {
      if (!titleYear) return CONFIG.cacheTTL.recent.ttlDays;
      const currentYear = new Date().getFullYear();
      const age = currentYear - parseInt(titleYear, 10);
      if (age < CONFIG.cacheTTL.recent.maxAge) return CONFIG.cacheTTL.recent.ttlDays;
      if (age < CONFIG.cacheTTL.mid.maxAge) return CONFIG.cacheTTL.mid.ttlDays;
      return CONFIG.cacheTTL.old.ttlDays;
    },

    /**
     * Build a storage key from normalized title + year.
     */
    _key(normalizedTitle, year) {
      return `${normalizedTitle}||${year || 'unknown'}`;
    },

    /**
     * Query the DB for a title. Returns { tconst, rating, votes, ... } or null.
     * Returns null if entry is stale (past TTL).
     */
    async get(normalizedTitle, year) {
      await this._ensureReady();

      return new Promise((resolve, reject) => {
        const tx = this._db.transaction(CONFIG.storeName, 'readonly');
        const store = tx.objectStore(CONFIG.storeName);
        const request = store.get(this._key(normalizedTitle, year));

        request.onsuccess = () => {
          const entry = request.result;
          if (!entry) return resolve(null);

          const ttlMs = (entry.ttlDays || 7) * 24 * 60 * 60 * 1000;
          const ageMs = Date.now() - entry.cachedAt;

          if (ageMs > ttlMs) {
            // Stale — return data but mark as stale for background refresh
            return resolve({ ...entry.data, _stale: true });
          }

          resolve(entry.data);
        };

        request.onerror = () => reject(request.error);
      });
    },

    /**
     * Store a rating entry in the DB.
     */
    async set(normalizedTitle, year, data) {
      await this._ensureReady();

      const ttlDays = this._ttlForYear(year || data.year);
      const entry = {
        key: this._key(normalizedTitle, year),
        normalizedTitle,
        year: year || data.year || 'unknown',
        ttlDays,
        cachedAt: Date.now(),
        data: {
          tconst: data.imdbID,
          title: data.title || data.Title,
          year: data.year || data.Year,
          rating: data.rating || data.imdbRating,
          votes: data.votes || data.imdbVotes || '0',
          type: data.type || data.Type,
        },
      };

      return new Promise((resolve, reject) => {
        const tx = this._db.transaction(CONFIG.storeName, 'readwrite');
        const store = tx.objectStore(CONFIG.storeName);
        const request = store.put(entry);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },

    /**
     * Get DB stats.
     */
    async stats() {
      await this._ensureReady();

      return new Promise((resolve, reject) => {
        const tx = this._db.transaction(CONFIG.storeName, 'readonly');
        const store = tx.objectStore(CONFIG.storeName);
        const countReq = store.count();

        countReq.onsuccess = () => {
          resolve({ entries: countReq.result });
        };
        countReq.onerror = () => reject(countReq.error);
      });
    },

    /**
     * Clear all entries.
     */
    async clear() {
      await this._ensureReady();

      return new Promise((resolve, reject) => {
        const tx = this._db.transaction(CONFIG.storeName, 'readwrite');
        const store = tx.objectStore(CONFIG.storeName);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },
  };

  // =============================================================================
  // RATE LIMITER
  // =============================================================================

  const RateLimiter = {
    _dayKey() {
      const d = new Date();
      return `ratelimit_${d.getFullYear()}_${d.getMonth()}_${d.getDate()}`;
    },

    getCount() {
      return GM_getValue(this._dayKey(), 0);
    },

    increment() {
      const key = this._dayKey();
      const count = GM_getValue(key, 0) + 1;
      GM_setValue(key, count);
      return count;
    },

    canMakeRequest() {
      return this.getCount() < CONFIG.dailyRequestLimit;
    },

    remaining() {
      return Math.max(0, CONFIG.dailyRequestLimit - this.getCount());
    },
  };

  // =============================================================================
  // OMDb API MODULE — Rating lookup by IMDb ID
  // =============================================================================

  const OMDb = {
    BASE: 'https://www.omdbapi.com/',

    /**
     * Fetch by IMDb ID directly (e.g. tt1234567).
     * 1 request per title — no search needed.
     */
    async fetchById(imdbId) {
      if (!CONFIG.apiKey) return null;
      if (!RateLimiter.canMakeRequest()) return null;

      const params = new URLSearchParams({
        apikey: CONFIG.apiKey,
        i: imdbId,
      });

      try {
        RateLimiter.increment();
        const resp = await fetch(`${this.BASE}?${params}`);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data.Response === 'False') return null;
        return {
          imdbID: data.imdbID,
          title: data.Title,
          year: data.Year,
          rating: data.imdbRating,
          votes: data.imdbVotes || '0',
          type: data.Type,
        };
      } catch (err) {
        console.error('[Netflix IMDb] OMDb fetchById error:', err);
        return null;
      }
    },
  };

  // =============================================================================
  // TMDb API MODULE — Primary search via /search/multi (unlimited rate limit)
  // =============================================================================

  const TMDb = {
    BASE: 'https://api.themoviedb.org/3',

    /**
     * Search TMDb by title using /search/multi (single request for movies + TV).
     * Returns { tmdbId, imdbId, title, year, mediaType } or null.
     */
    async search(title, year) {
      if (!CONFIG.tmdbApiKey) {
        if (window._nimdbDebug) console.log('[Netflix IMDb] No TMDb API key');
        return null;
      }

      const params = new URLSearchParams({
        api_key: CONFIG.tmdbApiKey,
        query: title,
        include_adult: 'false',
      });

      try {
        const resp = await fetch(`${this.BASE}/search/multi?${params}`);
        if (!resp.ok) {
          if (window._nimdbDebug) console.warn('[Netflix IMDb] TMDb multi search HTTP', resp.status);
          return null;
        }
        const data = await resp.json();
        if (!data.results || data.results.length === 0) return null;

        // Filter to movie and tv only (skip person, network, keyword)
        const mediaResults = data.results.filter((r) => r.media_type === 'movie' || r.media_type === 'tv');
        if (mediaResults.length === 0) return null;

        // Pick best match
        const best = this._pickBest(mediaResults, title, year);
        if (!best) return null;

        const mediaType = best.media_type;

        // Get external IDs to find IMDb ID
        const imdbId = await this._getExternalIds(best.id, mediaType);
        if (!imdbId) return null;

        const releaseYear = mediaType === 'movie'
          ? (best.release_date || '').slice(0, 4)
          : (best.first_air_date || '').slice(0, 4);

        return {
          tmdbId: best.id,
          imdbId,
          title: best.title || best.name,
          year: releaseYear || year,
          mediaType,
          tmdbRating: best.vote_average,
          tmdbVotes: best.vote_count,
        };
      } catch (err) {
        console.error('[Netflix IMDb] TMDb multi search error:', err);
        return null;
      }
    },

    _pickBest(results, title, year) {
      const normalized = title.toLowerCase().replace(/[^a-z0-9]/g, '');

      // Exact title match + year
      if (year) {
        const exact = results.find((r) => {
          const t = (r.title || r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const y = (r.release_date || r.first_air_date || '').slice(0, 4);
          return t === normalized && y === year;
        });
        if (exact) return exact;
      }

      // Closest title match
      let best = results[0];
      let bestScore = this._similarity(normalized, (best.title || best.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''));

      for (let i = 1; i < results.length; i++) {
        const r = results[i];
        const rTitle = (r.title || r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const score = this._similarity(normalized, rTitle);
        if (score > bestScore) {
          best = r;
          bestScore = score;
        }
      }

      return best;
    },

    _similarity(a, b) {
      if (a === b) return 1;
      if (a.includes(b) || b.includes(a)) return 0.9;
      const bigrams = (s) => {
        const set = new Set();
        for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
        return set;
      };
      const aBi = bigrams(a);
      const bBi = bigrams(b);
      let intersection = 0;
      for (const bg of aBi) if (bBi.has(bg)) intersection++;
      return (2 * intersection) / (aBi.size + bBi.size);
    },

    async _getExternalIds(tmdbId, mediaType) {
      try {
        const resp = await fetch(`${this.BASE}/${mediaType}/${tmdbId}/external_ids?api_key=${CONFIG.tmdbApiKey}`);
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.imdb_id || null;
      } catch (err) {
        console.error('[Netflix IMDb] TMDb external IDs error:', err);
        return null;
      }
    },
  };

  // =============================================================================
  // TITLE RESOLVER
  // =============================================================================

  const TitleResolver = {
    /**
     * Extract title from a preview modal / detail dialog.
     */
    fromModal(root) {
      // data-uia attributes are the most stable selectors
      const titleEl =
        root.querySelector('[data-uia="preview-modal-title"]') ||
        root.querySelector('.previewModal--player-titleTreatmentWrapper img') ||
        root.querySelector('.previewModal--player-titleTreatment-logo') ||
        root.querySelector('.about-header')?.children?.[0];

      let title = titleEl?.getAttribute('alt')?.trim() ||
                   titleEl?.getAttribute('aria-label')?.trim() ||
                   titleEl?.textContent?.trim() || null;

      // Fallback: any large img with alt
      if (!title) {
        const imgs = root.querySelectorAll('img[alt]');
        for (const img of imgs) {
          const alt = img.getAttribute('alt')?.trim();
          if (alt && alt.length > 1) { title = alt; break; }
        }
      }

      if (!title) return null;

      // Year
      const yearEl =
        root.querySelector('[data-uia="preview-modal-year"]') ||
        root.querySelector('.previewModal--detailsMetadata-left .year') ||
        root.querySelector('.year');
      let year = yearEl?.innerText?.trim() || null;
      if (year) {
        const m = year.match(/(\d{4})/);
        year = m ? m[1] : null;
      }

      return { title, year };
    },

    /**
     * Extract title from a browse card (slider-item).
     * Returns { title, year, container } — container is the element to append the badge to.
     */
    fromCard(card) {
      // Best: aria-label on the <a> link
      const link = card.querySelector('a[aria-label]');
      let title = link?.getAttribute('aria-label')?.trim() || null;

      // Fallback: img alt
      if (!title) {
        const img = card.querySelector('.boxart img, .boxart-container img, img[alt]');
        title = img?.getAttribute('alt')?.trim() || null;
      }

      // Fallback: fallback-text paragraph
      if (!title) {
        const p = card.querySelector('.fallback-text, p.fallback-text');
        title = p?.textContent?.trim() || null;
      }

      if (!title) return null;

      // Year: try metadata text near the card
      const sliderItem = card.closest('.slider-item') || card;
      const metaText = sliderItem.querySelector('.meta, .metadata, .supplemental')?.innerText || '';
      const yearMatch = metaText.match(/(\d{4})/);
      const year = yearMatch ? yearMatch[1] : null;

      // The best container for absolute-positioned badge
      const container =
        card.querySelector('.boxart-container') ||
        card.querySelector('.title-card') ||
        card;

      return { title, year, container };
    },

    normalize(title) {
      return title
        .replace(/\s*[\(\[].*?[\)\]]\s*/g, '')
        .replace(/\s*[-–—:]\s*.*$/, '')
        .replace(/[''']/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    },
  };

  // =============================================================================
  // BADGE RENDERER
  // =============================================================================

  const BadgeRenderer = {
    _styleInjected: false,

    injectStyles() {
      if (this._styleInjected) return;
      this._styleInjected = true;

      GM_addStyle(`
        .nimdb-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          border-radius: 5px;
          font-family: Netflix Sans, Helvetica Neue, Helvetica, Arial, sans-serif;
          font-size: 13px;
          font-weight: 700;
          color: #fff;
          line-height: 1;
          white-space: nowrap;
          z-index: 100;
          box-shadow: 0 2px 6px rgba(0,0,0,0.8);
          min-width: 52px;
          justify-content: center;
          cursor: pointer;
          text-decoration: none;
          text-shadow: 0 1px 2px rgba(0,0,0,0.6);
          letter-spacing: 0.3px;
        }

        .nimdb-badge:hover {
          filter: brightness(1.2);
          transform: scale(1.08);
          transition: all 0.15s ease;
        }

        .nimdb-badge--card {
          position: absolute;
          top: 10px;
          right: 10px;
          pointer-events: none;
        }

        .nimdb-badge--hover {
          position: absolute;
          top: 10px;
          right: 10px;
        }

        .nimdb-badge--modal {
          margin-top: 10px;
        }

        .nimdb-badge--billboard {
          margin-top: 10px;
          pointer-events: none;
        }

        .nimdb-badge__star {
          font-size: 11px;
        }

        .nimdb-badge__rating {
          font-weight: 700;
        }

        .nimdb-badge--loading {
          position: absolute;
          top: 10px;
          right: 10px;
          background: rgba(50,50,50,0.92);
          animation: nimdb-pulse 1.5s ease-in-out infinite;
          pointer-events: none;
        }

        .nimdb-badge--error {
          position: absolute;
          top: 10px;
          right: 10px;
          background: rgba(50,50,50,0.7);
          opacity: 0.7;
          pointer-events: none;
        }

        @keyframes nimdb-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `);
    },

    _colorForRating(rating, votes) {
      if (rating === null || rating === undefined || rating === 'N/A') return CONFIG.colors.na;
      const v = parseInt(String(votes).replace(/,/g, ''), 10) || 0;
      if (v >= 10000) return CONFIG.colors.high;
      if (v >= 1000) return CONFIG.colors.medium;
      if (v >= 100) return CONFIG.colors.low;
      return CONFIG.colors.veryLow;
    },

    _confidenceLabel(votes) {
      const v = parseInt(String(votes).replace(/,/g, ''), 10) || 0;
      if (v >= 10000) return 'High';
      if (v >= 1000) return 'Med';
      if (v >= 100) return 'Low';
      return 'V.Low';
    },

    createLoading() {
      const el = document.createElement('span');
      el.className = 'nimdb-badge nimdb-badge--loading';
      el.innerHTML = '<span class="nimdb-badge__star">⭐</span> ...';
      return el;
    },

    createRating(rating, imdbId, votes, source) {
      const el = document.createElement('a');
      el.className = 'nimdb-badge';
      el.style.background = this._colorForRating(rating, votes);
      el.target = '_blank';
      el.rel = 'noopener noreferrer';

      const confidence = this._confidenceLabel(votes);
      const sourceLabel = source === 'tmdb' ? 'TMDb rating' : 'IMDb rating';

      if (imdbId) {
        el.href = `https://www.imdb.com/title/${imdbId}`;
        el.title = `${confidence} confidence · ${sourceLabel}`;
      }

      const star = document.createElement('span');
      star.className = 'nimdb-badge__star';
      star.textContent = '⭐';

      const ratingText = document.createElement('span');
      ratingText.className = 'nimdb-badge__rating';
      ratingText.textContent = rating === 'N/A' ? 'N/A' : rating;

      el.appendChild(star);
      el.appendChild(ratingText);

      return el;
    },

    createError() {
      const el = document.createElement('span');
      el.className = 'nimdb-badge nimdb-badge--error';
      el.textContent = '—';
      el.title = 'Rating unavailable';
      return el;
    },

    initClickHandler() {
      document.addEventListener('click', (e) => {
        const badge = e.target.closest('.nimdb-badge');
        if (!badge || !badge.href) return;
        e.stopPropagation();
        e.stopImmediatePropagation();
      }, true);

      document.addEventListener('mousedown', (e) => {
        const badge = e.target.closest('.nimdb-badge');
        if (badge) e.stopPropagation();
      }, true);
    },
  };

  // =============================================================================
  // LOOKUP MANAGER
  // =============================================================================

  const LookupManager = {
    _inProgress: new Set(),

    async resolve(container, position, title, year) {
      if (container.querySelector('.nimdb-badge')) return;

      const dedupKey = `${title}||${year || ''}||${position}`;
      if (this._inProgress.has(dedupKey)) return;
      this._inProgress.add(dedupKey);

      const normalizedTitle = TitleResolver.normalize(title);

      // 1. Check IndexedDB (skip if force refresh)
      if (!CONFIG.forceRefresh) {
        try {
          const cached = await IMDbDB.get(normalizedTitle, year);
          if (cached && !cached._stale) {
            this._insertBadge(container, position, cached.rating, cached.tconst, cached.votes);
            this._inProgress.delete(dedupKey);
            return;
          }
          if (cached && cached._stale) {
            this._insertBadge(container, position, cached.rating, cached.tconst, cached.votes);
            this._backgroundRefresh(normalizedTitle, year, title);
            this._inProgress.delete(dedupKey);
            return;
          }
        } catch (err) {
          console.error('[Netflix IMDb] IndexedDB read error:', err);
        }
      }

      // 2. Show loading badge
      const loadingBadge = BadgeRenderer.createLoading();
      loadingBadge.classList.add(`nimdb-badge--${position}`);
      container.appendChild(loadingBadge);

      // 3. Resolve: TMDb search → IMDb ID → OMDb by ID → TMDb fallback
      let result = null;
      let source = '';

      if (CONFIG.tmdbApiKey) {
        try {
          const tmdbResult = await TMDb.search(title, year);
          if (tmdbResult && tmdbResult.imdbId) {
            if (window._nimdbDebug) console.log('[Netflix IMDb] TMDb found:', tmdbResult.imdbId, tmdbResult.title, `(${tmdbResult.mediaType})`);
            const omdbResult = await OMDb.fetchById(tmdbResult.imdbId);
            if (omdbResult && omdbResult.rating && omdbResult.rating !== 'N/A') {
              result = omdbResult;
              source = 'imdb';
            } else if (tmdbResult.tmdbRating && tmdbResult.tmdbRating > 0) {
              // OMDb N/A — fall back to TMDb rating
              result = {
                imdbID: tmdbResult.imdbId,
                title: tmdbResult.title,
                year: tmdbResult.year,
                rating: String(tmdbResult.tmdbRating),
                votes: String(tmdbResult.tmdbVotes),
                type: tmdbResult.mediaType,
              };
              source = 'tmdb';
            }
          }
        } catch (err) {
          console.error('[Netflix IMDb] Lookup error:', err);
        }
      }

      // 4. Remove loading badge
      loadingBadge.remove();
      this._inProgress.delete(dedupKey);

      if (result && result.rating && result.rating !== 'N/A') {
        try {
          await IMDbDB.set(normalizedTitle, year, result);
        } catch (err) {
          console.error('[Netflix IMDb] IndexedDB write error:', err);
        }
        if (window._nimdbDebug) console.log(`[Netflix IMDb] Resolved "${title}" via ${source}:`, result.rating, `${result.votes} votes`);
        this._insertBadge(container, position, result.rating, result.imdbID, result.votes, source);
      } else {
        container.appendChild(BadgeRenderer.createError());
      }
    },

    async _backgroundRefresh(normalizedTitle, year, originalTitle) {
      try {
        const tmdbResult = await TMDb.search(originalTitle, year);
        if (tmdbResult && tmdbResult.imdbId) {
          let result = null;
          let source = '';

          const omdbResult = await OMDb.fetchById(tmdbResult.imdbId);
          if (omdbResult && omdbResult.rating && omdbResult.rating !== 'N/A') {
            result = omdbResult;
            source = 'imdb';
          } else if (tmdbResult.tmdbRating && tmdbResult.tmdbRating > 0) {
            result = {
              imdbID: tmdbResult.imdbId,
              title: tmdbResult.title,
              year: tmdbResult.year,
              rating: String(tmdbResult.tmdbRating),
              votes: String(tmdbResult.tmdbVotes),
              type: tmdbResult.mediaType,
            };
            source = 'tmdb';
          }

          if (result) {
            await IMDbDB.set(normalizedTitle, year, result);

            document.querySelectorAll('.nimdb-badge').forEach((badge) => {
              if (badge.title && badge.title.includes(normalizedTitle)) {
                const votes = result.votes || '0';
                badge.style.background = BadgeRenderer._colorForRating(result.rating, votes);
                const ratingEl = badge.querySelector('.nimdb-badge__rating');
                if (ratingEl) ratingEl.textContent = result.rating;
                badge.title = `${BadgeRenderer._confidenceLabel(votes)} confidence · ${source === 'tmdb' ? 'TMDb rating' : 'IMDb rating'}`;
              }
            });
          }
        }
      } catch (_) {}
    },

    _insertBadge(container, position, rating, imdbId, votes, source) {
      const badge = BadgeRenderer.createRating(rating, imdbId, votes, source);
      badge.classList.add(`nimdb-badge--${position}`);
      container.appendChild(badge);
    },
  };

  // =============================================================================
  // DOM OBSERVER
  // =============================================================================

  const DOMObserver = {
    _observer: null,
    _processed: new WeakSet(),
    _intersectionObserver: null,
    _pendingCards: new Set(),

    init() {
      // MutationObserver for dynamically added elements
      this._observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            this._inspect(node);
          }
        }
      });

      this._observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      // IntersectionObserver for lazy-loaded cards
      this._intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const card = entry.target;
              this._intersectionObserver.unobserve(card);
              this._pendingCards.delete(card);
              this._handleCard(card);
            }
          }
        },
        { rootMargin: '200px', threshold: 0 }
      );

      // Scan existing DOM
      this._scanAll();
    },

    _scanAll() {
      // Modals
      document.querySelectorAll('.previewModal--container, [role="dialog"], .previewModal--wrapper').forEach((el) => {
        this._handleModal(el);
      });

      // Billboard
      const billboard = document.querySelector('.billboard-row');
      if (billboard) this._handleBillboard(billboard);

      // Hover preview cards (JawBone / bob-card)
      document.querySelectorAll('.jawBone, .bob-card, [data-uia=" jawbone"]').forEach((el) => {
        this._handleHoverPreview(el);
      });

      // Cards — watch for visibility via IntersectionObserver
      document.querySelectorAll('.slider-item, .title-card').forEach((el) => {
        this._observeCard(el);
      });
    },

    _observeCard(el) {
      if (this._processed.has(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        // Already visible
        this._handleCard(el);
      } else {
        // Not yet visible — observe for lazy loading
        this._pendingCards.add(el);
        this._intersectionObserver.observe(el);
      }
    },

    _inspect(node) {
      // Direct match
      if (node.matches?.('.previewModal--container, [role="dialog"], .previewModal--wrapper')) {
        this._handleModal(node);
      }
      if (node.matches?.('.billboard-row')) {
        this._handleBillboard(node);
      }
      if (node.matches?.('.jawBone, .bob-card')) {
        this._handleHoverPreview(node);
      }
      if (node.matches?.('.slider-item, .title-card')) {
        this._observeCard(node);
      }

      // Descendant scan
      node.querySelectorAll?.('.previewModal--container, [role="dialog"], .previewModal--wrapper')
        ?.forEach((el) => this._handleModal(el));
      node.querySelectorAll?.('.billboard-row')
        ?.forEach((el) => this._handleBillboard(el));
      node.querySelectorAll?.('.jawBone, .bob-card')
        ?.forEach((el) => this._handleHoverPreview(el));
      node.querySelectorAll?.('.slider-item, .title-card')
        ?.forEach((el) => this._observeCard(el));
    },

    _handleModal(modal) {
      if (this._processed.has(modal)) return;
      this._processed.add(modal);

      setTimeout(() => {
        const info = TitleResolver.fromModal(modal);
        if (!info) return;

        const insertTarget =
          modal.querySelector('[data-uia="preview-modal-title"]')?.closest('.previewModal--info') ||
          modal.querySelector('.previewModal--metadatAndControls-info') ||
          modal.querySelector('.previewModal--detailsMetadata-info') ||
          modal.querySelector('.previewModal--metadatAndControls');

        if (insertTarget) {
          LookupManager.resolve(insertTarget, 'modal', info.title, info.year);
        }
      }, 400);
    },

    _handleBillboard(billboard) {
      if (this._processed.has(billboard)) return;
      this._processed.add(billboard);

      setTimeout(() => {
        const logo = billboard.querySelector('.title-logo');
        const title = logo?.getAttribute('alt')?.trim();
        if (!title) return;

        const parent = logo.parentElement;
        if (parent) parent.style.position = 'relative';
        LookupManager.resolve(parent || billboard, 'billboard', title, null);
      }, 500);
    },

    _handleHoverPreview(preview) {
      if (this._processed.has(preview)) return;
      this._processed.add(preview);

      setTimeout(() => {
        // Extract title from the hover preview
        const titleEl =
          preview.querySelector('[data-uia="jawbone-title"]') ||
          preview.querySelector('.logo img') ||
          preview.querySelector('.jawBone-title img') ||
          preview.querySelector('img[alt]');

        let title = titleEl?.getAttribute('alt')?.trim() ||
                     titleEl?.getAttribute('aria-label')?.trim() || null;

        // Fallback: text content of title element
        if (!title) {
          const textEl = preview.querySelector('.video-title, .about-header, h3, h4');
          title = textEl?.textContent?.trim() || null;
        }

        if (!title) return;

        // Year
        const yearEl = preview.querySelector('.year, .meta .year, [data-uia="year"]');
        let year = yearEl?.innerText?.trim() || null;
        if (year) {
          const m = year.match(/(\d{4})/);
          year = m ? m[1] : null;
        }

        // Insertion point — find the metadata area
        const insertTarget =
          preview.querySelector('.video-title') ||
          preview.querySelector('.meta') ||
          preview.querySelector('.about-header') ||
          preview;

        if (insertTarget) {
          insertTarget.style.position = 'relative';
          LookupManager.resolve(insertTarget, 'hover', title, year);
        }
      }, 400);
    },

    _handleCard(card) {
      if (this._processed.has(card)) return;
      this._processed.add(card);

      const info = TitleResolver.fromCard(card);
      if (!info) {
        if (window._nimdbDebug) console.log('[Netflix IMDb] Card — no title found:', card);
        return;
      }

      // Use the container returned by TitleResolver (boxart-container or fallback)
      const target = info.container || card;
      target.style.position = 'relative';

      if (window._nimdbDebug) console.log('[Netflix IMDb] Card:', info.title, info.year, target);
      LookupManager.resolve(target, 'card', info.title, info.year);
    },

    destroy() {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
      if (this._intersectionObserver) {
        this._intersectionObserver.disconnect();
        this._intersectionObserver = null;
      }
    },
  };

  // =============================================================================
  // ROUTE CHANGE DETECTOR
  // =============================================================================

  const RouteDetector = {
    _lastUrl: '',

    init() {
      // Listen for SPA navigation (Netflix uses pushState)
      const origPush = history.pushState;
      history.pushState = (...args) => {
        origPush.apply(this, args);
        this._onNavigate();
      };

      const origReplace = history.replaceState;
      history.replaceState = (...args) => {
        origReplace.apply(this, args);
        this._onNavigate();
      };

      window.addEventListener('popstate', () => this._onNavigate());
    },

    _onNavigate() {
      const url = window.location.href;
      if (url === this._lastUrl) return;
      this._lastUrl = url;

      // Re-scan after navigation settles
      setTimeout(() => DOMObserver._scanAll(), 600);
    },
  };

  // =============================================================================
  // SETTINGS UI
  // =============================================================================

  const Settings = {
    async show() {
      const currentKey = CONFIG.apiKey;
      const currentTmdbKey = CONFIG.tmdbApiKey;
      let statsText = '(loading...)';
      try {
        const stats = await IMDbDB.stats();
        statsText = `${stats.entries} entries`;
      } catch (_) {}

      const todayUsed = RateLimiter.getCount();
      const todayRemaining = RateLimiter.remaining();

      const msg = [
        'Netflix IMDb Ratings — Settings',
        '',
        `TMDb API Key: ${currentTmdbKey ? '***' + currentTmdbKey.slice(-4) : '(not set) — recommended for unlimited search'}`,
        `  Get free at: https://www.themoviedb.org/settings/api`,
        '',
        `OMDb API Key: ${currentKey ? '***' + currentKey.slice(-4) : '(not set) — needed for rating lookup'}`,
        `  Get free at: https://www.omdbapi.com/apikey.aspx`,
        '',
        `Daily OMDb calls used: ${todayUsed} / ${CONFIG.dailyRequestLimit}`,
        `Daily OMDb calls remaining: ${todayRemaining}`,
        `Local DB: ${statsText}`,
        '',
        'Badge colors = confidence (based on vote count):',
        '  Green  = 10K+ votes (high)',
        '  Yellow = 1K-10K votes (medium)',
        '  Orange = 100-999 votes (low)',
        '  Red    = <100 votes (very low)',
        '',
        'Enter TMDb API key (or leave empty to skip):',
      ].join('\n');

      const newTmdbKey = prompt(msg, currentTmdbKey);
      if (newTmdbKey !== null && newTmdbKey !== currentTmdbKey) {
        CONFIG.tmdbApiKey = newTmdbKey;
      }

      // Then ask for OMDb key
      const omdbMsg = [
        'Enter OMDb API key (or leave empty to skip):',
      ].join('\n');

      const newKey = prompt(omdbMsg, currentKey);
      if (newKey !== null && newKey !== currentKey) {
        CONFIG.apiKey = newKey;
      }

      alert(
        `TMDb: ${CONFIG.tmdbApiKey ? '***' + CONFIG.tmdbApiKey.slice(-4) : '(not set)'}\n` +
        `OMDb: ${CONFIG.apiKey ? '***' + CONFIG.apiKey.slice(-4) : '(not set)'}`
      );
    },
  };

  // =============================================================================
  // INIT
  // =============================================================================

  async function init() {
    // Initialize IndexedDB
    try {
      await IMDbDB.init();
    } catch (err) {
      console.error('[Netflix IMDb] Failed to init IndexedDB:', err);
      alert('Netflix IMDb Ratings: Failed to initialize local database. Script may not work correctly.');
    }

    // Ensure API keys are set
    if (!CONFIG.apiKey) {
      const omdbKey = prompt(
        'Netflix IMDb Ratings\n\n' +
        'OMDb API Key (required for ratings)\n' +
        'Get free at: https://www.omdbapi.com/apikey.aspx\n\n' +
        '1000 requests/day on free tier.\n\n' +
        'OMDb API Key:'
      );
      if (omdbKey) {
        CONFIG.apiKey = omdbKey;
      } else {
        alert('OMDb key is required for ratings. You can set it later via the Tampermonkey menu.');
        return;
      }
    }

    if (!CONFIG.tmdbApiKey) {
      const tmdbKey = prompt(
        'TMDb API Key (recommended, unlimited search)\n\n' +
        'Get free at: https://www.themoviedb.org/settings/api\n\n' +
        'Enables unlimited title search (no rate limits).\n' +
        'Without it, all searches use OMDb (1000/day limit).\n\n' +
        'TMDb API Key (or leave empty to skip):'
      );
      if (tmdbKey) CONFIG.tmdbApiKey = tmdbKey;
    }

    BadgeRenderer.injectStyles();
    BadgeRenderer.initClickHandler();
    RouteDetector.init();
    DOMObserver.init();

    // Tampermonkey menu commands
    GM_registerMenuCommand('Settings', Settings.show);
    GM_registerMenuCommand('Toggle Force Refresh', () => {
      CONFIG.forceRefresh = !CONFIG.forceRefresh;
      alert(`Force Refresh: ${CONFIG.forceRefresh ? 'ON — will refetch all titles, cache ignored' : 'OFF — normal caching resumed'}`);
    });
    GM_registerMenuCommand('Toggle Debug Mode', () => {
      window._nimdbDebug = !window._nimdbDebug;
      alert(`Debug mode: ${window._nimdbDebug ? 'ON' : 'OFF'}\nCheck browser console (F12) for logs.`);
    });
    GM_registerMenuCommand('Clear Local DB', async () => {
      if (confirm('Clear all cached ratings from local database?')) {
        await IMDbDB.clear();
        alert('Local database cleared.');
      }
    });
    GM_registerMenuCommand('Show Stats', async () => {
      let statsText = '(error)';
      try {
        const stats = await IMDbDB.stats();
        statsText = `Local DB: ${stats.entries} entries`;
      } catch (_) {}
      const todayUsed = RateLimiter.getCount();
      alert(
        `${statsText}\n` +
        `TMDb: ${CONFIG.tmdbApiKey ? '***' + CONFIG.tmdbApiKey.slice(-4) : 'not set'}\n` +
        `Force Refresh: ${CONFIG.forceRefresh ? 'ON' : 'OFF'}\n` +
        `Today's OMDb calls: ${todayUsed} / ${CONFIG.dailyRequestLimit}\n` +
        `Remaining: ${RateLimiter.remaining()}\n` +
        `Cache TTL: 7d (recent) / 30d (3-5yr) / 90d (5yr+)`
      );
    });

    console.log('[Netflix IMDb] Initialized. TMDb: ' + (CONFIG.tmdbApiKey ? '***' + CONFIG.tmdbApiKey.slice(-4) : 'none') + ', OMDb: ***' + CONFIG.apiKey.slice(-4));
  }

  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }
})();
