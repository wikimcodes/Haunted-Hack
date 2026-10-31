# Game client (data layer only)

Connects the frontend to the backend: API calls, the live Terse WebSocket, the countdown and animation cues. **No 3D, no styling.** The scene, models and animations are Holly's; this only tells them what to play.

## Use it

Copy or import `frontend-game/src` into the React app (e.g. a Vite alias `@game` -> `../frontend-game/src`). React 18+ is the only dependency.

```tsx
import { ANIMATION_FOR_MOOD, useSpyMonster } from "@game"

function Game() {
    const game = useSpyMonster({ apiUrl: "http://localhost:3001" })

    // One-off effects
    game.useCue(cue => {
        if (cue.cue === "WITCH_REVEAL") { /* witch glow + show latest clue */ }
        if (cue.cue === "GOSSIP_STARTED") { /* sparkle particles */ }
        if (cue.cue === "MONSTER_SPEAKING") { /* focus camera on cue.monsterId */ }
    })

    if (!game.state) return <button onClick={() => game.start()}>Start</button>

    // Continuous state: each monster's clip comes from its mood
    // game.state.monsters.map(m => ANIMATION_FOR_MOOD[m.mood])   -> "Idle" | "Talk" | "Think" | "Nervous" | "Accused"
    // game.secondsLeft, game.secondsToReveal                   -> countdown UI
    // game.state.clues                                         -> Witch's Omen panel
    // game.chat, game.waitingFor                               -> dialogue panel
    // game.accuse("pebble")                                    -> "You're the Spy!"
    // game.state.phase / game.isOver / game.state.spyId        -> ending screens
    return null
}
```

## What you get from `useSpyMonster`

| Field | Meaning |
|---|---|
| `state` | `PublicGameState`: phase, monsters (with `mood`), clues, accusation, `spyId` (null until the end) |
| `secondsLeft`, `secondsToReveal` | Countdowns from the server's deadline |
| `chat`, `waitingFor`, `error` | Chat log, which monster is replying, last error |
| `connected` | Live socket is up (it reconnects by itself) |
| `start()`, `chat(id, text)`, `accuse(id)` | Actions |
| `useCue(handler)` | Animation triggers: `MONSTER_THINKING`, `MONSTER_SPEAKING`, `GOSSIP_STARTED`, `WITCH_REVEAL`, `ACCUSATION_CORRECT`, `ACCUSATION_WRONG`, `GAME_EXPIRED` |
| `shareUrl()` | Link that opens the same game on another phone (`?game=<id>`) |
| `director()` | Post-game evidence (Relay messages, gossip paths, Terse events) |

Refreshing the page rejoins the same game automatically, with the chat log restored. That is the Terse demo.

If Holly's clip names differ from `Idle/Talk/Think/Nervous/Accused`, change `ANIMATION_FOR_MOOD` in `src/types.ts`.

## Test

With the backend running (`backend/README.md`): `bun install && bun run test:live`. It plays a game from two "devices" and checks they stay in sync.
