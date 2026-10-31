// Framework-free game connection: API calls + the Terse WebSocket + local chat log.
// The React hook (useSpyMonster) is a thin wrapper around this.

import { createGameApi, type GameApi } from "./api"
import type { ChatLine, Cue, MonsterId, PublicGameState } from "./types"

export interface GameSnapshot {
    state: PublicGameState | null
    connected: boolean
    /** Monsters currently working on a reply. */
    waiting: MonsterId[]
    /** First monster still replying, if any (kept for simple UIs). */
    waitingFor: MonsterId | null
    /** Server clock minus this device's clock, so countdowns stay right on a phone whose clock is off. */
    clockOffsetMs: number
    chat: ChatLine[]
    error: string | null
}

type Listener = () => void
type CueListener = (cue: Cue) => void

const STORAGE_KEY = "spy-monster-session"

export class GameConnection {
    readonly api: GameApi
    #snapshot: GameSnapshot = { state: null, connected: false, waiting: [], waitingFor: null, clockOffsetMs: 0, chat: [], error: null }
    #listeners = new Set<Listener>()
    #cueListeners = new Set<CueListener>()
    #socket: WebSocket | null = null
    #sessionId: string | null = null
    #closed = false
    #retryMs = 500
    #generation = 0
    #socketGeneration = 0
    #retryTimer: ReturnType<typeof setTimeout> | null = null

    #witchVoice: boolean
    #spokenClues: Set<string> | null = null

