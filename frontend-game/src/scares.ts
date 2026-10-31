// The witch's surprise glimpses: two or three per game at unpredictable moments, on top of her
// scheduled reveals. The schedule comes from the session ID, so a refresh or a second device
// sees the same game, and fired glimpses are remembered so a refresh never replays one.

export const MAX_SCARES = 3
/** No glimpse in the first moments of a game or just before dawn. */
const QUIET_START_MS = 20_000
const QUIET_END_MS = 15_000
/** A glimpse held back (by a reveal, a menu, a hidden tab) can still happen this much later. */
export const SCARE_GRACE_MS = 20_000

function seeded(seed: string): () => number {
    let h = 2166136261
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
    return () => {
        h = (h + 0x6d2b79f5) | 0
        let t = Math.imul(h ^ (h >>> 15), 1 | h)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/** Times (epoch ms) of this game's glimpses: one somewhere inside each equal slice of the game. */
export function scareSchedule(sessionId: string, startedAt: number, deadlineAt: number): number[] {
    const start = startedAt + QUIET_START_MS
    const end = deadlineAt - QUIET_END_MS
    if (!(end > start)) return []
    const random = seeded(sessionId)
    const count = random() < .5 ? MAX_SCARES - 1 : MAX_SCARES
    const slice = (end - start) / count
    return Array.from({ length: count }, (_, i) => Math.round(start + slice * (i + .15 + .7 * random())))
}

/** Index of the glimpse to play now, or null. Never more than one at a time, never one already played. */
export function dueScare(schedule: number[], played: readonly number[], now: number, blocked: boolean): number | null {
    if (blocked || played.length >= MAX_SCARES) return null
    const index = schedule.findIndex((at, i) => !played.includes(i) && at <= now && now - at < SCARE_GRACE_MS)
    return index < 0 ? null : index
}
