// ==UserScript==
// @name         Netflix IMDb Ratings
// @namespace    https://github.com/netflix-imdb-ratings
// @version      5.3.0
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
    dailyLimit: 950,
    dbVersion: 3,
    dbName: 'NetflixIMDbRatings',
    storeName: 'ratings',
    cacheTTL: { recent: { maxAge: 3, ttlDays: 7 }, mid: { maxAge: 5, ttlDays: 30 }, old: { maxAge: Infinity, ttlDays: 90 } },
    colors: { high: '#2e7d32', medium: '#f9a825', low: '#e65100', veryLow: '#b71c1c', na: '#455a64' },
  };

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (s) => s?.trim() || null;
  const num = (v) => parseInt(String(v).replace(/,/g, ''), 10) || 0;

  // ─── NETFLIX ID EXTRACTOR ─────────────────────────────────────────────────

  const NetflixId = {
    fromUrl(url) { return url?.match(/\/(?:title|watch)\/(\d+)/)?.[1] || null; },
    fromCurrent() { return this.fromUrl(location.href); },
    fromCard(card) {
      const link = $('a[href*="/title/"], a[href*="/watch/"]', card) || card.closest('a[href*="/title/"], a[href*="/watch/"]');
      if (link) return this.fromUrl(link.getAttribute('href'));
      const dataEl = $('[data-id],[data-titleid]', card) || card.closest('[data-id],[data-titleid]');
      if (dataEl) { const raw = dataEl.getAttribute('data-id') || dataEl.getAttribute('data-titleid'); const id = this.fromUrl(raw) || raw; if (/^\d+$/.test(id)) return id; }
      for (const el of $$('*', card)) for (const attr of el.attributes) { const id = this.fromUrl(attr.value); if (id) return id; }
      const slider = card.closest('.slider-item');
      if (slider) for (const attr of slider.attributes) { const id = this.fromUrl(attr.value) || attr.value; if (/^\d+$/.test(id)) return id; }
      return null;
    },
  };

  // ─── INDEXED DB ───────────────────────────────────────────────────────────

  const DB = {
    _db: null,
    _ready: null,

    async init() {
      this._ready = new Promise((ok, fail) => {
        const req = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (db.objectStoreNames.contains(CONFIG.storeName)) db.deleteObjectStore(CONFIG.storeName);
          const s = db.createObjectStore(CONFIG.storeName, { keyPath: 'key' });
          s.createIndex('byImdbId', 'imdbId', { unique: false });
          s.createIndex('byCachedAt', 'cachedAt', { unique: false });
        };
        req.onsuccess = (e) => { this._db = e.target.result; ok(); };
        req.onerror = (e) => fail(e.target.error);
      });
      await this._ready;
    },

    _ready_() { return this._ready || this.init(); },

    _ttl(year) {
      if (!year) return CONFIG.cacheTTL.recent.ttlDays;
      const age = new Date().getFullYear() - parseInt(year, 10);
      if (age < CONFIG.cacheTTL.recent.maxAge) return CONFIG.cacheTTL.recent.ttlDays;
      if (age < CONFIG.cacheTTL.mid.maxAge) return CONFIG.cacheTTL.mid.ttlDays;
      return CONFIG.cacheTTL.old.ttlDays;
    },

    async get(id) {
      await this._ready_();
      return new Promise((ok, fail) => {
        const tx = this._db.transaction(CONFIG.storeName, 'readonly');
        const req = tx.objectStore(CONFIG.storeName).get(id);
        req.onsuccess = () => {
          const e = req.result;
          if (!e) return ok(null);
          ok((Date.now() - e.cachedAt > (e.ttlDays || 7) * 864e5) ? { ...e, _stale: true } : e);
        };
        req.onerror = () => fail(req.error);
      });
    },

    async set(id, data) {
      await this._ready_();
      const year = data.year || 'unknown';
      const src = data.source || 'imdb';
      return new Promise((ok, fail) => {
        const tx = this._db.transaction(CONFIG.storeName, 'readwrite');
        tx.objectStore(CONFIG.storeName).put({
          key: id, imdbId: data.imdbId || null, title: data.title || null, year,
          imdbRating: data.imdbRating || null, tmdbRating: data.tmdbRating || null,
          imdbVotes: data.imdbVotes || '0', tmdbVotes: data.tmdbVotes || '0',
          source: src, ttlDays: src === 'tmdb' ? 7 : this._ttl(year), cachedAt: Date.now(),
        });
        tx.oncomplete = () => ok();
        tx.onerror = () => fail(tx.error);
      });
    },

    async stats() {
      await this._ready_();
      return new Promise((ok, fail) => {
        const req = this._db.transaction(CONFIG.storeName, 'readonly').objectStore(CONFIG.storeName).count();
        req.onsuccess = () => ok({ entries: req.result });
        req.onerror = () => fail(req.error);
      });
    },

    async clear() {
      await this._ready_();
      return new Promise((ok, fail) => {
        const req = this._db.transaction(CONFIG.storeName, 'readwrite').objectStore(CONFIG.storeName).clear();
        req.onsuccess = () => ok();
        req.onerror = () => fail(req.error);
      });
    },
  };

  // ─── RATE LIMITER ─────────────────────────────────────────────────────────

  const Limiter = {
    _key() { const d = new Date(); return `rl_${d.getFullYear()}_${d.getMonth()}_${d.getDate()}`; },
    get count() { return GM_getValue(this._key(), 0); },
    get remaining() { return Math.max(0, CONFIG.dailyLimit - this.count); },
    hit() { const k = this._key(); GM_setValue(k, GM_getValue(k, 0) + 1); },
    get ok() { return this.count < CONFIG.dailyLimit; },
  };

  // ─── API LAYER ────────────────────────────────────────────────────────────

  const OMDb = {
    async byId(imdbId) {
      if (!CONFIG.apiKey || !Limiter.ok) return null;
      Limiter.hit();
      try {
        const r = await fetch(`https://www.omdbapi.com/?apikey=${CONFIG.apiKey}&i=${imdbId}`);
        const d = await r.json();
        return d.Response === 'False' ? null : { imdbId: d.imdbID, imdbRating: d.imdbRating, imdbVotes: d.imdbVotes || '0' };
      } catch { return null; }
    },
    async search(title, year) {
      if (!CONFIG.apiKey || !Limiter.ok) return null;
      Limiter.hit();
      try {
        const r = await fetch(`https://www.omdbapi.com/?apikey=${CONFIG.apiKey}&s=${encodeURIComponent(title)}${year ? `&y=${year}` : ''}&type=movie,series`);
        const d = await r.json();
        if (d.Response === 'False' || !d.Search?.length) return null;
        const best = d.Search.find((r) => (!year || r.Year === year) && r.Title?.toLowerCase() === title.toLowerCase()) || d.Search[0];
        return best?.imdbID || null;
      } catch { return null; }
    },
  };

  const Scraper = {
    _ua: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    async fetch(imdbId) {
      if (!imdbId) return null;
      return new Promise((ok) => {
        GM_xmlhttpRequest({
          method: 'GET', url: `https://www.imdb.com/title/${imdbId}/`,
          headers: { 'User-Agent': this._ua, 'Accept': 'text/html' }, timeout: 10000,
          onload: (r) => {
            if (r.status !== 200) return ok(null);
            const h = r.responseText;
            const meta = h.match(/<meta\s+(?:content="([^"]+)"\s+property="og:title"|property="og:title"\s+content="([^"]+)")/i);
            const content = meta?.[1] || meta?.[2];
            if (content) { const m = content.match(/(\d+\.\d+)/); if (m) return ok({ imdbRating: m[1], imdbVotes: '0' }); }
            const jld = h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
            if (jld) try { const a = JSON.parse(jld[1]).aggregateRating; if (a?.ratingValue) return ok({ imdbRating: String(a.ratingValue), imdbVotes: String(a.ratingCount || '0') }); } catch {}
            const raw = h.match(/"ratingValue"\s*:\s*"?(\d+\.?\d*)/);
            ok(raw ? { imdbRating: raw[1], imdbVotes: '0' } : null);
          },
          onerror: () => ok(null), ontimeout: () => ok(null),
        });
      });
    },
  };

  const TMDb = {
    async search(title, year) {
      if (!CONFIG.tmdbApiKey) return null;
      try {
        const r = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${CONFIG.tmdbApiKey}&query=${encodeURIComponent(title)}&include_adult=false`);
        const d = await r.json();
        const hits = (d.results || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv');
        if (!hits.length) return null;
        const best = this._pick(hits, title, year);
        if (!best) return null;
        const imdbId = await this._extId(best.id, best.media_type);
        if (!imdbId) return null;
        const ry = (best.media_type === 'movie' ? best.release_date : best.first_air_date || '').slice(0, 4);
        return { imdbId, title: best.title || best.name, year: ry || year, tmdbRating: best.vote_average, tmdbVotes: best.vote_count };
      } catch { return null; }
    },
    _pick(hits, title, year) {
      const n = title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (year) { const ex = hits.find((h) => (h.title || h.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === n && (h.release_date || h.first_air_date || '').slice(0, 4) === year); if (ex) return ex; }
      return hits.sort((a, b) => this._sim(n, (b.title || b.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')) - this._sim(n, (a.title || a.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')))[0];
    },
    _sim(a, b) {
      if (a === b) return 1; if (a.includes(b) || b.includes(a)) return 0.9;
      const bg = (s) => { const set = new Set(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; };
      const A = bg(a), B = bg(b); let c = 0; for (const x of A) if (B.has(x)) c++;
      return (2 * c) / (A.size + B.size);
    },
    async _extId(id, type) {
      const r = await fetch(`https://api.themoviedb.org/3/${type}/${id}/external_ids?api_key=${CONFIG.tmdbApiKey}`);
      return r.ok ? (await r.json()).imdb_id || null : null;
    },
  };

  // ─── UNIFIED LOOKUP ───────────────────────────────────────────────────────

  async function fetchEntry(title, year) {
    let imdbId = null, tmdbRating = null, tmdbVotes = null;

    if (CONFIG.tmdbApiKey) {
      const tmdb = await TMDb.search(title, year);
      if (tmdb) { imdbId = tmdb.imdbId; tmdbRating = tmdb.tmdbRating; tmdbVotes = tmdb.tmdbVotes; }
    } else if (CONFIG.apiKey) {
      imdbId = await OMDb.search(title, year);
    }

    if (!imdbId) return tmdbRating > 0 ? { tmdbRating: String(tmdbRating), tmdbVotes: String(tmdbVotes), source: 'tmdb' } : null;

    const omdb = await OMDb.byId(imdbId);
    let entry = { imdbId, source: null };

    if (omdb?.imdbRating && omdb.imdbRating !== 'N/A') {
      entry.imdbRating = omdb.imdbRating; entry.imdbVotes = omdb.imdbVotes; entry.source = 'imdb';
    } else {
      const scraped = await Scraper.fetch(imdbId);
      if (scraped?.imdbRating && scraped.imdbRating !== 'N/A') { entry.imdbRating = scraped.imdbRating; entry.imdbVotes = scraped.imdbVotes; entry.source = 'imdb'; }
    }

    if (tmdbRating > 0) { entry.tmdbRating = String(tmdbRating); entry.tmdbVotes = String(tmdbVotes); if (!entry.source) entry.source = 'tmdb'; }
    return entry;
  }

  // ─── BADGE ────────────────────────────────────────────────────────────────

  const Badge = {
    _color(rating, votes) {
      if (!rating || rating === 'N/A') return CONFIG.colors.na;
      const v = num(votes);
      return v >= 10000 ? CONFIG.colors.high : v >= 1000 ? CONFIG.colors.medium : v >= 100 ? CONFIG.colors.low : CONFIG.colors.veryLow;
    },
    _label(votes) { const v = num(votes); return v >= 10000 ? 'High' : v >= 1000 ? 'Med' : v >= 100 ? 'Low' : 'V.Low'; },
    _best(e) {
      if (e.imdbRating && e.imdbRating !== 'N/A') return { r: e.imdbRating, v: e.imdbVotes, s: 'imdb' };
      if (e.tmdbRating && e.tmdbRating !== 'N/A' && parseFloat(e.tmdbRating) > 0) return { r: e.tmdbRating, v: e.tmdbVotes, s: 'tmdb' };
      return null;
    },
    make(entry, position) {
      const best = this._best(entry);
      if (!best) return Object.assign(document.createElement('span'), { className: 'nimdb-badge nimdb-badge--error', textContent: '\u2014', title: 'Rating unavailable' });
      const el = document.createElement('a');
      el.className = `nimdb-badge nimdb-badge--${position}`;
      el.style.background = this._color(best.r, best.v);
      el.target = '_blank'; el.rel = 'noopener noreferrer';
      if (entry.imdbId) { el.href = `https://www.imdb.com/title/${entry.imdbId}`; el.title = `${this._label(best.v)} confidence \u00b7 ${best.s === 'tmdb' ? 'TMDb rating' : 'IMDb rating'}`; }
      el.innerHTML = `<span class="nimdb-badge__star">\u2b50</span><span class="nimdb-badge__rating">${best.r}</span>`;
      return el;
    },
    loading() { return Object.assign(document.createElement('span'), { className: 'nimdb-badge nimdb-badge--loading', innerHTML: '<span class="nimdb-badge__star">\u2b50</span> ...' }); },
    injectStyles() {
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
        @keyframes nimdb-pulse{0%,100%{opacity:1}50%{opacity:.5}}`);
    },
    stopClick(e) { if (e.target.closest('.nimdb-badge')) e.stopPropagation(); },
  };

  // ─── RESOLVE + INSERT ─────────────────────────────────────────────────────

  const badgeFor = new Map(); // netflixId → Set<position>

  async function resolve(container, position, title, year, netflixId) {
    if (!netflixId) return;
    if (container.querySelector('.nimdb-badge:not(.nimdb-badge--loading):not(.nimdb-badge--error)')) return;

    if (!CONFIG.forceRefresh) {
      try {
        const cached = await DB.get(netflixId);
        if (cached) {
          insert(container, position, cached, netflixId);
          if (cached._stale) refreshBg(netflixId, title, year);
          return;
        }
      } catch (err) { console.error('[Netflix IMDb] DB read error:', err); }
    }

    const load = Badge.loading();
    container.appendChild(load);

    const entry = await fetchEntry(title, year);
    load.remove();

    if (entry?.imdbRating || entry?.tmdbRating) {
      entry.title = title; entry.year = year;
      try { await DB.set(netflixId, entry); } catch (err) { console.error('[Netflix IMDb] DB write error:', err); }
      insert(container, position, entry, netflixId);
    } else {
      container.appendChild(Badge.make({}, position));
    }
  }

  function insert(container, position, entry, netflixId) {
    if (container.querySelector('.nimdb-badge:not(.nimdb-badge--loading):not(.nimdb-badge--error)')) return;
    const badge = Badge.make(entry, position);
    if (netflixId) badge.dataset.nimdbNetflixId = netflixId;
    container.appendChild(badge);
  }

  async function refreshBg(netflixId, title, year) {
    try {
      const entry = await fetchEntry(title, year);
      if (!entry?.imdbRating && !entry?.tmdbRating) return;
      entry.title = title; entry.year = year;
      await DB.set(netflixId, entry);
      const best = Badge._best(entry);
      if (!best) return;
      $$(`.nimdb-badge[data-nimdb-netflix-id="${netflixId}"]`).forEach((b) => {
        b.style.background = Badge._color(best.r, best.v);
        const r = $('.nimdb-badge__rating', b); if (r) r.textContent = best.r;
        b.title = `${Badge._label(best.v)} confidence \u00b7 ${best.s === 'tmdb' ? 'TMDb rating' : 'IMDb rating'}`;
      });
    } catch {}
  }

  // ─── DOM OBSERVER ─────────────────────────────────────────────────────────

  const processed = new WeakMap();

  function processEl(el, key, fn, delay = 400) {
    if (key && processed.get(el) === key) return;
    processed.set(el, key);
    setTimeout(fn, delay);
  }

  const Observer = {
    init() {
      new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) { if (n.nodeType === 1) inspect(n); }
      }).observe(document.body, { childList: true, subtree: true });

      new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { Observer.unobserve(e.target); handleCard(e.target); }
      }, { rootMargin: '200px', threshold: 0 });

      this._scanAll();
    },

    _scanAll() {
      $$('.previewModal--container, [role="dialog"], .previewModal--wrapper').forEach(handleModal);
      const bb = $('.billboard-row'); if (bb) handleBillboard(bb);
      $$('.jawBone, .bob-card, [data-uia="jawbone"], [data-uia="jawbone-title"], .previewModal--jawbone').forEach(handleHover);
      $$('.slider-item, .title-card').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) handleCard(el);
        else { pending.add(el); intersection.observe(el); }
      });
    },
  };

  const pending = new Set();
  const intersection = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { intersection.unobserve(e.target); pending.delete(e.target); handleCard(e.target); }
  }, { rootMargin: '200px', threshold: 0 });

  function inspect(node) {
    if (node.matches?.('.previewModal--container, [role="dialog"], .previewModal--wrapper')) handleModal(node);
    if (node.matches?.('.billboard-row')) handleBillboard(node);
    if (node.matches?.('.jawBone, .bob-card, [data-uia="jawbone"], [data-uia="jawbone-title"], .previewModal--jawbone')) handleHover(node);
    if (node.matches?.('.slider-item, .title-card')) { const r = node.getBoundingClientRect(); if (r.width > 0 && r.height > 0) handleCard(node); else { pending.add(node); intersection.observe(node); } }
    node.querySelectorAll?.('.previewModal--container, [role="dialog"], .previewModal--wrapper')?.forEach(handleModal);
    node.querySelectorAll?.('.billboard-row')?.forEach(handleBillboard);
    node.querySelectorAll?.('.jawBone, .bob-card, [data-uia="jawbone"], [data-uia="jawbone-title"], .previewModal--jawbone')?.forEach(handleHover);
    node.querySelectorAll?.('.slider-item, .title-card')?.forEach((el) => { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) handleCard(el); else { pending.add(el); intersection.observe(el); } });
  }

  function handleModal(modal) {
    const info = TitleResolver.fromModal(modal);
    const key = info ? `${info.title}||${info.year || ''}` : null;
    if (!key) return;
    processEl(modal, key, () => {
      const info = TitleResolver.fromModal(modal); if (!info) return;
      const id = NetflixId.fromUrl($('a[href*="/title/"], a[href*="/watch/"]', modal)?.getAttribute('href')) || NetflixId.fromCurrent();
      const target = $('[data-uia="preview-modal-title"]', modal)?.closest('.previewModal--info') || $('.previewModal--metadatAndControls-info', modal) || $('.previewModal--detailsMetadata-info', modal) || $('.previewModal--metadatAndControls', modal);
      if (target) resolve(target, 'modal', info.title, info.year, id);
    });
  }

  function handleBillboard(bb) {
    const logo = $('.title-logo', bb);
    const title = clamp(logo?.getAttribute('alt'));
    if (!title) return;
    processEl(bb, title, () => {
      const parent = logo.parentElement; if (parent) parent.style.position = 'relative';
      resolve(parent || bb, 'billboard', title, null, NetflixId.fromCurrent());
    }, 500);
  }

  function handleHover(preview) {
    const titleEl = $('[data-uia="jawbone-title"], [data-uia="title"], .logo img, .jawBone-title img, img[alt]', preview);
    let title = clamp(titleEl?.getAttribute('alt')) || clamp(titleEl?.getAttribute('aria-label'));
    if (!title) title = $('.video-title, .about-header, h3, h4', preview)?.textContent?.trim() || null;
    if (!title) return;
    const year = $('.year, .meta .year, [data-uia="year"]', preview)?.innerText?.trim()?.match(/(\d{4})/)?.[1] || null;
    const key = `${title}||${year || ''}`;
    processEl(preview, key, () => {
      const target = $('[data-uia="jawbone-info"], .video-title, .meta, .about-header', preview) || preview;
      target.style.position = 'relative';
      resolve(target, 'hover', title, year, NetflixId.fromCurrent());
    });
  }

  function handleCard(card) {
    const info = TitleResolver.fromCard(card); if (!info) return;
    const key = `${info.title}||${info.year || ''}`;
    if (processed.get(card) === key) return;
    processed.set(card, key);
    const target = info.container || card;
    target.style.position = 'relative';
    resolve(target, 'card', info.title, info.year, NetflixId.fromCard(card));
  }

  // ─── TITLE RESOLVER ───────────────────────────────────────────────────────

  const TitleResolver = {
    fromModal(root) {
      const titleEl = $('[data-uia="preview-modal-title"], .previewModal--player-titleTreatmentWrapper img, .previewModal--player-titleTreatment-logo', root) || $('.about-header', root)?.children?.[0];
      let title = clamp(titleEl?.getAttribute('alt')) || clamp(titleEl?.getAttribute('aria-label')) || clamp(titleEl?.textContent);
      if (!title) for (const img of $$('img[alt]', root)) { title = clamp(img.getAttribute('alt')); if (title?.length > 1) break; }
      if (!title) return null;
      const year = $('[data-uia="preview-modal-year"], .previewModal--detailsMetadata-left .year, .year', root)?.innerText?.trim()?.match(/(\d{4})/)?.[1] || null;
      return { title, year };
    },
    fromCard(card) {
      let title = clamp($('a[aria-label]', card)?.getAttribute('aria-label'));
      if (!title) title = clamp($('.boxart img, .boxart-container img, img[alt]', card)?.getAttribute('alt'));
      if (!title) title = $('.fallback-text, p.fallback-text', card)?.textContent?.trim() || null;
      if (!title) return null;
      const year = (card.closest('.slider-item') || card).querySelector('.meta, .metadata, .supplemental')?.innerText?.match(/(\d{4})/)?.[1] || null;
      const container = $('.boxart-container, .title-card', card) || card;
      return { title, year, container };
    },
  };

  // ─── SETTINGS ─────────────────────────────────────────────────────────────

  const Settings = {
    async show() {
      let stats = '(loading...)'; try { stats = `${(await DB.stats()).entries} entries`; } catch {}
      const msg = [
        'Netflix IMDb Ratings \u2014 Settings', '',
        `TMDb Key: ${CONFIG.tmdbApiKey ? '***' + CONFIG.tmdbApiKey.slice(-4) : '(not set)'}  (get at themoviedb.org/settings/api)`, '',
        `OMDb Key: ${CONFIG.apiKey ? '***' + CONFIG.apiKey.slice(-4) : '(not set)'}  (get at omdbapi.com/apikey.aspx)`, '',
        `OMDb: ${Limiter.count}/${CONFIG.dailyLimit} (${Limiter.remaining} left)  |  DB: ${stats}`, '',
        'Badge colors = confidence (vote count):', '  Green=10K+  Yellow=1K-10K  Orange=100-999  Red=<100', '',
        'Enter TMDb API key (or leave empty):',
      ].join('\n');
      const tmdb = prompt(msg, CONFIG.tmdbApiKey); if (tmdb !== null) CONFIG.tmdbApiKey = tmdb;
      const omdb = prompt('Enter OMDb API key (or leave empty):', CONFIG.apiKey); if (omdb !== null) CONFIG.apiKey = omdb;
    },
  };

  // ─── INIT ─────────────────────────────────────────────────────────────────

  async function init() {
    try { await DB.init(); } catch (err) { console.error('[Netflix IMDb] IndexedDB init failed:', err); }

    if (!CONFIG.apiKey) {
      const key = prompt('Netflix IMDb Ratings\n\nOMDb API Key (required)\nGet free at: https://www.omdbapi.com/apikey.aspx\n\nOMDb API Key:');
      if (key) CONFIG.apiKey = key;
      else { alert('OMDb key required. Set later via Tampermonkey menu.'); return; }
    }
    if (!CONFIG.tmdbApiKey) {
      const key = prompt('TMDb API Key (recommended, unlimited search)\nGet free at: https://www.themoviedb.org/settings/api\n\nTMDb API Key (or leave empty):');
      if (key) CONFIG.tmdbApiKey = key;
    }

    Badge.injectStyles();
    document.addEventListener('click', Badge.stopClick, true);
    document.addEventListener('mousedown', Badge.stopClick, true);
    Observer.init();

    GM_registerMenuCommand('Settings', Settings.show);
    GM_registerMenuCommand('Toggle Force Refresh', () => { CONFIG.forceRefresh = !CONFIG.forceRefresh; alert(`Force Refresh: ${CONFIG.forceRefresh ? 'ON' : 'OFF'}`); });
    GM_registerMenuCommand('Toggle Debug Mode', () => { window._nimdbDebug = !window._nimdbDebug; alert(`Debug: ${window._nimdbDebug ? 'ON' : 'OFF'}\nCheck F12 console.`); });
    GM_registerMenuCommand('Clear Local DB', async () => { if (confirm('Clear all cached ratings?')) { await DB.clear(); alert('Cleared.'); } });
    GM_registerMenuCommand('Show Stats', async () => {
      let t = '(error)'; try { t = `${(await DB.stats()).entries} entries`; } catch {}
      alert(`${t}\nTMDb: ${CONFIG.tmdbApiKey ? '***' + CONFIG.tmdbApiKey.slice(-4) : 'none'}\nForceRefresh: ${CONFIG.forceRefresh}\nOMDb: ${Limiter.count}/${CONFIG.dailyLimit}`);
    });

    console.log(`[Netflix IMDb] v5.3.0 | TMDb: ${CONFIG.tmdbApiKey ? '***' + CONFIG.tmdbApiKey.slice(-4) : 'none'} | OMDb: ***${CONFIG.apiKey.slice(-4)}`);
  }

  document.readyState === 'complete' ? init() : window.addEventListener('load', init);
})();
