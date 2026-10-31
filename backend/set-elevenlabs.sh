#!/bin/zsh
# Asks for an ElevenLabs API key (input hidden) and saves it to server/.env.
# Usage: zsh backend/set-elevenlabs.sh

ENV_FILE="${0:A:h}/server/.env"
[[ -f "$ENV_FILE" ]] || cp "${0:A:h}/server/.env.example" "$ENV_FILE"

echo "Paste your ElevenLabs API key, then press Enter. Nothing will show while you paste."
read -rs EL_KEY
echo
if [[ ${#EL_KEY} -lt 20 ]]; then
  echo "That looks too short for an ElevenLabs API key. Create one at https://elevenlabs.io/app/settings/api-keys"
  exit 1
fi

code=$(curl -s -o /dev/null -w "%{http_code}" https://api.elevenlabs.io/v1/voices -H "xi-api-key: $EL_KEY")
if [[ "$code" != "200" ]]; then
  echo "ElevenLabs rejected that key (HTTP $code). Check it has Text to Speech and Voices permissions."
  exit 1
fi

EL_KEY="$EL_KEY" python3 - "$ENV_FILE" <<'PY'
import os, sys
path = sys.argv[1]
lines = [l for l in open(path).read().splitlines() if not l.lstrip("# ").startswith("ELEVENLABS_API_KEY=")]
lines.append(f"ELEVENLABS_API_KEY={os.environ['EL_KEY']}")
open(path, "w").write("\n".join(lines) + "\n")
PY
echo "Saved and verified. Tell Claude: elevenlabs set."
