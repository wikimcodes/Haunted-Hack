// Shapes the backend sends. Mirrors backend/actor/src/actor.ts (PublicGameState etc.).

export type MonsterId = "sprout" | "pebble" | "momo"
export type GamePhase = "playing" | "won" | "lost" | "expired"
export type Mood = "idle" | "talking" | "thinking" | "nervous" | "accused"

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
    /** null until the game is over. */
    spyId: MonsterId | null
}

export type CueName =
    | "MONSTER_THINKING"
    | "MONSTER_SPEAKING"
    | "GOSSIP_STARTED"
    | "WITCH_REVEAL"
    | "ACCUSATION_CORRECT"
    | "ACCUSATION_WRONG"
    | "GAME_EXPIRED"

/** One-off animation trigger from the backend. */
export interface Cue {
    type: "cue"
    cue: CueName
    monsterId?: MonsterId
    at: number
}

export interface ChatLine {
    id: string
    monsterId: MonsterId
    role: "player" | "monster"
    text: string
    at: number
}

export interface ChatResult {
    monsterId: MonsterId
    reply: string
    factId: string
    source: "openai" | "fallback"
    /** The server is speaking this reply in the ghost's own voice; fetch it from `replyVoiceUrl`. */
    voice?: boolean
}

/** Mood -> Blender animation clip name (PRD 6.2). Holly can change these to match her clips. */
export const ANIMATION_FOR_MOOD: Record<Mood, string> = {
    idle: "Idle",
    talking: "Talk",
    thinking: "Think",
    nervous: "Think",
    accused: "Accused"
}
