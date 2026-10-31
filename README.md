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

**Begin investigation** requires the real game API, actors and agent processes. See [backend setup](backend/README.md), and set `VITE_API_URL` in `frontend-game/.env.local` if the API is not at `http://localhost:3001`. The frontend does not simulate AI conversations or sponsor activity when the backend is unavailable.

## Project layout

| Path | Contents |
|---|---|
| [frontend-game/](frontend-game/README.md) | React/TypeScript UI, first-person Three.js renderer, collisions and HTTP/WebSocket client |
| [backend/](backend/README.md) | Terse actors, Bun API and independent Relay agents |
| [docs/ASSETS.md](docs/ASSETS.md) | GLB pipeline, materials and texture credits |
| [PRD.md](PRD.md) | Product requirements and game design |

The frontend includes nearby-spirit selection, animated ghosts, dialogue, witch omens, accusation confirmation and server-driven endings. The escape door opens on a correct accusation. Post-game Director evidence is currently shown as raw JSON; the backend also has its own Director page.

## Build and verify

From `frontend-game/`:

```bash
npm test
npm run build
npm run preview
```

The production build and 14 client/collision tests passed during implementation. Live end-to-end gameplay with the backend has not been verified for this change; run the backend and its agents before performing that check. Deployment of the static `dist/` output and backend are separate operations.

## 3D assets

Five GLBs provide the library, Sprout, Pebble, Momo and the escape door. Web delivery uses WebP textures and Meshopt compression. The original exports are preserved in commit [`dd9ccf6`](https://github.com/wikimcodes/Haunted-Hack/tree/dd9ccf6/frontend-game/public/assets/library); the editable Blender source is retained separately. The browser renders actual 3D geometry, while the Cycles poster serves as title/loading artwork.

This implementation is on branch `codex/cinematic-web-walkthrough`. The [frontend guide](frontend-game/README.md) documents controls, configuration, rendering limits and the API integration.
