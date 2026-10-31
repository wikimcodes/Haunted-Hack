# Deploying

The website goes on Vercel. The game server and its four Relay agents go on Railway, because they must keep running: the agents poll Agent Relay every few seconds, and the server keeps timers and in-memory caches. Serverless platforms (Vercel Functions, Supabase Edge Functions) stop between requests, so they cannot host the backend. The Terse actors run on Terse cloud. Supabase stays optional, for the leaderboard.

```
Players ──► Vercel (frontend-game) ──► Railway (backend/server: API + agents) ──► Terse cloud actors
                                                                              ──► Agent Relay, OpenAI, ElevenLabs, Supabase
```

## 0. Before you start

- **Terse actors are deployed and up to date.** From `backend/actor/`, the Terse project owner runs `terse auth login` and then `terse deploy`. Redeploy after any change to `backend/actor/`.
- **A Terse API key that can access the project.** Check it from `backend/server/`:

  ```sh
  curl -s -o /dev/null -w "%{http_code}\n" -X POST "$TERSE_ACTOR_URL/access" -H "Authorization: Bearer $TERSE_API_KEY"
  ```

  `200` means the key works. `403` means the key is valid but has no access to this project, so get a key from the project owner. `401` means the key is missing or wrong.
- **A hosted Agent Relay workspace.** Run `bun run setup:relay` once in `backend/server/`. It writes `.relay.json`.
- **Only one copy of the agents per Relay workspace.** Stop any local `bun demo.ts` that uses hosted Relay while Railway runs. Otherwise both copies answer the same messages. For local testing alongside Railway, use `RELAY=local bun demo.ts`.

## 1. Backend on Railway

The free trial ($5 credit for 30 days, no card) covers a demo. For a full month, use Hobby ($5/month); the backend uses roughly 150–300 MB of memory.

1. **New Project → Deploy from GitHub repo**, and pick this repository. Railway's GitHub app must be allowed on the repository's owner account.
2. In the service's **Settings**:
   - **Root Directory**: `backend/server`. Railway finds the `Dockerfile` there.
   - **Healthcheck Path**: `/health`
   - **Networking → Generate Domain**. Note the URL, for example `https://spy-monster.up.railway.app`.
3. In the service's **Variables**:

   | Variable | Value |
   |---|---|
   | `TERSE_ACTOR_URL` | from `backend/server/.env` |
   | `TERSE_API_KEY` | a key that passed the check above |
   | `RELAY_CONFIG_JSON` | the whole contents of `backend/server/.relay.json`, pasted as one value |
   | `OPENAI_API_KEY` | from `backend/server/.env` |
   | `ALLOWED_ORIGIN` | the Vercel URL from step 2 below. Use `*` until you have it. |
   | `ELEVENLABS_API_KEY` | optional: ghost and witch voices |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | optional: leaderboard |

   Railway sets `PORT` itself. See `ENV.md` for every other variable.
4. Deploy. On each start the container generates the Terse client from the deployed actors, then starts the agents and the server. To check it, open `https://<railway-domain>/health`; it should return `{"ok":true,...}`. The Director View is at `/director`.

## 2. Frontend on Vercel

1. **Add New → Project**, and import this repository.
2. **Root Directory**: `frontend-game`. Vercel detects Vite, and the defaults are right: build `npm run build`, output `dist`.
3. **Environment Variables**: set `VITE_API_URL` to the Railway URL, for example `https://spy-monster.up.railway.app`. Vite bakes it in at build time, so redeploy after changing it.
4. Deploy, then set `ALLOWED_ORIGIN` on Railway to the Vercel URL, for example `https://spy-monster.vercel.app`, and redeploy the backend.

## 3. Updating

- Pushing to the branch each service watches redeploys it.
- After changing `backend/actor/`, run `terse deploy` first. Then redeploy Railway so the generated client matches the actors.
- The sound files in `frontend-game/public/audio/` are static. They need no API key at runtime.
