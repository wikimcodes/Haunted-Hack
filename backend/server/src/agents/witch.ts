// The witch's agent process. Holds only the witch's Relay token.
// Every DM it receives is handed to GameActor with the Relay-authenticated sender;
// the actor decides whether that sender is really the spy.

import { actors } from "../../generated/index.js"
import { connectAgent, withRelayRetry } from "../relayConfig"
import type { RelayMeta } from "../types"

const { relay, agent } = await connectAgent("witch")
const handled = new Set<string>()
const log = (...args: unknown[]) => console.log("[witch]", ...args)

async function handle(messageId: string): Promise<void> {
    if (handled.has(messageId)) return
    handled.add(messageId)
    const msg = await withRelayRetry("read", () => agent.messages.get(messageId))
    const meta = (msg.metadata ?? {}) as Partial<RelayMeta>
    if (meta.kind !== "report" || !meta.sessionId) return
    const from = msg.from?.name ?? "unknown"
    const factIds = Array.isArray(meta.factIds) ? meta.factIds.filter((id): id is string => typeof id === "string") : []
    const result = await actors.GameActor.get(meta.sessionId).acceptReport(from, factIds, msg.text ?? "", messageId)
    log(`${result.accepted ? "accepted" : "REJECTED"} report from ${from} (${messageId})`)
}

relay.addListener("dm.received", event => {
    const id = event.message.id ?? (event.message as { messageId?: string }).messageId
    if (!id) return
    handle(id).catch(err => log("error handling", id, String(err)))
})

log("online")
