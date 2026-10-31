// One-time Relay bootstrap. Retry a failed run to resume its saved workspace/tokens.
// --force replaces an existing completed configuration only after setup succeeds.

import { open, readFile, rename, unlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { AgentRelay } from "@agent-relay/sdk"
import { AGENT_NAMES, LOCAL_RELAY_URL, RELAY_LOCAL, withRelayRetry, type AgentName, type RelayConfig } from "./relayConfig"

// RELAY_MODE=local keeps its own workspace, tokens and checkpoint next to the hosted ones.
const CONFIG_PATH = fileURLToPath(new URL(RELAY_LOCAL ? "../.relay.local.json" : "../.relay.json", import.meta.url))
const CHECKPOINT_PATH = fileURLToPath(new URL(RELAY_LOCAL ? "../.relay-setup.local.json" : "../.relay-setup.json", import.meta.url))

type Checkpoint = {
    version: 1
    workspaceName: string
    workspaceKey?: string
    tokens: Partial<Record<AgentName, string>>
}
type BootstrapRelay = {
    workspaceKey?: string
    workspace: { register(input: { name: AgentName; type: "agent" }): Promise<{ name: string; token?: string }> }
}
type SetupOptions = {
    force?: boolean
    /** Self-hosted Relay engine; hosted Relay when absent. */
    baseUrl?: string
    configPath?: string
    checkpointPath?: string
    createWorkspace?: (name: string) => Promise<BootstrapRelay>
    resumeWorkspace?: (workspaceKey: string) => BootstrapRelay
    retry?: typeof withRelayRetry
}

async function readJson(path: string): Promise<unknown | null> {
    try { return JSON.parse(await readFile(path, "utf8")) }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        // Do not silently discard a damaged file that may contain issued credentials.
        throw new Error(`Cannot read Relay configuration at ${path}; existing credentials were left untouched.`)
    }
}

async function savePrivate(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.tmp`
    const file = await open(temporary, "w", 0o600)
    try {
        await file.chmod(0o600)
        await file.writeFile(JSON.stringify(value, null, 2) + "\n")
        await file.sync()
    } finally { await file.close() }
    await rename(temporary, path)
}

function parseCheckpoint(value: unknown): Checkpoint {
    const state = value as Checkpoint | null
    if (!state || state.version !== 1 || typeof state.workspaceName !== "string" || !state.workspaceName
        || (state.workspaceKey !== undefined && (typeof state.workspaceKey !== "string" || !state.workspaceKey))
        || !state.tokens || typeof state.tokens !== "object" || Array.isArray(state.tokens)
        || Object.entries(state.tokens).some(([name, token]) => !AGENT_NAMES.includes(name as AgentName) || typeof token !== "string" || !token)) {
        throw new Error("Invalid Relay setup checkpoint; retained it for recovery instead of creating another workspace.")
    }
    return state
}

export async function setupRelay(options: SetupOptions = {}): Promise<void> {
    const configPath = options.configPath ?? CONFIG_PATH
    const checkpointPath = options.checkpointPath ?? CHECKPOINT_PATH
    const retry = options.retry ?? withRelayRetry
    const baseUrl = "baseUrl" in options ? options.baseUrl : RELAY_LOCAL ? LOCAL_RELAY_URL : undefined
    const existing = await readJson(configPath)
    if (existing && !options.force) {
        console.log("Relay already set up. Pass --force to replace it after a new setup succeeds.")
        return
    }

    const saved = await readJson(checkpointPath)
    const checkpoint: Checkpoint = saved ? parseCheckpoint(saved) : {
        version: 1, workspaceName: `spy-monster-${Date.now()}`, tokens: {}
    }
    // Persist the name before contacting Relay, and the key before registering any agent.
    await savePrivate(checkpointPath, checkpoint)
    let relay: BootstrapRelay
    if (checkpoint.workspaceKey) {
        relay = options.resumeWorkspace?.(checkpoint.workspaceKey) ?? new AgentRelay({ workspaceKey: checkpoint.workspaceKey, ...(baseUrl ? { baseUrl } : {}) })
        console.log(`Resuming Relay setup (${Object.keys(checkpoint.tokens).length}/${AGENT_NAMES.length} agents saved).`)
    } else {
        relay = await retry("create workspace", () => options.createWorkspace?.(checkpoint.workspaceName)
            ?? AgentRelay.createWorkspace({ name: checkpoint.workspaceName, ...(baseUrl ? { baseUrl } : {}) }))
        if (!relay.workspaceKey) throw new Error("Relay did not return a workspace key; setup checkpoint retained.")
        checkpoint.workspaceKey = relay.workspaceKey
        await savePrivate(checkpointPath, checkpoint)
    }

    for (const name of AGENT_NAMES) {
        if (checkpoint.tokens[name]) continue
        // Registration is create-only in this SDK. A name conflict must fail rather
        // than rotate somebody's token; saved successful registrations are skipped.
        const agent = await retry(`register ${name}`, () => relay.workspace.register({ name, type: "agent" }))
        if (agent.name !== name || !agent.token) throw new Error(`Relay did not return the expected token for ${name}; setup checkpoint retained.`)
        checkpoint.tokens[name] = agent.token
        await savePrivate(checkpointPath, checkpoint)
        console.log(`Registered ${name} (${Object.keys(checkpoint.tokens).length}/${AGENT_NAMES.length}).`)
    }

    const complete: RelayConfig = {
        workspaceName: checkpoint.workspaceName,
        workspaceKey: checkpoint.workspaceKey!,
        tokens: checkpoint.tokens as Record<AgentName, string>,
        ...(baseUrl ? { baseUrl } : {})
    }
    await savePrivate(configPath, complete)
    // Only completed setup removes its checkpoint. Failed attempts retain all tokens.
    await unlink(checkpointPath)
    console.log(`${baseUrl ? "Local" : "Hosted"} Relay setup complete: ${AGENT_NAMES.join(", ")}.`)
}

if (import.meta.main) {
    await setupRelay({ force: process.argv.includes("--force") })
    process.exit(0)
}
