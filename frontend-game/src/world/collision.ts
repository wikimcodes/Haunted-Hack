/** Meter-scale collision proxies for the exported library, in glTF Y-up space. */
export interface Point2 { x: number; z: number }
export interface Obstacle { name: string; minX: number; maxX: number; minZ: number; maxZ: number; height: number }

export const EYE_HEIGHT = 1.65
export const PLAYER_RADIUS = 0.23
export const SPAWN: Point2 = { x: -0.7, z: 4.35 }
export const ROOM = { minX: -3.26, maxX: 3.26, minZ: -7.58, maxZ: 4.72 }
// Measured from the exported masonry opening. The door root is its hinge, not its center.
export const EXIT_DOOR = { minZ: -3.65, maxZ: -2.15, centerZ: -2.90, wallOutsideX: 3.81 }
export const COURTYARD = { minX: 4.0, maxX: 15, minZ: -7.0, maxZ: 1.2 }
export const OBSTACLES: readonly Obstacle[] = [
    { name: "left bookcases", minX: -3.6, maxX: -2.59, minZ: -7.15, maxZ: 4.4, height: 6.2 },
    { name: "reading counters", minX: -3.04, maxX: -1.96, minZ: -5.05, maxZ: 4.345, height: 1.04 },
    { name: "right desk", minX: 1.29, maxX: 2.37, minZ: -3.95, maxZ: 1.55, height: 1.04 },
    { name: "back bookcase", minX: -3.2, maxX: -1, minZ: -8, maxZ: -7.15, height: 6.2 },
    { name: "right rear bookcase", minX: 2.7, maxX: 3.6, minZ: -7.1, maxZ: -4.7, height: 6.2 },
    { name: "dead tree trunk", minX: 2.11, maxX: 2.65, minZ: -6.2, maxZ: -5.1, height: 3.8 }
]

const EPSILON = 0.0001

function overlaps(p: Point2, box: Obstacle, radius: number): boolean {
    return p.x > box.minX - radius && p.x < box.maxX + radius && p.z > box.minZ - radius && p.z < box.maxZ + radius
}

/** Connected room, narrow masonry passage, then the broader exterior landing. */
function withinBoundary(p: Point2, doorOpen: boolean, radius: number): boolean {
    const inRoom = p.x >= ROOM.minX + radius && p.x <= ROOM.maxX - radius
        && p.z >= ROOM.minZ + radius && p.z <= ROOM.maxZ - radius
    if (inRoom) return true
    if (!doorOpen) return false
    const inDoorway = p.x >= ROOM.maxX - radius && p.x <= COURTYARD.minX + radius
        && p.z >= EXIT_DOOR.minZ + radius && p.z <= EXIT_DOOR.maxZ - radius
    const inCourtyard = p.x >= COURTYARD.minX + radius && p.x <= COURTYARD.maxX - radius
        && p.z >= COURTYARD.minZ + radius && p.z <= COURTYARD.maxZ - radius
    return inDoorway || inCourtyard
}

/** Fixed-height walking with substeps. Axis separation lets the player slide along furniture. */
export function moveWithCollisions(
    start: Point2,
    delta: Point2,
    doorOpen = false,
    obstacles: readonly Obstacle[] = OBSTACLES,
    radius = PLAYER_RADIUS
): Point2 {
    const p = { ...start }
    if (![p.x, p.z, delta.x, delta.z].every(Number.isFinite)) return { ...SPAWN }
    const count = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.z) / 0.07))
    const step = { x: delta.x / count, z: delta.z / count }
    for (let i = 0; i < count; i++) {
        for (const axis of ["x", "z"] as const) {
            if (step[axis] === 0) continue
            const previous = p[axis]
            p[axis] += step[axis]
            for (const box of obstacles) {
                if (!overlaps(p, box, radius)) continue
                if (axis === "x") p.x = step.x > 0 ? box.minX - radius - EPSILON : box.maxX + radius + EPSILON
                else p.z = step.z > 0 ? box.minZ - radius - EPSILON : box.maxZ + radius + EPSILON
                // If an invalid starting point would snap through a whole obstacle, stay put.
                if (Math.abs(p[axis] - previous) > Math.abs(step[axis]) + 0.01) p[axis] = previous
            }
            // Reject crossing a wall rather than clamping to another region: otherwise an
            // exterior step could snap through the jamb or along the closed side wall.
            if (!withinBoundary(p, doorOpen, radius)) p[axis] = previous
        }
    }
    return p
}

export function isWalkable(p: Point2, doorOpen = false): boolean {
    return withinBoundary(p, doorOpen, PLAYER_RADIUS) && !OBSTACLES.some(box => overlaps(p, box, PLAYER_RADIUS))
}
