# AGENTS.md

## Project
"Путешествие души" (Soul Journey) — a single-player browser airport-management game.
Node.js + Express 5 + `ws`, no build step, no TypeScript, no bundler. All UI text,
code comments, and docs are in **Russian** — keep user-facing strings and comments
in Russian.

## Commands
- `npm install` then `npm start` (`start` and `dev` are identical: `node server/index.js`).
- No test, lint, typecheck, or codegen scripts exist. Verify with a manual run or `node --check <file>`.
- Serves on http://localhost:3000 (override with `PORT` env var).
- Reset a password without stopping the server: `node server/scripts/reset-password.js <login> <password>` (min 4 chars).
- Media tools: `node scripts/migrate-media.js [--clean]` and `node scripts/optimize-images.js [--apply]` (needs `sharp` or ImageMagick).

## Architecture
- `server/index.js` — ~4700-line monolith holding **every** Express route plus the game tick. No router modules.
- `server/store.js` — the only data layer (file-backed JSON store). To swap storage, replace just this file.
- `server/gameData.js` — the single source of balance/config (`CONFIG`, `BUILDINGS`, `*_ECONOMY`, `RATING`, …). Change numbers here, not in `index.js`.
- `server/disasters.js` — random/admin-triggered emergency events module.
- `public/app.js` (client logic), `public/index.html` + `style.css` (game UI), `public/admin.*` (admin panel).

## Game loop & config
- One tick = 10s real time = 1 game minute (`CONFIG.TICK_MS = 10 * 1000`), driven by `setInterval(runTick, …)`.
- `CONFIG.BUILD_TIME_SCALE` is currently `0.05` (builds/upgrades 20x faster, for debugging) — catalog `buildTicks` are not what players see.
- Note: README's "60 000 ms" claim for `TICK_MS` is stale; the code is the source of truth (10s).

## Persistence (important)
- The database is `data.json` at repo root (gitignored), created on first run. Never commit it.
- In-memory cache with delayed flush (~500ms) and atomic tmp-file+rename writes; flushed on process exit / SIGINT / SIGTERM.
- External edits to `data.json` (e.g. `reset-password.js`) are detected via mtime stat-check and invalidate the cache — such scripts may run while the server is live.
- Schema changes are applied as idempotent soft-migrations inside `store.js` `readFromDisk()`.

## Auth & admin
- Token auth via `Authorization: Bearer <token>`; live updates over WebSocket at `/ws?token=…`.
- Logins are case-insensitive and trimmed (`store.normalizeUsername`).
- Seed account `SoulJourney` / `ggg777ggg` is auto-created as admin on every start (hardcoded in `server/seed.js`). Admin UI at `/admin.html`; admin API routes require `isAdmin`.

## Conventions & gotchas
- No native dependencies on purpose (avoids `better-sqlite3`/node-gyp build failures on VPS). Keep deps limited to `express`/`ws`/`bcryptjs`.
- Docs: `README.md` is the full feature spec; `docs/BUILDINGS.md` and `docs/MECHANICS.md` describe mechanics with numbers synced to code; `docs/TODO.md` tracks outstanding work.
- Building/screen images resolve from `public/uploads/` (see `docs/media-folders.md`); `server/mediaScan.js` rescans folders every 30s.
