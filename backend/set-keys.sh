#!/bin/zsh
# Asks for the OpenAI and Terse API keys (input hidden) and writes them to server/.env.
# Usage: zsh backend/set-keys.sh

ENV_FILE="${0:A:h}/server/.env"
TERSE_URL="https://api.useterse.ai/cmvws2wp700qrjy2ajmtmuoks/actors"
[[ -f "$ENV_FILE" ]] || cp "${0:A:h}/server/.env.example" "$ENV_FILE"

echo "Paste your OpenAI API key (starts with sk-), then press Enter. Nothing will show while you paste."
read -rs OPENAI_KEY
echo
if [[ "$OPENAI_KEY" != sk-* || ${#OPENAI_KEY} -lt 40 ]]; then
  echo "That doesn't look like an OpenAI API key (it should start with sk- and be long). Get one at https://platform.openai.com/api-keys"
  exit 1
fi

echo "Paste your Terse API key, then press Enter. Nothing will show while you paste."
read -rs TERSE_KEY
echo
if [[ ${#TERSE_KEY} -lt 20 ]]; then
  echo "That looks too short for a Terse API key. Create one at https://app.useterse.ai/app/api-tokens?name=terse_spy-monster"
  exit 1
fi

OPENAI_KEY="$OPENAI_KEY" TERSE_KEY="$TERSE_KEY" TERSE_URL="$TERSE_URL" python3 - "$ENV_FILE" <<'PY'
import os, sys
path = sys.argv[1]
lines = open(path).read().splitlines()
keep = [l for l in lines if not l.lstrip("# ").startswith(("OPENAI_API_KEY=", "TERSE_ACTOR_URL=", "TERSE_API_KEY=")) and "Deployed Terse actors" not in l]
keep = [f"OPENAI_API_KEY={os.environ['OPENAI_KEY']}"] + keep + [
    f"TERSE_ACTOR_URL={os.environ['TERSE_URL']}",
    f"TERSE_API_KEY={os.environ['TERSE_KEY']}",
]
open(path, "w").write("\n".join(keep) + "\n")
PY
echo "Saved both keys to server/.env. Tell Claude: keys set."
