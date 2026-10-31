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

In Explore mode, open the menu and choose **Preview the witch’s reveal** to see the six-second window reveal. It is explicitly labelled **SCENE PREVIEW** and does not create a clue or change an investigation.

**Begin investigation** requires the real game API, actors and agent processes. See [backend setup](backend/README.md), and set `VITE_API_URL` in `frontend-game/.env.local` if the API is not at `http://localhost:3001`. The frontend does not simulate AI conversations or sponsor activity when the backend is unavailable.

## Project layout

| Path | Contents |
|---|---|
| [frontend-game/](frontend-game/README.md) | React/TypeScript UI, first-person Three.js renderer, collisions and HTTP/WebSocket client |
| [backend/](backend/README.md) | Terse actors, Bun API and independent Relay agents |
| [ENV.md](ENV.md) | Every environment variable for the backend, frontend and tests |
| [docs/ASSETS.md](docs/ASSETS.md) | GLB pipeline, materials and texture credits |
| [PRD.md](PRD.md) | Product requirements and game design |

The frontend includes nearby-spirit selection, animated ghosts, a cinematic witch, dialogue, witch omens, accusation confirmation and server-driven endings. The witch uses worn dark cloth and restrained rim lighting to match the library. Wide, per-monster close-up and witch-reveal camera modes share the same walkable scene. Lighting follows public story state only: a warm introduction, darker suspicion, a purple reveal and the server-determined ending. A correct accusation opens the escape door into dawn light.

Reduced-motion preferences suppress automatic camera travel and candle oscillation. Post-game Director evidence is currently shown as real raw JSON; the backend also has its own Director page. This frontend has no audio playback.

## Build and verify

From `frontend-game/`:

```bash
npm test
npm run build
npm run preview
```

All 22 automated tests and the production build passed. Checks cover client lifecycle, collision behavior and cinematic camera restoration. Live end-to-end gameplay with the backend has not been verified for this change because it is unavailable locally; run the backend and its agents before performing that check. Deployment of the static `dist/` output and backend are separate operations.

## 3D assets

Six GLBs provide the library, Sprout, Pebble, Momo, the escape door and the witch. WebP textures and Meshopt compression reduce the six models from 69.48 MB to 12.81 MB, retaining 420,345 triangles; HDRI and poster are additional. `presentation-manifest.json` supplies camera and lighting anchors, while the witch retains its eight-second deforming `Idle` cloth animation. The original five exports are preserved in commit [`dd9ccf6`](https://github.com/wikimcodes/Haunted-Hack/tree/dd9ccf6/frontend-game/public/assets/library); the editable Blender source and standalone `export_witch.py` are retained separately. The browser renders actual 3D geometry, while the Cycles poster serves as title/loading artwork. See the [asset pipeline](docs/ASSETS.md) before re-exporting.

This implementation is on branch `codex/cinematic-web-walkthrough`. The [frontend guide](frontend-game/README.md) documents controls, configuration, rendering limits and the API integration.
