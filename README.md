# The Spy Monster

Explore a haunted library, question three spirits and find the witch's spy before dawn. The project combines a walkable Three.js scene with a server-authoritative investigation backed by Terse durable actors and Agent Relay.

## Open the web frontend

```bash
cd frontend-game
npm ci
cp .env.example .env.local
npm run dev
```

Open **http://127.0.0.1:5180**. Choose **Explore the library** to walk through the room without starting the backend. Use WASD to move, Shift to move faster, the mouse or drag to look, and E near a spirit to interact. Touch movement controls are also available.

In Explore mode, open the menu and choose **Preview the witch’s reveal** to see and hear the six-second window reveal. It is explicitly labelled **SCENE PREVIEW** and does not create a clue or change an investigation. Sound begins after clicking to enter; the speaker control on the title screen, in the HUD or in the menu mutes it and remembers that choice.

**Begin investigation** requires the real game API, actors and agent processes. See [backend setup](backend/README.md), and set `VITE_API_URL` in `frontend-game/.env.local` if the API is not at `http://localhost:3001`. The frontend does not simulate AI conversations or sponsor activity when the backend is unavailable.

## Project layout

| Path | Contents |
|---|---|
| [frontend-game/](frontend-game/README.md) | React/TypeScript UI, first-person Three.js renderer, collisions and HTTP/WebSocket client |
| [backend/](backend/README.md) | Terse actors, Bun API and independent Relay agents |
| [DEPLOY.md](DEPLOY.md) | Hosting: backend on Railway, website on Vercel |
| [ENV.md](ENV.md) | Every environment variable for the backend, frontend and tests |
| [docs/ASSETS.md](docs/ASSETS.md) | GLB pipeline, materials and texture credits |
| [PRD.md](PRD.md) | Product requirements and game design |

The frontend includes nearby-spirit selection, animated ghosts, a cinematic witch, dialogue, witch omens, accusation confirmation and server-driven endings. The witch uses worn dark cloth and restrained rim lighting to match the library. Wide, per-monster close-up and witch-reveal camera modes share the same walkable scene. Lighting follows public story state only: a warm introduction, darker suspicion, a purple reveal and the server-determined ending. A correct accusation opens the escape door into dawn light.

Reduced-motion preferences suppress automatic camera travel and candle oscillation. **Director View** opens in a separate tab from the title screen, menu or ending, pinned to the current game when one is available. The existing backend page keeps its live Relay feed masked during play; after the game ends, it reveals the real messages, information-flow graph and Terse event timeline.

Two sound assets generated with ElevenLabs add a 29.5-second horror room loop of reversed whispers, distant humming, scraping and groans, plus a six-second witch reveal (570,181 bytes total, about 0.57 MB). Reveal playback follows the same `CameraDirector` clock as the shot, including cancellation and resuming from the current phase. Audio pauses when the tab is hidden. See the [frontend audio guide](frontend-game/README.md#sound) for controls and asset regeneration.

## Build and verify

From `frontend-game/`:

```bash
npm test
npm run build
npm run preview
```

The frontend production build and its 38 automated tests pass. Five additional Director data/privacy tests pass. Coverage includes client lifecycle, collisions, cinematic camera restoration, Director URL handling and audio timing/cleanup. Local integration has verified real game creation, a fallback monster reply, WebSocket state, a timed witch clue and a connected browser session against Terse and Agent Relay. True OpenAI replies, complete correct/incorrect-accusation browser flows and physical mobile controls still need verification. Browser checks verified gesture unlock, persisted mute, the reveal preview and a separate Director tab pinned to the current session with live evidence masked. Physical-device audio balance and mobile audio still need checking. Deployment of the static `dist/` output and backend are separate operations.

## 3D assets

Six GLBs provide the library, Sprout, Pebble, Momo, the escape door and the witch. WebP textures and Meshopt compression reduce the six models from 69.48 MB to 12.81 MB, retaining 420,345 triangles; HDRI and poster are additional. `presentation-manifest.json` supplies camera and lighting anchors, while the witch retains its eight-second deforming `Idle` cloth animation. The original five exports are preserved in commit [`dd9ccf6`](https://github.com/wikimcodes/Haunted-Hack/tree/dd9ccf6/frontend-game/public/assets/library); the editable Blender source and standalone `export_witch.py` are retained separately. The browser renders actual 3D geometry, while the Cycles poster serves as title/loading artwork. See the [asset pipeline](docs/ASSETS.md) before re-exporting.

The [frontend guide](frontend-game/README.md) documents controls, configuration, rendering limits and the API integration.
