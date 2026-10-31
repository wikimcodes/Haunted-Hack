// One command for the whole backend: Terse actors, game server and the four Relay agents.
// Usage (from backend/): bun demo.ts
// Ctrl+C stops everything.

import { fileURLToPath } from "node:url"

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const ACTOR_DIR = here("./actor")
const SERVER_DIR = here("./server")

type Proc = { name: string; proc: Bun.Subprocess }
const procs: Proc[] = []
const colors: Record<string, string> = { terse: "35", server: "36", agents: "33" }

function run(name: string, cmd: string[], cwd: string): Proc {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
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

const relayConfig = Bun.file(here("./server/.relay.json"))
if (!(await relayConfig.exists())) {
    console.log("No Relay workspace yet, creating one...")
    const setup = Bun.spawnSync(["bun", "src/setupRelay.ts"], { cwd: SERVER_DIR, stdout: "inherit", stderr: "inherit" })
    if (setup.exitCode !== 0) process.exit(1)
}

const deployed = !!process.env.TERSE_ACTOR_URL
if (!deployed) {
    run("terse", ["terse", "actor", "dev"], ACTOR_DIR)
    await waitFor("http://127.0.0.1:7100/v1/projects/local/deployment/contract", "Terse dev server")
    Bun.spawnSync(["terse", "actor", "generate"], { cwd: SERVER_DIR })
}

run("server", ["bun", "src/index.ts"], SERVER_DIR)
await waitFor("http://localhost:3001/health", "Game server")
run("agents", ["bun", "src/agents/runAll.ts"], SERVER_DIR)

console.log(`
  Spy Monster backend is up ${deployed ? "(actors on Terse cloud)" : "(local Terse)"}
  API            http://localhost:3001
  Director View  http://localhost:3001/director
  Ctrl+C to stop everything.
`)
