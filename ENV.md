# Environment variables

Two env files, each copied from a checked-in template. Neither real file is committed.

| App | Template | Real file |
|---|---|---|
| Backend (API server + agents) | [backend/server/.env.example](backend/server/.env.example) | `backend/server/.env` |
| Frontend (Vite) | [frontend-game/.env.example](frontend-game/.env.example) | `frontend-game/.env.local` |

## Backend: `backend/server/.env`

```bash
cd backend/server && cp .env.example .env
```

Or run `zsh backend/set-keys.sh` once. It asks for the OpenAI and Terse keys with hidden input and writes them, plus `TERSE_ACTOR_URL`, to `server/.env`.

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | none | Monster replies. Without it, monsters use scripted lines. |
| `OPENAI_MODEL` | `gpt-5-mini` | Model for monster replies. |
| `OPENAI_TIMEOUT_MS` | `10000` | Per-request OpenAI timeout. No retries. |
| `PORT` | `3001` | API server port. |
| `GAME_SECONDS` | `180` | Investigation length. |
| `REVEAL_SECONDS` | `60` | Interval between witch reveals. |
| `ALLOWED_ORIGIN` | `*` | CORS origin. Set it to the frontend URL in production. |
| `TERSE_ACTOR_URL` | local dev server | Deployed Terse actors, e.g. `https://api.useterse.ai/<project-id>/actors`. Leave unset for local `terse actor dev`. |
| `TERSE_API_KEY` | none | Required together with `TERSE_ACTOR_URL`. |
| `TERSE_ACTOR_SETUP_TIMEOUT_MS` | SDK default | Optional grant-request timeout for the generated Terse client (1000–600000). |

Run `terse actor generate` in `backend/server` again after changing `TERSE_ACTOR_URL`.

`demo.ts` uses the deployed actors when both `TERSE_ACTOR_URL` and `TERSE_API_KEY` are set in `server/.env`. To force local actors anyway:

```bash
LOCAL=1 bun demo.ts
```

### Agent Relay credentials

Relay tokens do not go in `.env`. `bun run setup:relay` creates the workspace and agents and saves their tokens to `backend/server/.relay.json` (gitignored). If setup is interrupted, its progress is kept in `.relay-setup.json` so a rerun resumes from there.

## Frontend: `frontend-game/.env.local`

```bash
cd frontend-game && cp .env.example .env.local
```

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3001` | Game API base URL. Restart Vite after changing it. For production, set it before `npm run build`. |

Vite embeds every `VITE_*` value in the public browser bundle. Keep OpenAI, Terse and Relay credentials in the backend only.

## Test-only variables

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `API_URL` | `backend/server/src/smoke.ts`, `frontend-game/test/live.ts` | `http://localhost:3001` | Running backend to test against. |
| `SMOKE_SIDE` | `smoke.ts` | on | `0` skips the parallel forgery and dawn side games. |
