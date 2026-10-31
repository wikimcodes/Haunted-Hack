import { Actor, Emittable, Persisted, type ActorContext, type ActorSocket } from "terse-sdk/actor"

import {
    CLEAR_LINES,
    DAWN_LINE,
    DEFAULT_GAME_MS,
    DEFAULT_REVEAL_MS,
    ECHO_LINES,
    GOSSIP_PER_ROUND,
    LOSE_LINE,
    MAX_FACT_CHARS,
    MAX_FACTS_PER_GAME,
    MAX_GOSSIP_CHARS,
    MONSTERS,
    MONSTER_IDS,
    SILENT_LINES,
    WIN_LINE,
    clip,
    isMonsterId,
    otherMonsters,
    pickRandom,
    type GamePhase,
    type MonsterId,
    type Mood
} from "./rules"

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface PublicMonster {
    id: MonsterId
    name: string
    personality: string
    mood: Mood
}

export interface PublicClue {
    id: string
    round: number
    kind: "echo" | "silent" | "clear" | "ending"
    content: string
    revealedAt: number
}

/** Everything a player is allowed to see. This is the only @Emittable field. */
export interface PublicGameState {
    sessionId: string
    phase: GamePhase
    startedAt: number
    deadlineAt: number
    nextRevealAt: number | null
    round: number
    monsters: PublicMonster[]
    clues: PublicClue[]
    accusation: { monsterId: MonsterId; correct: boolean; at: number } | null
    /** Revealed only once the game is over. */
    spyId: MonsterId | null
}

export interface Fact {
    id: string
    text: string
    toldTo: MonsterId
    createdAt: number
}

export interface Gossip {
    id: string
    from: MonsterId
    to: MonsterId
    factIds: string[]
    round: number
    status: "reserved" | "sent" | "received"
    relayMessageId: string | null
    text: string | null
    createdAt: number
}

export interface WitchReport {
    id: string
    sourceMonsterId: MonsterId
    factIds: string[]
    content: string
    relayMessageId: string
    receivedAt: number
    revealed: boolean
}

export interface ClueEvidence {
    clueId: string
    reportIds: string[]
    relayMessageIds: string[]
}

export interface GameEvent {
    seq: number
    type: string
    detail: string
    at: number
}

export interface DirectorView {
    spyId: MonsterId
    facts: Fact[]
    gossip: Gossip[]
    reports: WitchReport[]
    rejectedReports: { from: string; relayMessageId: string; at: number; reason: "not_spy" | "game_over" }[]
    evidence: ClueEvidence[]
    events: GameEvent[]
    public: PublicGameState
}

type SocketMeta = { playerId: string; role: "player" | "director" }
type Incoming = { type: "ping" }
type Cue = { type: "cue"; cue: string; monsterId?: MonsterId; at: number }
type Socket = ActorSocket<SocketMeta, Cue>

// ---------------------------------------------------------------------------
// GameActor: one per session. The referee and the witch.
// Owns the hidden spy, the clock (via the actor alarm), reports and clues.
// ---------------------------------------------------------------------------

export class GameActor extends Actor<SocketMeta, Incoming, Cue> {
    /** The only thing clients ever receive automatically. */
    @Persisted @Emittable publicState: PublicGameState | null = null

    // Private. Never emitted, never returned to players while playing.
    @Persisted private spyId: MonsterId | null = null
    @Persisted private revealIntervalMs = DEFAULT_REVEAL_MS
    @Persisted private facts: Fact[] = []
    @Persisted private knowledge: Record<string, string[]> = {}
    @Persisted private gossip: Gossip[] = []
    @Persisted private reports: WitchReport[] = []
    @Persisted private rejectedReports: { from: string; relayMessageId: string; at: number; reason: "not_spy" | "game_over" }[] = []
    @Persisted private evidence: ClueEvidence[] = []
    @Persisted private clearedMonster: MonsterId | null = null
    @Persisted private seq = 0
    @Persisted private handoffIds: string[] = []

