// React hook for the game. Holly's scene reads state from here and plays animations from cues.
//
//   const game = useSpyMonster({ apiUrl: "http://localhost:3001" })
//   game.state?.monsters  -> mood per monster (drive Idle/Talk/Think/... clips)
//   game.useCue(cue => ...) -> one-off effects (witch glow, gossip sparkles, endings)
//   game.chat("sprout", "hello"), game.accuse("pebble"), game.start()

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import { GameConnection } from "./connection"
import type { Cue, MonsterId } from "./types"

export interface UseSpyMonsterOptions {
    apiUrl: string
    /** Rejoin the last game (or ?game=<id>) on load. Default true. */
    autoResume?: boolean
}

export function useSpyMonster({ apiUrl, autoResume = true }: UseSpyMonsterOptions) {
    const connection = useMemo(() => new GameConnection(apiUrl), [apiUrl])
    const snapshot = useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot)
    const now = useNow(snapshot.state?.phase === "playing")

    useEffect(() => {
        if (autoResume) void connection.resume()
        return () => connection.close()
    }, [connection, autoResume])

    const state = snapshot.state
    const serverNow = now + snapshot.clockOffsetMs
    return {
        ...snapshot,
        /** Whole seconds until dawn, from the server's deadline. */
        secondsLeft: state ? Math.max(0, Math.ceil((state.deadlineAt - serverNow) / 1000)) : null,
        /** Whole seconds until the witch's next reveal, or null if none is left. */
        secondsToReveal: state?.nextRevealAt ? Math.max(0, Math.ceil((state.nextRevealAt - serverNow) / 1000)) : null,
        isOver: state ? state.phase !== "playing" : false,
        start: (options?: { gameSeconds?: number; revealSeconds?: number }) => connection.start(options),
        chat: (monsterId: MonsterId, message: string) => connection.chat(monsterId, message),
        accuse: (monsterId: MonsterId) => connection.accuse(monsterId),
        director: () => connection.director(),
        shareUrl: () => connection.shareUrl(),
        /** Subscribe to animation cues for the lifetime of the calling component. */
        useCue: (handler: (cue: Cue) => void) => useCueListener(connection, handler)
    }
}

function useCueListener(connection: GameConnection, handler: (cue: Cue) => void): void {
    const ref = useRef(handler)
    ref.current = handler
    useEffect(() => connection.onCue(cue => ref.current(cue)), [connection])
}

function useNow(ticking: boolean): number {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!ticking) return
        const id = setInterval(() => setNow(Date.now()), 250)
        return () => clearInterval(id)
    }, [ticking])
    return now
}
