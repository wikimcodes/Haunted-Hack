import assert from "node:assert/strict"
import { test } from "node:test"
import { PerspectiveCamera, Vector3 } from "three"
import {
    CameraDirector, REVEAL_DURATION, REVEAL_ENTER, REVEAL_RETURN,
    candleModulation, capturePose, lightProfile, poseLookingAt, revealEnvelope, type CameraPose
} from "./cinematics"

function assertPose(camera: PerspectiveCamera, expected: CameraPose) {
    assert.ok(camera.position.distanceTo(expected.position) < 1e-8, "camera position is restored")
    assert.ok(1 - Math.abs(camera.quaternion.dot(expected.quaternion)) < 1e-8, "camera orientation is restored")
    assert.equal(camera.fov, expected.fov)
}
function setup(reducedMotion = false) {
    const camera = new PerspectiveCamera(58)
    camera.position.set(-.7, 1.65, 4.35)
    camera.lookAt(new Vector3(-.3, 1.9, -4.6))
    const walking = capturePose(camera)
    const focus = poseLookingAt(new Vector3(-.4, 1.65, 3.8), new Vector3(-.8, 1.4, -2), 45)
    const witch = poseLookingAt(new Vector3(-.25, 1.65, -1.6), new Vector3(0, 1.65, -6.65), 42)
    const changes: boolean[] = []
    const director = new CameraDirector(camera, {
        reducedMotion,
        focus: (_id, saved) => reducedMotion ? saved : focus,
        witch: saved => reducedMotion ? saved : witch,
        onRevealChange: value => changes.push(value)
    })
    return { camera, walking, focus, witch, changes, director }
}

test("reveal eases toward the witch and restores the exact walking pose after six seconds", () => {
    const { camera, walking, witch, director, changes } = setup()
    director.update(REVEAL_ENTER / 2, true, null, 1)
    assert.ok(director.movementBlocked)
    assert.ok(director.isRevealing)
    assert.ok(camera.position.distanceTo(walking.position) > 0)
    assert.ok(camera.position.distanceTo(witch.position) > 0)
    director.update(REVEAL_ENTER / 2, true, null, 1)
    assertPose(camera, witch)
    director.update(REVEAL_RETURN - REVEAL_ENTER, true, null, 1)
    assertPose(camera, witch)
    director.update(REVEAL_DURATION - REVEAL_RETURN, true, null, 1)
    assertPose(camera, walking)
    assert.equal(director.movementBlocked, false)
    assert.equal(director.isRevealing, false)
    assert.deepEqual(changes, [true, false])
})

test("reveal preempts conversation, returns to it, and closing it restores the player", () => {
    const { camera, walking, focus, witch, director } = setup()
    director.update(1, true, "sprout", 0)
    assertPose(camera, focus)
    director.update(1, true, "sprout", 1)
    assertPose(camera, witch)
    director.update(5, true, "sprout", 1)
    assertPose(camera, focus)
    assert.equal(director.movementBlocked, true)
    director.update(1, true, null, 1)
    assertPose(camera, walking)
    assert.equal(director.movementBlocked, false)
})

test("closing a conversation during reveal returns directly to the saved walking pose", () => {
    const { camera, walking, director } = setup()
    director.update(.3, true, "pebble", 0)
    director.update(1, true, "pebble", 1)
    director.update(5, true, null, 1)
    assertPose(camera, walking)
    assert.equal(director.movementBlocked, false)
})

test("duplicate and stale event tokens cannot replay a reveal", () => {
    const { director, changes } = setup()
    director.update(6, true, null, 3)
    director.update(1, true, null, 3)
    director.update(1, true, null, 2)
    assert.equal(director.isRevealing, false)
    assert.deepEqual(changes, [true, false])
    director.update(1, true, null, 4)
    assert.equal(director.isRevealing, true)
    assert.deepEqual(changes, [true, false, true])
})

test("cancel and leaving the game restore the camera and consume inactive events", () => {
    const { camera, walking, director, changes } = setup()
    director.update(2, true, null, 1)
    director.cancel()
    assertPose(camera, walking)
    assert.equal(director.movementBlocked, false)
    director.update(1, false, null, 2)
    director.update(1, true, null, 2)
    assert.equal(director.isRevealing, false)
    director.update(1, true, "momo", 3)
    director.update(.1, false, null, 3)
    assertPose(camera, walking)
    assert.deepEqual(changes, [true, false, true, false])
})

test("reduced motion keeps the player camera still during focus and reveal", () => {
    const { camera, walking, director } = setup(true)
    director.update(.1, true, "momo", 0)
    assertPose(camera, walking)
    for (let i = 0; i < 120; i++) {
        director.update(.05, true, "momo", 1)
        assertPose(camera, walking)
    }
    director.update(.1, true, null, 1)
    director.update(.2, true, null, 1)
    assertPose(camera, walking)
    assert.equal(director.movementBlocked, false)
})

test("reveal brightness has smooth endpoints and candle changes are bounded", () => {
    assert.equal(revealEnvelope(0), 0)
    assert.equal(revealEnvelope(REVEAL_ENTER), 1)
    assert.equal(revealEnvelope(REVEAL_RETURN), 1)
    assert.equal(revealEnvelope(REVEAL_DURATION), 0)
    assert.equal(revealEnvelope(NaN), 0)
    for (let t = 0; t < 20; t += .03) {
        const strength = revealEnvelope(t)
        assert.ok(strength >= 0 && strength <= 1)
        const value = candleModulation(t, 2.31, strength, false)
        assert.ok(value >= .7 && value <= 1.05)
        assert.equal(candleModulation(t, 2.31, 1, true), .84)
    }
})

test("ending lighting changes the whole scene without selecting a monster", () => {
    const intro = lightProfile("introduction"), suspicion = lightProfile("suspicion")
    const won = lightProfile("won"), lost = lightProfile("lost")
    assert.ok(suspicion.candles < intro.candles)
    assert.ok(lost.candles < suspicion.candles)
    assert.equal(intro.witch, 1, "idle cloak has no dithered transparency")
    assert.equal(suspicion.witch, 1, "suspicion changes lighting, not cloak coverage")
    assert.equal(lost.witch, 1)
    assert.equal(won.witch, 0)
    assert.equal(won.dawn, 1)
    intro.candles = 0
    assert.equal(lightProfile("introduction").candles, 1)
})