    constructor(context: ActorContext) {
        super(context)
        // Schema setup runs once per wake, synchronously, before any call (Terse's migration pattern).
        this.db.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, type TEXT, detail TEXT, at INTEGER)")
    }

    #log(type: string, detail: Record<string, unknown> = {}): void {
        this.seq += 1
        this.db.exec("INSERT INTO events (seq, type, detail, at) VALUES (?, ?, ?, ?)", this.seq, type, JSON.stringify(detail), Date.now())
    }

    /** Animation cues are best effort: a failed broadcast must never break a state change. */
    #cue(cue: string, monsterId?: MonsterId): void {
        const message: Cue = monsterId ? { type: "cue", cue, monsterId, at: Date.now() } : { type: "cue", cue, at: Date.now() }
        try {
            this.broadcast(message)
        } catch (err) {
            console.error("cue failed", cue, String(err))
        }
    }

    #requireState(): PublicGameState {
        if (!this.publicState || !this.spyId) throw new Error("game_not_started")
        return this.publicState
    }

    #isLive(state: PublicGameState, now = Date.now()): boolean {
        return state.phase === "playing" && now < state.deadlineAt
    }

    #armAlarm(state: PublicGameState): void {
        if (state.phase !== "playing") {
            this.alarm.delete()
            return
        }
        const next = state.nextRevealAt === null ? state.deadlineAt : Math.min(state.nextRevealAt, state.deadlineAt)
        this.alarm.set(next)
    }

    // ----- lifecycle -------------------------------------------------------

    /** Creates the game. Idempotent: calling it again returns the existing state. */
    async start(input: { gameMs?: number; revealMs?: number } = {}): Promise<PublicGameState> {
        if (this.publicState) return this.publicState
        const now = Date.now()
        const gameMs = input.gameMs ?? DEFAULT_GAME_MS
        this.revealIntervalMs = input.revealMs ?? DEFAULT_REVEAL_MS
        this.spyId = pickRandom(MONSTER_IDS)
        this.knowledge = Object.fromEntries(MONSTER_IDS.map(id => [id, []]))
        const state: PublicGameState = {
            sessionId: this.id,
            phase: "playing",
            startedAt: now,
            deadlineAt: now + gameMs,
            nextRevealAt: now + this.revealIntervalMs < now + gameMs ? now + this.revealIntervalMs : null,
            round: 1,
            monsters: MONSTER_IDS.map(id => ({ id, name: MONSTERS[id].name, personality: MONSTERS[id].personality, mood: "idle" })),
            clues: [],
            accusation: null,
            spyId: null
        }
        this.publicState = state
        this.#log("GAME_STARTED", { deadlineAt: state.deadlineAt })
        this.#log("SPY_ASSIGNED", {})
        this.#armAlarm(state)
        return state
    }

    async getPublicState(): Promise<PublicGameState | null> {
        return this.publicState
    }

    /** Runs on the actor alarm, even when no client is connected. */
    async onAlarm(): Promise<void> {
        const state = this.publicState
        if (!state || state.phase !== "playing") return
        const now = Date.now()
        if (now >= state.deadlineAt) {
            this.#endGame("expired", DAWN_LINE)
            return
        }
        try {
            if (state.nextRevealAt !== null && now >= state.nextRevealAt) this.#revealClue(now)
        } catch (err) {
            // Never let one bad reveal stop the clock: skip this reveal and keep going.
            console.error("reveal failed", String(err))
            const s = this.publicState!
            this.publicState = { ...s, nextRevealAt: now + this.revealIntervalMs < s.deadlineAt ? now + this.revealIntervalMs : null }
        }
        this.#armAlarm(this.publicState!)
    }

    #revealClue(now: number): void {
        const state = this.#requireState()
        const round = state.round
        const pending = this.reports.filter(r => !r.revealed)
        let clue: PublicClue
        let reportIds: string[] = []

        if (pending.length > 0) {
            // Echo the newest report. Gossip means the echo does not prove who the player told.
            const report = pending[pending.length - 1]!
            const fact = this.facts.find(f => report.factIds.includes(f.id))
            const text = fact ? fact.text : report.content
            clue = { id: `clue_${round}`, round, kind: "echo", content: pickRandom(ECHO_LINES)(clip(text, 90)), revealedAt: now }
            reportIds = [report.id]
            this.reports = this.reports.map(r => (r.id === report.id ? { ...r, revealed: true } : r))
        } else if (round >= 2 && !this.clearedMonster) {
            const innocent = pickRandom(MONSTER_IDS.filter(id => id !== this.spyId))
            this.clearedMonster = innocent
            clue = { id: `clue_${round}`, round, kind: "clear", content: pickRandom(CLEAR_LINES)(MONSTERS[innocent].name), revealedAt: now }
        } else {
            const whispers = this.gossip.filter(g => g.status !== "reserved").length
            clue = { id: `clue_${round}`, round, kind: "silent", content: pickRandom(SILENT_LINES)(whispers), revealedAt: now }
        }

        // If an echo was shown on a later round and nobody has been cleared yet, clear one too
        // so the final round always narrows the field.
        const extra: PublicClue[] = []
        if (clue.kind === "echo" && round >= 2 && !this.clearedMonster) {
            const innocent = pickRandom(MONSTER_IDS.filter(id => id !== this.spyId))
            this.clearedMonster = innocent
            extra.push({ id: `clue_${round}b`, round, kind: "clear", content: pickRandom(CLEAR_LINES)(MONSTERS[innocent].name), revealedAt: now })
        }

        this.evidence = [
            ...this.evidence,
            {
                clueId: clue.id,
                reportIds,
                relayMessageIds: this.reports.filter(r => reportIds.includes(r.id)).map(r => r.relayMessageId)
            }
        ]
        const nextRevealAt = now + this.revealIntervalMs < state.deadlineAt ? now + this.revealIntervalMs : null
        this.publicState = { ...state, round: round + 1, nextRevealAt, clues: [...state.clues, clue, ...extra] }
        this.#log("WITCH_REVEAL", { clueId: clue.id, kind: clue.kind, reportIds })
        this.#cue("WITCH_REVEAL")
    }

    #endGame(phase: GamePhase, line: string): void {
        const state = this.#requireState()
        const now = Date.now()
        const ending: PublicClue = { id: "clue_end", round: state.round, kind: "ending", content: line, revealedAt: now }
        this.publicState = { ...state, phase, nextRevealAt: null, clues: [...state.clues, ending], spyId: this.spyId }
        this.alarm.delete()
        this.#log(phase === "expired" ? "GAME_EXPIRED" : "ACCUSATION_RESOLVED", { phase })
        this.#cue(phase === "won" ? "ACCUSATION_CORRECT" : phase === "lost" ? "ACCUSATION_WRONG" : "GAME_EXPIRED")
    }

    // ----- player actions (called by the game server) ----------------------

    /** One accusation per game. The mailbox runs one call at a time, so this cannot race the dawn alarm. */
    async accuse(monsterId: string): Promise<PublicGameState> {
        const state = this.#requireState()
        if (!isMonsterId(monsterId)) throw new Error("unknown_monster")
        if (state.phase !== "playing") return state
        const now = Date.now()
        if (now >= state.deadlineAt) {
            this.#endGame("expired", DAWN_LINE)
            return this.publicState!
        }
        await this.db.transaction(async () => {
            const correct = monsterId === this.spyId
            this.publicState = { ...this.publicState!, accusation: { monsterId, correct, at: now } }
            this.#setMood(monsterId, "accused")
            this.#endGame(correct ? "won" : "lost", correct ? WIN_LINE : LOSE_LINE)
        })
        return this.publicState!
    }

    /** Records something the player told a monster. Returns the new fact. */
    async recordPlayerFact(monsterId: string, text: string): Promise<Fact> {
        const state = this.#requireState()
        if (!isMonsterId(monsterId)) throw new Error("unknown_monster")
        if (!this.#isLive(state)) throw new Error("game_over")
        // Each saved list is rewritten whole on change, so keep a game's lists small.
        if (this.facts.length >= MAX_FACTS_PER_GAME) throw new Error("too_many_messages")
        const fact: Fact = { id: `f${this.facts.length + 1}`, text: clip(text, MAX_FACT_CHARS), toldTo: monsterId, createdAt: Date.now() }
        this.facts = [...this.facts, fact]
        this.knowledge = { ...this.knowledge, [monsterId]: [...(this.knowledge[monsterId] ?? []), fact.id] }
        this.#log("CONVERSATION_RECORDED", { monsterId, factId: fact.id })
        return fact
    }

    async setMonsterMood(monsterId: string, mood: Mood): Promise<void> {
        if (!isMonsterId(monsterId) || this.publicState?.phase !== "playing") return
        this.#setMood(monsterId, mood)
        if (mood === "talking" || mood === "nervous") this.#cue("MONSTER_SPEAKING", monsterId)
        if (mood === "thinking") this.#cue("MONSTER_THINKING", monsterId)
    }

    /** Returns a monster to idle only if nothing changed its mood since `expected` was set. */
    async settleMood(monsterId: string, expected: Mood): Promise<void> {
        if (!isMonsterId(monsterId) || this.publicState?.phase !== "playing") return
        const current = this.publicState.monsters.find(m => m.id === monsterId)?.mood
        if (current === expected) this.#setMood(monsterId, "idle")
    }

    #setMood(monsterId: MonsterId, mood: Mood): void {
        const state = this.publicState!
        this.publicState = { ...state, monsters: state.monsters.map(m => (m.id === monsterId ? { ...m, mood } : m)) }
    }

    // ----- agent-side calls (made by the Relay agent processes) ------------

    /** Private briefing for one monster's agent process: its own role and what it knows. Never other roles. */
    async briefing(monsterId: string): Promise<{ live: boolean; isSpy: boolean; knownFacts: Fact[]; reportedFactIds: string[] }> {
        const state = this.#requireState()
        if (!isMonsterId(monsterId)) throw new Error("unknown_monster")
        const known = new Set(this.knowledge[monsterId] ?? [])
        const isSpy = monsterId === this.spyId
        return {
            live: this.#isLive(state),
            isSpy,
            knownFacts: this.facts.filter(f => known.has(f.id)),
            reportedFactIds: isSpy ? this.reports.flatMap(r => r.factIds) : []
        }
    }

    /** Step 1 of gossip: check the quota and that the sender really knows the facts. */
    async reserveGossip(from: string, to: string, factIds: string[]): Promise<{ ok: boolean; reason?: string; gossipId?: string }> {
        const state = this.#requireState()
        if (!this.#isLive(state)) return { ok: false, reason: "game_over" }
        if (!isMonsterId(from) || !isMonsterId(to) || from === to) return { ok: false, reason: "bad_route" }
        const sentThisRound = this.gossip.filter(g => g.from === from && g.round === state.round).length
        if (sentThisRound >= GOSSIP_PER_ROUND) return { ok: false, reason: "quota" }
        const known = new Set(this.knowledge[from] ?? [])
        if (factIds.length === 0 || !factIds.every(id => known.has(id))) return { ok: false, reason: "unknown_fact" }
        const gossip: Gossip = {
            id: `g${this.gossip.length + 1}`,
            from,
            to,
            factIds,
            round: state.round,
            status: "reserved",
            relayMessageId: null,
            text: null,
            createdAt: Date.now()
        }
        this.gossip = [...this.gossip, gossip]
        this.#log("GOSSIP_RESERVED", { gossipId: gossip.id, from, to })
        return { ok: true, gossipId: gossip.id }
    }

    /** Step 2: the sender confirms the Relay message it actually sent. */
    async confirmGossip(gossipId: string, relayMessageId: string, text: string): Promise<void> {
        this.#requireState()
        // The receiver may have processed the DM first; keep its status but still record what was sent.
        this.gossip = this.gossip.map(g =>
            g.id === gossipId
                ? { ...g, status: g.status === "reserved" ? "sent" : g.status, relayMessageId: g.relayMessageId ?? relayMessageId, text: clip(text, MAX_GOSSIP_CHARS) }
                : g
        )
        this.#log("GOSSIP_SENT", { gossipId, relayMessageId })
        this.#cue("GOSSIP_STARTED")
    }

    /** The sender could not deliver the message: free the reservation so it does not burn the round's quota. */
    async releaseGossip(gossipId: string): Promise<void> {
        this.#requireState()
        const before = this.gossip.length
        this.gossip = this.gossip.filter(g => !(g.id === gossipId && g.status === "reserved"))
        if (this.gossip.length !== before) this.#log("GOSSIP_RELEASED", { gossipId })
    }

    /**
     * Step 3: the receiver reports what arrived. `from` must be the Relay-authenticated sender,
     * and must match the reservation, otherwise the facts are not learned.
     */
    async receiveGossip(gossipId: string, relayFrom: string, to: string, relayMessageId: string): Promise<{ ok: boolean; facts: Fact[] }> {
        this.#requireState()
        const g = this.gossip.find(x => x.id === gossipId)
        if (!g || g.from !== relayFrom || g.to !== to || (g.relayMessageId && g.relayMessageId !== relayMessageId)) {
            this.#log("GOSSIP_REJECTED", { gossipId, relayFrom, to })
            return { ok: false, facts: [] }
        }
        const known = new Set(this.knowledge[to] ?? [])
        g.factIds.forEach(id => known.add(id))
        this.knowledge = { ...this.knowledge, [to]: [...known] }
        this.gossip = this.gossip.map(x => (x.id === gossipId ? { ...x, status: "received", relayMessageId } : x))
        this.#log("GOSSIP_RECEIVED", { gossipId, to })
        return { ok: true, facts: this.facts.filter(f => g.factIds.includes(f.id)) }
    }

    /** Called by the witch agent. Only accepted if the Relay-authenticated sender is the spy. */
    async acceptReport(relayFrom: string, factIds: string[], content: string, relayMessageId: string): Promise<{ accepted: boolean }> {
        const state = this.#requireState()
        if (this.reports.some(r => r.relayMessageId === relayMessageId)) return { accepted: true }
        if (!isMonsterId(relayFrom) || relayFrom !== this.spyId || !this.#isLive(state)) {
            const reason = relayFrom === this.spyId ? "game_over" : "not_spy"
            this.rejectedReports = [...this.rejectedReports, { from: relayFrom, relayMessageId, at: Date.now(), reason }]
            this.#log("WITCH_REPORT_REJECTED", { relayFrom, relayMessageId, reason })
            return { accepted: false }
        }
        const known = new Set(this.knowledge[relayFrom] ?? [])
        const validFacts = factIds.filter(id => known.has(id))
        const report: WitchReport = {
            id: `r${this.reports.length + 1}`,
            sourceMonsterId: relayFrom,
            factIds: validFacts,
            content: clip(content, MAX_GOSSIP_CHARS),
            relayMessageId,
            receivedAt: Date.now(),
            revealed: false
        }
        this.reports = [...this.reports, report]
        this.#log("WITCH_REPORT_ACCEPTED", { reportId: report.id, relayMessageId })
        return { accepted: true }
    }

    /** The server records the Relay message it used to hand a fact to a monster's agent. */
    async recordHandoff(relayMessageId: string): Promise<void> {
        this.#requireState()
        if (!this.handoffIds.includes(relayMessageId)) this.handoffIds = [...this.handoffIds, relayMessageId]
    }

    /** Every Relay message ID that belongs to this game (for the Director's live feed). IDs only, no content. */
    async relayMessageIds(): Promise<string[]> {
        return [
            ...this.handoffIds,
            ...this.gossip.flatMap(g => (g.relayMessageId ? [g.relayMessageId] : [])),
            ...this.reports.map(r => r.relayMessageId),
            ...this.rejectedReports.map(r => r.relayMessageId)
        ]
    }

    /** Who a monster could gossip to. Exposed so agents do not hard-code the cast. */
    async gossipTargets(monsterId: string): Promise<MonsterId[]> {
        return isMonsterId(monsterId) ? otherMonsters(monsterId) : []
    }

    // ----- director --------------------------------------------------------

    /** Full evidence. The game server only serves this once the game has ended. */
    async director(): Promise<DirectorView | null> {
        const state = this.publicState
        if (!state || !this.spyId) return null
        const events = this.db.exec("SELECT seq, type, detail, at FROM events ORDER BY seq") as unknown as GameEvent[]
        return {
            spyId: this.spyId,
            facts: this.facts,
            gossip: this.gossip,
            reports: this.reports,
            rejectedReports: this.rejectedReports,
            evidence: this.evidence,
            events,
            public: state
        }
    }

    // ----- sockets ---------------------------------------------------------

    async onConnect(socket: Socket): Promise<void> {
        if (!this.publicState) {
            socket.reject(4004, "game_not_found")
            return
        }
        socket.setTags(socket.metadata.role)
        this.setWebSocketAutoResponse({ request: "ping", response: "pong" })
    }

    async onMessage(_socket: Socket, _message: Incoming): Promise<void> {
        // Clients only listen. All actions go through the game server.
    }
}

