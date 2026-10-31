// Pure game rules and content. No I/O, so the actor stays deterministic and easy to test.

export const MONSTER_IDS = ["sprout", "pebble", "momo"] as const
export type MonsterId = (typeof MONSTER_IDS)[number]

export type GamePhase = "playing" | "won" | "lost" | "expired"
export type Mood = "idle" | "talking" | "thinking" | "nervous" | "accused"

export const MONSTERS: Record<MonsterId, { name: string; personality: string; gossipChance: number }> = {
    sprout: { name: "Sprout", personality: "The Friendly One", gossipChance: 0.6 },
    pebble: { name: "Pebble", personality: "The Curious One", gossipChance: 0.8 },
    momo: { name: "Momo", personality: "The Quiet One", gossipChance: 0.35 }
}

export const DEFAULT_GAME_MS = 180_000
export const DEFAULT_REVEAL_MS = 30_000
export const GOSSIP_PER_ROUND = 1
export const MAX_FACT_CHARS = 140
export const MAX_GOSSIP_CHARS = 280
export const MAX_FACTS_PER_GAME = 120

export function isMonsterId(value: unknown): value is MonsterId {
    return typeof value === "string" && (MONSTER_IDS as readonly string[]).includes(value)
}

export function pickRandom<T>(items: readonly T[]): T {
    return items[Math.floor(Math.random() * items.length)]!
}

export function otherMonsters(id: MonsterId): MonsterId[] {
    return MONSTER_IDS.filter(m => m !== id)
}

export function clip(text: string, max: number): string {
    const clean = text.replace(/\s+/g, " ").trim()
    return clean.length <= max ? clean : clean.slice(0, max - 1) + "…"
}

// Witch lines are server templates: the AI never decides what a clue reveals.
export const ECHO_LINES = [
    (fact: string) => `One of my little friends whispered to me that you said: "${fact}"`,
    (fact: string) => `Hehehe... I hear everything. Someone told me: "${fact}"`,
    (fact: string) => `A tiny voice brought me your words: "${fact}"`
]

// No report yet means the spy has heard nothing from the player, directly or by gossip.
// The line says so, which is a real hint: the spy is a ghost the player hasn't reached.
export const SILENT_LINES = [
    (whispers: number) => `My spy has heard nothing from you yet. Have you spoken to everyone? ${whispers} whisper${whispers === 1 ? " has" : "s have"} passed in the dark.`,
    (whispers: number) => `Silence from my little spy... you haven't told it a thing. Yet ${whispers} whisper${whispers === 1 ? "" : "s"} drifted between the shelves.`
]

// The spy knows something but its report hasn't arrived yet: say nothing misleading.
export const WAITING_LINES = [
    (whispers: number) => `My spy is slow tonight. ${whispers} whisper${whispers === 1 ? " has" : "s have"} passed between the shelves.`
]

// How the reported secret reached the spy. Told directly: the spy is the ghost the player told.
// Via gossip: the ghost the player told is innocent, and the spy is someone it whispered to.
export const DIRECT_SUFFIX = " And it came straight from your own lips."
export const GOSSIP_SUFFIX = " Though it reached my spy through a whisper."

export const CLEAR_LINES = [
    (name: string) => `${name} is far too sweet to work for me. Don't waste your time.`,
    (name: string) => `${name}? Never. That one couldn't keep a secret from me if it tried.`
]

export const DAWN_LINE = "The sun rises. You stayed too long, and now you are mine."
export const WIN_LINE = "No! My little spy! The doors are open... for now."
export const LOSE_LINE = "Wrong! Hehehe. You accused an innocent, and now you're trapped forever."
