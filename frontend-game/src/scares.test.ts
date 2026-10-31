import assert from "node:assert/strict"
import test from "node:test"

import { MAX_SCARES, SCARE_GRACE_MS, dueScare, scareSchedule } from "./scares"

const START = 1_000_000
const END = START + 180_000

test("each game gets two or three glimpses, spread out and away from the start and dawn", () => {
    const counts = new Set<number>()
    for (let i = 0; i < 200; i++) {
        const times = scareSchedule(`game_${i}`, START, END)
        counts.add(times.length)
        assert.ok(times.length >= 2 && times.length <= MAX_SCARES)
        times.forEach((at, j) => {
            assert.ok(at >= START + 20_000 && at <= END - 15_000)
            if (j) assert.ok(at - times[j - 1]! > 10_000, "glimpses never bunch together")
        })
    }
    assert.deepEqual([...counts].sort(), [2, 3])
})

test("the schedule is the same for the same game, and differs between games", () => {
    assert.deepEqual(scareSchedule("game_a", START, END), scareSchedule("game_a", START, END))
    assert.notDeepEqual(scareSchedule("game_a", START, END), scareSchedule("game_b", START, END))
})

test("games too short for a quiet start and end get no glimpses", () => {
    assert.deepEqual(scareSchedule("game_a", START, START + 30_000), [])
})

test("a glimpse plays once, waits while blocked, and is dropped after the grace period", () => {
    const schedule = [START + 30_000, START + 90_000, START + 150_000]
    assert.equal(dueScare(schedule, [], START + 29_000, false), null)
    assert.equal(dueScare(schedule, [], START + 30_000, false), 0)
    assert.equal(dueScare(schedule, [], START + 30_000, true), null)
    assert.equal(dueScare(schedule, [], START + 30_000 + SCARE_GRACE_MS - 1, false), 0)
    assert.equal(dueScare(schedule, [], START + 30_000 + SCARE_GRACE_MS, false), null)
    assert.equal(dueScare(schedule, [0], START + 35_000, false), null)
    assert.equal(dueScare(schedule, [0], START + 90_000, false), 1)
    assert.equal(dueScare(schedule, [0, 1, 2], START + 150_000, false), null)
})