    constructor(apiUrl: string, options: { witchVoice?: boolean } = {}) {
        this.#witchVoice = options.witchVoice ?? true
        this.api = createGameApi(apiUrl, {
            onServerTime: offset => {
                if (Math.abs(offset - this.#snapshot.clockOffsetMs) > 250) this.#set({ clockOffsetMs: Math.round(offset) })
            }
        })
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
        const generation = this.#beginSession()
        const state = await this.api.start(options)
        if (!this.#isCurrent(generation)) throw new DOMException("Game connection was closed or replaced", "AbortError")
        this.#spokenClues = new Set() // a brand-new game: speak every clue
        this.#remember(state.sessionId)
        this.#set({ state, chat: [], error: null })
        void this.#connect(state.sessionId, generation)
        return state
    }

    /**
     * Rejoins an existing game (after a refresh, or on a second device).
     * Looks at ?game=<id> in the URL first, then the last game in this browser.
     */
    async resume(sessionId = GameConnection.savedSessionId()): Promise<PublicGameState | null> {
        if (!sessionId) return null
        const generation = this.#beginSession()
        try {
            const state = await this.api.get(sessionId)
            if (!this.#isCurrent(generation)) return null
            this.#spokenClues = null // rejoining: don't replay clues revealed before we arrived
            this.#remember(sessionId)
            this.#set({ state, error: null, chat: this.#loadChat(sessionId) })
            void this.#connect(sessionId, generation)
            return state
        } catch {
            return null
        }
    }

    /**
     * Sends a message to one monster. Different monsters can be asked at the same time;
     * a second message to a monster that is still replying is refused (returns false, sets error).
     */
    async chat(monsterId: MonsterId, message: string): Promise<boolean> {
        const sessionId = this.#sessionId
        const generation = this.#generation
        if (this.#closed || !sessionId) return false
        if (this.#snapshot.waiting.includes(monsterId)) {
            this.#set({ error: "still_replying" })
            return false
        }
        this.#pushChat({ id: crypto.randomUUID(), monsterId, role: "player", text: message, at: Date.now() })
        this.#setWaiting([...this.#snapshot.waiting, monsterId], { error: null })
        try {
            const result = await this.api.chat(sessionId, monsterId, message)
            if (!this.#isCurrent(generation, sessionId)) return false
            this.#pushChat({ id: crypto.randomUUID(), monsterId, role: "monster", text: result.reply, at: Date.now() })
            this.#setWaiting(this.#snapshot.waiting.filter(m => m !== monsterId))
            return true
        } catch (err) {
            if (!this.#isCurrent(generation, sessionId)) return false
            this.#setWaiting(this.#snapshot.waiting.filter(m => m !== monsterId), { error: (err as Error).message })
            return false
        }
    }

    #setWaiting(waiting: MonsterId[], extra: Partial<GameSnapshot> = {}): void {
        this.#set({ ...extra, waiting, waitingFor: waiting[0] ?? null })
    }

    async accuse(monsterId: MonsterId): Promise<PublicGameState | null> {
        const sessionId = this.#sessionId
        const generation = this.#generation
        if (this.#closed || !sessionId) return null
        const { state } = await this.api.accuse(sessionId, monsterId)
        if (!this.#isCurrent(generation, sessionId)) return null
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
        this.#generation++
        this.#cancelSocket()
        this.#setWaiting([], { connected: false })
    }

    // ----- WebSocket ---------------------------------------------------------

    #isCurrent(generation: number, sessionId?: string): boolean {
        return !this.#closed && this.#generation === generation && (sessionId === undefined || this.#sessionId === sessionId)
    }

    #beginSession(): number {
        this.#closed = false
        this.#generation++
        this.#sessionId = null
        this.#retryMs = 500
        this.#cancelSocket()
        this.#setWaiting([], { connected: false })
        return this.#generation
    }

    #cancelSocket(): void {
        this.#socketGeneration++
        if (this.#retryTimer !== null) clearTimeout(this.#retryTimer)
        this.#retryTimer = null
        const socket = this.#socket
        this.#socket = null
        if (socket) {
            socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
            socket.close()
        }
    }

    async #connect(sessionId: string, generation: number): Promise<void> {
        if (!this.#isCurrent(generation, sessionId)) return
        this.#cancelSocket()
        const socketGeneration = this.#socketGeneration
        const current = () => this.#isCurrent(generation, sessionId) && this.#socketGeneration === socketGeneration
        try {
            const { websocketUrl } = await this.api.socket(sessionId, "player")
            if (!current()) return
            const ws = new WebSocket(websocketUrl)
            this.#socket = ws
            ws.onopen = () => {
                if (!current() || this.#socket !== ws) return
                this.#retryMs = 500
                this.#set({ connected: true })
            }
            ws.onmessage = event => {
                if (current() && this.#socket === ws) this.#receive(String(event.data))
            }
            ws.onclose = () => {
                if (!current() || this.#socket !== ws) return
                this.#socket = null
                this.#set({ connected: false })
                this.#reconnectLater(sessionId, generation, socketGeneration)
            }
        } catch {
            if (current()) this.#reconnectLater(sessionId, generation, socketGeneration)
        }
    }

    #reconnectLater(sessionId: string, generation: number, socketGeneration: number): void {
        if (!this.#isCurrent(generation, sessionId) || this.#socketGeneration !== socketGeneration) return
        if (this.#retryTimer !== null) clearTimeout(this.#retryTimer)
        const wait = this.#retryMs
        this.#retryMs = Math.min(this.#retryMs * 2, 8000)
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = null
            if (this.#isCurrent(generation, sessionId) && this.#socketGeneration === socketGeneration) void this.#connect(sessionId, generation)
        }, wait)
    }

    #applyState(state: PublicGameState): void {
        this.#set({ state })
        this.#speakNewClues(state)
    }

    /** Turns the witch's spoken clues on or off (on by default). */
    setWitchVoice(on: boolean): void {
        this.#witchVoice = on
    }

    // Speaks clues revealed while this client is watching. Clues that already existed when the
    // client joined (a refresh, a second phone) are not replayed.
    #speakNewClues(state: PublicGameState): void {
        if (!this.#spokenClues) {
            this.#spokenClues = new Set(state.clues.map(c => c.id))
            return
        }
        for (const clue of state.clues) {
            if (this.#spokenClues.has(clue.id)) continue
            this.#spokenClues.add(clue.id)
            if (this.#witchVoice && typeof Audio !== "undefined") {
                // Browsers only allow sound after the player has tapped something; starting the game counts.
                void new Audio(this.api.voiceUrl(state.sessionId, clue.id)).play().catch(() => {})
            }
        }
    }

    #receive(raw: string): void {
        if (raw === "pong") return
        let message: { type?: string; state?: { publicState?: PublicGameState }; changes?: { publicState?: PublicGameState } }
        try {
            message = JSON.parse(raw)
        } catch {
            return
        }
        if (message.type === "state" && message.state?.publicState?.sessionId === this.#sessionId) this.#applyState(message.state.publicState)
        else if (message.type === "state_update" && message.changes?.publicState?.sessionId === this.#sessionId) this.#applyState(message.changes.publicState)
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
            const value: unknown = JSON.parse(localStorage.getItem(`${STORAGE_KEY}:${sessionId}:chat`) ?? "[]")
            if (!Array.isArray(value)) return []
            return value.filter((line): line is ChatLine => line !== null && typeof line === "object"
                && typeof line.id === "string" && ["sprout", "pebble", "momo"].includes(line.monsterId)
                && ["player", "monster"].includes(line.role) && typeof line.text === "string" && typeof line.at === "number")
        } catch {
            return []
        }
    }
}
