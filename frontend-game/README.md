# The Spy Monster — Web frontend

A React, TypeScript and Three.js client for walking through the cinematic library and investigating its three spirits. The running scene renders the exported GLB models, including animated cloth, the escape door and a witch in worn dark robes that match the library. The Cycles poster is used on the title/loading screen.

## Run locally

Tested with Node 24 and npm 11. From this directory:

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open **http://127.0.0.1:5180**. Vite uses a strict port and reports an error if another process already occupies 5180.

`VITE_API_URL` defaults to `http://localhost:3001`. Change it in `.env.local` for a different game API, then restart Vite. For a production build, set it before building; Vite embeds this public URL in the browser bundle. Keep OpenAI, Terse and Relay credentials on the backend, never in `VITE_*` variables.

```bash
npm test                 # Client lifecycle, collision and cinematic tests
npm run typecheck
npm run build            # Type-check and produce dist/
npm run preview          # Serve the production build, normally on port 4173
```

Host the generated `dist/` directory on a static web host. The API and its agent processes run separately; follow [backend setup](../backend/README.md). An HTTPS frontend needs an HTTPS API and a compatible secure WebSocket endpoint. The selected API must permit requests from the frontend's origin.

## Explore or investigate

**Explore the library** works without a backend. It loads the actual room, three animated ghosts, the door and the witch. You can walk around and approach the spirits. In the menu, **Preview the witch’s reveal** plays the six-second effect with a **SCENE PREVIEW** label. Exploration and this preview do not generate conversations, clues, a spy identity or a game result.

**Begin investigation** starts a real three-minute game through the existing API. Dialogue, witch omens, accusations and outcomes come from the server. The UI reports a connection failure if the API is unavailable, and exploration remains available. No deployed API is configured in this checkout.

| Control | Action |
|---|---|
| WASD or arrow keys | Walk |
| Shift | Walk faster |
| Mouse | Look around while pointer lock is active |
| Drag the scene | Look when pointer lock is unavailable |
| E or a nearby spirit's interaction label | Speak to the targeted spirit |
| Esc / menu | Release the mouse or open the pause menu |
| Touch movement pad + drag | Move and look on touchscreens |

Walls, shelves, counters and the tree use simplified collision proxies. Movement stays at walking height and slides along obstacles. Proximity selection prevents starting an interaction from across the room. Returning to the entrance resets the player position.

The pause menu does not pause a live investigation: the server's deadline continues. The accusation dialog asks for confirmation; only the backend determines the result. A successful game opens the escape door. After the game ends, **Behind the betrayal** retrieves actual Director evidence and displays it as raw JSON. It is not a fabricated event feed or a finished visual timeline.

## Cameras and story presentation

Three camera modes use the same scene: a wide entrance view, a close-up focused on the selected monster, and a witch reveal at the window. Monster framing is computed from the character and the player's position. Closing a conversation or completing a reveal restores the stored walking pose; opening the menu cancels the cinematic. The wide and reveal anchors are supplied by `presentation-manifest.json`.

During investigation, only public world state and public `WITCH_REVEAL` events drive presentation. The introduction is warm; the first published clue changes the room to suspicion lighting. A reveal briefly strengthens the purple window light, makes the witch clearer and modulates candle brightness, then returns after six seconds. Winning introduces dawn light and opens the door; losing darkens the room and exposes the witch. Hidden spy identity never selects lighting or camera treatment, and the frontend does not invent its own timed clues.

The renderer respects `prefers-reduced-motion`: automatic camera travel and candle oscillation are suppressed while the reveal caption and story lighting remain available. There is no audio playback in this version.

## Assets and rendering

Assets live in `public/assets/library/`:

