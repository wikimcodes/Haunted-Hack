// One command for the whole backend: Terse actors, game server and the four Relay agents.
// Usage (from backend/): bun demo.ts            hosted Agent Relay
//                        RELAY=local bun demo.ts local Relay engine (if hosted Relay is overloaded)
// Ctrl+C stops everything.

import { fileURLToPath } from "node:url"

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const ACTOR_DIR = here("./actor")
const SERVER_DIR = here("./server")

type Proc = { name: string; proc: Bun.Subprocess }
const procs: Proc[] = []
const colors: Record<string, string> = { terse: "35", server: "36", agents: "33", relay: "32" }

function run(name: string, cmd: string[], cwd: string, env: Record<string, string | undefined> = process.env): Proc {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env })
    const prefix = `\x1b[${colors[name] ?? "37"}m[${name}]\x1b[0m `
    for (const stream of [proc.stdout, proc.stderr]) {
        ;(async () => {
            const decoder = new TextDecoder()
            for await (const chunk of stream as ReadableStream<Uint8Array>) {
                for (const line of decoder.decode(chunk).split("\n")) if (line.trim()) console.log(prefix + line)
            }
        })()
    }
    proc.exited.then(code => console.log(`${prefix}exited with ${code}`))
    const entry = { name, proc }
    procs.push(entry)
    return entry
}

async function waitFor(url: string, label: string, timeoutMs = 60_000) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
        try {
            const res = await fetch(url)
            if (res.status < 500) return
        } catch {}
        await Bun.sleep(500)
    }
    throw new Error(`${label} did not start within ${timeoutMs / 1000}s`)
}

function stopAll() {
    for (const { proc } of procs) proc.kill()
    process.exit(0)
}
process.on("SIGINT", stopAll)
process.on("SIGTERM", stopAll)

// RELAY=local runs Relay's open-source engine on this machine (fallback when hosted Relay is overloaded).
const relayLocal = process.env.RELAY === "local"
if (relayLocal) {
    process.env.RELAY_MODE = "local"
    const dir = here("./relay-local")
    await Bun.$`mkdir -p ${dir}`.quiet()
    run("relay", ["npx", "-y", "@relaycast/engine", "--db", "./relaycast.db", "--port", "8787"], dir)
    await waitFor("http://localhost:8787/health", "Local Relay engine", 120_000)
}
const relayConfig = Bun.file(here(relayLocal ? "./server/.relay.local.json" : "./server/.relay.json"))
if (!(await relayConfig.exists())) {
    console.log(`No ${relayLocal ? "local" : "hosted"} Relay workspace yet, creating one...`)
    const setup = Bun.spawnSync(["bun", "src/setupRelay.ts"], { cwd: SERVER_DIR, stdout: "inherit", stderr: "inherit", env: process.env })
    if (setup.exitCode !== 0) process.exit(1)
}

// The server reads server/.env itself; read it here too so we know whether actors are deployed.
// LOCAL=1 forces local actors even when a deployed URL is configured.
const serverEnv = await Bun.file(here("./server/.env")).text().catch(() => "")
const deployedUrl = serverEnv.match(/^TERSE_ACTOR_URL=(\S+)/m)?.[1]
const deployed = !!deployedUrl && !!serverEnv.match(/^TERSE_API_KEY=\S+/m) && process.env.LOCAL !== "1"
if (deployed) {
    Bun.spawnSync(["terse", "actor", "generate"], { cwd: SERVER_DIR, env: { ...process.env, TERSE_ACTOR_URL: deployedUrl } })
} else {
    run("terse", ["terse", "actor", "dev"], ACTOR_DIR)
    await waitFor("http://127.0.0.1:7100/v1/projects/local/deployment/contract", "Terse dev server")
    Bun.spawnSync(["terse", "actor", "generate"], { cwd: SERVER_DIR, env: { ...process.env, TERSE_ACTOR_URL: "" } })
}
// Local mode must not inherit the deployed settings from server/.env.
const childEnv = deployed ? process.env : { ...process.env, TERSE_ACTOR_URL: "", TERSE_API_KEY: "" }

// Build the website so the game server can serve it from the same address as the API
// (one public link + QR code for everything). Skipped if the frontend isn't installed.
const WEB_DIR = here("../frontend-game")
if (await Bun.file(`${WEB_DIR}/node_modules/.bin/vite`).exists()) {
    console.log("Building the website...")
    const build = Bun.spawnSync(["npx", "vite", "build"], { cwd: WEB_DIR, env: { ...process.env, VITE_API_URL: "/" }, stdout: "ignore", stderr: "pipe" })
    if (build.exitCode !== 0) console.log("Website build failed (API still works):", build.stderr.toString().slice(-400))
} else {
    console.log("Website not built: run `bun install` in frontend-game to serve it from this server.")
}

run("server", ["bun", "src/index.ts"], SERVER_DIR, childEnv)
await waitFor("http://localhost:3001/health", "Game server")
run("agents", ["bun", "src/agents/runAll.ts"], SERVER_DIR, childEnv)

console.log(`
  Spy Monster backend is up ${deployed ? `(actors on Terse cloud: ${deployedUrl})` : "(local Terse)"}, ${relayLocal ? "local Relay engine" : "hosted Agent Relay"}
  Game website   http://localhost:3001
  Director View  http://localhost:3001/director   ("Scan to play" shows a QR code via a public link)
  Ctrl+C to stop everything.
`)
