# Netflix IMDb Ratings

A Tampermonkey userscript that shows IMDb ratings on Netflix titles with local caching.

## Features

- Displays IMDb/TMDb ratings on Netflix cards, hover previews, modals, and billboard
- Confidence-based badge colors (green → red based on vote count)
- Click badges to open IMDb page
- Local IndexedDB cache with tiered TTL (7d/30d/90d based on title age)
- TMDb-powered title search (unlimited, free)
- OMDb rating lookup by IMDb ID
- TMDb rating fallback when OMDb returns N/A
- Force refresh mode to refetch all titles
- Debug mode for troubleshooting

## Setup

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser
2. Create a free [OMDb API key](https://www.omdbapi.com/apikey.aspx) (required)
3. Create a free [TMDb API key](https://www.themoviedb.org/settings/api) (recommended)
4. Install the script from `netflix-imdb-ratings.user.js`
5. Enter your API keys when prompted

## API Flow

```
TMDb /search/multi  →  IMDb ID + TMDb rating
OMDb ?i=tt1234567   →  IMDb rating (primary)
TMDb vote_average   →  fallback when OMDb N/A
```

## Badge Colors

| Color | Votes | Confidence |
|-------|-------|------------|
| Green | 10K+ | High |
| Yellow | 1K-10K | Medium |
| Orange | 100-999 | Low |
| Red | <100 | Very Low |

## Menu

Access via Tampermonkey icon → Netflix IMDb Ratings:

- **Settings** — Edit API keys
- **Toggle Force Refresh** — Skip cache, refetch all titles
- **Toggle Debug Mode** — Log details to console (F12)
- **Clear Local DB** — Wipe all cached ratings
- **Show Stats** — View cache size and API usage

## License

MIT