- `environment.glb`: static library geometry.
- `sprout.glb`, `pebble.glb`, `momo.glb`: individual animated spirits.
- `door.glb`: the escape door and `Open` animation.
- `witch.glb`: the cinematic witch and eight-second looping `Idle` cloth morph animation.
- `forest.hdr`: distant scenery and environmental lighting.
- `asset-manifest.json`: original placements and asset metadata.
- `lighting-manifest.json`: Blender lighting reference values.
- `presentation-manifest.json`: wide/reveal camera presets, monster focus guidance and witch/window/exit light anchors in glTF coordinates.
- `validation-report.json`: Blender export/reimport checks.
- `witch-validation-report.json`: isolated witch GLB inspection and reimported cloth-animation checks.
- `web-validation-report.json`: compressed delivery checks.

The six runtime GLBs use WebP textures and Meshopt compression, reducing 69,477,436 source bytes to 12,812,884 delivery bytes (69.48 MB to 12.81 MB), with 420,345 triangles retained. HDRI and poster are additional. The witch accounts for 203,176 delivery bytes and 15,924 triangles. The original five uncompressed exports were committed in [`dd9ccf6`](https://github.com/wikimcodes/Haunted-Hack/tree/dd9ccf6/frontend-game/public/assets/library). The editable Blender source is retained separately. See the [asset pipeline and credits](../docs/ASSETS.md) for current validation files, texture provenance and the standalone `export_witch.py` workflow. Preserve `Idle` morph targets and weight animation when replacing or recompressing the witch.

The web renderer reconstructs the lighting using HDRI, realtime lights, shadows and fog. Blender Cycles area lights, volumetrics, compositor effects and depth of field are not automatically reproduced by GLB export. This is a realtime interpretation of the scene, not the offline render playing as a background.

## Game data layer

The existing `src/index.ts` exports remain usable independently of the rendered app. `useSpyMonster({ apiUrl })` connects to the actual HTTP API and Terse WebSocket grant flow; there is no SSE endpoint in this integration.

| Hook field | Meaning |
|---|---|
| `state` | Public world state, moods, clues and outcome; `spyId` stays null during play |
| `messages` | Local conversation history |
| `chat(id, text)` | Send a message, up to the server's 300-character limit |
| `waitingFor`, `error` | Pending reply and latest chat error |
| `secondsLeft`, `secondsToReveal` | Countdown displays derived from server deadlines |
| `connected` | Current live socket status |
| `start()`, `accuse(id)` | Server-controlled game actions |
| `useCue(handler)` | Subscribe to backend animation cues; call unconditionally in the component |
| `shareUrl()` | Link to rejoin the same session |
| `director()` | Post-game evidence; the server rejects access during play |

`messages` is separate from the `chat()` sending function. Animation moods use `Idle`, `Talk`, `Think` and `Accused`; `nervous` falls back to `Think`, because these exports contain no `Nervous` clip.

Refreshing resumes the saved session when its backend is reachable. Chat history is stored in the current browser; another device receives shared world state but does not receive this browser's local transcript. Late responses and stale socket grants are ignored after unmount, a new session or React Strict Mode cleanup. Requests have bounded timeouts.

## Verification

All 22 automated tests and the production build passed. Tests cover client lifecycle races, request errors and timeouts, collision behavior, reveal timing and camera restoration, including reduced motion and interrupted shots. The original exported GLBs were separately reimported into Blender to verify their animations and materials before web compression. The witch passed its isolated source reimport check, and its eight-second `Idle` retains actual cloth deformation through web compression.

Browser QA inspected the witch at idle and at peak reveal after correcting glTF sheen and nested-surface depth rendering. It verified the six-second preview, resumed walking and conversation camera restoration, with no console errors in that check. Earlier browser QA also verified loading the compressed models, forward movement, drag-to-look fallback, the nearby Sprout interaction prompt and panel, resetting to the entrance, and the unavailable-server message. The embedded browser does not support pointer lock, so its drag fallback was tested; native pointer-lock capture and physical touch input still need checks in their target browsers.

Live end-to-end gameplay against Terse, Agent Relay and OpenAI has not been run for this frontend change because the backend was not available locally. With the real backend and agents running, run `npm run test:live` (requires Bun), then verify dialogue, timed omens, accusation outcomes and Director evidence in the browser.
