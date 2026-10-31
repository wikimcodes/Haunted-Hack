export {}

// Starts each agent as its own OS process (four independent Relay participants)
// and restarts any that exit, so one Relay hiccup cannot remove a monster mid-demo.

const agents = [
    ["witch", "src/agents/witch.ts"],
    ["sprout", "src/agents/monster.ts", "sprout"],
    ["pebble", "src/agents/monster.ts", "pebble"],
    ["momo", "src/agents/monster.ts", "momo"]
] as const

let stopping = false
const procs = new Map<string, Bun.Subprocess>()

function launch(name: string, file: string, arg?: string, attempt = 0) {
    const startedAt = Date.now()
    const proc = Bun.spawn(["bun", file, ...(arg ? [arg] : [])], { stdout: "inherit", stderr: "inherit", env: process.env })
    procs.set(name, proc)
    proc.exited.then(code => {
        if (stopping) return
        // Back off if it keeps dying straight away; reset once it has stayed up for a minute.
        const next = Date.now() - startedAt > 60_000 ? 0 : attempt + 1
        const delay = Math.min(1000 * 2 ** next, 30_000)
        console.log(`[runAll] ${name} exited with ${code}, restarting in ${delay / 1000}s`)
        setTimeout(() => !stopping && launch(name, file, arg, next), delay)
    })
}

for (const [name, file, arg] of agents) launch(name, file, arg)

const stop = () => {
    stopping = true
    procs.forEach(p => p.kill())
    process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
