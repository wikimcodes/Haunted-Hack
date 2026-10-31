import assert from "node:assert/strict"
import { test } from "node:test"
import { LibraryAudio, type AudioFrame, type AudioStatus } from "./LibraryAudio"

class Param {
    value = 0
    setValueAtTime(value: number) { this.value = value }
    linearRampToValueAtTime(value: number) { this.value = value }
    setTargetAtTime(value: number) { this.value = value }
    cancelScheduledValues() {}
}
class Node {
    gain = new Param(); pan = new Param(); disconnected = false
    connect(_target: unknown) { return _target }
    disconnect() { this.disconnected = true }
}
class Source extends Node {
    buffer: AudioBuffer | null = null; loop = false; onended: (() => void) | null = null
    started: { when: number; offset: number } | null = null
    stopped = false
    start(when: number, offset: number) { this.started = { when, offset } }
    stop() { this.stopped = true }
}
class Context {
    currentTime = 0
    state: AudioContextState = "suspended"
    destination = new Node(); sources: Source[] = []; gains: Node[] = []; closed = false
    onstatechange: (() => void) | null = null
    rejectResume = false
    createGain() { const gain = new Node(); this.gains.push(gain); return gain }
    createStereoPanner() { return new Node() }
    createBufferSource() { const source = new Source(); this.sources.push(source); return source }
    async decodeAudioData(data: ArrayBuffer) { return { duration: new Uint8Array(data)[0] } as AudioBuffer }
    async resume() { if (this.rejectResume) throw new Error("User gesture required"); this.state = "running"; this.onstatechange?.() }
    async close() { this.closed = true; this.state = "closed" }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const bytes = (url: string) => new Uint8Array([url.includes("room") ? 30 : 6]).buffer
const scene = (elapsed: number | null = null, token = 1): AudioFrame => ({
    active: true, muted: false, reveal: elapsed === null ? null : { token, elapsed, strength: 1 }
})
function setup(fetchAudio?: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>) {
    const ctx = new Context(), statuses: AudioStatus[] = []
    let contexts = 0
    const audio = new LibraryAudio({
        baseUrl: "/audio/", createContext: () => { contexts++; return ctx as unknown as AudioContext },
        fetchAudio: fetchAudio ?? (async url => bytes(url)), onStatus: status => statuses.push(status)
    })
    return { audio, ctx, statuses, contexts: () => contexts }
}

test("audio is created only by an explicit unlock and repeated clicks do not duplicate ambience", async () => {
    const { audio, ctx, contexts } = setup()
    audio.update(scene())
    assert.equal(contexts(), 0)
    await audio.unlock(); await flush()
    assert.equal(contexts(), 1)
    assert.equal(ctx.sources.length, 1)
    assert.equal(ctx.sources[0].loop, true)
    await audio.unlock(); audio.update(scene()); await flush()
    assert.equal(contexts(), 1); assert.equal(ctx.sources.length, 1)
    audio.dispose(); assert.equal(ctx.closed, true)
})

test("reveal follows the visual time, deduplicates a token and starts a newer cue from its own phase", async () => {
    const { audio, ctx } = setup()
    await audio.unlock(); await flush()
    audio.update(scene(.2, 2))
    assert.equal(ctx.sources.length, 2)
    assert.equal(ctx.sources[1].started?.offset, .2)
    ctx.currentTime = 1; audio.update(scene(1.2, 2)); audio.update(scene(1.2, 2))
    assert.equal(ctx.sources.length, 2)
    audio.update(scene(.1, 3))
    assert.equal(ctx.sources[1].stopped, true)
    assert.equal(ctx.sources[2].started?.offset, .1)
    audio.update(scene(.3, 2))
    assert.equal(ctx.sources.length, 3, "stale cue cannot start sound")
    audio.dispose()
})

test("mute stops both sources and unmute seeks the current reveal rather than replaying its start", async () => {
    const { audio, ctx } = setup()
    await audio.unlock(); await flush(); audio.update(scene(.5))
    audio.update({ ...scene(.8), muted: true })
    assert.ok(ctx.sources.every(source => source.stopped))
    ctx.currentTime = 2.5; audio.update(scene(3))
    assert.equal(ctx.sources.at(-1)?.started?.offset, 3)
    audio.update(scene()); assert.equal(ctx.sources.at(-1)?.stopped, true)
    const count = ctx.sources.length
    audio.update(scene()); assert.equal(ctx.sources.length, count)
    audio.dispose()
})

test("hiding stops audio immediately and returning resumes the paused visual phase", async () => {
    const { audio, ctx } = setup()
    await audio.unlock(); await flush(); audio.update(scene(1.4))
    audio.setHidden(true)
    assert.ok(ctx.sources.every(source => source.stopped))
    ctx.currentTime = 80
    audio.update(scene(1.4)); assert.equal(ctx.sources.length, 2)
    audio.setHidden(false)
    assert.equal(ctx.sources.at(-1)?.started?.offset, 1.4)
    audio.update({ ...scene(1.4), active: false })
    assert.ok(ctx.sources.every(source => source.stopped), "menu/title stops the room and reveal")
    audio.dispose()
})

test("late decode joins an active reveal at its current time and never replays a cancelled one", async () => {
    const pending: (() => void)[] = []
    const { audio, ctx, statuses } = setup(url => new Promise(resolve => pending.push(() => resolve(bytes(url)))))
    await audio.unlock(); audio.update(scene(.1)); audio.update(scene(4.2))
    assert.equal(statuses.at(-1), "loading", "a running context without decoded assets is not ready")
    for (const resolve of pending) resolve()
    await flush()
    assert.equal(ctx.sources.at(-1)?.started?.offset, 4.2)
    assert.equal(statuses.at(-1), "ready")
    audio.dispose()

    const pending2: (() => void)[] = []
    const cancelled = setup(url => new Promise(resolve => pending2.push(() => resolve(bytes(url)))))
    await cancelled.audio.unlock(); cancelled.audio.update(scene(.1)); cancelled.audio.update(scene())
    for (const resolve of pending2) resolve()
    await flush()
    assert.equal(cancelled.ctx.sources.length, 1, "only ambience remains after the shot was cancelled")
    cancelled.audio.dispose()
})

test("drift resynchronizes to the camera clock and a naturally ended cue never retriggers", async () => {
    const { audio, ctx } = setup()
    await audio.unlock(); await flush(); audio.update(scene(.1))
    ctx.currentTime = 2; audio.update(scene(1))
    assert.equal(ctx.sources.at(-1)?.started?.offset, 1)
    ctx.sources.at(-1)?.onended?.()
    const count = ctx.sources.length
    audio.update(scene(5.8))
    assert.equal(ctx.sources.length, count)
    audio.dispose()
})

test("a load failure is nonfatal and disposing during a pending load cannot start sound", async () => {
    const failed = setup(async () => { throw new Error("offline") })
    await failed.audio.unlock(); failed.audio.update(scene()); await flush()
    assert.equal(failed.statuses.at(-1), "unavailable")
    assert.equal(failed.ctx.sources.length, 0); failed.audio.dispose()
    const pending: (() => void)[] = []
    const closed = setup(url => new Promise(resolve => pending.push(() => resolve(bytes(url)))))
    await closed.audio.unlock(); closed.audio.update(scene(.1)); closed.audio.dispose()
    const statusCount = closed.statuses.length
    for (const resolve of pending) resolve()
    await flush()
    assert.equal(closed.ctx.sources.length, 0); assert.equal(closed.statuses.length, statusCount)
})

test("an interrupted audio context stops playback and reports when another click is needed", async () => {
    const { audio, ctx, statuses } = setup()
    await audio.unlock(); await flush(); audio.update(scene())
    ctx.state = "suspended"; ctx.onstatechange?.()
    assert.ok(ctx.sources[0].stopped)
    assert.equal(statuses.at(-1), "locked")
    ctx.rejectResume = true
    assert.equal(await audio.unlock(), false)
    assert.equal(ctx.sources.length, 1)
    ctx.rejectResume = false
    assert.equal(await audio.unlock(), true)
    assert.equal(ctx.sources.length, 2)
    audio.dispose()
})

test("the room falls quiet before the witch arrives and recovers after the cue", async () => {
    const { audio, ctx } = setup()
    await audio.unlock(); await flush(); audio.update(scene())
    const roomGain = ctx.gains[1].gain
    const normal = roomGain.value
    audio.update(scene(.3))
    assert.ok(roomGain.value < normal * .1, "anticipation leaves near silence")
    audio.update(scene(1.4))
    assert.ok(roomGain.value > normal * .1 && roomGain.value < normal * .4, "the arrival stays in front of the room")
    audio.update(scene(5.7))
    assert.ok(roomGain.value > normal * .8, "the room returns during the camera return")
    audio.update(scene())
    assert.equal(roomGain.value, normal)
    audio.dispose()
})

test("a surprise glimpse plays the sting's first hit once, ducks the room, and respects mute", async () => {
    const { audio, ctx } = setup()
    audio.update({ ...scene(), muted: true })
    await audio.unlock(); await flush()
    audio.scare()
    assert.equal(ctx.sources.length, 0)
    audio.update(scene()); await flush()
    const room = ctx.sources.length
    audio.scare()
    assert.equal(ctx.sources.length, room + 1)
    const glimpse = ctx.sources.at(-1)!
    assert.equal(glimpse.loop, false)
    assert.ok(glimpse.started!.offset > 0 && glimpse.started!.offset < .5)
    audio.update({ ...scene(), muted: true })
    assert.equal(glimpse.stopped, true)
})
