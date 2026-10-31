export const MONSTER_IDS = ["sprout", "pebble", "momo"] as const
export type MonsterId = (typeof MONSTER_IDS)[number]

export const MONSTER_NAMES: Record<MonsterId, string> = { sprout: "Sprout", pebble: "Pebble", momo: "Momo" }

export function isMonsterId(value: unknown): value is MonsterId {
    return typeof value === "string" && (MONSTER_IDS as readonly string[]).includes(value)
}

/** Metadata carried on every Relay message in this game. */
export type RelayMeta =
    | { kind: "heard"; sessionId: string; factId: string }
    | { kind: "gossip"; sessionId: string; gossipId: string; factIds: string[] }
    | { kind: "report"; sessionId: string; factIds: string[] }
