import assert from "node:assert/strict"
import { test } from "node:test"
import { isWalkable, moveWithCollisions, OBSTACLES, PLAYER_RADIUS, ROOM, SPAWN } from "./collision"

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

test("only an open door permits entering the short escape threshold", () => {
    const start = { x: 2.8, z: -3.65 }
    assert.ok(moveWithCollisions(start, { x: 2, z: 0 }, false).x < 3.1)
    const open = moveWithCollisions(start, { x: 2, z: 0 }, true)
    assert.ok(open.x > 3.5)
    assert.ok(isWalkable(open, true))
})

test("invalid motion does not poison the camera transform", () => {
    assert.deepEqual(moveWithCollisions(SPAWN, { x: NaN, z: 1 }), SPAWN)
})
