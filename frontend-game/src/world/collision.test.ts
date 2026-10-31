import assert from "node:assert/strict"
import { test } from "node:test"
import { isWalkable, moveWithCollisions, COURTYARD, EXIT_DOOR, OBSTACLES, PLAYER_RADIUS, ROOM, SPAWN } from "./collision"

test("the entry point and a direct walk down the main aisle stay clear", () => {
    assert.ok(isWalkable(SPAWN))
    const end = moveWithCollisions(SPAWN, { x: 0, z: -9 })
    assert.ok(isWalkable(end))
    assert.ok(end.z < -4)
})

test("large frame deltas cannot tunnel through the reading counter", () => {
    const end = moveWithCollisions({ x: 0, z: 0 }, { x: -8, z: 0 })
    assert.ok(isWalkable(end))
    assert.ok(end.x >= OBSTACLES[1].maxX + PLAYER_RADIUS)
})

test("diagonal movement slides along furniture", () => {
    const end = moveWithCollisions({ x: 0.9, z: 0 }, { x: 2, z: -2 })
    assert.ok(isWalkable(end))
    assert.ok(end.x < 1.29 - PLAYER_RADIUS)
    assert.ok(end.z < -1.8)
})

test("room walls bound walking in every direction", () => {
    for (const delta of [{ x: 0, z: 100 }, { x: 0, z: -100 }, { x: 100, z: 0 }, { x: -100, z: 0 }]) {
        const end = moveWithCollisions({ x: 0, z: -6.7 }, delta)
        assert.ok(isWalkable(end))
        assert.ok(end.x <= ROOM.maxX - PLAYER_RADIUS)
        assert.ok(end.z >= ROOM.minZ + PLAYER_RADIUS)
    }
})

test("the unlocked masonry opening reaches the exterior rather than a short threshold", () => {
    const start = { x: 2.85, z: EXIT_DOOR.centerZ }
    const closed = moveWithCollisions(start, { x: 7.15, z: 0 }, false)
    assert.ok(closed.x <= ROOM.maxX - PLAYER_RADIUS)
    const open = moveWithCollisions(start, { x: 7.15, z: 0 }, true)
    assert.ok(Math.abs(open.x - 10) < 1e-8)
    assert.ok(isWalkable(open, true))
    assert.equal(isWalkable(open, false), false)
})

test("the former misaligned threshold and side wall cannot lead outside", () => {
    for (const z of [-3.9, -.5, .7]) {
        const start = { x: 2.85, z }
        assert.ok(isWalkable(start, true))
        const end = moveWithCollisions(start, { x: 10, z: 0 }, true)
        assert.ok(end.x <= ROOM.maxX - PLAYER_RADIUS)
        assert.ok(isWalkable(end, true))
    }
    assert.equal(isWalkable({ x: 3.6, z: -3.9 }, true), false)
    assert.equal(isWalkable({ x: 3.6, z: -.5 }, true), false)
})

test("a locked door cannot be bypassed with diagonal movement around the wall", () => {
    for (const delta of [{ x: 100, z: 100 }, { x: 100, z: -100 }]) {
        const end = moveWithCollisions({ x: 2.85, z: -2.9 }, delta, false)
        assert.ok(end.x <= ROOM.maxX - PLAYER_RADIUS)
        assert.ok(isWalkable(end, false))
    }
})

test("players can move sideways outside without being clamped back to the doorway", () => {
    const upper = moveWithCollisions({ x: 10, z: -2.9 }, { x: 0, z: 3.4 }, true)
    const lower = moveWithCollisions(upper, { x: 0, z: -6.5 }, true)
    assert.ok(Math.abs(upper.z - .5) < 1e-8)
    assert.ok(Math.abs(lower.z + 6) < 1e-8)
    assert.equal(upper.x, 10)
    assert.equal(lower.x, 10)
    assert.ok(isWalkable(upper, true) && isWalkable(lower, true))
})

test("the courtyard bounds stop long movements and its west wall only admits the doorway", () => {
    const start = { x: 10, z: -2.9 }
    for (const delta of [{ x: 100, z: 0 }, { x: 0, z: 100 }, { x: 0, z: -100 }]) {
        const end = moveWithCollisions(start, delta, true)
        assert.ok(isWalkable(end, true))
        assert.ok(end.x <= COURTYARD.maxX - PLAYER_RADIUS)
        assert.ok(end.z >= COURTYARD.minZ + PLAYER_RADIUS)
        assert.ok(end.z <= COURTYARD.maxZ - PLAYER_RADIUS)
    }
    const wall = moveWithCollisions({ x: 10, z: .5 }, { x: -20, z: 0 }, true)
    assert.ok(wall.x >= COURTYARD.minX + PLAYER_RADIUS)
    assert.ok(isWalkable(wall, true))
    const returned = moveWithCollisions(start, { x: -7.15, z: 0 }, true)
    assert.ok(Math.abs(returned.x - 2.85) < 1e-8)
    assert.ok(isWalkable(returned, false))
})

test("the complete front-aisle route goes around the desk, crosses the sill and returns inside", () => {
    let current = { ...SPAWN }
    for (const target of [{ x: 2.85, z: 2.05 }, { x: 2.85, z: -2.9 }, { x: 10, z: -2.9 }, { x: 2.85, z: -2.9 }, { x: 2.85, z: 2.05 }, SPAWN]) {
        current = moveWithCollisions(current, { x: target.x - current.x, z: target.z - current.z }, true)
        assert.ok(Math.hypot(current.x - target.x, current.z - target.z) < .001)
        assert.ok(isWalkable(current, true))
    }
})

test("invalid motion does not poison the camera transform", () => {
    assert.deepEqual(moveWithCollisions(SPAWN, { x: NaN, z: 1 }), SPAWN)
})
