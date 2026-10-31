# The Spy Monster: backend

Terse durable actors hold the game. Agent Relay carries every whisper. OpenAI writes the monsters' lines.

```
actor/    Terse project: GameActor (referee + witch + clock) and MonsterActor (each monster's memory)
server/   Game API (Bun), OpenAI calls, and the Relay agent processes (sprout, pebble, momo, witch)
```

## Run it locally

**One command** (after the one-time `bun install` in `actor/` and `server/`):

```bash
cd backend && bun demo.ts
```

Keys: run `zsh backend/set-keys.sh` once. It asks for the OpenAI and Terse API keys with hidden input and writes `server/.env`. With a Terse key set, `demo.ts` uses the deployed cloud actors (`LOCAL=1 bun demo.ts` forces local).

It starts the game server and the four agents (plus local Terse when not deployed), creates a Relay workspace if there isn't one, and stops everything on Ctrl+C.

**If hosted Agent Relay is overloaded** (sends take 10-30s or fail with 503 "database_overloaded"), run Relay's open-source engine on the laptop instead:

```bash
cd backend && RELAY=local bun demo.ts
```

It starts `@relaycast/engine` on port 8787, creates a separate local workspace (`server/.relay.local.json`) and points the server and agents at it. Sends drop to milliseconds. Same Agent Relay protocol and SDK, just not the hosted cloud.

**Or by hand (3 terminals):**

Needs Bun 1.4.2+ (`bun upgrade`) and the Terse CLI (`bunx terse-cli@latest install --yes`).

```bash
# 1. Actors
cd backend/actor && bun install && terse actor dev
```

```bash
# 2. One-time setup, then the API server
cd backend/server && bun install
terse actor generate          # typed client in server/generated (rerun after changing actor methods)
bun run setup:relay           # creates a Relay workspace + 5 agents, saves tokens to .relay.json
cp .env.example .env          # add OPENAI_API_KEY (optional: without it monsters use scripted lines)
bun run dev                   # http://localhost:3001
```

```bash
# 3. The four agents, each its own process with its own Relay token
cd backend/server && bun run agents
```

**Director View:** open http://localhost:3001/director on the judges' screen. The charcoal dashboard shows session metrics, observed message activity, a horizontal participant flow, Relay messages, clues and the Terse timeline. Use `?game=` to pin a session; otherwise it selects the latest available game. During play, counts and public omens are visible while identities, message text and actual routes stay hidden. After the ending, filters and clue selection trace real reports, upstream gossip, graph edges and events. A zero countdown still says “Awaiting outcome” until the server ends the game. All chart values come from the selected game; unavailable data is labeled explicitly. Sprout, Pebble, Momo and Witch use portraits rendered from the same exported character GLBs as the game. The graph shows all four public characters; message portraits appear only after private evidence unlocks. See `server/public/director-portraits/README.md` for source hashes and regeneration.

The page is served from `server/public/director.html`, with explicit CSS/JS/model asset routes. Run its five data/privacy checks with `node --test server/public/director-model.test.mjs` from `backend/`. Browser QA covered completed and in-progress sessions, clue links, filters, session switching and the narrow layout.

Check everything with `bun run smoke` (plays a short game, a forged-report attack and a dawn timeout). `SMOKE_SIDE=0 bun run smoke` runs only the main game.

## API (for the frontend)

| Call | Body | Returns |
|---|---|---|
| `POST /api/game/start` | `{ gameSeconds?, revealSeconds? }` | `PublicGameState` (has `sessionId`) |
| `GET /api/game/:id` | | `PublicGameState` |
| `POST /api/game/:id/chat` | `{ monsterId, message, requestId }` | `{ monsterId, reply, factId, source }` |
| `POST /api/game/:id/accuse` | `{ monsterId }` | `{ outcome, state }` |
| `POST /api/game/:id/socket` | `{ role: "player" }` | `{ websocketUrl, ... }` (Terse grant) |
| `GET /api/game/:id/director` | | Full evidence + messages re-read from Relay. `403` while playing |
| `GET /api/games/recent` | | Last 20 games (kept in a Terse `Lobby` actor) |

`monsterId` is `sprout`, `pebble` or `momo`. Send a fresh `requestId` per chat message; retries with the same id return the same answer.

### Live updates

Open the `websocketUrl` from `/socket` right away (it expires). You receive:

- `{ type: "state", state: { publicState } }` on connect.
- `{ type: "state_update", changes: { publicState } }` after every change (moods, clues, phase).
- `{ type: "cue", cue, monsterId?, at }` for animations: `MONSTER_THINKING`, `MONSTER_SPEAKING`, `GOSSIP_STARTED`, `WITCH_REVEAL`, `ACCUSATION_CORRECT`, `ACCUSATION_WRONG`, `GAME_EXPIRED`.

