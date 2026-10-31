import { COURTYARD, EXIT_DOOR, PLAYER_RADIUS, ROOM, type Point2 } from './collision'

export const ESCAPE_FINISH_X = 9.6

/** Track an actual outward walk. UI clicks and a camera jump cannot finish the game. */
export class ExitJourney {
    private crossed = false
    private reported = false

    reset(): void { this.crossed = false; this.reported = false }

    step(from: Point2, to: Point2, open: boolean): boolean {
        if (!open) { this.reset(); return false }
        if (this.reported || ![from.x, from.z, to.x, to.z].every(Number.isFinite)) return false
        if (Math.hypot(to.x - from.x, to.z - from.z) > .25) { this.crossed = false; return false }
        const threshold = EXIT_DOOR.wallOutsideX + PLAYER_RADIUS
        const inDoorway = to.z >= EXIT_DOOR.minZ + PLAYER_RADIUS && to.z <= EXIT_DOOR.maxZ - PLAYER_RADIUS
        // Movement is collision-substepped upstream. Both samples must straddle the real sill.
        if (from.x < threshold && to.x >= threshold && inDoorway) this.crossed = true
        if (to.x < ROOM.maxX - PLAYER_RADIUS) this.crossed = false
        if (!this.crossed || to.x < ESCAPE_FINISH_X || to.x > COURTYARD.maxX - PLAYER_RADIUS
            || to.z < COURTYARD.minZ + PLAYER_RADIUS || to.z > COURTYARD.maxZ - PLAYER_RADIUS) return false
        this.reported = true
        return true
    }
}

/** Face the next safe leg around the reading desk; never move the player. */
export function nextExitWaypoint(p: Point2): Point2 {
    if (p.x >= 4.02) return { x: 11, z: EXIT_DOOR.centerZ }
    if (p.x > 2.61 && p.z > -4.27) {
        return Math.abs(p.z - EXIT_DOOR.centerZ) < .24
            ? { x: 11, z: EXIT_DOOR.centerZ }
            : { x: 2.85, z: EXIT_DOOR.centerZ }
    }
    if (p.x > 2.61) return { x: .45, z: -4.4 }
    if (p.z > 1.85) return { x: 2.85, z: 2.05 }
    return { x: .45, z: 2.05 }
}

export function outdoorBlend(p: Point2): number {
    const t = Math.max(0, Math.min(1, (p.x - 3.55) / 3.2))
    return t * t * (3 - 2 * t)
}
