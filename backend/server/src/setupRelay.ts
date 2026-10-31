// One-time setup: create an Agent Relay workspace and register every game agent.
// Usage: bun run setup:relay        (refuses to overwrite an existing .relay.json)
//        bun run setup:relay --force

import { AgentRelay } from "@agent-relay/sdk"

import { AGENT_NAMES, LOCAL_RELAY_URL, RELAY_LOCAL, loadRelayConfig, saveRelayConfig, type AgentName } from "./relayConfig"

const force = process.argv.includes("--force")
const existing = await loadRelayConfig().catch(() => null)
if (existing && !force) {
    console.log(`Relay already set up (workspace ${existing.workspaceName}). Pass --force to create a new one.`)
    process.exit(0)
}

const workspaceName = `spy-monster-${Date.now()}`
const baseUrl = RELAY_LOCAL ? LOCAL_RELAY_URL : undefined
const relay = await AgentRelay.createWorkspace({ name: workspaceName, ...(baseUrl ? { baseUrl } : {}) })
if (!relay.workspaceKey) throw new Error("Relay did not return a workspace key")

const registered = await relay.workspace.register(AGENT_NAMES.map(name => ({ name, type: "agent" as const })))
const tokens = {} as Record<AgentName, string>
for (const agent of registered) {
    if (!agent.token) throw new Error(`No token returned for ${agent.name}`)
    tokens[agent.name as AgentName] = agent.token
}

await saveRelayConfig({ workspaceName, workspaceKey: relay.workspaceKey, tokens, ...(baseUrl ? { baseUrl } : {}) })
console.log(`Created ${baseUrl ? "local" : "hosted"} Relay workspace ${workspaceName} with agents: ${AGENT_NAMES.join(", ")}`)
process.exit(0)
