// Relay credentials live in .relay.json (gitignored), written once by `bun run setup:relay`.
// Each agent process only ever reads its own token from here.

import { fileURLToPath } from "node:url"

import { AgentRelay } from "@agent-relay/sdk"

export const AGENT_NAMES = ["gamemaster", "witch", "sprout", "pebble", "momo"] as const
export type AgentName = (typeof AGENT_NAMES)[number]

export interface RelayConfig {
    workspaceName: string
    workspaceKey: string
    tokens: Record<AgentName, string>
}

const CONFIG_PATH = fileURLToPath(new URL("../.relay.json", import.meta.url))

export async function loadRelayConfig(): Promise<RelayConfig> {
    const file = Bun.file(CONFIG_PATH)
    if (!(await file.exists())) throw new Error("Missing backend/server/.relay.json. Run `bun run setup:relay` first.")
    return (await file.json()) as RelayConfig
}

export async function saveRelayConfig(config: RelayConfig): Promise<void> {
    await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2))
}

/**
 * Relay can briefly refuse writes under load ("write capacity is busy"). Every send in this
 * game carries an idempotency key, so retrying with backoff is safe and never duplicates.
 */
export async function withRelayRetry<T>(label: string, fn: () => Promise<T>, attempts = 8): Promise<T> {
    let delay = 300
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn()
        } catch (err) {
            const message = String(err)
            const info = err as { retryable?: boolean; retryAfterMs?: number }
            const retryable = info.retryable === true || /busy|retry|rate|429|5\d\d|timeout|ECONNRESET|fetch failed/i.test(message)
            if (!retryable || attempt >= attempts) throw err
            const wait = Math.max(delay, info.retryAfterMs ?? 0) + Math.random() * 300
            console.warn(`[relay] ${label} busy (attempt ${attempt}), retrying in ${Math.round(wait)}ms`)
            await Bun.sleep(wait)
            delay = Math.min(delay * 2, 4000)
        }
    }
}

/**
 * Relay's push delivery can lag by tens of seconds. Agents also poll their own inbox and hand
 * each conversation's newest unread message to `handle` (which must ignore IDs it has seen).
 * The game logic only needs the newest message per conversation: it re-reads its briefing.
 */
export function pollInbox(
    agent: { inbox: { get(options?: { limit?: number }): Promise<{ unreadDms?: { lastMessage?: { id?: string } }[] }> } },
    handle: (messageId: string) => void,
    intervalMs = 3000
): () => void {
    let stopped = false
    let wait = intervalMs
    const tick = async () => {
        while (!stopped) {
            try {
                const inbox = await agent.inbox.get()
                for (const dm of inbox.unreadDms ?? []) if (dm.lastMessage?.id) handle(dm.lastMessage.id)
                wait = intervalMs
            } catch (err) {
                // Relay is busy or overloaded: back off instead of adding to its load.
                wait = Math.min(wait * 2, 20_000)
                console.warn(`[relay] inbox poll failed, next try in ${wait / 1000}s:`, String(err).slice(0, 120))
            }
            await Bun.sleep(wait)
        }
    }
    void tick()
    return () => {
        stopped = true
    }
}

/** Connects as one named agent using only that agent's token. */
export async function connectAgent(name: AgentName, config?: RelayConfig) {
    const cfg = config ?? (await loadRelayConfig())
    const token = cfg.tokens[name]
    const relay = new AgentRelay({ agentToken: token })
    relay.onError(err => console.error(`[relay:${name}]`, String(err)))
    const agent = await relay.workspace.reconnect({ apiToken: token })
    return { relay, agent }
}
