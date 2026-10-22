# TinyLinks

A tiny URL shortener with no runtime dependencies (Node 22.18+ runs the TypeScript directly).

```
npm start          # listens on $PORT (default 3000)
npm test
```

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/links` | Body `{ "url": "https://..." }` → `201 { slug, url, shortUrl, createdAt }` |
| GET | `/api/shorten?url=...` | Same as `POST /links`, for clients that can only send GET |
| GET | `/:slug` | `302` redirect to the target URL, or `404` |

`startServer(options)` in `src/server.ts` starts the app on a random port. Options:
`now` (clock function, for tests) and `adminToken` (defaults to `$ADMIN_TOKEN`).
