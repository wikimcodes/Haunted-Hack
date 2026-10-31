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
npm test                 # Client lifecycle, collision, cinematic, Director and audio tests
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
| Speaker / Sound on–off | Mute or enable the room atmosphere and reveal sound |
| Director View | Open the server’s Director page in a separate tab |

Walls, shelves, counters and the tree use simplified collision proxies. Movement stays at walking height and slides along obstacles. Proximity selection prevents starting an interaction from across the room. Returning to the entrance resets the player position.

The pause menu does not pause a live investigation: the server's deadline continues. The accusation dialog asks for confirmation; only the backend determines the result. A successful game opens the escape door.

**Director View** is a native link on the title screen, in the pause menu and on the ending screen. It opens the existing backend page in a separate tab and includes `?game=` for the current session, preserving the configured API origin and deployment path prefix. Without a current game, the Director page selects the latest available game or shows its empty state. During play, the server keeps the spy and message text private while the page shows a masked live Relay feed. After the game ends, it reveals the actual Relay messages, information-flow graph, Terse event timeline and clue-to-message links. The game remains open in its original tab; browser tab switching pauses its local audio, while the server clock continues. The Director dashboard uses charcoal cards, real activity metrics and a horizontal flow diagram. Message filters and selected clues link the actual Relay messages, graph routes and Terse events; live sessions show a masked participant topology instead.

## Cameras and story presentation

Three camera modes use the same scene: a wide entrance view, a close-up focused on the selected monster, and a witch reveal at the window. Monster framing is computed from the character and the player's position. Closing a conversation or completing a reveal restores the stored walking pose; opening the menu cancels the cinematic. The wide and reveal anchors are supplied by `presentation-manifest.json`.

During investigation, only public world state and public `WITCH_REVEAL` events drive presentation. The introduction is warm; the first published clue changes the room to suspicion lighting. A reveal first dims the candlelight and holds the shot for 0.65 seconds. The camera then turns toward the witch, the impact lands at about 0.95 seconds, and local violet light reveals her silhouette. From 4.6 seconds, the camera, ghost materials and lighting return to normal, completing at six seconds. All three ghosts receive the same temporary darkening. Low-frame-rate cinematics use real elapsed time while movement stays step-limited, so the audio does not repeatedly rewind under rendering load. Winning introduces dawn light and opens the door; losing darkens the room and exposes the witch. Hidden spy identity never selects lighting or camera treatment, and the frontend does not invent its own timed clues.

The renderer respects `prefers-reduced-motion`: automatic camera travel and candle oscillation are suppressed while the reveal caption and story lighting remain available.

## Sound

Playback is unlocked by clicking **Explore the library**, **Begin investigation**, **Resume investigation** or **Enable sound**. Nothing plays just because the title page loaded. Speaker controls on the title screen and HUD, plus **Sound on/off** in the menu, mute both audio layers. The choice is stored locally and persists across reloads. If audio cannot load, the 3D game remains usable and the menu offers **Try sound again**. If a browser interrupts playback, the HUD and menu offer **Resume sound**. A brief **Preparing sound…** status distinguishes decoding from playback readiness.

The two MP3s in `public/audio/` were generated with the ElevenLabs Sound Effects API and total **570,181 bytes** (about **0.57 MB**):

- `library-room.mp3`: a 29.5-second horror loop with reversed whispers, a child humming far away, nails scraping on wood, metallic groans, close creaks, a pulsing drone and sudden silences broken by a distant thud.
- `witch-reveal.mp3`: a six-second arrival cue with its loudest hit around 0.35 seconds and further impacts around 2.2–2.9 seconds, followed by a fading tail.

`LibraryAudio` follows `CameraDirector`'s reveal token and elapsed time. Repeated events do not stack the cue; cancellation stops it; late decoding or unmuting joins at the current visual phase. The room atmosphere falls to 4% before the arrival, then returns gradually with the camera. The source URLs use an explicit sound revision so a refreshed page fetches the new mix; replacing the MP3s requires updating `SOUND_REVISION` in `LibraryAudio.ts`. Opening the pause menu or returning to the title stops local playback, and hiding the browser tab pauses it. Resuming a hidden tab follows the paused camera phase instead of restarting the reveal from the beginning. The backend's investigation deadline continues independently.

The audio scope is room atmosphere and Witch Reveal; footsteps and voiced dialogue are not included. See `public/audio/README.md` for prompts, measurements and regeneration with `npm run audio:elevenlabs`. The earlier procedural generator, `scripts/generate-audio.py`, still works as a fallback that needs no API key.

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

The production build and all 38 automated tests pass. Tests cover client lifecycle races, request errors and timeouts, collision behavior, reveal timing and camera restoration, including reduced motion and interrupted shots. Director URL tests cover game pinning, deployment prefixes and unsafe URLs. Audio tests cover gesture unlock, mute, hidden tabs, cancellation, stale events, late loading and cleanup. The original exported GLBs were separately reimported into Blender to verify their animations and materials before web compression. The witch passed its isolated source reimport check, and its eight-second `Idle` retains actual cloth deformation through web compression.

Browser QA also verified the darker anticipation, localized violet window shader, readable witch framing, and restoration of ghost materials and the walking view after the revised six-second cue, with no shader/console errors. Audio reached ready only after decoding, and mute/unmute recovered playback readiness. Browser QA inspected the witch at idle and at peak reveal after correcting glTF sheen and nested-surface depth rendering. It verified the six-second preview, resumed walking and conversation camera restoration, with no console errors in that check. Earlier browser QA also verified loading the compressed models, forward movement, drag-to-look fallback, the nearby Sprout interaction prompt and panel, resetting to the entrance, and the unavailable-server message. The embedded browser does not support pointer lock, so its drag fallback was tested; native pointer-lock capture and physical touch input still need checks in their target browsers.

Local integration against running Terse and Agent Relay has verified real game creation, a monster reply with `source: "fallback"`, live WebSocket state, a timed `WITCH_REVEAL` cue and clue, and a browser session showing **CONNECTED**. True OpenAI replies and full correct/incorrect-accusation browser flows remain unverified. Browser checks verified that audio stays locked on initial load, unlocks on entry, mute updates the control and persists after reload, and the reveal preview returns to exploration without console errors. The menu Director link opened a separate tab with the current session selected and the live evidence still masked. Hidden-tab stopping/resuming and reveal seeking are covered by audio lifecycle tests; listening-level checks on physical speakers/headphones and mobile browser audio still remain. With the real backend and agents running, `npm run test:live` (requires Bun) exercises the API layer; follow it with the remaining browser checks.
