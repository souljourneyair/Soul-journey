# AGENTS.md

## Project
"Путешествие души" (Soul Journey) — a single-player browser airport-management game.
Node.js + Express 5 + `ws`, no build step, no TypeScript, no bundler. All UI text,
code comments, and docs are in **Russian** — keep user-facing strings and comments
in Russian.

## Commands
- `npm install` then `npm start` (`start` and `dev` are identical: `node server/index.js`).
- Store regression tests: `npm run test:store` (Node.js built-in test runner).
- No lint, typecheck, or codegen scripts exist. Verify changed files with `node --check <file>`.
- Serves on http://localhost:3000 (override with `PORT` env var).
- Reset a password only with the server stopped: `node server/scripts/reset-password.js <login> <password>` (min 4 chars).
- Media tools: `node scripts/migrate-media.js [--clean]` and `node scripts/optimize-images.js [--apply]` (needs `sharp` or ImageMagick).

## Architecture
- `server/index.js` — ~4700-line monolith holding **every** Express route plus the game tick. No router modules.
- `server/store.js` — the only data layer (file-backed JSON store). To swap storage, replace just this file.
- `server/gameData.js` — the single source of balance/config (`CONFIG`, `BUILDINGS`, `*_ECONOMY`, `RATING`, …). Change numbers here, not in `index.js`.
- `server/disasters.js` — random/admin-triggered emergency events module.
- `public/app.js` (client logic), `public/index.html` + `style.css` (game UI), `public/admin.*` (admin panel).

## Game loop & config
- **1 tick = 2 game hours** (`CALENDAR` in `server/gameData.js`): day = 12 ticks (2 real min), week = 84 (14 min), month = 360 (1 real hour), year = 4320. Time display steps by 2 hours. See `docs/SCENARIO.md` §9.1.
- `CONFIG.TICK_MS` is normally `10 * 1000` (10s), but the repo currently has a **temporary ×3 test speed** (`Math.round(10 000 / 3)` ≈ 3.3s). Return it to `10 * 1000` for production.
- `CONFIG.BUILD_TIME_SCALE` is `1.0` (honest build times).
- Note: README's "60 000 ms" claim for `TICK_MS` is stale; the code is the source of truth (10s).

## Persistence (important)
- The database is `data.json` at repo root (gitignored), created on first run. Never commit it.
- Exactly one process may own the database. `server/store.js` creates an exclusive `data.json.lock`; a second server or maintenance script must stop with a clear error.
- The in-memory cache is the single source of truth while the process runs. Writes are delayed (~500ms), use a unique temporary file + `fsync` + atomic rename, and flush on exit / SIGINT / SIGTERM.
- A periodic stat-signature check detects external edits; it never silently reloads them over memory. On a conflict the store writes a `data.json.memory-conflict-...` snapshot and refuses to overwrite the changed file.
- Run maintenance scripts (including `reset-password.js`) only after stopping the server. If a crash leaves `data.json.lock`, check the recorded PID is no longer running before manually deleting the stale lock.
- Corrupt JSON is copied to `data.json.corrupt-...` and startup fails instead of creating an empty database.
- Schema changes are applied as idempotent soft-migrations inside `store.js` `readFromDisk()`.

## Auth & admin
- Token auth via `Authorization: Bearer <token>`; live updates over WebSocket at `/ws?token=…`.
- Logins are case-insensitive and trimmed (`store.normalizeUsername`).
- Seed account `SoulJourney` is created as the initial administrator when absent; a generated temporary password must be changed on first login. Admin UI at `/admin.html`; admin API routes require `isAdmin`.

## Conventions & gotchas
- No native dependencies on purpose (avoids `better-sqlite3`/node-gyp build failures on VPS). Keep deps limited to `express`/`ws`/`bcryptjs`.
- Docs: `README.md` is the full feature spec; `docs/BUILDINGS.md` and `docs/MECHANICS.md` describe mechanics with numbers synced to code; `docs/TODO.md` tracks outstanding work.
- Building/screen images resolve from `public/uploads/` (see `docs/media-folders.md`); `server/mediaScan.js` rescans folders every 30s.
