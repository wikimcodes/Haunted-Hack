#!/bin/sh
# Container entry point. Generates the typed Terse client from the deployed actors (so it always
# matches what is running), then starts the four agents and the game server.
set -e

for name in TERSE_ACTOR_URL TERSE_API_KEY RELAY_CONFIG_JSON; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || { echo "Missing $name (see DEPLOY.md)"; exit 1; }
done

terse actor generate --non-interactive

# runAll restarts any agent that exits. If the server exits, the container stops and the host restarts it.
bun src/agents/runAll.ts &
exec bun src/index.ts
