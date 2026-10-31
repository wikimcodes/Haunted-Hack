// One monster's agent process. Run as: bun src/agents/monster.ts <sprout|pebble|momo>
// It holds only its own Relay token. It hears facts from the gamemaster, gossips to other
// monsters over Relay DMs, and, if it is the spy for that session, reports to the witch.

import { actors } from "../../generated/index.js"
import { connectAgent, pollInbox, withRelayRetry } from "../relayConfig"
import { MONSTER_NAMES, isMonsterId, type MonsterId, type RelayMeta } from "../types"

const me = process.argv[2]
if (!isMonsterId(me)) {
    console.error("usage: bun src/agents/monster.ts <sprout|pebble|momo>")
    process.exit(1)
}
const self: MonsterId = me

const GOSSIP_CHANCE: Record<MonsterId, number> = { sprout: 0.6, pebble: 0.8, momo: 0.35 }
const GOSSIP_LINES: Record<MonsterId, (fact: string) => string> = {
    sprout: f => `Psst, friend! The human told me something sweet: "${f}"`,
    pebble: f => `Ooh ooh, guess what the human said! "${f}"`,
    momo: f => `...the human said "${f}". Don't tell.`
}
const REPORT_LINE = (facts: string[]) => `Mistress, the human has been talking. ${facts.map(f => `"${f}"`).join(" and ")}`

const { relay, agent } = await connectAgent(self)
const handled = new Set<string>()
// Ignore anything that was already waiting before this process started (old games).
const startedAt = Date.now() - 5000
const log = (...args: unknown[]) => console.log(`[${self}]`, ...args)

async function reportIfSpy(sessionId: string): Promise<void> {
    const g = actors.GameActor.get(sessionId)
    const brief = await g.briefing(self)
    if (!brief.live || !brief.isSpy) return
    const reported = new Set(brief.reportedFactIds)
    const fresh = brief.knownFacts.filter(f => !reported.has(f.id))
    if (fresh.length === 0) return
    const meta: RelayMeta = { kind: "report", sessionId, factIds: fresh.map(f => f.id) }
    const sent = await withRelayRetry("report", () =>
        agent.sendMessage({
            to: "@witch",
            text: REPORT_LINE(fresh.map(f => f.text)),
            metadata: meta,
            idempotencyKey: `report-${sessionId}-${self}-${meta.factIds.join("-")}`
        })
    )
    log(`reported ${meta.factIds.join(",")} to the witch (${sent.id})`)
}

async function maybeGossip(sessionId: string, factIds: string[], texts: string[]): Promise<void> {
    if (factIds.length === 0 || Math.random() > GOSSIP_CHANCE[self]) return
    const g = actors.GameActor.get(sessionId)
    const targets = await g.gossipTargets(self)
    const to = targets[Math.floor(Math.random() * targets.length)]
    if (!to) return
    const reservation = await g.reserveGossip(self, to, factIds)
    if (!reservation.ok || !reservation.gossipId) {
        log(`no gossip (${reservation.reason})`)
        return
    }
    // Small human-ish delay so whispers do not land instantly.
    await Bun.sleep(1500 + Math.random() * 3000)
    const text = GOSSIP_LINES[self](texts[0]!)
    const meta: RelayMeta = { kind: "gossip", sessionId, gossipId: reservation.gossipId, factIds }
    let sent
    try {
        sent = await withRelayRetry("gossip", () =>
            agent.sendMessage({ to: `@${to}`, text, metadata: meta, idempotencyKey: `gossip-${sessionId}-${reservation.gossipId}` })
        )
    } catch (err) {
        // Nothing was delivered: give the round's whisper back instead of burning it.
        await g.releaseGossip(reservation.gossipId).catch(() => {})
        throw err
    }
    await g.confirmGossip(reservation.gossipId, sent.id, text)
    log(`gossiped ${factIds.join(",")} to ${MONSTER_NAMES[to]} (${sent.id})`)
}

async function handle(messageId: string): Promise<void> {
    if (handled.has(messageId)) return
    handled.add(messageId)
    // Fetch the full message: Relay attaches the authenticated sender and our metadata.
    const msg = await withRelayRetry("read", () => agent.messages.get(messageId))
    const from = msg.from?.name
    if (from === self || (msg.createdAt && Date.parse(msg.createdAt) < startedAt)) return
    const meta = (msg.metadata ?? {}) as Partial<RelayMeta>
    if (!meta.sessionId || !meta.kind) return
    const sessionId = meta.sessionId

    if (meta.kind === "heard" && from === "gamemaster") {
        const brief = await actors.GameActor.get(sessionId).briefing(self)
        const fact = brief.knownFacts.find(f => f.id === meta.factId)
        if (!fact) return
        await reportIfSpy(sessionId)
        await maybeGossip(sessionId, [fact.id], [fact.text])
        return
    }

    if (meta.kind === "gossip" && isMonsterId(from)) {
        const received = await actors.GameActor.get(sessionId).receiveGossip(meta.gossipId!, from, self, messageId)
        if (!received.ok) {
            log(`rejected gossip ${meta.gossipId} from ${from}`)
            return
        }
        await actors.MonsterActor.get(`${sessionId}.${self}`).hearRumour(from, msg.text ?? "", messageId)
        log(`heard gossip from ${MONSTER_NAMES[from]}`)
        await reportIfSpy(sessionId)
    }
}

const dispatch = (id: string) => handle(id).catch(err => log("error handling", id, String(err)))

// Push delivery when it is fast, inbox polling when it is not. `handle` ignores repeats.
relay.addListener("dm.received", event => {
    const id = event.message.id ?? (event.message as { messageId?: string }).messageId
    if (id) dispatch(id)
})
pollInbox(agent, dispatch)

log("online")
