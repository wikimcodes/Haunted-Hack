import assert from "node:assert/strict"
import test from "node:test"
import { createGameApi, GameApiError } from "./api"
import { GameConnection } from "./connection"
import type { PublicGameState } from "./types"

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}

function state(sessionId: string, phase: PublicGameState["phase"] = "playing"): PublicGameState {
    return {
        sessionId, phase, startedAt: Date.now(), deadlineAt: Date.now() + 180_000,
        nextRevealAt: Date.now() + 60_000, round: 0,
        monsters: [{ id: "sprout", name: "Sprout", personality: "Friendly", mood: "idle" }],
        clues: [], accusation: null, spyId: phase === "playing" ? null : "sprout"
    }
}

function json(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

class Socket {
    static instances: Socket[] = []
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    closed = false
    constructor(readonly url: string) { Socket.instances.push(this) }
    close() { this.closed = true; this.onclose?.() }
    open() { this.onopen?.() }
    receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
}

type FetchMock = (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>

function environment(fetch: FetchMock) {
    const descriptors = new Map<string, PropertyDescriptor | undefined>()
    const storage = new Map<string, string>()
    const replacements: Record<string, unknown> = {
        fetch,
        WebSocket: Socket,
        localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value)
        }
    }
    Socket.instances = []
    for (const [key, value] of Object.entries(replacements)) {
        descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    }
    return {
        storage,
        restore() {
            for (const [key, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor)
                else Reflect.deleteProperty(globalThis, key)
            }
        }
    }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

test("game client lifecycle and actual API contract", async t => {
    await t.test("closing during resume never reconnects or saves the stale session", async () => {
        const pending = deferred<Response>()
        let requests = 0
        const env = environment(async () => { requests++; return pending.promise })
        const connection = new GameConnection("http://api.test")
        try {
            const resumed = connection.resume("old")
            connection.close()
            pending.resolve(json(state("old")))
            assert.equal(await resumed, null)
            assert.equal(requests, 1)
            assert.equal(Socket.instances.length, 0)
            assert.equal(connection.getSnapshot().state, null)
            assert.equal(env.storage.size, 0)
        } finally { connection.close(); env.restore() }
    })

    await t.test("Strict Mode cleanup and remount only accepts the new resume", async () => {
        const first = deferred<Response>()
        let gets = 0
        const env = environment(async input => {
            if (String(input).endsWith("/socket")) return json({ websocketUrl: "ws://new" })
            return ++gets === 1 ? first.promise : json(state("same"))
        })
        const connection = new GameConnection("http://api.test")
        try {
            const stale = connection.resume("same")
            connection.close()
            await connection.resume("same")
            first.resolve(json(state("same", "lost")))
            assert.equal(await stale, null)
            await tick()
            assert.equal(connection.getSnapshot().state?.phase, "playing")
            assert.equal(Socket.instances.length, 1)
            Socket.instances[0]!.open()
            assert.equal(connection.getSnapshot().connected, true)
        } finally { connection.close(); env.restore() }
    })

    await t.test("two grants for the same session cannot install an obsolete socket", async () => {
        const firstGrant = deferred<Response>()
        const secondGrant = deferred<Response>()
        let grants = 0
        const env = environment(async input => String(input).endsWith("/socket")
            ? (++grants === 1 ? firstGrant.promise : secondGrant.promise)
            : json(state("same")))
        const connection = new GameConnection("http://api.test")
        try {
            await connection.resume("same")
            await connection.resume("same")
            secondGrant.resolve(json({ websocketUrl: "ws://current" }))
            await tick()
            firstGrant.resolve(json({ websocketUrl: "ws://stale" }))
            await tick()
            assert.deepEqual(Socket.instances.map(socket => socket.url), ["ws://current"])
        } finally { connection.close(); env.restore() }
    })

    await t.test("old replies, old socket events and foreign snapshots cannot alter a replacement game", async () => {
        const reply = deferred<Response>()
        const env = environment(async input => {
            const url = String(input)
            if (url.endsWith("/chat")) return reply.promise
            if (url.endsWith("/socket")) return json({ websocketUrl: "ws://" + url.split("/").at(-2) })
            return json(state(url.split("/").at(-1)!))
        })
        const connection = new GameConnection("http://api.test")
        try {
            await connection.resume("old"); await tick()
            const oldMessage = Socket.instances[0]!.onmessage!
            const chat = connection.chat("sprout", "Who was here?")
            await connection.resume("new"); await tick()
            reply.resolve(json({ monsterId: "sprout", reply: "Old answer", factId: "f1", source: "openai" }))
            await chat
            oldMessage({ data: JSON.stringify({ type: "state", state: { publicState: state("old", "lost") } }) })
            Socket.instances.at(-1)!.receive({ type: "state", state: { publicState: state("foreign", "lost") } })
            assert.equal(connection.getSnapshot().state?.sessionId, "new")
            assert.equal(connection.getSnapshot().state?.phase, "playing")
            assert.deepEqual(connection.getSnapshot().chat, [])
            assert.equal(connection.getSnapshot().waitingFor, null)
            assert.equal(Socket.instances[0]!.closed, true)
        } finally { connection.close(); env.restore() }
    })

    await t.test("closing cancels a scheduled reconnect", async () => {
        let requests = 0
        const env = environment(async input => {
            requests++
            return String(input).endsWith("/socket") ? json({ websocketUrl: "ws://current" }) : json(state("one"))
        })
        const connection = new GameConnection("http://api.test")
        try {
            await connection.resume("one"); await tick()
            Socket.instances[0]!.close()
            connection.close()
            await new Promise(resolve => setTimeout(resolve, 540))
            assert.equal(requests, 2)
            assert.equal(connection.getSnapshot().connected, false)
        } finally { connection.close(); env.restore() }
    })

    await t.test("chat errors release the pending state, and malformed storage is ignored", async () => {
        const env = environment(async input => {
            const url = String(input)
            if (url.endsWith("/chat")) return json({ error: "message_too_long" }, 400)
            if (url.endsWith("/socket")) return json({ websocketUrl: "ws://current" })
            return json(state("one"))
        })
        env.storage.set("spy-monster-session:one:chat", '{"bad":"data"}')
        const connection = new GameConnection("http://api.test")
        try {
            await connection.resume("one")
            assert.deepEqual(connection.getSnapshot().chat, [])
            await connection.chat("sprout", "hello")
            assert.equal(connection.getSnapshot().error, "message_too_long")
            assert.equal(connection.getSnapshot().waitingFor, null)
            assert.equal(connection.getSnapshot().chat.length, 1)
        } finally { connection.close(); env.restore() }
    })

    await t.test("ghost replies play on the shared player, newest first, and muting stops them", async () => {
        const bodies: { requestId: string; voice: boolean }[] = []
        const env = environment(async (input, options) => {
            const url = String(input)
            if (url.endsWith("/chat")) {
                const body = JSON.parse(String(options!.body))
                bodies.push(body)
                return json({ monsterId: body.monsterId, reply: "Boo.", factId: "f", source: "openai", voice: body.voice })
            }
            if (url.endsWith("/socket")) return json({ websocketUrl: "ws://current" })
            return json(state("one"))
        })
        const players: FakeAudio[] = [], played: string[] = []
        class FakeAudio {
            src = ""; paused = true; preload = ""
            constructor(src?: string) { if (src) this.src = src; players.push(this) }
            addEventListener() {}
            play() { this.paused = false; played.push(this.src); return Promise.resolve() }
            pause() { this.paused = true }
        }
        const previousAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio")
        Object.defineProperty(globalThis, "Audio", { configurable: true, writable: true, value: FakeAudio })
        const connection = new GameConnection("http://api.test")
        try {
            await connection.resume("one")
            await connection.chat("sprout", "hello")
            await connection.chat("momo", "and you?")
            const voiceUrl = (b: { requestId: string }) => `http://api.test/api/game/one/reply-voice/${b.requestId}`
            assert.equal(players.length, 1, "every line goes through the one tap-unlocked player")
            assert.deepEqual(played.filter(src => !src.startsWith("data:")), bodies.map(voiceUrl), "a newer reply replaces the one still playing")
            connection.setVoices(false)
            assert.equal(players[0]!.paused, true, "muting stops the current line")
            await connection.chat("pebble", "quiet now")
            assert.equal(bodies.at(-1)!.voice, false, "a muted client does not ask the server to spend a voice")
            assert.equal(played.filter(src => !src.startsWith("data:")).length, 2)
        } finally {
            connection.close(); env.restore()
            if (previousAudio) Object.defineProperty(globalThis, "Audio", previousAudio)
            else delete (globalThis as { Audio?: unknown }).Audio
        }
    })

    await t.test("API timeout aborts hanging requests and preserves backend error codes", async () => {
        const env = environment(async (_input, options) => new Promise<Response>((_resolve, reject) => {
            options!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
        }))
        try {
            await assert.rejects(createGameApi("http://api.test", { timeoutMs: 5 }).start(),
                error => error instanceof GameApiError && error.status === 408 && error.code === "request_timeout")
            Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true,
                value: async () => json({ error: "game_still_playing" }, 403) })
            await assert.rejects(createGameApi("http://api.test").director("one"),
                error => error instanceof GameApiError && error.status === 403 && error.code === "game_still_playing")
        } finally { env.restore() }
    })
})
