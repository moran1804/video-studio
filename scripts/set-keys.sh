#!/usr/bin/env bash
# Interactively set API keys in .env (input for keys is hidden), then restart the app.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "No .env here ($(pwd)). Run this on the machine with the project."; exit 1; }
python3 - <<'PY'
import getpass, re
path = ".env"
secret = ["OPENAI_API_KEY", "GOOGLE_GEMINI_API_KEY", "RUNWAY_API_KEY", "ELEVENLABS_API_KEY"]
plain = ["GOOGLE_VIDEO_MODEL", "ELEVENLABS_VOICE_ID"]
text = open(path).read()
for k in secret + plain:
    ask = getpass.getpass if k in secret else input
    v = ask(f"{k} (Enter to skip): ").strip()
    if v:
        text = re.sub(rf"^{k}=.*$", lambda m: f"{k}={v}", text, flags=re.M)
        print(f"  {k} updated")
open(path, "w").write(text)
print("Saved .env")
PY
chmod 600 .env
echo "Restarting the studio…"
docker compose up -d --wait
echo "Done. Open http://192.168.68.105:3000 → Settings → Test connection."
