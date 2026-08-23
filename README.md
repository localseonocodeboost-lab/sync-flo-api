# Sync Flo API

Recovered backend for the Sync Flo Google Visibility Check.

## Local setup
1. Copy `.env.example` to `.env.local`.
2. Put the real `GOOGLE_PLACES_API_KEY` in `.env.local`.
3. Run `npm install` then `npm run dev`.

The API routes are:
- `POST /api/places`
- `POST /api/crawl`

Both routes include CORS support for `https://syncflo.co.uk` and `https://www.syncflo.co.uk`.
