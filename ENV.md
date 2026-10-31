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

Or run `zsh backend/set-keys.sh` once. It asks for the OpenAI and Terse keys with hidden input and writes them, plus `TERSE_ACTOR_URL`, to `server/.env`. For the leaderboard, run `backend/supabase/schema.sql` in the Supabase SQL Editor, then `zsh backend/set-supabase.sh`.

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
| `RELAY_CONFIG_JSON` | none | Contents of `.relay.json`, for hosts without a persistent disk (see `DEPLOY.md`). It takes precedence over the file. |
| `RELAY_MODE` | hosted | `local` points setup, the server and agents at a self-hosted Relay engine instead of hosted Agent Relay. |
| `RELAY_LOCAL_URL` | `http://localhost:8787` | Address of that local engine. |
| `WITCH_VOICE` | `fable` | OpenAI text-to-speech voice for spoken clues. |
| `WITCH_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI text-to-speech model. |
| `ELEVENLABS_API_KEY` | none | With `ELEVENLABS_VOICE_ID`, the witch speaks with ElevenLabs instead of OpenAI. Any ElevenLabs error falls back to OpenAI. `zsh backend/set-elevenlabs.sh` saves it with hidden input. |
| `ELEVENLABS_VOICE_ID` | none | ElevenLabs voice for the witch. Required for ElevenLabs speech. |
| `ELEVENLABS_MODEL` | `eleven_multilingual_v2` | ElevenLabs text-to-speech model. |
| `ELEVENLABS_VOICE_SPROUT` | Jessica (`cgSgspJ2msm6clMCkdW9`) | Sprout's voice. With `ELEVENLABS_API_KEY` set, each ghost speaks its replies in its own voice. Without the key, the ghosts use OpenAI voices (`coral`, `verse`, `onyx`). |
| `ELEVENLABS_VOICE_PEBBLE` | Charlie (`IKne3meq5aSn9XLyUdCD`) | Pebble's voice. |
| `ELEVENLABS_VOICE_MOMO` | Callum (`N2lVS1w4EtoT3dr4eOWO`) | Momo's voice. |
| `ELEVENLABS_CONCURRENCY` | `2` | ElevenLabs requests in flight at once. Extra lines queue, and a 429 is retried before falling back to OpenAI. Raise it if your plan allows more. |
| `SUPABASE_URL` | none | Optional cross-game leaderboard. Without it, games are not archived and the game runs unchanged. |
| `SUPABASE_SERVICE_ROLE_KEY` | none | Required together with `SUPABASE_URL`. Server-only: never expose it to the frontend. |

The generated client reads `TERSE_ACTOR_URL` and `TERSE_API_KEY` at runtime, so changing them needs only a server restart. Run `terse actor generate` in `backend/server` again only after changing actor methods.

`demo.ts` uses the deployed actors when both `TERSE_ACTOR_URL` and `TERSE_API_KEY` are set in `server/.env`. To force local actors anyway:

```bash
LOCAL=1 bun demo.ts
```

`RELAY=local bun demo.ts` starts the open-source Relay engine (`npx @relaycast/engine`) on port 8787 and sets `RELAY_MODE=local` for everything it launches. Use it when hosted Relay is slow or overloaded. When starting processes by hand, set `RELAY_MODE=local` on each of them yourself.

### Agent Relay credentials

Relay tokens do not go in `.env`. `bun run setup:relay` creates the workspace and agents and saves their tokens to `backend/server/.relay.json` (gitignored). If setup is interrupted, its progress is kept in `.relay-setup.json` so a rerun resumes from there.

Local mode keeps a separate workspace in `.relay.local.json`, with progress in `.relay-setup.local.json`. The engine's own data lives in `backend/relay-local/`. All of these are gitignored.

## Frontend: `frontend-game/.env.local`

```bash
cd frontend-game && cp .env.example .env.local
```

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3001` | Game API base URL. Restart Vite after changing it. For production, set it before `npm run build`. |

Vite embeds every `VITE_*` value in the public browser bundle. Keep OpenAI, Terse and Relay credentials in the backend only.

## Build-time variables

| Variable | Where | Purpose |
|---|---|---|
| `ELEVENLABS_API_KEY` | `backend/server/.env` | Used by `npm run audio:elevenlabs` in `frontend-game/` to regenerate the room loop and witch reveal sounds. The server also reads it at runtime for the witch's voice (see the backend table). Never sent to the browser. |
| `ELEVENLABS_SFX_MODEL` | shell | Optional. Sound Effects model, default `eleven_text_to_sound_v2`. |

## Test-only variables

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `API_URL` | `backend/server/src/smoke.ts`, `frontend-game/test/live.ts` | `http://localhost:3001` | Running backend to test against. |
| `SMOKE_SIDE` | `smoke.ts` | on | `0` skips the parallel forgery and dawn side games. |
