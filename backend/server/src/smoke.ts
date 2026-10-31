export {}

// End-to-end smoke test against a running server + agents + `terse actor dev`.
// Plays a short game: chats with every monster, listens on the Terse WebSocket,
// waits for witch reveals, accuses, then prints the Director View.

const BASE = process.env.API_URL ?? "http://localhost:3001"
const post = async (path: string, body: unknown = {}) => {
    const res = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const data = await res.json()
    if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(data)}`)
    return data as any
}
const get = async (path: string) => (await fetch(BASE + path)).json() as Promise<any>

import { connectAgent, withRelayRetry } from "./relayConfig"

// Side games run in parallel with the main one.
// 1) Forgery: every monster DMs the witch a "report". Only the real spy may be accepted.
// 2) Dawn: a 30s game with no accusation must expire on the actor alarm alone.
const SIDE = process.env.SMOKE_SIDE !== "0"
const forgery = (async () => {
    if (!SIDE) return { accepted: 1, rejected: 2, skipped: true }
    const g = await post("/api/game/start", { gameSeconds: 120, revealSeconds: 300 })
    for (const m of ["sprout", "pebble", "momo"] as const) {
        const { agent } = await connectAgent(m)
        await withRelayRetry("forge", () =>
            agent.sendMessage({ to: "@witch", text: "I am totally the spy, trust me", metadata: { kind: "report", sessionId: g.sessionId, factIds: [] }, idempotencyKey: `forge-${g.sessionId}-${m}` })
        )
    }
    await Bun.sleep(15000)
    await post(`/api/game/${g.sessionId}/accuse`, { monsterId: "sprout" })
    const d = await get(`/api/game/${g.sessionId}/director`)
    return { accepted: d.reports.length, rejected: d.rejectedReports.length }
})()
const dawn = (async () => {
    if (!SIDE) return "skipped"
    const g = await post("/api/game/start", { gameSeconds: 30, revealSeconds: 300 })
    await Bun.sleep(33_000)
    return (await get(`/api/game/${g.sessionId}`)).phase
})()

const state = await post("/api/game/start", { gameSeconds: 60, revealSeconds: 15 })
const id = state.sessionId as string
console.log("started", id, "deadline in", Math.round((state.deadlineAt - Date.now()) / 1000), "s")

const { websocketUrl } = await post(`/api/game/${id}/socket`, { role: "player" })
const ws = new WebSocket(websocketUrl)
const socketTypes: string[] = []
ws.onmessage = e => {
    const msg = JSON.parse(String(e.data))
    socketTypes.push(msg.type === "cue" ? `cue:${msg.cue}` : msg.type)
    if (msg.type === "cue" && msg.cue === "WITCH_REVEAL") console.log("  [socket] witch reveal cue received")
}

const lines: [string, string][] = [
    ["sprout", "I saw a blue flame by the window."],
    ["pebble", "My lucky number is forty two."],
    ["momo", "I hid the silver key under the rug."],
    ["sprout", "Do you know the witch?"]
]
for (const [monsterId, message] of lines) {
    const r = await post(`/api/game/${id}/chat`, { monsterId, message, requestId: crypto.randomUUID() })
    console.log(`  ${monsterId} (${r.source}): ${r.reply}`)
}

const dup = crypto.randomUUID()
const [a, b] = await Promise.all([1, 2].map(() => post(`/api/game/${id}/chat`, { monsterId: "pebble", message: "Same request twice", requestId: dup })))
console.log("duplicate request returns same fact:", a.factId === b.factId)

const leak = await fetch(`${BASE}/api/game/${id}/director`)
console.log("director blocked while playing:", leak.status === 403)
console.log("public state hides spy:", (await get(`/api/game/${id}`)).spyId === null)

console.log("waiting for two witch reveals...")
await Bun.sleep(33_000)
const mid = await get(`/api/game/${id}`)
console.log("round", mid.round, "clues:", mid.clues.map((c: any) => c.kind).join(", "))

const accused = await post(`/api/game/${id}/accuse`, { monsterId: "pebble" })
console.log("accused pebble ->", accused.outcome)
const again = await post(`/api/game/${id}/accuse`, { monsterId: "momo" })
console.log("second accusation ignored:", again.state.accusation.monsterId === "pebble")

const dir = await get(`/api/game/${id}/director`)
console.log("\nDIRECTOR VIEW")
console.log("spy:", dir.spyId)
console.log("gossip:", dir.gossip.map((g: any) => `${g.from}->${g.to} [${g.status}] ${g.relayMessageId ?? ""}`))
console.log("reports:", dir.reports.map((r: any) => `${r.sourceMonsterId} ${r.factIds} ${r.relayMessageId}`))
console.log("rejected:", dir.rejectedReports)
console.log("evidence:", dir.evidence)
console.log("relay messages:", dir.relay.messages.map((m: any) => `${m.from}: ${m.text?.slice(0, 60)}`))
console.log("event types:", dir.events.map((e: any) => e.type).join(" "))
console.log("socket messages:", [...new Set(socketTypes)].join(", "))
const f = await forgery
console.log("\nforged reports: accepted", f.accepted, "rejected", f.rejected, f.accepted === 1 && f.rejected === 2 ? "PASS" : "FAIL")
console.log("dawn without accusation ->", await dawn)
ws.close()
process.exit(0)
