// Framework-free game connection: API calls + the Terse WebSocket + local chat log.
// The React hook (useSpyMonster) is a thin wrapper around this.

import { createGameApi, type GameApi } from "./api"
import type { ChatLine, Cue, MonsterId, PublicGameState } from "./types"

export interface GameSnapshot {
    state: PublicGameState | null
    connected: boolean
    /** Monster currently waiting on a reply, if any. */
    waitingFor: MonsterId | null
    chat: ChatLine[]
    error: string | null
}

type Listener = () => void
type CueListener = (cue: Cue) => void

const STORAGE_KEY = "spy-monster-session"

export class GameConnection {
    readonly api: GameApi
    #snapshot: GameSnapshot = { state: null, connected: false, waitingFor: null, chat: [], error: null }
    #listeners = new Set<Listener>()
    #cueListeners = new Set<CueListener>()
    #socket: WebSocket | null = null
    #sessionId: string | null = null
    #closed = false
    #retryMs = 500

    constructor(apiUrl: string) {
        this.api = createGameApi(apiUrl)
    }

    // ----- subscriptions (useSyncExternalStore-compatible) -----------------

    getSnapshot = (): GameSnapshot => this.#snapshot

    subscribe = (listener: Listener): (() => void) => {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    /** Fires once per animation cue (MONSTER_SPEAKING, WITCH_REVEAL, ...). */
    onCue(listener: CueListener): () => void {
        this.#cueListeners.add(listener)
        return () => this.#cueListeners.delete(listener)
    }

    #set(patch: Partial<GameSnapshot>): void {
        this.#snapshot = { ...this.#snapshot, ...patch }
        this.#listeners.forEach(l => l())
    }

    // ----- game lifecycle --------------------------------------------------

    /** Starts a new game and connects to it. */
    async start(options?: { gameSeconds?: number; revealSeconds?: number }): Promise<PublicGameState> {
        const state = await this.api.start(options)
        this.#remember(state.sessionId)
        this.#set({ state, chat: [], error: null })
        this.#connect(state.sessionId)
        return state
    }

    /**
     * Rejoins an existing game (after a refresh, or on a second device).
     * Looks at ?game=<id> in the URL first, then the last game in this browser.
     */
    async resume(sessionId = GameConnection.savedSessionId()): Promise<PublicGameState | null> {
        if (!sessionId) return null
        try {
            const state = await this.api.get(sessionId)
            this.#remember(sessionId)
            this.#set({ state, error: null, chat: this.#loadChat(sessionId) })
            this.#connect(sessionId)
            return state
        } catch {
            return null
        }
    }

    async chat(monsterId: MonsterId, message: string): Promise<void> {
        const sessionId = this.#sessionId
        if (!sessionId || this.#snapshot.waitingFor) return
        const now = Date.now()
        const playerLine: ChatLine = { id: crypto.randomUUID(), monsterId, role: "player", text: message, at: now }
        this.#pushChat(playerLine)
        this.#set({ waitingFor: monsterId, error: null })
        try {
            const result = await this.api.chat(sessionId, monsterId, message)
            this.#pushChat({ id: crypto.randomUUID(), monsterId, role: "monster", text: result.reply, at: Date.now() })
            this.#set({ waitingFor: null })
        } catch (err) {
            this.#set({ waitingFor: null, error: (err as Error).message })
        }
    }

    async accuse(monsterId: MonsterId): Promise<PublicGameState | null> {
        const sessionId = this.#sessionId
        if (!sessionId) return null
        const { state } = await this.api.accuse(sessionId, monsterId)
        this.#set({ state })
        return state
    }

    /** Post-game evidence for the Director View. Throws 403 while the game is still running. */
    director(): Promise<unknown> {
        if (!this.#sessionId) throw new Error("no_game")
        return this.api.director(this.#sessionId)
    }

    /** Link that opens this same game on another device. */
    shareUrl(): string | null {
        if (!this.#sessionId || typeof location === "undefined") return null
        const url = new URL(location.href)
        url.searchParams.set("game", this.#sessionId)
        return url.toString()
    }

    close(): void {
        this.#closed = true
        this.#socket?.close()
    }

    // ----- WebSocket ---------------------------------------------------------

    async #connect(sessionId: string): Promise<void> {
        this.#socket?.close()
        this.#closed = false
        this.#sessionId = sessionId
        try {
            const { websocketUrl } = await this.api.socket(sessionId, "player")
            if (this.#sessionId !== sessionId || this.#closed) return
            const ws = new WebSocket(websocketUrl)
            this.#socket = ws
            ws.onopen = () => {
                this.#retryMs = 500
                this.#set({ connected: true })
            }
            ws.onmessage = event => this.#receive(String(event.data))
            ws.onclose = () => {
                if (this.#socket !== ws) return
                this.#set({ connected: false })
                this.#reconnectLater(sessionId)
            }
        } catch {
            this.#reconnectLater(sessionId)
        }
    }

    #reconnectLater(sessionId: string): void {
        if (this.#closed || this.#sessionId !== sessionId) return
        const wait = this.#retryMs
        this.#retryMs = Math.min(this.#retryMs * 2, 8000)
        setTimeout(() => {
            if (!this.#closed && this.#sessionId === sessionId) this.#connect(sessionId)
        }, wait)
    }

    #receive(raw: string): void {
        if (raw === "pong") return
        let message: { type?: string; state?: { publicState?: PublicGameState }; changes?: { publicState?: PublicGameState } }
        try {
            message = JSON.parse(raw)
        } catch {
            return
        }
        if (message.type === "state" && message.state?.publicState) this.#set({ state: message.state.publicState })
        else if (message.type === "state_update" && message.changes?.publicState) this.#set({ state: message.changes.publicState })
        else if (message.type === "cue") this.#cueListeners.forEach(l => l(message as unknown as Cue))
    }

    // ----- local persistence (chat log survives refresh) -------------------

    static savedSessionId(): string | null {
        if (typeof location !== "undefined") {
            const fromUrl = new URL(location.href).searchParams.get("game")
            if (fromUrl) return fromUrl
        }
        try {
            return localStorage.getItem(STORAGE_KEY)
        } catch {
            return null
        }
    }

    #remember(sessionId: string): void {
        this.#sessionId = sessionId
        try {
            localStorage.setItem(STORAGE_KEY, sessionId)
        } catch {
            // Private mode: resume via ?game= still works.
        }
    }

    #pushChat(line: ChatLine): void {
        const chat = [...this.#snapshot.chat, line]
        this.#set({ chat })
        try {
            if (this.#sessionId) localStorage.setItem(`${STORAGE_KEY}:${this.#sessionId}:chat`, JSON.stringify(chat))
        } catch {
            // Ignore storage failures.
        }
    }

    #loadChat(sessionId: string): ChatLine[] {
        try {
            return JSON.parse(localStorage.getItem(`${STORAGE_KEY}:${sessionId}:chat`) ?? "[]") as ChatLine[]
        } catch {
            return []
        }
    }
}
