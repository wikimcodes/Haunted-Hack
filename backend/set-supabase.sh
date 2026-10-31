#!/bin/zsh
# Asks for the Supabase project URL and service_role key (key input hidden) and adds them to server/.env.
# Usage: zsh backend/set-supabase.sh [project-url]

ENV_FILE="${0:A:h}/server/.env"
[[ -f "$ENV_FILE" ]] || cp "${0:A:h}/server/.env.example" "$ENV_FILE"

SB_URL="$1"
if [[ -z "$SB_URL" ]]; then
  echo "Paste your Supabase Project URL (looks like https://abcd1234.supabase.co), then press Enter:"
  read -r SB_URL
fi
if [[ "$SB_URL" != https://*.supabase.co* ]]; then
  echo "That doesn't look like a Supabase project URL. Find it in Supabase > Project Settings > API."
  exit 1
fi

echo "Paste your service_role key (Project Settings > API keys), then press Enter. Nothing will show while you paste."
read -rs SB_KEY
echo
if [[ ${#SB_KEY} -lt 30 ]]; then
  echo "That looks too short for a service_role key."
  exit 1
fi

SB_URL="${SB_URL%/}" SB_KEY="$SB_KEY" python3 - "$ENV_FILE" <<'PY'
import os, sys
path = sys.argv[1]
lines = [l for l in open(path).read().splitlines() if not l.startswith(("SUPABASE_URL=", "SUPABASE_SERVICE_ROLE_KEY="))]
lines += [f"SUPABASE_URL={os.environ['SB_URL']}", f"SUPABASE_SERVICE_ROLE_KEY={os.environ['SB_KEY']}"]
open(path, "w").write("\n".join(lines) + "\n")
PY

# Quick check that the key works and the table exists.
code=$(curl -s -o /dev/null -w "%{http_code}" "${SB_URL%/}/rest/v1/games?select=session_id&limit=1" -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY")
if [[ "$code" == "200" ]]; then
  echo "Saved. Supabase works and the games table exists. Tell Claude: supabase set."
else
  echo "Saved, but Supabase answered $code. If it's 404, run backend/supabase/schema.sql in the SQL Editor first. Then tell Claude."
fi