`publicState.spyId` is `null` until the game ends. Countdown: render from `deadlineAt`; the server decides when time is up.

## How a whisper travels

1. Player chats with Sprout. The server records the fact in `GameActor`, gets Sprout's reply from OpenAI, and DMs the fact to the `sprout` agent over Relay (from `gamemaster`).
2. The `sprout` process may gossip it: `GameActor.reserveGossip` checks the quota, then Sprout DMs another monster over Relay.
3. The receiver re-reads the message from Relay (authenticated sender + metadata) and `GameActor.receiveGossip` checks it matches the reservation.
4. Whoever is the spy DMs the witch. The `witch` process passes Relay's sender to `GameActor.acceptReport`, which rejects anyone who is not the spy.
5. The actor alarm fires every reveal interval (even with no one connected) and the witch echoes a report, clears an innocent, or counts whispers.

## The witch's voice

Each revealed clue can be spoken with OpenAI text-to-speech (`gpt-4o-mini-tts`, voice set by `WITCH_VOICE`, default `fable`): `GET /api/game/:id/voice/:clueId` returns an MP3. Only clues already in the public state can be voiced, so it never leaks anything early; each clue is generated once and cached. The Director screen has a **Sound** button (browsers need one click before playing audio) and then reads every new clue aloud; the frontend hook does the same automatically.

The ghosts speak too. Each has its own voice: by default Sprout is Jessica, Pebble is Charlie and Momo is Callum, from the premade ElevenLabs voices. Without an ElevenLabs key they use the OpenAI voices `coral`, `verse` and `onyx`. A chat that sends `voice: true` returns `voice: true` once the server starts speaking the reply, and `GET /api/game/:id/reply-voice/:requestId` returns the MP3. Only replies the server generated can be spoken. ElevenLabs calls queue (`ELEVENLABS_CONCURRENCY`, default 2), so the plan's concurrency limit is not exceeded, and a 429 is retried before falling back to OpenAI.

## Leaderboard (Supabase, optional)

Live games stay in Terse actors (one per game). When a game ends, the server writes one summary row to Supabase Postgres, so all-games questions never wake every actor. Accusations archive immediately; dawn endings are picked up by a 10-second sweep. The Director screen shows an "All games" panel (games played, escape rate, fastest catch, most deceptive monster); `GET /api/leaderboard` returns the same data.

Setup: create a Supabase project, run `backend/supabase/schema.sql` in the SQL Editor, then `zsh backend/set-supabase.sh <project-url>` to save the service key with hidden input. Without these keys the game runs unchanged.

To clear test games before judging: `truncate public.games;` in the SQL Editor.

## One link + QR code for everyone

The game server also serves the built website (`frontend-game/dist`, built by `demo.ts` with `VITE_API_URL=/`), so the game and the API share one address. To let anyone play from their phone:

1. Start everything: `cd backend && RELAY=local bun demo.ts`
2. In another terminal, open a public link to it: `cloudflared tunnel --url http://localhost:3001` (it prints `https://…trycloudflare.com`)
3. On the big screen, open `<that link>/director` and click **Scan to play**. The QR code points at the public link; people scan it and play in their browser.

The tunnel stays up only while that command runs. Close it with Ctrl+C after the demo.

## Phones on the same wifi

Point the frontend's `apiUrl` at the laptop's address (`ipconfig getifaddr en0`, e.g. `http://172.17.19.187:3001`). With local actors, socket grants then go through `/terse-ws` on the game server, which relays to the local Terse runtime (it only listens on 127.0.0.1). Venue wifi that isolates devices will block this; deploy instead.

## Deploying

`terse deploy` (from `actor/`, needs `terse auth login`) hosts the actors. Then set `TERSE_ACTOR_URL` and `TERSE_API_KEY` in `server/.env` and rerun `terse actor generate`. The server and agents can run on any host with Bun; `server/Dockerfile` runs both in one container. See [DEPLOY.md](../DEPLOY.md) for Railway (backend) plus Vercel (website).

## Known limits

- Relay's push delivery can lag by 10 to 30 seconds, so agents also poll their own inbox every 3s (backing off when Relay is busy). Messages from before an agent started are ignored. If hosted Relay is overloaded (HTTP 503 "database_overloaded", sends taking 10-30s), whispers and spy reports arrive late; clues then fall back to whisper counts and clearing an innocent.
- Relay rate-limits bursts (HTTP 429 "workspace busy"). Every Relay call retries with backoff and an idempotency key, so nothing is duplicated. Several games at once can delay whispers by a few seconds.
- If OpenAI fails or times out (8s), monsters fall back to scripted lines (`source: "fallback"`).
- Duplicate-request memory is per server process.