// ---------------------------------------------------------------------------
// MonsterActor: one per monster per session (id = `${sessionId}.${monsterId}`).
// The monster's own memory: what the player said, what it replied, rumours it heard.
// ---------------------------------------------------------------------------

export interface ChatLine {
    role: "player" | "monster"
    content: string
    at: number
}

export interface Rumour {
    from: MonsterId
    text: string
    relayMessageId: string
    at: number
}

export class MonsterActor extends Actor {
    @Persisted private history: ChatLine[] = []
    @Persisted private rumours: Rumour[] = []

    async memory(): Promise<{ history: ChatLine[]; rumours: Rumour[] }> {
        return { history: this.history, rumours: this.rumours }
    }

    async rememberExchange(playerText: string, monsterText: string): Promise<ChatLine[]> {
        const now = Date.now()
        this.history = [...this.history, { role: "player", content: playerText, at: now }, { role: "monster", content: monsterText, at: now }]
        return this.history
    }

    async hearRumour(from: string, text: string, relayMessageId: string): Promise<void> {
        if (!isMonsterId(from) || this.rumours.some(r => r.relayMessageId === relayMessageId)) return
        this.rumours = [...this.rumours, { from, text: clip(text, MAX_GOSSIP_CHARS), relayMessageId, at: Date.now() }]
    }
}

// ---------------------------------------------------------------------------
// Lobby: a single actor ("main") that remembers recent games for the Director screen.
// ---------------------------------------------------------------------------

export class Lobby extends Actor {
    @Persisted private recent: { sessionId: string; startedAt: number }[] = []

    async add(sessionId: string): Promise<void> {
        if (this.recent.some(g => g.sessionId === sessionId)) return
        this.recent = [{ sessionId, startedAt: Date.now() }, ...this.recent].slice(0, 20)
    }

    async list(): Promise<{ sessionId: string; startedAt: number }[]> {
        return this.recent
    }
}
