# Netflix IMDb Ratings

A Tampermonkey userscript that shows IMDb ratings on every Netflix title — cards, hover previews, modals, and billboard — with local IndexedDB caching, confidence-based badge colors, and TMDb-powered title search.

## Installation

### Prerequisites

- [Tampermonkey](https://www.tampermonkey.net/) browser extension (Chrome, Firefox, Edge, Safari)
- A free [OMDb API key](https://www.omdbapi.com/apikey.aspx) (required for IMDb ratings)
- A free [TMDb API key](https://www.themoviedb.org/settings/api) (recommended for unlimited title search)

### Steps

1. **Install Tampermonkey** from your browser's extension store
2. **Open the script file** `netflix-imdb-ratings.user.js` in your browser — Tampermonkey will detect it and offer to install
3. **Confirm installation** when prompted
4. **Navigate to Netflix** — the script activates automatically on `netflix.com/*`
5. **Enter your API keys** when prompted on first run:
   - TMDb key: unlimited title search via TMDb's `/search/multi` endpoint (recommended)
   - OMDb key: IMDb rating lookup by ID (required)
   - Both keys are free — TMDb key is optional but highly recommended

### Manual Installation

If the automatic detection doesn't work:

1. Open Tampermonkey dashboard (click extension icon → Dashboard)
2. Click the **"+"** tab (Create a new script)
3. Delete the template code
4. Paste the contents of `netflix-imdb-ratings.user.js`
5. Press `Ctrl+S` to save

## Features

- **Rating badges** on every Netflix title card, hover preview, detail modal, and billboard
- **Clickable badges** open the IMDb page for that title in a new tab
- **Confidence-based colors** — badge color reflects how reliable the rating is (based on vote count, not the rating itself)
- **Local IndexedDB cache** — ratings persist across sessions, no server required
- **Tiered cache TTL** — recent titles (0-3 years) refresh weekly, older titles (5+ years) refresh quarterly
- **TMDb-powered title search** — matches Netflix titles to IMDb IDs using TMDb's multi-search API
- **Multiple fallback sources** — OMDb → IMDb scraper → TMDb `vote_average` (never leaves you empty-handed)
- **OMDb search fallback** — when TMDb key is missing, uses OMDb's `?s=` endpoint for title search
- **Force refresh mode** — bypass cache to refetch all titles without clearing the DB
- **Debug mode** — logs lookup details to the console for troubleshooting
- **Duplicate badge prevention** — each title gets exactly one badge, even across multiple DOM containers
- **Netflix SPA-compatible** — MutationObserver handles all Netflix navigation without intercepting `pushState`/`replaceState`

## How It Works

### Rating Lookup Chain

The script uses a unified `fetchEntry(title, year)` function that tries multiple sources in order:

```
TMDb /search/multi       →  IMDb ID + TMDb vote_average
  ↓
OMDb ?i=tt1234567        →  IMDb rating (primary)
  ↓
IMDb scraper (OG bot)    →  IMDb rating (fallback, no API key needed)
  ↓
TMDb vote_average        →  last resort when all above fail
```

**Without TMDb key:**

```
OMDb /?s=Title           →  IMDb ID
  ↓
OMDb ?i=tt1234567        →  IMDb rating
  ↓
IMDb scraper             →  fallback
```

### IMDb Scraper

Netflix does not expose IMDb IDs in its DOM. The script:

1. Finds the title via TMDb search (or OMDb search as fallback)
2. Gets the IMDb ID from TMDb's external IDs endpoint
3. Fetches `imdb.com/title/{id}/` using the `facebookexternalhit/1.1` User-Agent — IMDb whitelists this crawler and returns full HTML
4. Extracts ratings from three sources (in order): `og:title` meta tag, JSON-LD `aggregateRating`, raw HTML `ratingValue`

### Badge Colors

Badge colors represent **confidence** based on vote count, not rating value:

| Color | Votes | Confidence | Meaning |
|-------|-------|------------|---------|
| Green | 10,000+ | High | Well-established title |
| Yellow | 1,000–10,000 | Medium | Moderately popular |
| Orange | 100–999 | Low | Lesser-known title |
| Red | <100 | Very Low | Very few ratings |
| Gray | N/A | Unavailable | Rating could not be determined |

### Caching

- **Primary key**: Netflix ID (extracted from URL `/title/{id}` or `/watch/{id}` paths, or from DOM attributes)
- **Schema v3**: Flat entry with `imdbId`, `title`, `year`, `imdbRating`, `tmdbRating`, `imdbVotes`, `tmdbVotes`, `source`, `ttlDays`, `cachedAt`
- **Tiered TTL** based on title age:
  - Recent (0–3 years): 7 days
  - Mid (3–5 years): 30 days
  - Old (5+ years): 90 days
  - TMDb-only entries: always 7 days regardless of title age
- **Stale-while-revalidate**: Stale entries display immediately, then refresh in the background

## Technical Details

### Architecture

The script is a single self-contained IIFE (~530 lines) with no external dependencies beyond Tampermonkey APIs and browser-native IndexedDB.

**Modules:**

| Module | Purpose |
|--------|---------|
| `CONFIG` | API keys, cache TTL, rate limits, colors (all persisted via `GM_setValue`) |
| `NetflixId` | Extracts Netflix ID from URLs, DOM attributes, and card elements |
| `DB` | IndexedDB wrapper with v3 schema, tiered TTL, stale detection |
| `Limiter` | Daily OMDb rate limit tracker (950/day) |
| `OMDb` | OMDb API — `byId(imdbId)` + `search(title, year)` |
| `Scraper` | IMDb scraper using `facebookexternalhit/1.1` User-Agent |
| `TMDb` | TMDb API — `/search/multi` + `/external_ids` for IMDb ID lookup |
| `fetchEntry()` | Unified lookup: TMDb → OMDb → Scraper → TMDb fallback |
| `Badge` | Badge creation, coloring, label generation, style injection |
| `Observer` | MutationObserver + IntersectionObserver for Netflix SPA |
| `TitleResolver` | Extracts title/year from modal, card, hover, billboard DOM |
| `Settings` | Settings UI (Tampermonkey menu) |

### DOM Handling

Netflix is a single-page app. The script uses:

- **MutationObserver** on `document.body` with `childList: true, subtree: true` — detects all DOM changes
- **IntersectionObserver** for cards not yet visible in the viewport (lazy-loaded slider rows)
- **WeakMap** tracking processed elements by `element → "title||year"` key — handles Netflix reusing DOM elements for different titles

**Element handlers:**

| Handler | Targets | Badge Position |
|---------|---------|----------------|
| `handleModal` | `.previewModal--container`, `[role="dialog"]` | Below title info |
| `handleBillboard` | `.billboard-row` | Below logo |
| `handleHover` | `.jawBone`, `.bob-card`, `[data-uia="jawbone"]` | Top-right of preview |
| `handleCard` | `.slider-item`, `.title-card` | Top-right (non-clickable) |

### Netflix ID Extraction

Netflix uses different URL patterns depending on context:

- **Detail modal**: URL changes to `/title/{netflixID}` — extractable from `window.location`
- **Mini modal**: URL does NOT change — extract from `<a href="/title/{id}">` inside the modal
- **Cards**: Use `/watch/{id}` in `<a href>` — NetflixIdExtractor handles both `/title/` and `/watch/` patterns

### Anti-Bot Strategy

IMDb blocks standard `fetch()` requests (returns HTTP 202). The script uses `GM_xmlhttpRequest` (runs from Tampermonkey's extension context) with the `facebookexternalhit/1.1` User-Agent — IMDb whitelists this crawler and returns HTTP 200 with full HTML including `og:title` metadata.

### Rate Limiting

OMDb allows 1,000 requests/day on the free tier. The script:

- Tracks daily usage via `GM_setValue` with a date-based key
- Reserves 50 requests as buffer (hard limit: 950/day)
- Falls back to IMDb scraper when rate limit is reached
- Shows remaining count in the stats menu

### Click Handling

Badge clicks are intercepted via delegated `click` and `mousedown` listeners on `document`. When a click targets `.nimdb-badge`, `stopPropagation()` prevents Netflix's own click handlers from intercepting the navigation. Card badges use `pointer-events: none` to be visual-only (Netflix cards already have their own click behavior).

## Menu Commands

Access via Tampermonkey icon → Netflix IMDb Ratings:

| Command | Description |
|---------|-------------|
| **Settings** | Edit TMDb and OMDb API keys |
| **Toggle Force Refresh** | Skip cache, refetch all titles (does not clear DB) |
| **Toggle Debug Mode** | Log lookup details to F12 console |
| **Clear Local DB** | Wipe all cached ratings |
| **Show Stats** | View cache size, API usage, force refresh status |

## Troubleshooting

1. **No badges appearing**: Open F12 console, look for `[Netflix IMDb]` logs. If you see "DB read error", your IndexedDB may be corrupted — use "Clear Local DB" from the menu.
2. **All badges showing "—"**: Your OMDb key may be invalid or rate-limited. Check "Show Stats" for remaining quota.
3. **Badges showing gray**: The title could not be matched via TMDb or OMDb search. Try "Toggle Force Refresh" to refetch.
4. **Console not showing logs**: Toggle Debug Mode from the Tampermonkey menu.

## License

MIT
