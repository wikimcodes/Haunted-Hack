// Drives GameConnection against a running backend (see backend/README.md).
import { GameConnection } from "../src"

const API = process.env.API_URL ?? "http://localhost:3001"
const a = new GameConnection(API)
const cues: string[] = []
a.onCue(c => cues.push(c.cue + (c.monsterId ? `:${c.monsterId}` : "")))

const state = await a.start({ gameSeconds: 45, revealSeconds: 12 })
console.log("started", state.sessionId)
await Bun.sleep(1500)
console.log("socket connected:", a.getSnapshot().connected)

// Second device joins the same game.
const b = new GameConnection(API)
await b.resume(state.sessionId)
await Bun.sleep(1500)
console.log("second device connected:", b.getSnapshot().connected, "same game:", b.getSnapshot().state?.sessionId === state.sessionId)

// Two monsters at once must both answer; a second message to a busy monster is refused.
const both = Promise.all([a.chat("sprout", "I saw a blue flame by the window."), a.chat("momo", "The key is under the rug.")])
console.log("busy monster refused:", (await a.chat("sprout", "hello again")) === false && a.getSnapshot().error === "still_replying")
console.log("parallel chats ok:", (await both).every(Boolean))
const snap = a.getSnapshot()
console.log("chat lines:", snap.chat.length, "waiting:", snap.waiting, "clock offset ms:", snap.clockOffsetMs)

await Bun.sleep(14_000)
console.log("device A clues:", a.getSnapshot().state?.clues.map(c => c.kind).join(","))
console.log("device B clues:", b.getSnapshot().state?.clues.map(c => c.kind).join(","), "(live via socket, no refetch)")

const end = await a.accuse("pebble")
await Bun.sleep(800)
console.log("outcome:", end?.phase, "| device B sees:", b.getSnapshot().state?.phase, "| spy revealed:", b.getSnapshot().state?.spyId)
console.log("cues:", [...new Set(cues)].join(", "))
const dir = (await a.director()) as { relay: { messages: unknown[] } }
console.log("director relay messages:", dir.relay.messages.length)
a.close()
b.close()
process.exit(0)
