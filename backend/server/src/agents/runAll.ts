export {}

// Starts each agent as its own OS process (four independent Relay participants).

const agents = [
    ["witch", "src/agents/witch.ts"],
    ["sprout", "src/agents/monster.ts", "sprout"],
    ["pebble", "src/agents/monster.ts", "pebble"],
    ["momo", "src/agents/monster.ts", "momo"]
] as const

const procs = agents.map(([name, file, arg]) => {
    const proc = Bun.spawn(["bun", file, ...(arg ? [arg] : [])], { stdout: "inherit", stderr: "inherit", env: process.env })
    proc.exited.then(code => console.log(`[runAll] ${name} exited with ${code}`))
    return proc
})

const stop = () => {
    procs.forEach(p => p.kill())
    process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
